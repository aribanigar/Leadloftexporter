"""Email-marketing campaigns — multi-sender bulk send with warmup + halt.

LIFECYCLE
    draft → scheduled → sending ⇄ paused → completed | cancelled | failed

The send loop is /campaigns/{id}/tick. It claims pending CampaignRecipient
rows in batches of `campaign.batch_size`, rotates across the configured
sender pool (sender_account_ids), enforces per-sender warmup caps, skips
addresses in the workspace's Suppression list, and dispatches the actual
SMTP/HTTPS send via the existing email_sender.send_email_message path.

WHY TICK + WORKER + FRONTEND POLL
On Render's free tier no Celery worker runs, so we can't rely on a
background drainer. The same `/tick` endpoint is called by:
  - The frontend polling loop while the user watches the live progress
    bar (always works — even on free tier).
  - The Celery beat schedule `tick_email_campaigns` (every minute) when
    the worker IS running (Starter plan and up).
Both are idempotent — only `status="pending"` rows advance, transitions
go pending → sending → sent/failed/skipped under a DB row lock.

WARMUP
SenderWarmup carries a per-account daily cap that ramps from 20 on day 1
up to `daily_cap_ceiling` (default 2,000) over `ramp_days` (default 30):
  day 1   : 20
  day 2   : 30
  day 3   : 50
  day 4   : 75
  day 7   : 200
  day 14  : 700
  day 30+ : daily_cap_ceiling
Curve is `min(ceiling, round(20 * 1.18 ** (day-1)))`. Reset at the UTC
day rollover by comparing `day_anchor` to today's YYYY-MM-DD.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import (
    Activity,
    Campaign,
    CampaignRecipient,
    ConnectedAccount,
    EmailMessage,
    EmailThread,
    Lead,
    SenderWarmup,
    Suppression,
    Workspace,
)

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _own_campaign(db: Session, ctx: AuthContext, campaign_id: str) -> Campaign:
    c = (
        db.query(Campaign)
        .filter(Campaign.id == campaign_id, Campaign.workspace_id == ctx.workspace_id)
        .first()
    )
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "campaign_not_found")
    return c


def _render_token(template: str, lead: Lead) -> str:
    """Merge-tag rendering used by the campaign send + composer alike."""
    first = (lead.first_name or "").strip()
    if not first and lead.full_name:
        first = lead.full_name.strip().split(" ")[0]
    company = ""
    if lead.company_id and getattr(lead, "company", None):
        company = (lead.company.name or "").strip()
    repl = {
        "{first_name}": first or "there",
        "{last_name}": (lead.last_name or "").strip(),
        "{full_name}": (lead.full_name or first or "there").strip(),
        "{title}": (lead.title or "").strip(),
        "{company}": company,
        "{email}": (lead.email or "").strip(),
    }
    out = template
    for k, v in repl.items():
        out = out.replace(k, v)
    return out


def _warmup_daily_cap(w: SenderWarmup) -> int:
    """Calc today's permitted cap for this sender (curve described above)."""
    if not w.enabled:
        return w.daily_cap_ceiling
    started = w.started_at or datetime.now(timezone.utc)
    day = (datetime.now(timezone.utc) - started).days + 1
    if day <= 0:
        day = 1
    if day >= (w.ramp_days or 30):
        return w.daily_cap_ceiling
    cap = round(20 * (1.18 ** (day - 1)))
    return min(int(cap), int(w.daily_cap_ceiling))


def _warmup_for_account(
    db: Session, workspace_id: str, account_id: str
) -> SenderWarmup:
    w = (
        db.query(SenderWarmup)
        .filter(SenderWarmup.connected_account_id == account_id)
        .first()
    )
    if w is None:
        w = SenderWarmup(
            workspace_id=workspace_id, connected_account_id=account_id
        )
        db.add(w)
        db.flush()
    # Roll over day if the UTC date changed.
    today = date.today().isoformat()
    if w.day_anchor != today:
        w.sent_today = 0
        w.day_anchor = today
    return w


