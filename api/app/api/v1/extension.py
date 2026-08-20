"""API surface for the Chrome extension.

Auth uses X-API-Key. These endpoints are what the user's browser hits when they
hover/save a LinkedIn profile, scroll a search/Sales Nav page, or when the
extension polls for queued automated actions to execute in-page.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_extension_context
from app.models import ApiKey, ConnectedAccount, ExtensionJob, Lead, LinkedInMessage, Membership, Playbook, SavedView, User
from app.schemas import (
    ExtensionJobOut,
    ExtensionJobResult,
    ExtensionSyncProfile,
    ExtensionSyncSearch,
    LeadIngestResponse,
)
from app.schemas.lead import CompanyMini, LeadOut
from app.services.leads import ingest_lead
from app.services.outreach import enroll_lead

router = APIRouter(prefix="/extension", tags=["extension"])


def _bump_api_key(db: Session, ctx: AuthContext) -> None:
    db.query(ApiKey).filter(
        ApiKey.workspace_id == ctx.workspace_id, ApiKey.user_id == ctx.user_id
    ).update({ApiKey.last_used_at: datetime.now(timezone.utc)})
    if ctx.license_key is not None:
        ctx.license_key.last_used_at = datetime.now(timezone.utc)


def _mark_linkedin_connected(db: Session, ctx: AuthContext) -> None:
    """Extension authenticating proves LinkedIn is active in the user's browser."""
    existing = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.user_id == ctx.user_id,
            ConnectedAccount.provider == "linkedin",
        )
        .first()
    )
    if existing:
        existing.status = "active"
    else:
        db.add(
            ConnectedAccount(
                workspace_id=ctx.workspace_id,
                user_id=ctx.user_id,
                provider="linkedin",
                label="Chrome Extension",
                status="active",
            )
        )


def _serialize_lead(lead) -> LeadOut:
    out = LeadOut.model_validate(lead)
    if lead.company_id and getattr(lead, "company", None):
        out.company = CompanyMini.model_validate(lead.company)
    return out


@router.get("/me")
def extension_me(ctx: AuthContext = Depends(get_extension_context), db: Session = Depends(get_db)):
    _bump_api_key(db, ctx)
    _mark_linkedin_connected(db, ctx)
    db.commit()
    return {
        "user": {"id": ctx.user_id, "email": ctx.user.email},
        "workspace": {"id": ctx.workspace.id, "name": ctx.workspace.name, "slug": ctx.workspace.slug},
        "settings": (ctx.workspace.settings or {}).get("outreach", {}),
    }


