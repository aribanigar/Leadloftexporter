from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Activity, Company, Lead, PipelineStage


def _domain_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    s = url.strip()
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    s = s.split("/")[0].lower()
    if s.startswith("www."):
        s = s[4:]
    return s or None


def upsert_company(
    db: Session,
    workspace_id: str,
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
    website: Optional[str] = None,
    linkedin_url: Optional[str] = None,
    extra: Optional[dict] = None,
) -> Optional[Company]:
    if not (name or domain or website or linkedin_url):
        return None
    domain = domain or _domain_from_url(website)
    q = db.query(Company).filter(Company.workspace_id == workspace_id)
    company: Optional[Company] = None
    if linkedin_url:
        company = q.filter(Company.linkedin_url == linkedin_url).first()
    if not company and domain:
        company = q.filter(Company.domain == domain).first()
    if not company and name:
        company = q.filter(Company.name == name).first()
    if not company:
        company = Company(
            workspace_id=workspace_id,
            name=name or domain or "Unknown",
            domain=domain,
            website=website,
            linkedin_url=linkedin_url,
            data=extra or {},
        )
        db.add(company)
        db.flush()
    else:
        if not company.domain and domain:
            company.domain = domain
        if not company.website and website:
            company.website = website
        if not company.linkedin_url and linkedin_url:
            company.linkedin_url = linkedin_url
        if extra:
            merged = dict(company.data or {})
            merged.update(extra)
            company.data = merged
    return company


def default_stage(db: Session, workspace_id: str) -> Optional[PipelineStage]:
    return (
        db.query(PipelineStage)
        .filter(PipelineStage.workspace_id == workspace_id)
        .order_by(PipelineStage.position.asc())
        .first()
    )