def _eligible_senders(
    db: Session, campaign: Campaign
) -> list[tuple[ConnectedAccount, SenderWarmup]]:
    """Return (account, warmup) for every sender currently under its daily
    cap. Ordered to start at campaign.rotation_index for round-robin
    fairness across the pool."""
    pool = campaign.sender_account_ids or []
    if not pool:
        # No explicit pool — auto-select every active SMTP/Resend/SendGrid/
        # Gmail account in the workspace.
        accts = (
            db.query(ConnectedAccount)
            .filter(
                ConnectedAccount.workspace_id == campaign.workspace_id,
                ConnectedAccount.provider.in_(
                    ("smtp", "gmail", "resend", "sendgrid")
                ),
                ConnectedAccount.status == "active",
            )
            .all()
        )
    else:
        accts = (
            db.query(ConnectedAccount)
            .filter(
                ConnectedAccount.id.in_(pool),
                ConnectedAccount.workspace_id == campaign.workspace_id,
                ConnectedAccount.status == "active",
            )
            .all()
        )
    out: list[tuple[ConnectedAccount, SenderWarmup]] = []
    for a in accts:
        w = _warmup_for_account(db, campaign.workspace_id, a.id)
        cap = _warmup_daily_cap(w)
        if w.sent_today < cap:
            out.append((a, w))
    # Rotate starting at the campaign's rotation_index so consecutive ticks
    # advance through the pool.
    if out:
        idx = campaign.rotation_index % len(out)
        out = out[idx:] + out[:idx]
    return out


# ──────────────────────────────────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────────────────────────────────


class CampaignCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    subject: str = Field(default="", max_length=500)
    preheader: Optional[str] = Field(default=None, max_length=500)
    body_html: str = ""
    body_text: Optional[str] = None
    lead_ids: Optional[list[str]] = None
    stage_id: Optional[str] = None
    sender_account_ids: list[str] = []
    batch_size: int = 8
    seconds_between_sends: int = 30
    warmup_enabled: bool = True


# ──────────────────────────────────────────────────────────────────────────
# Endpoints — CRUD + lifecycle
# ──────────────────────────────────────────────────────────────────────────


