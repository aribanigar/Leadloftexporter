from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import ConnectedAccount, EmailMessage, EmailThread, Lead
from app.services.ai_writer import generate_email_for_lead
from app.services.outreach import (
    emails_sent_today,
    outreach_settings,
    queue_email,
)

router = APIRouter(prefix="/inbox", tags=["inbox"])


def _render_email(template: str, lead: Lead) -> str:
    """Per-recipient merge-tag rendering — matches the WhatsApp / LinkedIn tokens
    so the same template body works on every channel."""
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
        "{email}": (lead.email or "").strip(),
    }
    out = template
    for token, value in tokens.items():
        out = out.replace(token, value)
    return out


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
    """Send a single email synchronously.

    Manual sends from the Outreach / Lead Detail composer MUST dispatch
    the SMTP/HTTPS call inline — they're driven by a user clicking Send
    and the UI shows a spinner that won't resolve until we return. The
    old behaviour was to call queue_email() and rely on the Celery worker
    to drain queued rows every minute. On Render's free tier no worker
    runs, so rows sat in "queued" forever and the UI bubbles spun forever.

    Flow:
      1. queue_email() creates the EmailMessage row + email_queued Activity
      2. send_email_message() picks a connected account, runs the actual
         transport (Resend / SendGrid / Gmail / SMTP → Vercel relay
         fallback), stamps status=sent/sent_at on success or
         status=failed/error on failure.
      3. We return the resolved status so the frontend can flip the
         pending bubble straight to "sent" or "failed".
    """
    from app.services.email_sender import send_email_message

    lead_id = body.get("lead_id")
    to_address = body.get("to")
    subject = body.get("subject")
    body_html = body.get("body_html") or body.get("body") or ""
    body_text = body.get("body_text") or ""
    if not (to_address and (body_html or body_text)):
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
    if body_text:
        msg.body_text = body_text
    db.flush()

    # Dispatch immediately. send_email_message mutates msg.status / .sent_at
    # / .error / .provider_message_id and returns a SendResult.
    result = send_email_message(db, msg, ctx.workspace, user_id=ctx.user_id)
    db.commit()
    return {
        "id": msg.id,
        "status": msg.status,
        "ok": result.ok,
        "error": msg.error,
        "sent_at": msg.sent_at.isoformat() if msg.sent_at else None,
        "from_address": msg.from_address or None,
    }