def normalize_linkedin(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    s = url.split("?")[0].rstrip("/").lower()
    # Cap at the linkedin_url column length (500) so a degenerate input
    # never trips a Postgres value-too-long crash.
    return s[:500] if len(s) > 500 else s


# Column-length caps from app/models/base.py. Centralised here so a single
# table-of-truth update covers every code path that may ingest user data.
# Without this, page-2 LinkedIn search cards routinely produced 500s because
# the scraped `title` (=entire headline when no " at " separator exists) or
# the signed avatar JWT URL exceed these tight column bounds.
_LEAD_FIELD_CAPS = {
    "first_name": 120,
    "last_name": 120,
    "full_name": 240,
    "title": 240,
    "email": 255,
    "phone": 60,
    "linkedin_url": 500,
    "location": 200,
    "avatar_url": 500,
    "source": 40,
    # headline is TEXT (unbounded); no cap.
}


def _cap(value, max_len: int):
    """Trim a string to fit a column; preserve None / non-strings."""
    if value is None:
        return None
    s = str(value)
    return s[:max_len] if len(s) > max_len else s


def _clean_avatar_url(url: Optional[str]) -> Optional[str]:
    """LinkedIn media CDN URLs include a signed JWT in the query string that
    the CDN validates on every request. Stripping the query returns a 403
    placeholder image, so the URL must be stored verbatim. Lead.avatar_url
    is TEXT (unbounded) — see migration 0002_lead_avatar_text.
    """
    if not url:
        return None
    return str(url)


def ingest_lead(
    db: Session,
    workspace_id: str,
    owner_id: Optional[str],
    payload: dict,
    source: str = "extension",
) -> tuple[Lead, bool]:
    """Upsert a lead from a scraped LinkedIn profile blob.

    Returns (lead, created_bool).

    Server-side guard: rejects payloads where the scraped `full_name` is
    actually a LinkedIn action-button label ("View LinkedIn profile",
    "Open profile", "Connect", "Save Lead", etc.). Even with up-to-date
    extension code there are layout variants where the per-card scraper
    can miss; this guard ensures the pipeline never accumulates rows
    named after buttons regardless of which extension version is
    installed.
    """
    # Reject action-label names BEFORE any DB work. This mirrors the
    # extension's _isActionLabel filter so the server is authoritative.
    _ACTION_LABEL_RE = re.compile(
        r"^(view\s+\S+\s+profile|view\s+profile|view\s+in\s+sales\s+navigator|"
        r"save\s+in\s+sales\s+navigator|save\s+lead|save|open|open\s+profile|"
        r"open\s+in\s+new\s+tab|connect|pending|message|follow|following|"
        r"invite|invited|withdraw|more|premium|"
        # Page-chrome / placeholder names that leaked in when the extension
        # scraped during a brief URL-corruption window (h1 = "LinkedIn"
        # because /overlay/contact-info/ doesn't render the profile h1) or
        # when LinkedIn shows a 3rd-degree placeholder card.
        r"linked\s*in|linked\s*in\s+member)$",
        re.IGNORECASE,
    )
    raw_full = (payload.get("full_name") or "").strip()
    raw_first = (payload.get("first_name") or "").strip()
    raw_last = (payload.get("last_name") or "").strip()
    if (
        (raw_full and _ACTION_LABEL_RE.match(raw_full))
        or (raw_first and _ACTION_LABEL_RE.match(raw_first))
    ):
        # Drop the polluted name fields but keep the rest of the payload.
        # If the LinkedIn URL is present, we can recover the name from the
        # URL slug below. If not, the upsert will simply create a nameless
        # row that the existing /cleanup/nameless endpoint can sweep.
        payload = dict(payload)
        payload["full_name"] = None
        payload["first_name"] = None
        payload["last_name"] = None

    linkedin = normalize_linkedin(payload.get("linkedin_url"))
    existing: Optional[Lead] = None
    if linkedin:
        existing = (
            db.query(Lead)
            .filter(Lead.workspace_id == workspace_id, Lead.linkedin_url == linkedin)
            .first()
        )

    company = upsert_company(
        db,
        workspace_id,
        # Cap company name to its String(200) column; same defensive idea as
        # the lead-side caps below — long bio-style strings would 500 the
        # request when the company is created.
        name=_cap(payload.get("company_name"), 200),
        domain=_cap(payload.get("company_domain"), 200),
        website=_cap(payload.get("company_url"), 500),
    )

    full_name = payload.get("full_name") or " ".join(
        filter(None, [payload.get("first_name"), payload.get("last_name")])
    ) or None

    # If name fields were stripped by the action-label guard above (or just
    # never sent), derive a best-effort name from the LinkedIn URL slug.
    # Drops alphanumeric user-id segments like "a742831ab" so the result is
    # "Faisal Alsagoubi", not "Faisal Alsagoubi A742831ab".
    if not full_name and linkedin and "/in/" in linkedin:
        try:
            slug_match = re.search(r"/in/([^/?#]+)", linkedin)
            if slug_match:
                slug = slug_match.group(1).rstrip("/")
                parts = [
                    p for p in slug.split("-")
                    if len(p) >= 2
                    and not p.isdigit()
                    and not (any(c.isalpha() for c in p) and any(c.isdigit() for c in p))
                ]
                derived = " ".join(p[:1].upper() + p[1:] for p in parts).strip()
                if derived:
                    full_name = derived
                    payload = dict(payload)
                    payload["full_name"] = derived
                    first, *rest = derived.split(" ", 1)
                    payload["first_name"] = first
                    payload["last_name"] = rest[0] if rest else None
        except Exception:
            pass

    # Reject UI-button text that historically leaked into the headline/title
    # fields when the extension's overlay chips were picked up by the page
    # scraper. Without this guard the pipeline shows rows like
    # "Waleed Khan / Save" because "Save" was stored as the headline.
    _UI_NOISE_RE = re.compile(
        r"^(save(\s+lead)?|saving…?|saved\s*✓?|save\s+in\s+sales\s+navigator|"
        r"add\s+to\s+pipeline|connect|message|follow|following|pending|more|premium)$",
        re.IGNORECASE,
    )

    def _is_ui_noise(v) -> bool:
        return bool(v) and bool(_UI_NOISE_RE.fullmatch(str(v).strip()))

    def _strip_ui_noise(v):
        return None if _is_ui_noise(v) else v

    # Resolve each scalar to its column-capped value once. Reused below in
    # both the update-existing-lead and insert-new-lead branches.
    capped = {
        "first_name": _cap(payload.get("first_name"), 120),
        "last_name": _cap(payload.get("last_name"), 120),
        "full_name": _cap(full_name, 240),
        # `title` from the extension is split off the headline by " at ";
        # when no " at " exists, the entire headline is used as the title,
        # which routinely exceeds 240 chars. Truncate defensively.
        "title": _cap(
            _strip_ui_noise(payload.get("title") or payload.get("headline")),
            240,
        ),
        "headline": _strip_ui_noise(payload.get("headline")),  # TEXT — no cap
        "email": _cap(payload.get("email"), 255),
        "phone": _cap(payload.get("phone"), 60),
        # LinkedIn avatar URLs append a signed JWT query that often pushes
        # them well past 500 chars. Strip the query and cap.
        "avatar_url": _clean_avatar_url(payload.get("avatar_url")),
        "location": _cap(payload.get("location"), 200),
    }

    now = datetime.now(timezone.utc)
    created = False
    if existing:
        lead = existing

        # Tokens from the LinkedIn URL slug — the ground-truth identifier
        # for the person this row represents. For /in/fouad-chehade-59407431
        # we get {"fouad", "chehade"} after filtering out numeric and
        # alphanumeric user-id fragments.
        slug_tokens: set[str] = set()
        if linkedin and "/in/" in linkedin:
            try:
                slug = linkedin.split("/in/", 1)[1].split("?", 1)[0].rstrip("/")
                slug = slug.split("/", 1)[0]
                for tok in slug.split("-"):
                    tok = tok.strip().lower()
                    if len(tok) < 3:
                        continue
                    if tok.isdigit():
                        continue
                    # Drop alphanumeric user-id fragments like "a742831ab"
                    if re.search(r"\d", tok) and re.search(r"[a-z]", tok):
                        continue
                    slug_tokens.add(tok)
            except (IndexError, AttributeError):
                pass

        def _name_tokens(name: str) -> set[str]:
            return {
                tok.lower()
                for tok in re.findall(r"[A-Za-z]+", name or "")
                if len(tok) >= 2
            }

        # full_name: overwrite when the existing value is clearly wrong —
        # either polluted by old scraper noise, OR a stale mis-attribution
        # from the historical mutual-connection bug (existing name shares
        # NO tokens with the URL slug, while the new scrape DOES). The slug
        # is the unique identifier we trust most; any name disagreeing with
        # it AND with a fresher in-agreement scrape is wrong.
        # Extension v1.0.20+ tags scrapes from /in/<handle>'s <h1> with
        # raw.name_authority="profile_page". That tag means: this name came
        # from the canonical, unambiguous source on the page, NOT a search-
        # card scrape that could have picked up a mutual-connection name
        # embedded in the same <li>. Honor it unconditionally so stale wrong-
        # name rows get auto-corrected on the next profile visit, even when
        # the slug-token heuristic can't tell (e.g. numeric vanity URLs).
        raw_payload = payload.get("raw") or {}
        canonical_name = raw_payload.get("name_authority") == "profile_page"

        if capped["full_name"]:
            old = lead.full_name or ""
            old_tokens = _name_tokens(old)
            new_tokens = _name_tokens(capped["full_name"])
            mismatched_attribution = bool(
                slug_tokens
                and old_tokens
                and not (old_tokens & slug_tokens)
                and (new_tokens & slug_tokens)
            )
            polluted = (
                not old
                or "·" in old
                or "•" in old
                or bool(re.search(r"\b[A-Z][0-9A-F]{6,}\b", old, re.IGNORECASE))
                or mismatched_attribution
                or (canonical_name and old.strip().lower() != capped["full_name"].strip().lower())
            )
            if polluted:
                lead.full_name = capped["full_name"]
                # Realign first/last/avatar when we correct a mis-attributed
                # name so the whole row reflects the right person, not a
                # half-rewritten Frankenstein with Joann's name and Fouad's
                # avatar (the exact bug surfaced by the user).
                if capped.get("first_name"):
                    lead.first_name = capped["first_name"]
                if capped.get("last_name"):
                    lead.last_name = capped["last_name"]
                overwrite_related = mismatched_attribution or canonical_name
                if overwrite_related and capped.get("avatar_url"):
                    lead.avatar_url = capped["avatar_url"]
                if overwrite_related and capped.get("headline"):
                    lead.headline = capped["headline"]
                if overwrite_related and capped.get("title"):
                    lead.title = capped["title"]

        # Merge other descriptive fields. For title/headline we ALSO overwrite
        # if the EXISTING value is UI-button noise ("Save", "Connect", …) —
        # leads captured by old buggy extension versions had headline="Save"
        # because the scraper picked up its own injected chip. Plain fill-only
        # would leave those rows polluted forever even after a clean re-sync.
        for attr in ("title", "headline"):
            val = capped.get(attr)
            old = getattr(lead, attr)
            if val and (not old or _is_ui_noise(old)):
                setattr(lead, attr, val)
        for attr in ("location", "avatar_url"):
            val = capped.get(attr)
            if val and not getattr(lead, attr):
                setattr(lead, attr, val)
        # Fill-only first/last for the case where full_name was already
        # correct and only the individual name parts were missing.
        for attr in ("first_name", "last_name"):
            val = capped.get(attr)
            if val and not getattr(lead, attr):
                setattr(lead, attr, val)
        # Contact info — OVERWRITE when the extension provides a non-null
        # value. The extension only sends what it actually scraped from the
        # live profile, so the latest scrape is the most accurate. Fixes
        # the case where a stray mailto: anchor from elsewhere on the page
        # was previously attributed to the wrong lead — opening Contact
        # info on that profile and re-saving now corrects the email/phone
        # instead of silently keeping the wrong value.
        if capped["email"]:
            lead.email = capped["email"]
        if capped.get("phone"):
            lead.phone = capped["phone"]
        if company and not lead.company_id:
            lead.company_id = company.id
        merged_custom = dict(lead.custom or {})
        merged_custom.update({k: v for k, v in (payload.get("raw") or {}).items() if v is not None})
        lead.custom = merged_custom
    else:
        stage = default_stage(db, workspace_id)
        lead = Lead(
            workspace_id=workspace_id,
            owner_id=owner_id,
            stage_id=stage.id if stage else None,
            company_id=company.id if company else None,
            first_name=capped["first_name"],
            last_name=capped["last_name"],
            full_name=capped["full_name"],
            title=capped["title"],
            headline=capped["headline"],
            email=capped["email"],
            phone=capped["phone"],
            linkedin_url=linkedin,
            location=capped["location"],
            avatar_url=capped["avatar_url"],
            source=_cap(source, 40),
            custom=payload.get("raw") or {},
        )
        db.add(lead)
        created = True
    db.flush()
    db.add(
        Activity(
            workspace_id=workspace_id,
            lead_id=lead.id,
            actor_id=owner_id,
            type="lead_captured" if created else "lead_updated",
            payload={"source": source, "linkedin_url": linkedin},
        )
    )
    lead.last_activity_at = now
    return lead, created
