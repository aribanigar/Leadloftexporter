from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Enrollment, Lead, Playbook, PlaybookStep
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
    for lid in lead_ids:
        lead = db.query(Lead).filter(Lead.id == lid, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            continue
        e = enroll_lead(db, pb, lead)
        enrolled.append(e.id)
    db.commit()
    return {"enrolled": enrolled}
