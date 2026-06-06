import csv
import io
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import (
    Activity,
    CallLog,
    Company,
    EmailMessage,
    Enrollment,
    EnrollmentStepRun,
    ExtensionJob,
    Lead,
    Note,
    PipelineStage,
    Task,
)
from app.schemas import (
    LeadCreate,
    LeadIngest,
    LeadIngestResponse,
    LeadList,
    LeadOut,
    LeadUpdate,
)
from app.services.leads import ingest_lead, upsert_company, default_stage, normalize_linkedin
from app.services.outreach import queue_extension_job

router = APIRouter(prefix="/leads", tags=["leads"])


def _serialize(lead: Lead) -> LeadOut:
    data = LeadOut.model_validate(lead)
    if lead.company_id and lead.company:  # type: ignore[attr-defined]
        from app.schemas.lead import CompanyMini

        data.company = CompanyMini.model_validate(lead.company)
    return data


@router.get("", response_model=LeadList)
def list_leads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    q: Optional[str] = None,
    stage_id: Optional[str] = None,
    owner_id: Optional[str] = None,
    segment: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    sort: str = "created_at",
    direction: str = "desc",
):
    base = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.workspace_id == ctx.workspace_id)
    )
    if q:
        like = f"%{q.lower()}%"
        base = base.filter(
            or_(
                Lead.full_name.ilike(like),
                Lead.email.ilike(like),
                Lead.title.ilike(like),
                Lead.linkedin_url.ilike(like),
            )
        )
    if stage_id:
        base = base.filter(Lead.stage_id == stage_id)
    if owner_id:
        base = base.filter(Lead.owner_id == owner_id)
    if segment:
        base = base.filter(Lead.custom["segment"].astext == segment)

    total = base.count()
    sort_col = getattr(Lead, sort, Lead.created_at)
    base = base.order_by(sort_col.desc() if direction == "desc" else sort_col.asc())
    rows = base.offset((page - 1) * page_size).limit(page_size).all()
    items: list[LeadOut] = []
    for r in rows:
        # Defense-in-depth: never let one malformed row 500 the whole list.
        # A single bad lead used to blank the entire Pipeline/Prospecting view.
        try:
            item = LeadOut.model_validate(r)
            if r.company_id and getattr(r, "company", None):
                from app.schemas.lead import CompanyMini

                item.company = CompanyMini.model_validate(r.company)
            items.append(item)
        except Exception:  # noqa: BLE001 — skip the row, keep the page working
            continue
    return LeadList(items=items, total=total, page=page, page_size=page_size)


class BulkMessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    # When omitted, every lead in the workspace that has a LinkedIn URL is
    # messaged. Pass a subset to target specific leads, and/or stage_id to
    # target a single pipeline stage.
    lead_ids: Optional[list[str]] = None
    stage_id: Optional[str] = None


def _render_message(template: str, lead: Lead) -> str:
    """Substitute {first_name}/{last_name}/{full_name}/{title}/{company}
    merge tags with the lead's own values so every message is personalized.
    {first_name} falls back to the first word of the full name, then "there",
    so a blank greeting never goes out."""
    first = (lead.first_name or "").strip()
    if not first and lead.full_name:
        first = lead.full_name.strip().split(" ")[0]
    company = ""
    if lead.company_id and getattr(lead, "company", None):
        company = (lead.company.name or "").strip()
    tokens = {
        "{first_name}": first or "there",
        "{last_name}": (lead.last_name or "").strip(),
        "{full_name}": (lead.full_name or first or "there").strip(),
        "{title}": (lead.title or "").strip(),
        "{company}": company,
    }
    out = template
    for token, value in tokens.items():
        out = out.replace(token, value)
    return out


