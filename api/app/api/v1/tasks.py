from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import EnrollmentStepRun, Lead, PipelineStage, Task

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("/office")
def office_workload(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Aggregate every actionable item into an "office workload" dashboard: due
    tasks, cadence steps due, replied leads to close, ready-to-contact,
    waiting-on-enrichment, and unreachable leads. Read-only; 6 buckets with a
    count + up to 5 sample rows each."""
    ws = ctx.workspace_id
    now = datetime.now(timezone.utc)

    def lead_label(l: Lead) -> dict:
        name = l.full_name or (f"{l.first_name or ''} {l.last_name or ''}".strip()) or l.email or "Lead"
        company = l.company.name if l.company else None
        return {"id": l.id, "label": name, "sublabel": company, "href": f"/leads/{l.id}"}

    base = db.query(Lead).options(joinedload(Lead.company)).filter(Lead.workspace_id == ws)

    # Stage ids that count as "won/lost" (closed) — excluded from active buckets.
    closed_stage_ids = [
        s.id for s in db.query(PipelineStage).filter(
            PipelineStage.workspace_id == ws,
            or_(PipelineStage.is_won.is_(True), PipelineStage.is_lost.is_(True)),
        ).all()
    ]

    # 1) Due tasks — open + due now (or no due date).
    due_q = (
        db.query(Task)
        .filter(Task.workspace_id == ws, Task.status == "open", or_(Task.due_at.is_(None), Task.due_at <= now))
        .order_by(Task.due_at.asc().nullsfirst())
    )
    due_count = due_q.count()
    due_samples = []
    for t in due_q.limit(5).all():
        lead = db.get(Lead, t.lead_id) if t.lead_id else None
        nm = (lead.full_name if lead else None) or None
        due_samples.append({
            "id": t.id,
            "label": t.title,
            "sublabel": nm,
            "href": f"/leads/{t.lead_id}" if t.lead_id else "/tasks",
            "task_id": t.id,
        })

    # 2) Cadence steps due — pending EnrollmentStepRuns past run_at.
    cad_q = (
        db.query(EnrollmentStepRun)
        .filter(EnrollmentStepRun.workspace_id == ws, EnrollmentStepRun.status == "pending", EnrollmentStepRun.run_at <= now)
        .order_by(EnrollmentStepRun.run_at.asc())
    )
    cad_count = cad_q.count()
    cad_samples = [
        {"id": r.id, "label": "Outreach step", "sublabel": f"due {_rel(r.run_at, now)}", "href": "/playbooks"}
        for r in cad_q.limit(5).all()
    ]

    # 3) Needs you — leads that replied recently (awaiting your response).
    replied_q = (
        base.filter(Lead.last_inbound_at.isnot(None))
        .order_by(Lead.last_inbound_at.desc())
    )
    replied_count = replied_q.count()
    replied_samples = [lead_label(l) for l in replied_q.limit(5).all()]

    # 4) Ready to contact — has a channel, never contacted, not closed.
    ready_q = base.filter(
        Lead.last_outbound_at.is_(None),
        or_(Lead.email.isnot(None), Lead.phone.isnot(None), Lead.linkedin_url.isnot(None)),
    )
    if closed_stage_ids:
        ready_q = ready_q.filter(or_(Lead.stage_id.is_(None), Lead.stage_id.notin_(closed_stage_ids)))
    ready_count = ready_q.count()
    ready_samples = []
    for l in ready_q.order_by(Lead.created_at.desc()).limit(5).all():
        d = lead_label(l)
        chans = []
        if l.email:
            chans.append("✉️")
        if l.phone:
            chans.append("📱")
        if l.linkedin_url:
            chans.append("in")
        d["sublabel"] = " · ".join(filter(None, [d.get("sublabel"), " ".join(chans)]))
        ready_samples.append(d)

    # 5) Waiting on enrichment — no email yet but reachable on LinkedIn.
    enrich_q = base.filter(Lead.email.is_(None), Lead.linkedin_url.isnot(None))
    enrich_count = enrich_q.count()
    enrich_samples = [lead_label(l) for l in enrich_q.order_by(Lead.created_at.desc()).limit(5).all()]

    # 6) Unreachable — no email, no phone, no linkedin.
    unreach_q = base.filter(Lead.email.is_(None), Lead.phone.is_(None), Lead.linkedin_url.is_(None))
    unreach_count = unreach_q.count()
    unreach_samples = [lead_label(l) for l in unreach_q.order_by(Lead.created_at.desc()).limit(5).all()]

    groups = [
        {
            "key": "due_tasks", "title": "Due tasks", "kind": "human",
            "desc": "Open tasks that are due now — calls, emails, and to-dos you scheduled.",
            "icon": "CalendarClock", "accent": "#9334e6", "bg": "#f3e8fd",
            "count": due_count, "samples": due_samples, "actionHref": "/tasks?view=list", "actionLabel": "Open task list",
        },
        {
            "key": "needs_you", "title": "Needs YOUR attention — replied", "kind": "human",
            "desc": "Leads who replied. Auto-outreach stops here — respond and close them yourself.",
            "icon": "MessageSquare", "accent": "#0d652d", "bg": "#e6f4ea",
            "count": replied_count, "samples": replied_samples, "actionHref": "/inbox", "actionLabel": "Open inbox",
        },
        {
            "key": "cadence_due", "title": "Due follow-ups (cadence)", "kind": "auto",
            "desc": "Playbook steps scheduled in the past. The scheduler sends these on its next run.",
            "icon": "Send", "accent": "#1a73e8", "bg": "#e8f0fe",
            "count": cad_count, "samples": cad_samples, "actionHref": "/playbooks", "actionLabel": "Open playbooks",
        },
        {
            "key": "ready", "title": "Ready to contact", "kind": "auto",
            "desc": "Leads with a channel that haven't been contacted yet. Enroll them or reach out.",
            "icon": "Search", "accent": "#137333", "bg": "#e6f4ea",
            "count": ready_count, "samples": ready_samples, "actionHref": "/prospecting", "actionLabel": "Prospecting",
        },
        {
            "key": "enrich", "title": "Waiting on enrichment", "kind": "auto",
            "desc": "No email yet, but reachable on LinkedIn — capture their contact info to unlock outreach.",
            "icon": "PenLine", "accent": "#b06000", "bg": "#fef7e0",
            "count": enrich_count, "samples": enrich_samples, "actionHref": "/prospecting", "actionLabel": "Enrich leads",
        },
        {
            "key": "unreachable", "title": "Unreachable — add a channel", "kind": "human",
            "desc": "No email, phone, or LinkedIn. Add a real channel manually, or hunt for replacements.",
            "icon": "AlertTriangle", "accent": "#c5221f", "bg": "#fce8e6",
            "count": unreach_count, "samples": unreach_samples, "actionHref": "/prospecting", "actionLabel": "Find leads",
        },
    ]

    counters = {
        "due_now": due_count + cad_count,
        "needs_you": replied_count,
        "ready": ready_count,
        "unreachable": unreach_count,
    }
    return {"groups": groups, "counters": counters}


def _rel(d: datetime, now: datetime) -> str:
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    ms = (now - d).total_seconds()
    past = ms >= 0
    ms = abs(ms)
    m = int(ms // 60)
    if m < 60:
        return f"{m}m {'ago' if past else 'from now'}"
    h = m // 60
    if h < 24:
        return f"{h}h {'ago' if past else 'from now'}"
    return f"{h // 24}d {'ago' if past else 'from now'}"


@router.get("")
def list_tasks(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    status_: Optional[str] = None,
    assignee_id: Optional[str] = None,
):
    q = db.query(Task).filter(Task.workspace_id == ctx.workspace_id)
    if status_:
        q = q.filter(Task.status == status_)
    if assignee_id:
        q = q.filter(Task.assignee_id == assignee_id)
    rows = q.order_by(Task.due_at.asc().nullslast(), Task.created_at.desc()).all()
    return [
        {
            "id": t.id,
            "title": t.title,
            "notes": t.notes,
            "type": t.type,
            "status": t.status,
            "due_at": t.due_at,
            "completed_at": t.completed_at,
            "lead_id": t.lead_id,
            "assignee_id": t.assignee_id,
            "created_at": t.created_at,
        }
        for t in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_task(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = Task(
        workspace_id=ctx.workspace_id,
        title=body["title"],
        notes=body.get("notes"),
        type=body.get("type", "todo"),
        lead_id=body.get("lead_id"),
        assignee_id=body.get("assignee_id") or ctx.user_id,
        due_at=body.get("due_at"),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id}


@router.patch("/{task_id}")
def update_task(
    task_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = db.query(Task).filter(Task.id == task_id, Task.workspace_id == ctx.workspace_id).first()
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    for k in ("title", "notes", "type", "status", "due_at", "lead_id", "assignee_id"):
        if k in body:
            setattr(t, k, body[k])
    if body.get("status") == "done" and not t.completed_at:
        t.completed_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.delete("/{task_id}")
def delete_task(
    task_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = db.query(Task).filter(Task.id == task_id, Task.workspace_id == ctx.workspace_id).first()
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(t)
    db.commit()
    return {"ok": True}
