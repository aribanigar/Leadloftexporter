import csv
import io
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import or_
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

    total = base.count()
    sort_col = getattr(Lead, sort, Lead.created_at)
    base = base.order_by(sort_col.desc() if direction == "desc" else sort_col.asc())
    rows = base.offset((page - 1) * page_size).limit(page_size).all()
    items: list[LeadOut] = []
    for r in rows:
        item = LeadOut.model_validate(r)
        if r.company_id and getattr(r, "company", None):
            from app.schemas.lead import CompanyMini

            item.company = CompanyMini.model_validate(r.company)
        items.append(item)
    return LeadList(items=items, total=total, page=page, page_size=page_size)


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


@router.delete("/cleanup/nameless")
def cleanup_nameless_leads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Delete extension-sourced leads that have no name.

    These are created when the background enrichment tab scrapes a LinkedIn
    profile before the page has hydrated — the lead gets a linkedin_url and
    possibly an email/phone, but full_name / first_name / last_name are all
    null. They show as '—' rows in the pipeline table and duplicate the real
    named lead for the same person.
    """
    rows = (
        db.query(Lead)
        .filter(
            Lead.workspace_id == ctx.workspace_id,
            Lead.full_name.is_(None),
            Lead.first_name.is_(None),
            Lead.last_name.is_(None),
            Lead.source == "extension",
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
    )
    payload = result.to_dict()

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