@router.post("/sync/profile", response_model=LeadIngestResponse)
def sync_profile(
    body: ExtensionSyncProfile,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    lead, created = ingest_lead(db, ctx.workspace_id, ctx.user_id, body.model_dump())
    db.commit()
    db.refresh(lead)
    return LeadIngestResponse(lead=_serialize_lead(lead), created=created)


@router.post("/sync/search")
def sync_search(
    body: ExtensionSyncSearch,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    created_count = 0
    updated_count = 0
    skipped_count = 0
    ids: list[str] = []
    errors: list[dict] = []
    for profile in body.profiles:
        # Per-profile savepoint: one bad row (FK error, encoding glitch,
        # whatever) must not abort the whole batch. Without this, the user
        # sees "Failed: Internal Server Error" on Save All Leads even when
        # 99% of profiles are perfectly valid.
        try:
            with db.begin_nested():
                lead, created = ingest_lead(
                    db, ctx.workspace_id, ctx.user_id, profile.model_dump()
                )
                ids.append(lead.id)
                if created:
                    created_count += 1
                else:
                    updated_count += 1
        except Exception as e:
            skipped_count += 1
            errors.append({"linkedin_url": profile.linkedin_url, "error": str(e)[:200]})
    db.commit()
    return {
        "imported": len(ids),
        "created": created_count,
        "updated": updated_count,
        "skipped": skipped_count,
        "lead_ids": ids,
        "errors": errors[:20],  # cap response size
    }


@router.get("/jobs/next", response_model=list[ExtensionJobOut])
def claim_jobs(
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
    limit: int = 1,
):
    """Hands the extension the next queued action (connect/message/visit) to execute
    in the user's own browser at a human pace."""
    _bump_api_key(db, ctx)
    now = datetime.now(timezone.utc)
    # Reclaim jobs stuck in "claimed" for >10 min. A job lands here when the
    # extension claimed it but never reported a result — the tab was closed, the
    # page navigated away mid-send, or the browser crashed. Without this they'd
    # be lost forever (claim_jobs only serves status="queued"), which is the main
    # reason bulk messages appeared to "queue but never send".
    stale_before = now - timedelta(minutes=10)
    db.query(ExtensionJob).filter(
        ExtensionJob.workspace_id == ctx.workspace_id,
        ExtensionJob.user_id == ctx.user_id,
        ExtensionJob.status == "claimed",
        ExtensionJob.claimed_at.isnot(None),
        ExtensionJob.claimed_at < stale_before,
    ).update({ExtensionJob.status: "queued"}, synchronize_session=False)

    rows = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.user_id == ctx.user_id,
            ExtensionJob.status == "queued",
        )
        .filter((ExtensionJob.not_before.is_(None)) | (ExtensionJob.not_before <= now))
        .order_by(ExtensionJob.created_at.asc())
        .limit(max(1, min(limit, 5)))
        .all()
    )
    for r in rows:
        r.status = "claimed"
        r.claimed_at = now
    db.commit()
    return [ExtensionJobOut.model_validate(r) for r in rows]


@router.post("/jobs/{job_id}/result")
def submit_result(
    job_id: str,
    body: ExtensionJobResult,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    job = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.id == job_id,
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.user_id == ctx.user_id,
        )
        .first()
    )
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    job.status = body.status if body.status in {"done", "failed", "skipped"} else "done"
    job.completed_at = datetime.now(timezone.utc)
    job.result = body.result or {}
    job.error = body.error

    # Reflect into LinkedInMessage where applicable
    if job.kind in {"connect", "message"} and job.lead_id and body.status == "done":
        rec = LinkedInMessage(
            workspace_id=ctx.workspace_id,
            lead_id=job.lead_id,
            kind=job.kind,
            direction="outbound",
            body=(job.payload or {}).get("body"),
            status="sent",
            sent_at=datetime.now(timezone.utc),
        )
        db.add(rec)

    # search_scrape jobs return a profiles[] array — ingest them and bump
    # the SearchScraper counters / auto-enroll into the linked playbook.
    if (
        job.kind == "scrape_search"
        and body.status == "done"
        and (body.result or {}).get("profiles")
    ):
        from app.models import SearchScraper, Playbook
        from app.services.leads import ingest_lead
        from app.services.outreach import enroll_lead

        scraper_id = (job.payload or {}).get("scraper_id")
        scraper = (
            db.query(SearchScraper).filter(SearchScraper.id == scraper_id).first()
            if scraper_id else None
        )
        playbook = (
            db.query(Playbook).filter(Playbook.id == scraper.playbook_id).first()
            if scraper and scraper.playbook_id else None
        )
        saved = 0
        for profile in (body.result or {}).get("profiles") or []:
            try:
                lead, created = ingest_lead(
                    db, ctx.workspace_id, ctx.user_id, profile
                )
                if created and playbook:
                    enroll_lead(db, playbook, lead)
                saved += 1
            except Exception:
                continue
        if scraper:
            from app.api.v1.search_scrapers import reset_daily_counters_if_new_day

            reset_daily_counters_if_new_day(scraper)
            scraper.saved_today += saved
            scraper.saved_total += saved
            scraper.last_run_at = datetime.now(timezone.utc)
            if scraper.saved_total >= scraper.total_save_cap:
                scraper.status = "completed"
    db.commit()
    return {"ok": True}


