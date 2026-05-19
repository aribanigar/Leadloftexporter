from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Template

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("")
def list_templates(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(Template)
        .filter(Template.workspace_id == ctx.workspace_id)
        .order_by(Template.created_at.desc())
        .all()
    )
    return [
        {
            "id": t.id,
            "name": t.name,
            "channel": t.channel,
            "subject": t.subject,
            "body": t.body,
            "variables": t.variables,
        }
        for t in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_template(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = Template(
        workspace_id=ctx.workspace_id,
        name=body["name"],
        channel=body.get("channel", "email"),
        subject=body.get("subject"),
        body=body["body"],
        variables=body.get("variables", []),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id}


@router.patch("/{template_id}")
def update_template(
    template_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = (
        db.query(Template)
        .filter(Template.id == template_id, Template.workspace_id == ctx.workspace_id)
        .first()
    )
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    for k in ("name", "channel", "subject", "body", "variables"):
        if k in body:
            setattr(t, k, body[k])
    db.commit()
    return {"ok": True}


@router.delete("/{template_id}")
def delete_template(
    template_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = (
        db.query(Template)
        .filter(Template.id == template_id, Template.workspace_id == ctx.workspace_id)
        .first()
    )
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(t)
    db.commit()
    return {"ok": True}
