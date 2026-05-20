from __future__ import annotations

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
    """
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
            payload.get("title") or payload.get("headline"), 240
        ),
        "headline": payload.get("headline"),  # TEXT column — no cap
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
        # Merge non-empty fields
        for attr in (
            "first_name",
            "last_name",
            "title",
            "headline",
            "location",
            "avatar_url",
            "phone",
        ):
            val = capped.get(attr)
            if val and not getattr(lead, attr):
                setattr(lead, attr, val)
        if capped["full_name"] and not lead.full_name:
            lead.full_name = capped["full_name"]
        if capped["email"] and not lead.email:
            lead.email = capped["email"]
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