# Default segments every workspace gets — the lead "lists" the extension tags
# saved leads into. Stored as shared SavedViews whose filters carry a "segment"
# key, which both distinguishes them from pipeline saved-views and lets the
# Pipeline/Prospecting list filter by lead.custom["segment"].
_DEFAULT_SEGMENTS = [
    {"name": "LinkedIn Leads", "icon": "linkedin"},
    {"name": "Website Leads", "icon": "globe"},
]


def _segment_query(db: Session, workspace_id: str):
    """Shared SavedViews that are segments (their filters carry a 'segment' key)."""
    return (
        db.query(SavedView)
        .filter(
            SavedView.workspace_id == workspace_id,
            SavedView.is_shared.is_(True),
            SavedView.filters.has_key("segment"),  # noqa: W601 — JSONB has_key
        )
        .order_by(SavedView.position.asc())
    )


def _ensure_default_segments(db: Session, workspace_id: str) -> None:
    """Idempotently create the default segments for a workspace if absent.

    Runs on /options so both freshly-bootstrapped and pre-existing workspaces
    surface "LinkedIn Leads" / "Website Leads" in the extension dropdown.
    """
    existing = {s.name for s in _segment_query(db, workspace_id).all()}
    missing = [s for s in _DEFAULT_SEGMENTS if s["name"] not in existing]
    if not missing:
        return
    base_pos = db.query(SavedView).filter(SavedView.workspace_id == workspace_id).count()
    for i, seg in enumerate(missing):
        db.add(
            SavedView(
                workspace_id=workspace_id,
                name=seg["name"],
                icon=seg["icon"],
                filters={"segment": seg["name"]},
                columns=["full_name", "title", "company", "email", "stage", "owner"],
                sort={"field": "created_at", "dir": "desc"},
                position=base_pos + i,
                is_shared=True,
            )
        )
    db.commit()


@router.get("/options")
def options(ctx: AuthContext = Depends(get_extension_context), db: Session = Depends(get_db)):
    """Populate the bottom-toolbar dropdowns: Segment / Playbook / User."""
    playbooks = (
        db.query(Playbook)
        .filter(Playbook.workspace_id == ctx.workspace_id, Playbook.is_active.is_(True))
        .order_by(Playbook.created_at.desc())
        .all()
    )
    _ensure_default_segments(db, ctx.workspace_id)
    segments = _segment_query(db, ctx.workspace_id).all()
    members = (
        db.query(Membership, User)
        .join(User, User.id == Membership.user_id)
        .filter(Membership.workspace_id == ctx.workspace_id)
        .all()
    )
    return {
        "user": {"id": ctx.user_id, "email": ctx.user.email, "name": (ctx.user.first_name or ctx.user.email.split("@")[0])},
        "workspace": {"id": ctx.workspace.id, "name": ctx.workspace.name, "slug": ctx.workspace.slug},
        "playbooks": [{"id": p.id, "name": p.name, "steps_count": len(p.steps)} for p in playbooks],
        "segments": [{"id": s.id, "name": s.name, "icon": s.icon} for s in segments],
        "users": [
            {
                "id": u.id,
                "name": (u.first_name or u.email.split("@")[0]),
                "email": u.email,
                "role": m.role,
            }
            for (m, u) in members
        ],
    }


