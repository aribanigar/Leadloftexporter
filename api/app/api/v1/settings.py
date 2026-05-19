from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import LeadField

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/fields")
def list_fields(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(LeadField)
        .filter(LeadField.workspace_id == ctx.workspace_id)
        .order_by(LeadField.position.asc(), LeadField.created_at.asc())
        .all()
    )
    return [
        {
            "id": f.id,
            "key": f.key,
            "label": f.label,
            "type": f.type,
            "options": f.options,
            "position": f.position,
            "visible_default": f.visible_default,
            "is_system": f.is_system,
        }
        for f in rows
    ]


@router.post("/fields", status_code=status.HTTP_201_CREATED)
def create_field(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    f = LeadField(
        workspace_id=ctx.workspace_id,
        key=body["key"],
        label=body["label"],
        type=body.get("type", "text"),
        options=body.get("options", {}),
        position=body.get("position", 999),
        visible_default=body.get("visible_default", True),
        is_system=False,
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id}


@router.patch("/fields/{field_id}")
def update_field(
    field_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    f = (
        db.query(LeadField)
        .filter(LeadField.id == field_id, LeadField.workspace_id == ctx.workspace_id)
        .first()
    )
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    for k in ("label", "type", "options", "position", "visible_default"):
        if k in body:
            setattr(f, k, body[k])
    db.commit()
    return {"ok": True}


@router.delete("/fields/{field_id}")
def delete_field(
    field_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    f = (
        db.query(LeadField)
        .filter(LeadField.id == field_id, LeadField.workspace_id == ctx.workspace_id)
        .first()
    )
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if f.is_system:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "system_field_immutable")
    db.delete(f)
    db.commit()
    return {"ok": True}


@router.get("/outreach")
def get_outreach(ctx: AuthContext = Depends(get_workspace_context)):
    s = (ctx.workspace.settings or {}).get("outreach") or {}
    return {
        "email_sending_pattern": s.get("email_sending_pattern", "mimic_humans"),
        "schedule": s.get("schedule", "any_day"),
        "time_frame_start": s.get("time_frame_start", "07:00"),
        "time_frame_end": s.get("time_frame_end", "19:00"),
        "timezone": s.get("timezone", "Asia/Calcutta"),
        "email_limit_per_day": s.get("email_limit_per_day", 80),
        "linkedin_connect_limit": s.get("linkedin_connect_limit", 15),
        "linkedin_message_limit": s.get("linkedin_message_limit", 30),
    }


@router.patch("/outreach")
def update_outreach(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    settings = dict(ctx.workspace.settings or {})
    outreach = dict(settings.get("outreach") or {})
    for k in (
        "email_sending_pattern",
        "schedule",
        "time_frame_start",
        "time_frame_end",
        "timezone",
        "email_limit_per_day",
        "linkedin_connect_limit",
        "linkedin_message_limit",
    ):
        if k in body:
            outreach[k] = body[k]
    settings["outreach"] = outreach
    ctx.workspace.settings = settings
    db.commit()
    return {"ok": True, "outreach": outreach}