@router.get("")
def list_campaigns(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Campaign)
        .filter(Campaign.workspace_id == ctx.workspace_id)
        .order_by(Campaign.created_at.desc())
        .limit(200)
        .all()
    )
    return [
        {
            "id": c.id,
            "name": c.name,
            "subject": c.subject,
            "status": c.status,
            "total_recipients": c.total_recipients,
            "sent_count": c.sent_count,
            "failed_count": c.failed_count,
            "skipped_count": c.skipped_count,
            "created_at": c.created_at,
            "started_at": c.started_at,
            "finished_at": c.finished_at,
        }
        for c in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_campaign(
    body: CampaignCreateIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Create a campaign and materialise its CampaignRecipient rows
    immediately. Recipients are a SNAPSHOT — new leads added to the
    workspace after the campaign was created won't be auto-included.
    """
    c = Campaign(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        name=body.name.strip(),
        subject=(body.subject or "").strip(),
        preheader=(body.preheader or "").strip() or None,
        body_html=body.body_html or "",
        body_text=body.body_text,
        recipient_filter={
            "lead_ids": body.lead_ids,
            "stage_id": body.stage_id,
        },
        sender_account_ids=body.sender_account_ids or [],
        batch_size=max(1, min(50, body.batch_size)),
        seconds_between_sends=max(0, min(3600, body.seconds_between_sends)),
        warmup_enabled=body.warmup_enabled,
        status="draft",
    )
    db.add(c)
    db.flush()

    # Build the recipient set: leads with a valid email, not suppressed.
    q = db.query(Lead).filter(
        Lead.workspace_id == ctx.workspace_id, Lead.email.isnot(None)
    )
    if body.lead_ids:
        q = q.filter(Lead.id.in_(body.lead_ids))
    if body.stage_id:
        q = q.filter(Lead.stage_id == body.stage_id)
    leads = q.all()
    suppressed = {
        s.email.lower()
        for s in db.query(Suppression).filter(
            Suppression.workspace_id == ctx.workspace_id
        )
    }
    added = 0
    skipped_suppressed = 0
    for lead in leads:
        email = (lead.email or "").strip().lower()
        if not email:
            continue
        if email in suppressed:
            skipped_suppressed += 1
            continue
        db.add(
            CampaignRecipient(
                campaign_id=c.id,
                lead_id=lead.id,
                email=lead.email,
                status="pending",
            )
        )
        added += 1
    c.total_recipients = added
    c.skipped_count = skipped_suppressed
    db.commit()
    db.refresh(c)
    return {
        "id": c.id,
        "name": c.name,
        "status": c.status,
        "total_recipients": c.total_recipients,
        "skipped_suppressed": skipped_suppressed,
    }


@router.get("/{campaign_id}")
def get_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_campaign(db, ctx, campaign_id)
    return {
        "id": c.id,
        "name": c.name,
        "subject": c.subject,
        "preheader": c.preheader,
        "body_html": c.body_html,
        "body_text": c.body_text,
        "recipient_filter": c.recipient_filter,
        "sender_account_ids": c.sender_account_ids,
        "rotation_index": c.rotation_index,
        "batch_size": c.batch_size,
        "seconds_between_sends": c.seconds_between_sends,
        "warmup_enabled": c.warmup_enabled,
        "status": c.status,
        "scheduled_for": c.scheduled_for,
        "started_at": c.started_at,
        "paused_at": c.paused_at,
        "finished_at": c.finished_at,
        "last_tick_at": c.last_tick_at,
        "total_recipients": c.total_recipients,
        "sent_count": c.sent_count,
        "failed_count": c.failed_count,
        "skipped_count": c.skipped_count,
        "error": c.error,
        "created_at": c.created_at,
    }


@router.get("/{campaign_id}/recipients")
def list_recipients(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    limit: int = 100,
    status_filter: Optional[str] = None,
):
    """List a campaign's recipients with current status — drives the
    progress table on the Campaign Detail page."""
    _own_campaign(db, ctx, campaign_id)
    q = db.query(CampaignRecipient).filter(
        CampaignRecipient.campaign_id == campaign_id
    )
    if status_filter:
        q = q.filter(CampaignRecipient.status == status_filter)
    q = q.order_by(CampaignRecipient.created_at.asc()).limit(limit)
    rows = q.all()
    leads_by_id = {
        l.id: l
        for l in db.query(Lead)
        .filter(Lead.id.in_([r.lead_id for r in rows]))
        .all()
    } if rows else {}
    return [
        {
            "id": r.id,
            "lead_id": r.lead_id,
            "lead_name": (leads_by_id.get(r.lead_id).full_name if leads_by_id.get(r.lead_id) else None),
            "email": r.email,
            "status": r.status,
            "error": r.error,
            "sent_at": r.sent_at,
            "sender_account_id": r.sender_account_id,
        }
        for r in rows
    ]


@router.post("/{campaign_id}/start")
def start_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_campaign(db, ctx, campaign_id)
    if c.status not in ("draft", "scheduled", "paused"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"cannot_start_in_state:{c.status}",
        )
    # Validate at least one sender is available.
    if not _eligible_senders(db, c):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "no_eligible_senders — connect an SMTP / Resend / SendGrid / Gmail sender or wait for warmup cap to reset",
        )
    c.status = "sending"
    if c.started_at is None:
        c.started_at = datetime.now(timezone.utc)
    c.paused_at = None
    c.error = None
    db.commit()
    # Process one tick inline so the UI sees immediate progress.
    return _process_tick(db, c, ctx_user_id=ctx.user_id)


@router.post("/{campaign_id}/pause")
def pause_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_campaign(db, ctx, campaign_id)
    if c.status != "sending":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"cannot_pause_in_state:{c.status}",
        )
    c.status = "paused"
    c.paused_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": c.status}


@router.post("/{campaign_id}/resume")
def resume_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_campaign(db, ctx, campaign_id)
    if c.status != "paused":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"cannot_resume_in_state:{c.status}",
        )
    c.status = "sending"
    c.paused_at = None
    db.commit()
    return _process_tick(db, c, ctx_user_id=ctx.user_id)


@router.post("/{campaign_id}/cancel")
def cancel_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_campaign(db, ctx, campaign_id)
    if c.status in ("completed", "cancelled"):
        return {"status": c.status}
    c.status = "cancelled"
    c.finished_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": c.status}


@router.post("/{campaign_id}/tick")
def tick_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Advance the campaign by one batch. Called by the frontend's poll
    loop and (optionally) by Celery beat. Idempotent — only processes
    recipients in `status="pending"`."""
    c = _own_campaign(db, ctx, campaign_id)
    return _process_tick(db, c, ctx_user_id=ctx.user_id)


@router.get("/{campaign_id}/status")
def campaign_status(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Lightweight read for the frontend's progress poll — no recipient
    rows, just counters."""
    c = _own_campaign(db, ctx, campaign_id)
    return {
        "id": c.id,
        "status": c.status,
        "total_recipients": c.total_recipients,
        "sent_count": c.sent_count,
        "failed_count": c.failed_count,
        "skipped_count": c.skipped_count,
        "pending_count": max(
            0,
            c.total_recipients - c.sent_count - c.failed_count - c.skipped_count,
        ),
        "last_tick_at": c.last_tick_at,
        "error": c.error,
    }


# ──────────────────────────────────────────────────────────────────────────
# Sender + warmup endpoints
# ──────────────────────────────────────────────────────────────────────────


@router.get("/senders/list")
def list_senders(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Every email-capable connected account in the workspace, with its
    current warmup state. Powers the sender-picker on the campaign wizard
    and the per-sender status pills on the Senders settings page."""
    accts = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider.in_(
                ("smtp", "gmail", "resend", "sendgrid")
            ),
        )
        .order_by(ConnectedAccount.created_at.asc())
        .all()
    )
    out = []
    for a in accts:
        w = _warmup_for_account(db, ctx.workspace_id, a.id)
        cap = _warmup_daily_cap(w)
        out.append(
            {
                "id": a.id,
                "provider": a.provider,
                "label": a.label,
                "from_address": a.external_id,
                "status": a.status,
                "warmup": {
                    "enabled": w.enabled,
                    "started_at": w.started_at,
                    "ramp_days": w.ramp_days,
                    "daily_cap_ceiling": w.daily_cap_ceiling,
                    "daily_cap_today": cap,
                    "sent_today": w.sent_today,
                    "total_sent": w.total_sent,
                    "day": (
                        (datetime.now(timezone.utc) - w.started_at).days + 1
                        if w.started_at
                        else 1
                    ),
                },
            }
        )
    db.commit()
    return out


class WarmupPatchIn(BaseModel):
    enabled: Optional[bool] = None
    ramp_days: Optional[int] = Field(default=None, ge=1, le=365)
    daily_cap_ceiling: Optional[int] = Field(default=None, ge=1, le=100_000)
    reset_day: Optional[bool] = None


@router.patch("/senders/{account_id}/warmup")
def patch_warmup(
    account_id: str,
    body: WarmupPatchIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    acct = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.id == account_id,
            ConnectedAccount.workspace_id == ctx.workspace_id,
        )
        .first()
    )
    if not acct:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sender_not_found")
    w = _warmup_for_account(db, ctx.workspace_id, account_id)
    if body.enabled is not None:
        w.enabled = body.enabled
    if body.ramp_days is not None:
        w.ramp_days = body.ramp_days
    if body.daily_cap_ceiling is not None:
        w.daily_cap_ceiling = body.daily_cap_ceiling
    if body.reset_day:
        w.started_at = datetime.now(timezone.utc)
        w.sent_today = 0
    db.commit()
    return {
        "id": w.id,
        "enabled": w.enabled,
        "ramp_days": w.ramp_days,
        "daily_cap_ceiling": w.daily_cap_ceiling,
        "sent_today": w.sent_today,
    }