@router.post("/bulk-send")
def bulk_send_email(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Queue an email to every (or selected) workspace lead.

    Per recipient: renders the merge tags ({first_name}, {company}, …), creates
    a queued EmailMessage row, and lets Celery's ``send_queued_emails`` task
    drain them at the workspace's configured pace. The endpoint never blocks
    on actual delivery — even a 500-lead burst returns in <1 s. Pacing is
    enforced server-side by ``email_drain_per_minute`` and the daily quota,
    so a free-tier deploy with no worker still has a sane backlog when the
    worker comes up later.
    """
    subject_tpl = (body.get("subject") or "").strip()
    body_html_tpl = body.get("body_html") or body.get("body") or ""
    body_text_tpl = body.get("body_text") or ""
    lead_ids = body.get("lead_ids") or None
    stage_id = body.get("stage_id") or None
    # AI mode: generate one bespoke email per lead from {intent, tone}.
    # When ai=true, subject/body act as fallback only if Claude is offline.
    ai_mode = bool(body.get("ai"))
    ai_intent = (body.get("ai_intent") or body.get("intent") or "").strip()
    ai_tone = (body.get("ai_tone") or body.get("tone") or "professional").strip()
    if ai_mode and not ai_intent:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "ai_intent_required_when_ai_enabled"
        )
    if not ai_mode and not (subject_tpl and (body_html_tpl or body_text_tpl)):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "subject_and_body_required"
        )

    has_provider = (
        db.query(ConnectedAccount.id)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider.in_(("resend", "sendgrid", "gmail", "smtp")),
            ConnectedAccount.status == "active",
        )
        .first()
    )
    if not has_provider:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "no_email_account_connected",
        )

    daily_cap = int(outreach_settings(ctx.workspace).get("email_limit_per_day", 80))
    already_today = emails_sent_today(db, ctx.workspace_id)

    # Cap the queue depth at remaining daily budget + the next 24h's budget so
    # an over-eager bulk send to a 5,000-row pipeline doesn't sit half-stale
    # for a week. Anything beyond budget × 2 returns as "skipped_over_cap"
    # and the user is told to come back tomorrow.
    enqueue_cap = max(0, daily_cap * 2 - already_today)
    if enqueue_cap == 0:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"daily_limit_reached: {already_today}/{daily_cap}",
        )

    q = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.workspace_id == ctx.workspace_id, Lead.email.isnot(None))
    )
    if lead_ids:
        q = q.filter(Lead.id.in_(lead_ids))
    if stage_id:
        q = q.filter(Lead.stage_id == stage_id)
    leads = q.all()

    queued = 0
    skipped_no_email = 0
    skipped_over_cap = 0
    skipped_recent_dup = 0
    # Don't double-queue the same lead+subject within 24h (rage-clicks on Send).
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    recent_pairs = {
        (m.lead_id, (m.subject or "").strip())
        for m in db.query(EmailMessage)
        .filter(
            EmailMessage.workspace_id == ctx.workspace_id,
            EmailMessage.direction == "outbound",
            EmailMessage.created_at >= cutoff,
            EmailMessage.lead_id.isnot(None),
        )
        .all()
    }

    for lead in leads:
        if not (lead.email or "").strip():
            skipped_no_email += 1
            continue
        if queued >= enqueue_cap:
            skipped_over_cap += 1
            continue
        if ai_mode:
            try:
                generated = generate_email_for_lead(
                    lead,
                    instruction=ai_intent,
                    tone=ai_tone,
                    workspace=ctx.workspace,
                )
                rendered_subject = (generated.get("subject") or "").strip()
                if not rendered_subject:
                    rendered_subject = (
                        _render_email(subject_tpl, lead) if subject_tpl else "Hi"
                    )
                rendered_body_html = generated.get("body_html") or ""
                rendered_body_text = generated.get("body_text") or ""
            except Exception:  # noqa: BLE001
                # Per-lead AI failure must NOT poison the whole batch — fall
                # back to the static template if one was provided, else skip.
                if not (subject_tpl and (body_html_tpl or body_text_tpl)):
                    skipped_no_email += 1
                    continue
                rendered_subject = _render_email(subject_tpl, lead)
                rendered_body_html = (
                    _render_email(body_html_tpl, lead) if body_html_tpl else ""
                )
                rendered_body_text = (
                    _render_email(body_text_tpl, lead) if body_text_tpl else ""
                )
        else:
            rendered_subject = _render_email(subject_tpl, lead)
            rendered_body_html = (
                _render_email(body_html_tpl, lead) if body_html_tpl else ""
            )
            rendered_body_text = (
                _render_email(body_text_tpl, lead) if body_text_tpl else ""
            )
        if (lead.id, rendered_subject.strip()) in recent_pairs:
            skipped_recent_dup += 1
            continue
        msg_row = queue_email(
            db,
            workspace_id=ctx.workspace_id,
            user_id=ctx.user_id,
            lead=lead,
            to_address=lead.email,
            subject=rendered_subject,
            body_html=rendered_body_html,
        )
        if rendered_body_text:
            msg_row.body_text = rendered_body_text
        queued += 1

    db.commit()
    return {
        "queued": queued,
        "skipped_no_email": skipped_no_email,
        "skipped_over_cap": skipped_over_cap,
        "skipped_recent_dup": skipped_recent_dup,
        "daily_cap": daily_cap,
        "daily_sent": already_today,
        "total": len(leads),
    }


@router.post("/ai-preview")
def ai_preview(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Generate a one-off AI-personalised email for a single lead so the user
    can sanity-check the prompt + tone before clicking Send to a 200-row
    pipeline. Returns the same shape as a single AI generation: subject,
    body_text, body_html."""
    lead_id = body.get("lead_id")
    intent = (body.get("intent") or body.get("ai_intent") or "").strip()
    tone = (body.get("tone") or body.get("ai_tone") or "professional").strip()
    if not (lead_id and intent):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "lead_id_and_intent_required"
        )
    lead = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")
    try:
        generated = generate_email_for_lead(
            lead, instruction=intent, tone=tone, workspace=ctx.workspace
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"ai_generation_failed: {exc}"
        )
    return {
        "lead_id": lead.id,
        "subject": generated.get("subject", ""),
        "body_text": generated.get("body_text", ""),
        "body_html": generated.get("body_html", ""),
    }


@router.get("/bulk-status")
def bulk_status(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Live counts of today's outbound emails for the bulk-send progress bar."""
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    rows = (
        db.query(EmailMessage.status, func.count(EmailMessage.id))
        .filter(
            EmailMessage.workspace_id == ctx.workspace_id,
            EmailMessage.direction == "outbound",
            EmailMessage.created_at >= since,
        )
        .group_by(EmailMessage.status)
        .all()
    )
    counts = {r[0]: r[1] for r in rows}
    daily_cap = int(outreach_settings(ctx.workspace).get("email_limit_per_day", 80))
    return {
        "queued": counts.get("queued", 0),
        "sent": counts.get("sent", 0) + counts.get("delivered", 0) + counts.get("opened", 0),
        "failed": counts.get("failed", 0) + counts.get("bounced", 0),
        "daily_cap": daily_cap,
        "daily_sent": emails_sent_today(db, ctx.workspace_id),
    }