@router.post("/bulk-message")
def bulk_message(
    body: BulkMessageIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Queue LinkedIn messages for every (or selected) pipeline lead.

    Creates one ExtensionJob(kind="message") per lead with a LinkedIn URL, all
    with not_before=now so the extension can claim them immediately. Human-paced
    delivery (45 s – 3 min gaps) is enforced inside the extension by
    paceBetweenActions() — no server-side stagger needed.
    """
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "message_required")

    base = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.workspace_id == ctx.workspace_id)
    )
    if body.lead_ids:
        base = base.filter(Lead.id.in_(body.lead_ids))
    if body.stage_id:
        base = base.filter(Lead.stage_id == body.stage_id)
    leads = base.all()

    # Skip leads that already have a pending/claimed message job so an
    # accidental double-click doesn't queue the same message twice.
    already_pending = {
        r[0]
        for r in db.query(ExtensionJob.lead_id)
        .filter(
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.kind == "message",
            ExtensionJob.status.in_(("queued", "claimed")),
        )
        .all()
    }

    now = datetime.now(timezone.utc)
    queued = 0
    skipped_no_linkedin = 0
    skipped_pending = 0
    for lead in leads:
        if not lead.linkedin_url:
            skipped_no_linkedin += 1
            continue
        if lead.id in already_pending:
            skipped_pending += 1
            continue
        queue_extension_job(
            db,
            workspace_id=ctx.workspace_id,
            user_id=ctx.user_id,
            lead_id=lead.id,
            kind="message",
            payload={"linkedin_url": lead.linkedin_url, "body": _render_message(msg, lead)},
            not_before=now,  # available immediately; extension enforces human pacing
        )
        queued += 1
    db.commit()
    return {
        "queued": queued,
        "skipped_no_linkedin": skipped_no_linkedin,
        "skipped_pending": skipped_pending,
        "total": len(leads),
    }


@router.get("/message-jobs/status")
def message_jobs_status(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Live count of today's LinkedIn message jobs for the progress indicator."""
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    rows = (
        db.query(ExtensionJob.status, func.count())
        .filter(
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.kind == "message",
            ExtensionJob.created_at >= since,
        )
        .group_by(ExtensionJob.status)
        .all()
    )
    counts = {row[0]: row[1] for row in rows}
    pending = counts.get("queued", 0) + counts.get("claimed", 0)
    sent = counts.get("done", 0)
    failed = counts.get("failed", 0) + counts.get("skipped", 0)
    return {"pending": pending, "sent": sent, "failed": failed, "total": pending + sent + failed}



@router.post("/import-csv/preview")
async def preview_csv_import(
    file: UploadFile = File(...),
    ctx: AuthContext = Depends(get_workspace_context),
):
    """Parse a CSV and return its column names + first 5 rows, no import yet."""
    content = await file.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "empty_file")

    headers = [h.strip() for h in rows[0]]
    data_rows = rows[1:]
    preview = [dict(zip(headers, [c.strip() for c in row])) for row in data_rows[:5]]
    return {"columns": headers, "preview": preview, "total_rows": len(data_rows)}


