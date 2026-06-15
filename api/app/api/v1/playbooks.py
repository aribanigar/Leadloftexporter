from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import EmailMessage, Enrollment, Lead, PipelineStage, Playbook, PlaybookStep
from app.schemas import PlaybookCreate, PlaybookOut, PlaybookUpdate, StepOut
from app.services.outreach import enroll_lead

router = APIRouter(prefix="/playbooks", tags=["playbooks"])


def _to_out(pb: Playbook, enrolled_count: int = 0) -> PlaybookOut:
    out = PlaybookOut.model_validate(pb)
    out.steps = [StepOut.model_validate(s) for s in sorted(pb.steps, key=lambda s: s.position)]
    out.enrolled_count = enrolled_count
    return out


@router.get("", response_model=list[PlaybookOut])
def list_playbooks(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(Playbook)
        .filter(Playbook.workspace_id == ctx.workspace_id)
        .order_by(Playbook.created_at.desc())
        .all()
    )
    return [_to_out(r) for r in rows]


@router.post("", response_model=PlaybookOut, status_code=status.HTTP_201_CREATED)
def create_playbook(
    body: PlaybookCreate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    pb = Playbook(
        workspace_id=ctx.workspace_id,
        name=body.name,
        description=body.description,
        is_active=body.is_active,
        trigger=body.trigger,
        trigger_config=body.trigger_config,
        daily_enrollment_limit=body.daily_enrollment_limit,
        track_opens=body.track_opens,
        contact_unverified=body.contact_unverified,
        eject_on_reply=body.eject_on_reply,
        fallback_to_email_domain=body.fallback_to_email_domain,
        find_phone_numbers=body.find_phone_numbers,
        on_positive_reply_stage=body.on_positive_reply_stage,
        on_negative_reply_stage=body.on_negative_reply_stage,
        on_no_reply_stage=body.on_no_reply_stage,
    )
    db.add(pb)
    db.flush()
    for i, step in enumerate(body.steps):
        db.add(
            PlaybookStep(
                playbook_id=pb.id,
                position=i,
                kind=step.kind,
                wait_days=step.wait_days,
                wait_hours=step.wait_hours,
                config=step.config,
                template_id=step.template_id,
            )
        )
    db.commit()
    db.refresh(pb)
    return _to_out(pb)


@router.get("/{playbook_id}", response_model=PlaybookOut)
def get_playbook(
    playbook_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    enrolled = (
        db.query(Enrollment).filter(Enrollment.playbook_id == pb.id, Enrollment.status == "active").count()
    )
    return _to_out(pb, enrolled_count=enrolled)


@router.patch("/{playbook_id}", response_model=PlaybookOut)
def update_playbook(
    playbook_id: str,
    body: PlaybookUpdate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    data = body.model_dump(exclude_unset=True)
    steps = data.pop("steps", None)
    for k, v in data.items():
        setattr(pb, k, v)
    if steps is not None:
        db.query(PlaybookStep).filter(PlaybookStep.playbook_id == pb.id).delete()
        db.flush()
        for i, step in enumerate(steps):
            db.add(
                PlaybookStep(
                    playbook_id=pb.id,
                    position=i,
                    kind=step["kind"],
                    wait_days=step.get("wait_days", 0),
                    wait_hours=step.get("wait_hours", 0),
                    config=step.get("config", {}),
                    template_id=step.get("template_id"),
                )
            )
    db.commit()
    db.refresh(pb)
    return _to_out(pb)


@router.delete("/{playbook_id}")
def delete_playbook(
    playbook_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(pb)
    db.commit()
    return {"ok": True}


@router.post("/{playbook_id}/enroll")
def enroll(
    playbook_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    lead_ids: list[str] = body.get("lead_ids", [])
    enrolled = []
    enrichment_queued = 0
    for lid in lead_ids:
        lead = db.query(Lead).filter(Lead.id == lid, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            continue
        before_email = lead.email
        before_phone = lead.phone
        e = enroll_lead(db, pb, lead)
        enrolled.append(e.id)
        if (not before_email or not before_phone) and lead.linkedin_url and "/in/" in lead.linkedin_url:
            enrichment_queued += 1
    db.commit()
    return {"enrolled": enrolled, "enrichment_queued": enrichment_queued}


@router.get("/{playbook_id}/enrollments")
def list_enrollments(
    playbook_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """List every lead enrolled in this playbook with status + enrichment
    flag. The UI shows this so users can verify their Enroll click worked
    and see who still needs contact details before email steps fire."""
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    rows = (
        db.query(Enrollment, Lead)
        .join(Lead, Lead.id == Enrollment.lead_id)
        .filter(Enrollment.playbook_id == playbook_id)
        .order_by(Enrollment.created_at.desc())
        .all()
    )
    out = []
    for enrollment, lead in rows:
        needs_enrichment = (
            bool(lead.linkedin_url)
            and (not lead.email or not lead.phone)
            and "/in/" in (lead.linkedin_url or "")
        )
        out.append({
            "id": enrollment.id,
            "status": enrollment.status,
            "current_step": enrollment.current_step,
            "ejected_reason": enrollment.ejected_reason,
            "completed_at": enrollment.completed_at,
            "created_at": enrollment.created_at,
            "needs_enrichment": needs_enrichment,
            "lead": {
                "id": lead.id,
                "full_name": lead.full_name,
                "first_name": lead.first_name,
                "last_name": lead.last_name,
                "email": lead.email,
                "phone": lead.phone,
                "title": lead.title,
                "linkedin_url": lead.linkedin_url,
                "avatar_url": lead.avatar_url,
                "location": lead.location,
            },
        })
    return out


@router.delete("/{playbook_id}/enrollments/{enrollment_id}")
def unenroll(
    playbook_id: str,
    enrollment_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Remove a lead from a playbook. Cascade-deletes the
    EnrollmentStepRun rows so any pending step doesn't try to fire after
    the lead is gone."""
    e = (
        db.query(Enrollment)
        .filter(
            Enrollment.id == enrollment_id,
            Enrollment.playbook_id == playbook_id,
            Enrollment.workspace_id == ctx.workspace_id,
        )
        .first()
    )
    if not e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(e)
    db.commit()
    return {"ok": True}


@router.get("/stats/overview")
def playbook_stats(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    days: int = Query(90, ge=1, le=365),
    sender_id: Optional[str] = None,
):
    """Aggregate outreach stats for the workspace dashboard.

    `days` is the lookback window. `series` is daily outbound email counts.
    `interested` counts leads currently sitting in a stage flagged is_won
    or named like Interested/Customer — a useful "warm" cohort indicator.
    """
    to_at = datetime.now(timezone.utc)
    from_at = to_at - timedelta(days=days)

    email_q = (
        db.query(EmailMessage)
        .filter(
            EmailMessage.workspace_id == ctx.workspace_id,
            EmailMessage.direction == "outbound",
            EmailMessage.created_at >= from_at,
        )
    )

    contacted = email_q.filter(EmailMessage.status != "queued").count()
    sent = email_q.filter(
        EmailMessage.status.in_(["sent", "delivered", "opened", "clicked", "replied"])
    ).count()
    replied = email_q.filter(EmailMessage.replied_at.isnot(None)).count()

    interested_stages = (
        db.query(PipelineStage.id)
        .filter(
            PipelineStage.workspace_id == ctx.workspace_id,
            (
                PipelineStage.is_won.is_(True)
                | PipelineStage.name.ilike("%interested%")
                | PipelineStage.name.ilike("%customer%")
                | PipelineStage.name.ilike("%proposal%")
            ),
        )
        .all()
    )
    interested_stage_ids = [s[0] for s in interested_stages]
    interested = 0
    if interested_stage_ids:
        interested = (
            db.query(Lead)
            .filter(
                Lead.workspace_id == ctx.workspace_id,
                Lead.stage_id.in_(interested_stage_ids),
                Lead.updated_at >= from_at,
            )
            .count()
        )

    # Daily series of outbound emails (any non-queued status counts as activity)
    rows = (
        db.query(
            func.date_trunc("day", EmailMessage.created_at).label("d"),
            func.count(EmailMessage.id).label("n"),
        )
        .filter(
            EmailMessage.workspace_id == ctx.workspace_id,
            EmailMessage.direction == "outbound",
            EmailMessage.created_at >= from_at,
        )
        .group_by("d")
        .order_by("d")
        .all()
    )
    series_map = {r.d.date().isoformat(): int(r.n) for r in rows}

    # Fill gaps with zeros so the chart renders continuous days
    series: list[dict] = []
    cursor = from_at.date()
    end = to_at.date()
    while cursor <= end:
        iso = cursor.isoformat()
        series.append({"date": iso, "count": series_map.get(iso, 0)})
        cursor = cursor + timedelta(days=1)

    reply_rate = round((replied / sent) * 100, 1) if sent else 0.0
    interested_rate = round((interested / contacted) * 100, 1) if contacted else 0.0

    return {
        "contacted": contacted,
        "replied": replied,
        "interested": interested,
        "reply_rate": reply_rate,
        "interested_rate": interested_rate,
        "from": from_at.isoformat(),
        "to": to_at.isoformat(),
        "series": series,
    }
