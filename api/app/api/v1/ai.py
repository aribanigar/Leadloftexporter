from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Lead
from app.services.ai_writer import generate_email_for_lead, classify_reply_sentiment

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/write/email")
def write_email(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    lead_id = body.get("lead_id")
    instruction = body.get("instruction") or "Write a warm, personalized cold outreach email."
    tone = body.get("tone", "professional")
    lead = None
    if lead_id:
        lead = (
            db.query(Lead)
            .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
            .first()
        )
        if not lead:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")
    result = generate_email_for_lead(lead, instruction=instruction, tone=tone, workspace=ctx.workspace)
    return result


@router.post("/classify/reply")
def classify_reply(body: dict, ctx: AuthContext = Depends(get_workspace_context)):
    text = body.get("text", "")
    if not text:
        return {"sentiment": "no_reply", "confidence": 0.0}
    return classify_reply_sentiment(text)