@router.post("/segments")
def create_segment(
    body: dict,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Create a new segment (lead list) from the extension's '+ New Segment'.

    A segment is a shared SavedView whose filters carry a 'segment' key, so the
    Pipeline list can group by lead.custom['segment'] == name. Idempotent on
    name: re-creating an existing segment returns the existing one.
    """
    name = (body.get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_required")
    existing = (
        _segment_query(db, ctx.workspace_id).filter(SavedView.name == name).first()
    )
    if existing:
        return {"id": existing.id, "name": existing.name, "icon": existing.icon}
    pos = db.query(SavedView).filter(SavedView.workspace_id == ctx.workspace_id).count()
    view = SavedView(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        name=name,
        icon="tag",
        filters={"segment": name},
        columns=["full_name", "title", "company", "email", "stage", "owner"],
        sort={"field": "created_at", "dir": "desc"},
        position=pos,
        is_shared=True,
    )
    db.add(view)
    db.commit()
    db.refresh(view)
    return {"id": view.id, "name": view.name, "icon": view.icon}


@router.post("/enroll")
def enroll_batch(
    body: dict,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Bulk-enroll a list of saved leads into a playbook. Called by the
    extension immediately after Save All Leads when the user has selected a
    Playbook in the bottom toolbar."""
    playbook_id = body.get("playbook_id")
    lead_ids: list[str] = body.get("lead_ids") or []
    if not playbook_id or not lead_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "playbook_id_and_lead_ids_required")
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "playbook_not_found")
    enrolled = []
    for lid in lead_ids:
        lead = db.query(Lead).filter(Lead.id == lid, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            continue
        e = enroll_lead(db, pb, lead)
        enrolled.append(e.id)
    db.commit()
    return {"enrolled": enrolled, "count": len(enrolled)}


# ── Case #2 bulk-message 24h sent-history (durable, workspace-scoped) ──────
#
# The extension keeps a local 24h sent-history (chrome.storage + linkedin.com
# localStorage) so it can skip already-messaged profiles on re-runs. That
# local mirror survives extension version-swaps but is wiped if the user:
#   • removes the extension AND clears linkedin.com site data,
#   • switches browsers / machines,
#   • signs into a different Chrome profile.
# Mirroring it to the backend gives a single workspace-scoped source of truth
# the extension can re-hydrate from on a cold install. Stored as a list of
# {url, ts_ms} in `Workspace.settings["case2_sent_log"]`; capped at 5 000
# entries and pruned to the last 7 days on every write so the JSONB blob
# stays small (typical worst case ~100 KB).

_CASE2_LOG_KEY = "case2_sent_log"
_CASE2_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000   # keep a week on the server
_CASE2_LOG_CAP = 5000                          # hard ceiling on entries


def _normalize_in_path(url: str) -> Optional[str]:
    """Reduce any LinkedIn profile URL to `/in/<handle>` (lowercased)."""
    if not url:
        return None
    import re
    m = re.search(r"/in/([^/?#]+)", str(url))
    return ("/in/" + m.group(1)).lower() if m else None


def _prune_case2_log(entries: list, now_ms: int) -> list:
    """Drop entries older than the TTL; cap to the most-recent N. Pure."""
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        ts = e.get("ts")
        url = e.get("url")
        if not isinstance(ts, (int, float)) or not isinstance(url, str):
            continue
        if (now_ms - int(ts)) >= _CASE2_LOG_TTL_MS:
            continue
        out.append({"url": url, "ts": int(ts)})
    # newest first, then cap
    out.sort(key=lambda e: e["ts"], reverse=True)
    return out[:_CASE2_LOG_CAP]


@router.post("/case2-message-sent")
def case2_message_sent(
    body: dict,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Record that the user just messaged this LinkedIn profile via bulk
    Message All. The extension fire-and-forgets this on every successful
    pre-mark, so a fresh install on any device can re-hydrate the local
    24h dedupe by calling GET /case2-message-sent.

    Body: { "linkedin_url": "<any /in/... URL>", "ts": <optional ms> }
    Returns: { ok, count } — the new total count after dedupe + prune.
    """
    raw_url = (body or {}).get("linkedin_url") or (body or {}).get("url") or ""
    norm = _normalize_in_path(raw_url)
    if not norm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "linkedin_url required")
    ts_in = (body or {}).get("ts")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    ts = int(ts_in) if isinstance(ts_in, (int, float)) else now_ms

    ws = ctx.workspace
    settings = dict(ws.settings or {})
    existing = settings.get(_CASE2_LOG_KEY) or []
    # Dedupe by URL; keep the newest timestamp.
    by_url = {}
    for e in existing:
        if isinstance(e, dict) and isinstance(e.get("url"), str):
            prev = by_url.get(e["url"])
            if not prev or (isinstance(e.get("ts"), (int, float)) and int(e["ts"]) > prev):
                by_url[e["url"]] = int(e.get("ts") or 0)
    # Insert / upgrade this URL's timestamp.
    if ts > by_url.get(norm, 0):
        by_url[norm] = ts
    merged = [{"url": u, "ts": t} for u, t in by_url.items()]
    pruned = _prune_case2_log(merged, now_ms)
    settings[_CASE2_LOG_KEY] = pruned
    ws.settings = settings
    # SQLAlchemy with JSONB needs an explicit attribute reassignment to mark
    # the column dirty when the dict is mutated in place.
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(ws, "settings")
    db.commit()
    return {"ok": True, "count": len(pruned), "url": norm}


@router.get("/case2-message-sent")
def case2_message_sent_list(
    since_ms: Optional[int] = None,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Return the workspace's bulk-message sent-history within a window.

    Default window is the last 24h (matches the extension's local TTL).
    Pass `since_ms` to override (e.g. since_ms=604800000 for 7 days).
    Response: { ok, ttl_ms, entries: [{url, ts}], urls: ["/in/..."] }
    where `urls` is a flat list ready to feed the extension's Set-based
    dedupe gate.
    """
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    window_ms = int(since_ms) if isinstance(since_ms, int) and since_ms > 0 else 24 * 60 * 60 * 1000
    existing = (ctx.workspace.settings or {}).get(_CASE2_LOG_KEY) or []
    entries = [
        e for e in existing
        if isinstance(e, dict)
        and isinstance(e.get("ts"), (int, float))
        and (now_ms - int(e["ts"])) < window_ms
        and isinstance(e.get("url"), str)
    ]
    entries.sort(key=lambda e: e["ts"], reverse=True)
    return {
        "ok": True,
        "ttl_ms": window_ms,
        "entries": [{"url": e["url"], "ts": int(e["ts"])} for e in entries],
        "urls": [e["url"] for e in entries],
    }


@router.get("/known-urls")
def known_linkedin_urls(
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Return every LinkedIn profile URL the workspace already has as a lead,
    normalized to `/in/<handle>` and lowercased — the exact key shape the
    extension's local dedupe gate uses. Lets bulk Save All Leads skip
    profiles already in the CRM upfront (no tab opened, no scrape wasted,
    no extra "view" recorded against the user's LinkedIn account).

    Covers EVERY source the local cache can't see: CSV imports, web app
    saves, teammate saves in the same workspace, leads created before the
    extension started tracking, anything saved from another browser /
    device / Chrome profile.

    Cap at 50 000 entries (more than any LinkedIn search can surface in one
    session); newest-first so we keep the freshest if we ever truncate.
    Pure read — never writes. The `Lead.linkedin_url` column has an index,
    so this is a single fast scan even at large workspace sizes.
    """
    import re
    rows = (
        db.query(Lead.linkedin_url)
        .filter(
            Lead.workspace_id == ctx.workspace_id,
            Lead.linkedin_url.isnot(None),
        )
        .order_by(Lead.created_at.desc())
        .limit(50_000)
        .all()
    )
    seen = set()
    urls = []
    for (raw,) in rows:
        if not raw:
            continue
        m = re.search(r"/in/([^/?#]+)", raw)
        if not m:
            continue
        norm = ("/in/" + m.group(1)).lower()
        if norm in seen:
            continue
        seen.add(norm)
        urls.append(norm)
    return {"ok": True, "count": len(urls), "urls": urls}


@router.get("/health")
def health():
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}
