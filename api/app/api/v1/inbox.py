from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import EmailMessage, EmailThread, Lead
from app.services.outreach import queue_email

router = APIRouter(prefix="/inbox", tags=["inbox"])


@router.get("/threads")
def list_threads(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    lead_id: Optional[str] = None,
):
    q = db.query(EmailThread).filter(EmailThread.workspace_id == ctx.workspace_id)
    if lead_id:
        q = q.filter(EmailThread.lead_id == lead_id)
    rows = q.order_by(EmailThread.last_message_at.desc().nullslast()).limit(200).all()
    return [
        {
            "id": t.id,
            "subject": t.subject,
            "lead_id": t.lead_id,
            "last_message_at": t.last_message_at,
        }
        for t in rows
    ]


@router.get("/threads/{thread_id}")
def get_thread(
    thread_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    thread = (
        db.query(EmailThread)
        .filter(EmailThread.id == thread_id, EmailThread.workspace_id == ctx.workspace_id)
        .first()
    )
    if not thread:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    messages = (
        db.query(EmailMessage)
        .filter(EmailMessage.thread_id == thread_id)
        .order_by(EmailMessage.created_at.asc())
        .all()
    )
    return {
        "thread": {
            "id": thread.id,
            "subject": thread.subject,
            "lead_id": thread.lead_id,
        },
        "messages": [
            {
                "id": m.id,
                "direction": m.direction,
                "from_address": m.from_address,
                "to_address": m.to_address,
                "subject": m.subject,
                "body_html": m.body_html,
                "body_text": m.body_text,
                "status": m.status,
                "sent_at": m.sent_at,
                "opened_at": m.opened_at,
                "replied_at": m.replied_at,
                "created_at": m.created_at,
            }
            for m in messages
        ],
    }


@router.post("/send")
def send_email(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead_id = body.get("lead_id")
    to_address = body.get("to")
    subject = body.get("subject")
    body_html = body.get("body_html") or body.get("body") or ""
    if not (to_address and body_html):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "to_and_body_required")
    lead = None
    if lead_id:
        lead = (
            db.query(Lead)
            .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
            .first()
        )
    msg = queue_email(
        db,
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        lead=lead,
        to_address=to_address,
        subject=subject or "",
        body_html=body_html,
    )
    db.commit()
    return {"id": msg.id, "status": msg.status}
