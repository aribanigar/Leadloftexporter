from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Campaign, ConnectedAccount, Template

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


@router.get("/last-used")
def last_used_for_domain(
    domain: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Which Template was used the last time a campaign sent from a sender
    on `domain`. Powers the Campaign Builder's "you last used X for this
    domain" suggestion. Reuses Campaign.template_id (set when a campaign is
    started from a template) and Campaign.sender_account_ids + the same
    address.split('@')[1] domain derivation the frontend already uses to
    group senders — no new usage-tracking table."""
    domain = (domain or "").strip().lower()
    if not domain:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "domain_required")

    account_ids = {
        a.id
        for a in db.query(ConnectedAccount.id, ConnectedAccount.external_id).filter(
            ConnectedAccount.workspace_id == ctx.workspace_id
        )
        if a.external_id and "@" in a.external_id and a.external_id.split("@", 1)[1].lower() == domain
    }
    if not account_ids:
        return None

    # Bounded scan of recent campaigns (most workspaces have far fewer than
    # this) rather than a JSONB-containment SQL query — simpler and avoids a
    # DB-specific operator for what's a rare, small lookup.
    recent = (
        db.query(Campaign)
        .filter(Campaign.workspace_id == ctx.workspace_id, Campaign.template_id.isnot(None))
        .order_by(Campaign.created_at.desc())
        .limit(200)
        .all()
    )
    for c in recent:
        if account_ids.intersection(c.sender_account_ids or []):
            t = db.query(Template).filter(Template.id == c.template_id).first()
            if not t:
                continue
            return {
                "template_id": t.id,
                "name": t.name,
                "subject": t.subject,
                "body": t.body,
                "used_at": c.created_at,
            }
    return None


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