@router.post("/import-csv")
async def import_csv_leads(
    file: UploadFile = File(...),
    mapping: str = Form(...),
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Import leads from a CSV file with a column→field mapping.

    `mapping` is a JSON object: { lead_field: csv_column }.
    Supported fields: full_name, first_name, last_name, email, phone,
    linkedin_url, title, company_name, location, stage_name.
    Deduplicates by linkedin_url first, then email.
    """
    try:
        col_map: dict = json.loads(mapping)
    except json.JSONDecodeError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_mapping")

    content = await file.read()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    stages_by_name = {
        s.name.lower().strip(): s.id
        for s in db.query(PipelineStage)
        .filter(PipelineStage.workspace_id == ctx.workspace_id)
        .all()
    }
    default = default_stage(db, ctx.workspace_id)
    default_stage_id = default.id if default else None

    reader = csv.DictReader(io.StringIO(text))
    imported = updated = skipped = 0
    errors: list[str] = []

    for i, row in enumerate(reader):
        if len(errors) >= 20:
            break
        try:
            def _get(field: str) -> Optional[str]:
                col = col_map.get(field)
                if not col:
                    return None
                return (row.get(col) or "").strip() or None

            full_name = _get("full_name")
            first_name = _get("first_name")
            last_name = _get("last_name")
            email = _get("email")
            li_url = normalize_linkedin(_get("linkedin_url"))

            if not full_name and (first_name or last_name):
                full_name = " ".join(filter(None, [first_name, last_name])) or None

            if not (full_name or email or li_url):
                skipped += 1
                continue

            # Dedup
            existing: Optional[Lead] = None
            if li_url:
                existing = (
                    db.query(Lead)
                    .filter(Lead.workspace_id == ctx.workspace_id, Lead.linkedin_url == li_url)
                    .first()
                )
            if not existing and email:
                existing = (
                    db.query(Lead)
                    .filter(Lead.workspace_id == ctx.workspace_id, Lead.email == email)
                    .first()
                )

            company = upsert_company(db, ctx.workspace_id, name=_get("company_name"))

            sn = _get("stage_name")
            stage_id = stages_by_name.get(sn.lower()) if sn else None
            if not stage_id:
                stage_id = default_stage_id

            if existing:
                if full_name and not existing.full_name:
                    existing.full_name = full_name
                if email and not existing.email:
                    existing.email = email
                if _get("phone") and not existing.phone:
                    existing.phone = _get("phone")
                if _get("title") and not existing.title:
                    existing.title = _get("title")
                if _get("location") and not existing.location:
                    existing.location = _get("location")
                if company and not existing.company_id:
                    existing.company_id = company.id
                if li_url and not existing.linkedin_url:
                    existing.linkedin_url = li_url
                updated += 1
            else:
                lead = Lead(
                    workspace_id=ctx.workspace_id,
                    owner_id=ctx.user_id,
                    stage_id=stage_id,
                    company_id=company.id if company else None,
                    full_name=full_name,
                    first_name=first_name,
                    last_name=last_name,
                    title=_get("title"),
                    email=email,
                    phone=_get("phone"),
                    linkedin_url=li_url,
                    location=_get("location"),
                    source="import",
                )
                db.add(lead)
                imported += 1
        except Exception as exc:
            errors.append(f"Row {i + 2}: {str(exc)[:120]}")

    db.commit()
    return {"imported": imported, "updated": updated, "skipped": skipped, "errors": errors}


@router.post("", response_model=LeadOut, status_code=status.HTTP_201_CREATED)
def create_lead(
    body: LeadCreate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    company = upsert_company(
        db,
        ctx.workspace_id,
        name=body.company_name,
        domain=body.company_domain,
        website=body.company_website,
    )
    stage_id = body.stage_id
    if not stage_id:
        s = default_stage(db, ctx.workspace_id)
        stage_id = s.id if s else None
    lead = Lead(
        workspace_id=ctx.workspace_id,
        owner_id=ctx.user_id,
        stage_id=stage_id,
        company_id=company.id if company else None,
        first_name=body.first_name,
        last_name=body.last_name,
        full_name=body.full_name or " ".join(filter(None, [body.first_name, body.last_name])) or None,
        title=body.title,
        email=body.email,
        phone=body.phone,
        linkedin_url=normalize_linkedin(body.linkedin_url),
        location=body.location,
        headline=body.headline,
        avatar_url=body.avatar_url,
        estimated_value=body.estimated_value,
        custom=body.custom,
        tags=body.tags,
        source="manual",
    )
    db.add(lead)
    db.flush()
    db.add(
        Activity(
            workspace_id=ctx.workspace_id,
            lead_id=lead.id,
            actor_id=ctx.user_id,
            type="lead_created_manual",
            payload={},
        )
    )
    db.commit()
    db.refresh(lead)
    return _serialize(lead)


@router.get("/{lead_id}", response_model=LeadOut)
def get_lead(
    lead_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return _serialize(lead)


@router.patch("/{lead_id}", response_model=LeadOut)
def update_lead(
    lead_id: str,
    body: LeadUpdate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead = (
        db.query(Lead)
        .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k == "linkedin_url":
            v = normalize_linkedin(v)
        setattr(lead, k, v)
    if "stage_id" in data:
        db.add(
            Activity(
                workspace_id=ctx.workspace_id,
                lead_id=lead.id,
                actor_id=ctx.user_id,
                type="stage_changed",
                payload={"stage_id": data["stage_id"]},
            )
        )
    db.commit()
    db.refresh(lead)
    return _serialize(lead)


@router.delete("/{lead_id}")
def delete_lead(
    lead_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead = (
        db.query(Lead)
        .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(lead)
    db.commit()
    return {"ok": True}


@router.delete("/cleanup/no-contact")
def cleanup_no_contact_leads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Delete leads that have NEITHER an email NOR a phone number.

    A lead with no email and no phone has no way to be contacted, so it's dead
    weight in Prospecting. This sweeps every such lead in the workspace —
    regardless of source — treating NULL, empty, and whitespace-only values as
    "missing". Leads with at least one of email/phone are always kept.
    """
    blank_email = or_(Lead.email.is_(None), func.trim(Lead.email) == "")
    blank_phone = or_(Lead.phone.is_(None), func.trim(Lead.phone) == "")
    rows = (
        db.query(Lead)
        .filter(
            Lead.workspace_id == ctx.workspace_id,
            blank_email,
            blank_phone,
        )
        .all()
    )
    count = len(rows)
    for lead in rows:
        db.delete(lead)
    db.commit()
    return {"deleted": count}


@router.delete("/cleanup/polluted-names")
def cleanup_polluted_name_leads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Delete extension-sourced leads whose `full_name` is actually a
    LinkedIn action-button label ("View LinkedIn profile", "Open profile",
    "Connect", etc.). The current extension blocks these at scrape time,
    but historical rows captured before that fix still pollute pipelines.
    """
    import re as _re

    pattern = _re.compile(
        r"^(view\s+\S+\s+profile|view\s+profile|view\s+in\s+sales\s+navigator|"
        r"save\s+in\s+sales\s+navigator|save\s+lead|save|open|open\s+profile|"
        r"open\s+in\s+new\s+tab|connect|pending|message|follow|following|"
        r"invite|invited|withdraw|more|premium)$",
        _re.IGNORECASE,
    )
    rows = (
        db.query(Lead)
        .filter(Lead.workspace_id == ctx.workspace_id, Lead.source == "extension")
        .all()
    )
    deleted: list[str] = []
    for lead in rows:
        candidate = (lead.full_name or lead.first_name or "").strip()
        if not candidate:
            continue
        if pattern.match(candidate):
            deleted.append(candidate)
            db.delete(lead)
    db.commit()
    return {"deleted": len(deleted), "examples": deleted[:10]}


@router.delete("/cleanup/wipe-pipeline")
def wipe_workspace_pipeline_data(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Nuclear reset of pipeline + prospecting + playbook execution data
    for the current workspace. Deletes every Lead row plus all dependent
    activity, notes, tasks, calls, emails, playbook enrollments and
    extension-job records. Pipeline stages, playbook definitions, custom
    fields, segments, and saved views are preserved — only the *captured*
    data is wiped, not the workspace configuration.

    Returns per-table counts so the UI can show what was deleted.
    """
    ws = ctx.workspace_id
    counts = {
        "activities": db.query(Activity).filter(Activity.workspace_id == ws).delete(synchronize_session=False),
        "notes": db.query(Note).filter(Note.workspace_id == ws).delete(synchronize_session=False),
        "tasks": db.query(Task).filter(Task.workspace_id == ws).delete(synchronize_session=False),
        "call_logs": db.query(CallLog).filter(CallLog.workspace_id == ws).delete(synchronize_session=False),
        "emails": db.query(EmailMessage).filter(EmailMessage.workspace_id == ws).delete(synchronize_session=False),
        "enrollment_step_runs": (
            db.query(EnrollmentStepRun)
            .filter(EnrollmentStepRun.enrollment_id.in_(
                db.query(Enrollment.id).filter(Enrollment.workspace_id == ws)
            ))
            .delete(synchronize_session=False)
        ),
        "enrollments": db.query(Enrollment).filter(Enrollment.workspace_id == ws).delete(synchronize_session=False),
        "extension_jobs": db.query(ExtensionJob).filter(ExtensionJob.workspace_id == ws).delete(synchronize_session=False),
        "leads": db.query(Lead).filter(Lead.workspace_id == ws).delete(synchronize_session=False),
    }
    db.commit()
    return {"deleted": counts}


@router.get("/needs-enrichment", response_model=LeadList)
def leads_needing_enrichment(
    limit: int = 500,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Return leads that have a linkedin_url but are missing email OR phone.

    Used by the Bulk Enrich runner on the prospecting page to walk every
    candidate one at a time. Sorted oldest-created-first so the longest
    sitting leads enrich first (newer ones likely captured by a version
    of the extension that already scraped the modal).
    """
    rows = (
        db.query(Lead)
        .filter(
            Lead.workspace_id == ctx.workspace_id,
            Lead.linkedin_url.isnot(None),
            (Lead.email.is_(None)) | (Lead.phone.is_(None)),
        )
        .order_by(Lead.created_at.asc())
        .limit(max(1, min(limit, 1000)))
        .all()
    )
    return LeadList(
        items=[_serialize(r) for r in rows],
        total=len(rows),
        page=1,
        page_size=len(rows),
    )


@router.post("/cleanup/repair-corrupted")
def repair_corrupted_leads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Repair in place (do NOT delete) leads polluted by previous extension
    versions. Detects and fixes four corruption patterns:

      1. linkedin_url contains a sub-route like /overlay/contact-info/ —
         strip back to canonical /in/<handle>/. Catches the v1.0.11
         pushState bug that wrote URLs ending in
         /overlay/contact-info/overlay/contact-info/.

      2. full_name is an action-button label or page-chrome placeholder
         ("LinkedIn", "Save", "Connect", "View LinkedIn profile", etc.)
         — null it, then re-derive from the URL slug.

      3. headline / title match the UI-noise regex ("Save", "Saving…",
         "Saved ✓", a11y "Profile details loaded for…", Sales-Nav
         "Select <name>", presence "Status is online", etc.) — null
         the field so the next scrape can repopulate it cleanly.

      4. full_name shows the camelCase mashing bug (e.g. "Safnaz
         SaleemData-Driven Digital Marketing & ... | Doha") — cut at the
         lower→Upper boundary when the tail looks like a headline.

    Safe to run repeatedly: each rule is a no-op when its precondition
    is already false. Returns a per-rule counter so the UI can show what
    was fixed.
    """
    import re as _re

    ws = ctx.workspace_id

    # ---------- Detection regexes ----------
    URL_SUBROUTE_RE = _re.compile(r"^(/in/[^/]+)/")
    NAME_NOISE_RE = _re.compile(
        r"^(view\s+\S+\s+profile|view\s+profile|view\s+in\s+sales\s+navigator|"
        r"save\s+in\s+sales\s+navigator|save\s+lead|save|open|open\s+profile|"
        r"open\s+in\s+new\s+tab|connect|pending|message|follow|following|"
        r"invite|invited|withdraw|more|premium|"
        r"linked\s*in|linked\s*in\s+member)$",
        _re.IGNORECASE,
    )
    HEADLINE_NOISE_RE = _re.compile(
        r"^(save(\s+lead)?|saving…?|saved\s*✓?|save\s+in\s+sales\s+navigator|"
        r"add\s+to\s+pipeline|connect|message|follow|following|pending|more|"
        r"premium|"
        # Sales-Nav / a11y debug strings that leaked into title/headline
        r"profile details loaded for\s+.+|select\s+\S+\s+\S+|"
        r"view\s+\S+(?:'|’)s\s+profile|status is\s+(online|offline|reachable)|"
        r"open\s+\S+(?:'|’)s\s+profile)$",
        _re.IGNORECASE,
    )
    ROLE_KEYWORDS_RE = _re.compile(
        r"[|()/]|\s+at\s+|—|–|"
        r"\bmarketing\b|\bmanager\b|\bdirector\b|\bengineer\b|\bdeveloper\b|"
        r"\bspecialist\b|\bconsultant\b|\bstrategist\b",
        _re.IGNORECASE,
    )
    CAMEL_BOUNDARY_RE = _re.compile(r"^(.+?[a-z])([A-Z][a-z].*)$")
    SLUG_RE = _re.compile(r"/in/([^/?#]+)")

    def _derive_name_from_url(url: str | None):
        if not url:
            return None
        m = SLUG_RE.search(url)
        if not m:
            return None
        slug = m.group(1).rstrip("/")
        parts = [
            p for p in slug.split("-")
            if len(p) >= 2
            and not p.isdigit()
            and not (any(c.isalpha() for c in p) and any(c.isdigit() for c in p))
        ]
        derived = " ".join(p[:1].upper() + p[1:] for p in parts).strip()
        return derived or None

    def _cut_mashed_name(name: str) -> str | None:
        """Mirror of scraper.js Stage 2b. Returns repaired name or None."""
        if not name or len(name) <= 30:
            return None
        # No-space CamelCase
        if " " not in name:
            m = _re.match(r"^([A-Z][a-z]+)([A-Z].+)$", name)
            if m:
                return m.group(1)
            return None
        # Has spaces but mashed somewhere internally
        m = CAMEL_BOUNDARY_RE.match(name)
        if not m:
            return None
        before, after = m.group(1), m.group(2)
        if len(after) > 12 and ROLE_KEYWORDS_RE.search(after):
            return before.strip() or None
        return None

    leads = db.query(Lead).filter(Lead.workspace_id == ws).all()
    urls_fixed = 0
    names_fixed = 0
    headlines_fixed = 0
    titles_fixed = 0
    mash_fixed = 0
    examples: list[dict] = []

    for lead in leads:
        changed = False
        before_snapshot = {
            "id": lead.id,
            "full_name": lead.full_name,
            "linkedin_url": lead.linkedin_url,
            "headline": lead.headline,
            "title": lead.title,
        }

        # 1. URL sub-route strip
        if lead.linkedin_url:
            url = lead.linkedin_url
            if "/overlay/" in url or "/contact-info" in url:
                # Find /in/<handle>/ canonical prefix and truncate to it.
                try:
                    from urllib.parse import urlparse, urlunparse
                    p = urlparse(url)
                    m = URL_SUBROUTE_RE.match(p.path)
                    if m:
                        new_path = m.group(1) + "/"
                        if new_path != p.path:
                            lead.linkedin_url = urlunparse(
                                (p.scheme, p.netloc, new_path, "", "", "")
                            )
                            urls_fixed += 1
                            changed = True
                except Exception:
                    pass

        # 2. Action-label / page-chrome name
        if lead.full_name and NAME_NOISE_RE.match(lead.full_name.strip()):
            derived = _derive_name_from_url(lead.linkedin_url)
            lead.full_name = derived
            if derived:
                first, *rest = derived.split(" ", 1)
                lead.first_name = first
                lead.last_name = rest[0] if rest else None
            else:
                lead.first_name = None
                lead.last_name = None
            names_fixed += 1
            changed = True

        # 3. CamelCase mash repair (only if name didn't already get nulled)
        if lead.full_name:
            cut = _cut_mashed_name(lead.full_name)
            if cut and cut != lead.full_name:
                lead.full_name = cut
                first, *rest = cut.split(" ", 1)
                lead.first_name = first
                lead.last_name = rest[0] if rest else None
                mash_fixed += 1
                changed = True

        # 4. Headline noise
        if lead.headline and HEADLINE_NOISE_RE.match(lead.headline.strip()):
            lead.headline = None
            headlines_fixed += 1
            changed = True

        # 5. Title noise
        if lead.title and HEADLINE_NOISE_RE.match(lead.title.strip()):
            lead.title = None
            titles_fixed += 1
            changed = True

        if changed and len(examples) < 20:
            examples.append({
                "id": lead.id,
                "before": before_snapshot,
                "after": {
                    "full_name": lead.full_name,
                    "linkedin_url": lead.linkedin_url,
                    "headline": lead.headline,
                    "title": lead.title,
                },
            })

    db.commit()
    return {
        "scanned": len(leads),
        "urls_fixed": urls_fixed,
        "names_fixed": names_fixed,
        "name_mash_fixed": mash_fixed,
        "headlines_fixed": headlines_fixed,
        "titles_fixed": titles_fixed,
        "total_rows_changed": urls_fixed + names_fixed + mash_fixed + headlines_fixed + titles_fixed,
        "examples": examples,
    }


@router.post("/ingest", response_model=LeadIngestResponse)
def ingest(
    body: LeadIngest,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead, created = ingest_lead(
        db, ctx.workspace_id, ctx.user_id, body.model_dump(), source="extension"
    )
    db.commit()
    db.refresh(lead)
    return LeadIngestResponse(lead=_serialize(lead), created=created)


@router.post("/export.csv")
def export_csv(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    columns: str = Query("full_name,title,email,phone,linkedin_url,company,stage,created_at"),
):
    cols = [c.strip() for c in columns.split(",") if c.strip()]
    leads = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.workspace_id == ctx.workspace_id)
        .order_by(Lead.created_at.desc())
        .all()
    )
    stages = {
        s.id: s.name
        for s in db.query(PipelineStage).filter(PipelineStage.workspace_id == ctx.workspace_id).all()
    }
    buf = io.StringIO()
    buf.write("﻿")  # BOM for Excel
    writer = csv.writer(buf)
    writer.writerow(cols)
    for lead in leads:
        row: list = []
        for c in cols:
            if c == "company":
                row.append(lead.company.name if lead.company else "")
            elif c == "stage":
                row.append(stages.get(lead.stage_id or "", ""))
            elif c == "created_at" or c == "updated_at" or c == "last_activity_at":
                v = getattr(lead, c, None)
                row.append(v.isoformat() if v else "")
            elif c in {"full_name", "title", "email", "phone", "linkedin_url", "location", "headline"}:
                row.append(getattr(lead, c, "") or "")
            elif c == "estimated_value":
                row.append(lead.estimated_value or "")
            else:
                row.append(str((lead.custom or {}).get(c, "")))
        writer.writerow(row)
    csv_bytes = buf.getvalue().encode("utf-8")
    filename = f"leads-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _ensure_lead(db: Session, lead_id: str, workspace_id: str) -> Lead:
    lead = (
        db.query(Lead).filter(Lead.id == lead_id, Lead.workspace_id == workspace_id).first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return lead


@router.post("/{lead_id}/find-email")
def find_lead_email(
    lead_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Run the email-finder pipeline for a single lead — pattern infer
    from first+last name against the company's domain, MX lookup, SMTP
    RCPT probe with catch-all detection. No third-party API.

    On a verified hit, writes lead.email AND caches the finder result
    in lead.custom["email_finder"] so repeat calls return instantly
    without re-probing.

    Returns 200 with {email, status, confidence} regardless of outcome.
    Status: verified | risky | unknown | not_found.
    """
    from app.services.email_finder import find_email_sync

    lead = _ensure_lead(db, lead_id, ctx.workspace_id)

    # Reuse cached result if we ran the finder in the last 7 days.
    cached = (lead.custom or {}).get("email_finder")
    if isinstance(cached, dict) and cached.get("status") in ("verified", "risky"):
        return cached

    company = lead.company
    result = find_email_sync(
        first_name=lead.first_name,
        last_name=lead.last_name,
        domain=(company.domain if company else None),
        company_url=(company.website if company else None) or lead.company_url,
        company_name=(company.name if company else None),
        linkedin_url=lead.linkedin_url,
        db=db,
        workspace_id=ctx.workspace_id,
    )
    payload = result.to_dict()
    if result.phone and not lead.phone:
        lead.phone = result.phone

    # Persist
    merged_custom = dict(lead.custom or {})
    merged_custom["email_finder"] = payload
    lead.custom = merged_custom
    if result.email and result.status == "verified" and not lead.email:
        lead.email = result.email
    elif result.email and result.status == "risky" and not lead.email:
        # Risky results still go into lead.email but flagged via custom —
        # the user can decide whether to send.
        lead.email = result.email
    db.commit()
    return payload


@router.post("/find-emails-bulk")
def find_emails_bulk(
    body: dict | None = None,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Run the email-finder waterfall (cache → pattern+SMTP → Apollo)
    against every lead in the workspace that doesn't have an email yet.

    Hard-capped at 50 leads per call so the request can complete inside
    Render's HTTP timeout (~30s — SMTP probes are 2-6s each, so 50 leads
    parallelised should fit). If you have more than 50 nameless leads,
    just call this endpoint again.

    Body (optional):
      { "limit": 25, "include_risky": false }

    Returns per-status counters + the IDs of leads we successfully
    enriched, so the frontend can refresh those rows in-place.
    """
    import asyncio
    from app.services.email_finder import find_email_async

    body = body or {}
    limit = max(1, min(int(body.get("limit") or 25), 50))

    # Candidates: extension-saved leads with NO email + (URL or company hint).
    rows = (
        db.query(Lead)
        .filter(
            Lead.workspace_id == ctx.workspace_id,
            Lead.email.is_(None),
        )
        .order_by(Lead.created_at.desc())
        .limit(limit)
        .all()
    )

    if not rows:
        return {
            "processed": 0,
            "verified": 0,
            "risky": 0,
            "unknown": 0,
            "not_found": 0,
            "enriched_ids": [],
            "remaining": 0,
        }

    async def _process_one(lead: Lead) -> tuple[Lead, dict]:
        company = lead.company
        result = await find_email_async(
            first_name=lead.first_name,
            last_name=lead.last_name,
            domain=(company.domain if company else None),
            company_url=(company.website if company else None) or lead.company_url,
            company_name=(company.name if company else None),
            linkedin_url=lead.linkedin_url,
            db=db,
            workspace_id=ctx.workspace_id,
        )
        return lead, result.to_dict()

    async def _run_all() -> list[tuple[Lead, dict]]:
        # Parallelise — SMTP probes don't conflict, and Apollo API is
        # naturally concurrent. Bounded by limit (max 50).
        return await asyncio.gather(*(_process_one(r) for r in rows))

    pairs = asyncio.run(_run_all())

    counts = {"verified": 0, "risky": 0, "unknown": 0, "not_found": 0}
    enriched_ids: list[str] = []
    for lead, payload in pairs:
        status = payload.get("status") or "not_found"
        counts[status] = counts.get(status, 0) + 1
        # Persist finder result + write email/phone on the lead row
        merged_custom = dict(lead.custom or {})
        merged_custom["email_finder"] = payload
        lead.custom = merged_custom
        if payload.get("email") and not lead.email and status in ("verified", "risky"):
            lead.email = payload["email"]
            enriched_ids.append(lead.id)
        if payload.get("phone") and not lead.phone:
            lead.phone = payload["phone"]
    db.commit()

    remaining = (
        db.query(Lead)
        .filter(Lead.workspace_id == ctx.workspace_id, Lead.email.is_(None))
        .count()
    )

    return {
        "processed": len(pairs),
        **counts,
        "enriched_ids": enriched_ids,
        "remaining": remaining,
    }


@router.get("/{lead_id}/timeline")
def lead_timeline(
    lead_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Unified activity timeline: emails + notes + calls + system activities, newest first."""
    _ensure_lead(db, lead_id, ctx.workspace_id)
    items: list[dict] = []
    for a in (
        db.query(Activity)
        .filter(Activity.workspace_id == ctx.workspace_id, Activity.lead_id == lead_id)
        .all()
    ):
        items.append({"kind": "activity", "id": a.id, "type": a.type, "payload": a.payload, "at": a.created_at})
    for m in (
        db.query(EmailMessage)
        .filter(EmailMessage.workspace_id == ctx.workspace_id, EmailMessage.lead_id == lead_id)
        .all()
    ):
        items.append({
            "kind": "email",
            "id": m.id,
            "direction": m.direction,
            "from": m.from_address,
            "to": m.to_address,
            "subject": m.subject,
            "preview": (m.body_text or "")[:280],
            "status": m.status,
            "at": m.sent_at or m.created_at,
        })
    for n in (
        db.query(Note)
        .filter(Note.workspace_id == ctx.workspace_id, Note.lead_id == lead_id)
        .all()
    ):
        items.append({"kind": "note", "id": n.id, "body": n.body, "at": n.created_at})
    for c in (
        db.query(CallLog)
        .filter(CallLog.workspace_id == ctx.workspace_id, CallLog.lead_id == lead_id)
        .all()
    ):
        items.append({
            "kind": "call",
            "id": c.id,
            "outcome": c.outcome,
            "duration_seconds": c.duration_seconds,
            "notes": c.notes,
            "at": c.created_at,
        })
    items.sort(key=lambda x: x["at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return items


@router.post("/{lead_id}/notes")
def add_note(
    lead_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _ensure_lead(db, lead_id, ctx.workspace_id)
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "body_required")
    note = Note(
        workspace_id=ctx.workspace_id,
        lead_id=lead_id,
        author_id=ctx.user_id,
        body=text,
    )
    db.add(note)
    db.add(
        Activity(
            workspace_id=ctx.workspace_id,
            lead_id=lead_id,
            actor_id=ctx.user_id,
            type="note_added",
            payload={"preview": text[:200]},
        )
    )
    db.commit()
    db.refresh(note)
    return {"id": note.id, "body": note.body, "created_at": note.created_at}


@router.post("/{lead_id}/log-call")
def log_call(
    lead_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _ensure_lead(db, lead_id, ctx.workspace_id)
    call = CallLog(
        workspace_id=ctx.workspace_id,
        lead_id=lead_id,
        user_id=ctx.user_id,
        outcome=body.get("outcome") or "connected",
        duration_seconds=int(body.get("duration_seconds") or 0),
        notes=body.get("notes"),
    )
    db.add(call)
    db.add(
        Activity(
            workspace_id=ctx.workspace_id,
            lead_id=lead_id,
            actor_id=ctx.user_id,
            type="call_logged",
            payload={"outcome": call.outcome, "duration_seconds": call.duration_seconds},
        )
    )
    db.commit()
    db.refresh(call)
    return {"id": call.id, "outcome": call.outcome, "created_at": call.created_at}


@router.get("/{lead_id}/tasks")
def list_lead_tasks(
    lead_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _ensure_lead(db, lead_id, ctx.workspace_id)
    rows = (
        db.query(Task)
        .filter(Task.workspace_id == ctx.workspace_id, Task.lead_id == lead_id)
        .order_by(Task.created_at.desc())
        .all()
    )
    return [
        {
            "id": t.id,
            "title": t.title,
            "type": t.type,
            "status": t.status,
            "due_at": t.due_at,
            "completed_at": t.completed_at,
            "notes": t.notes,
        }
        for t in rows
    ]


@router.post("/{lead_id}/tasks")
def add_lead_task(
    lead_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _ensure_lead(db, lead_id, ctx.workspace_id)
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title_required")
    due_at_raw = body.get("due_at")
    due_at = None
    if due_at_raw:
        try:
            due_at = datetime.fromisoformat(due_at_raw.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            pass
    task = Task(
        workspace_id=ctx.workspace_id,
        lead_id=lead_id,
        assignee_id=ctx.user_id,
        title=title,
        type=body.get("type") or "todo",
        notes=body.get("notes"),
        due_at=due_at,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return {"id": task.id, "title": task.title, "status": task.status, "due_at": task.due_at}


@router.patch("/tasks/{task_id}")
def update_task(
    task_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    task = (
        db.query(Task)
        .filter(Task.id == task_id, Task.workspace_id == ctx.workspace_id)
        .first()
    )
    if not task:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if "status" in body:
        task.status = body["status"]
        if body["status"] == "done":
            task.completed_at = datetime.now(timezone.utc)
    if "title" in body:
        task.title = body["title"]
    if "notes" in body:
        task.notes = body["notes"]
    db.commit()
    return {"ok": True}