# ──────────────────────────────────────────────────────────────────────────
# Suppressions endpoints
# ──────────────────────────────────────────────────────────────────────────


@router.get("/suppressions/list")
def list_suppressions(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Suppression)
        .filter(Suppression.workspace_id == ctx.workspace_id)
        .order_by(Suppression.created_at.desc())
        .limit(500)
        .all()
    )
    return [
        {
            "id": s.id,
            "email": s.email,
            "reason": s.reason,
            "created_at": s.created_at,
        }
        for s in rows
    ]


class SuppressionAddIn(BaseModel):
    emails: list[str]
    reason: str = "manual"


@router.post("/suppressions")
def add_suppressions(
    body: SuppressionAddIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    added = 0
    for raw in body.emails:
        e = (raw or "").strip().lower()
        if "@" not in e:
            continue
        existing = (
            db.query(Suppression)
            .filter(
                Suppression.workspace_id == ctx.workspace_id,
                Suppression.email == e,
            )
            .first()
        )
        if existing:
            continue
        db.add(
            Suppression(
                workspace_id=ctx.workspace_id, email=e, reason=body.reason
            )
        )
        added += 1
    db.commit()
    return {"added": added}


@router.delete("/suppressions/{suppression_id}")
def delete_suppression(
    suppression_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    s = (
        db.query(Suppression)
        .filter(
            Suppression.id == suppression_id,
            Suppression.workspace_id == ctx.workspace_id,
        )
        .first()
    )
    if s:
        db.delete(s)
        db.commit()
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
# THE SEND LOOP
# ──────────────────────────────────────────────────────────────────────────


def _process_tick(db: Session, campaign: Campaign, ctx_user_id: Optional[str] = None) -> dict:
    """Advance the campaign by up to `batch_size` recipients.

    Honoured by both the frontend poll AND the Celery beat task — both
    point at the same path. Idempotent: only `status="pending"` rows are
    eligible, transitions go pending → sending → sent/failed/skipped
    under a SELECT…FOR UPDATE row lock so concurrent ticks can't double-
    send.
    """
    from app.services.email_sender import send_email_message

    campaign.last_tick_at = datetime.now(timezone.utc)
    if campaign.status != "sending":
        db.commit()
        return _stats(campaign, sent=0, failed=0, skipped=0)

    # Build (sender, warmup) eligible pool.
    eligible = _eligible_senders(db, campaign)
    if not eligible:
        # All senders capped — keep the campaign as "sending" but no-op
        # this tick; next call will recheck after midnight UTC reset.
        db.commit()
        return _stats(campaign, sent=0, failed=0, skipped=0, note="warmup_capped")

    # Refresh suppressions for this tick.
    suppressed = {
        s.email.lower()
        for s in db.query(Suppression).filter(
            Suppression.workspace_id == campaign.workspace_id
        )
    }

    # Claim a batch of pending recipients.
    batch = (
        db.query(CampaignRecipient)
        .filter(
            CampaignRecipient.campaign_id == campaign.id,
            CampaignRecipient.status == "pending",
        )
        .order_by(CampaignRecipient.created_at.asc())
        .limit(int(campaign.batch_size or 8))
        .with_for_update(skip_locked=True)
        .all()
    )
    if not batch:
        _maybe_finalize(db, campaign)
        return _stats(campaign, sent=0, failed=0, skipped=0)

    sent = failed = skipped = 0
    rotation_index = campaign.rotation_index or 0

    for r in batch:
        # Workspace suppression check.
        if (r.email or "").lower() in suppressed:
            r.status = "skipped"
            r.error = "suppressed"
            campaign.skipped_count = (campaign.skipped_count or 0) + 1
            skipped += 1
            continue

        # Pick the next sender that's still under its warmup cap.
        sender = None
        warmup = None
        for i in range(len(eligible)):
            cand_acct, cand_warm = eligible[(rotation_index + i) % len(eligible)]
            if cand_warm.sent_today < _warmup_daily_cap(cand_warm):
                sender, warmup = cand_acct, cand_warm
                rotation_index = (rotation_index + i + 1) % len(eligible)
                break
        if not sender:
            break  # all senders capped mid-batch

        # Materialise the EmailMessage row, render merge tags, dispatch.
        lead = db.get(Lead, r.lead_id)
        if not lead:
            r.status = "skipped"
            r.error = "lead_not_found"
            campaign.skipped_count = (campaign.skipped_count or 0) + 1
            skipped += 1
            continue
        subject = _render_token(campaign.subject or "", lead)
        body_html = _render_token(campaign.body_html or "", lead)
        body_text = _render_token(campaign.body_text or "", lead) if campaign.body_text else None

        thread = EmailThread(
            workspace_id=campaign.workspace_id,
            lead_id=lead.id,
            subject=subject,
        )
        db.add(thread)
        db.flush()
        msg = EmailMessage(
            workspace_id=campaign.workspace_id,
            thread_id=thread.id,
            lead_id=lead.id,
            direction="outbound",
            from_address=sender.external_id or "",
            to_address=r.email,
            subject=subject,
            body_html=body_html,
            body_text=body_text,
            status="queued",
        )
        db.add(msg)
        db.flush()
        r.message_id = msg.id
        r.sender_account_id = sender.id
        r.status = "sending"
        db.flush()

        # Dispatch through the existing transport layer — this picks the
        # right sender stack (Resend, SendGrid, Gmail HTTPS, or SMTP via
        # the Vercel relay) and stamps msg.status / sent_at / error.
        try:
            ws = db.get(Workspace, campaign.workspace_id)
            if ws is None:
                r.status = "failed"
                r.error = "workspace_missing"
                campaign.failed_count = (campaign.failed_count or 0) + 1
                failed += 1
                continue
            result = send_email_message(
                db,
                msg,
                ws,
                user_id=ctx_user_id or campaign.user_id,
            )
            if result.ok:
                r.status = "sent"
                r.sent_at = datetime.now(timezone.utc)
                warmup.sent_today += 1
                warmup.total_sent += 1
                campaign.sent_count = (campaign.sent_count or 0) + 1
                sent += 1
                db.add(
                    Activity(
                        workspace_id=campaign.workspace_id,
                        lead_id=lead.id,
                        actor_id=campaign.user_id,
                        type="campaign_sent",
                        payload={
                            "campaign_id": campaign.id,
                            "subject": subject,
                            "from": sender.external_id,
                        },
                    )
                )
            else:
                r.status = "failed"
                r.error = (result.error or "send_failed")[:500]
                campaign.failed_count = (campaign.failed_count or 0) + 1
                failed += 1
                # Auto-suppress on hard auth/permanent failures so we don't
                # keep hammering a known-bad address.
                low_err = (result.error or "").lower()
                if any(s in low_err for s in ("550", "bounce", "rejected", "invalid recipient")):
                    db.add(
                        Suppression(
                            workspace_id=campaign.workspace_id,
                            email=(r.email or "").lower(),
                            reason="bounce",
                            source_campaign_id=campaign.id,
                        )
                    )
        except Exception as exc:  # noqa: BLE001
            r.status = "failed"
            r.error = str(exc)[:500]
            campaign.failed_count = (campaign.failed_count or 0) + 1
            failed += 1

    campaign.rotation_index = rotation_index
    _maybe_finalize(db, campaign)
    db.commit()
    return _stats(campaign, sent=sent, failed=failed, skipped=skipped)


def _maybe_finalize(db: Session, campaign: Campaign) -> None:
    remaining = (
        db.query(func.count(CampaignRecipient.id))
        .filter(
            CampaignRecipient.campaign_id == campaign.id,
            CampaignRecipient.status.in_(("pending", "sending")),
        )
        .scalar()
        or 0
    )
    if remaining == 0:
        campaign.status = "completed"
        campaign.finished_at = datetime.now(timezone.utc)


def _stats(campaign: Campaign, sent: int, failed: int, skipped: int, note: Optional[str] = None) -> dict:
    return {
        "id": campaign.id,
        "status": campaign.status,
        "this_tick": {"sent": sent, "failed": failed, "skipped": skipped},
        "totals": {
            "total_recipients": campaign.total_recipients,
            "sent_count": campaign.sent_count,
            "failed_count": campaign.failed_count,
            "skipped_count": campaign.skipped_count,
        },
        "note": note,
    }
