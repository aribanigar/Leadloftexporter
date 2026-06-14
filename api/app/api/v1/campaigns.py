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

import re
import secrets
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
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


# {token} merge for free-form CSV / pasted recipients that aren't CRM leads.
_MERGE_RE = re.compile(r"\{(\w+)\}")


def _render_merge(template: str, merge: dict, email: str = "") -> str:
    """Substitute {column} tokens from a per-recipient merge dict. Unknown
    tokens are left intact (matches the provided module's behaviour). A
    couple of universal fallbacks (`{email}`) are always available."""
    if not template:
        return template
    data = dict(merge or {})
    data.setdefault("email", email)

    def repl(m: "re.Match[str]") -> str:
        key = m.group(1)
        val = data.get(key)
        return str(val) if val not in (None, "") else m.group(0)

    return _MERGE_RE.sub(repl, template)


def _new_tracking_id() -> str:
    return secrets.token_hex(8)


def _inject_tracking(
    html: str,
    base_url: str,
    campaign_id: str,
    recipient_id: str,
    links: list,
) -> str:
    """Rewrite outbound <a href> links through the click-tracking redirect
    and append a 1×1 open-tracking pixel. `links` is the campaign's link
    registry ([{tracking_id, original_url, clicks}]) and is mutated in place
    so new URLs get a stable tracking id reused across recipients."""
    base = (base_url or "").rstrip("/")
    by_url = {l.get("original_url"): l for l in links if isinstance(l, dict)}

    def repl(m: "re.Match[str]") -> str:
        url = m.group(1)
        entry = by_url.get(url)
        if entry is None:
            entry = {"tracking_id": _new_tracking_id(), "original_url": url, "clicks": 0}
            links.append(entry)
            by_url[url] = entry
        tid = entry["tracking_id"]
        return f'href="{base}/api/v1/track/click/{campaign_id}/{tid}?rid={recipient_id}"'

    processed = re.sub(r'href="(https?://[^"]+)"', repl, html or "")
    pixel = (
        f'<img src="{base}/api/v1/track/open/{campaign_id}/{recipient_id}" '
        'width="1" height="1" alt="" style="display:none" />'
    )
    if "</body>" in processed:
        processed = processed.replace("</body>", pixel + "</body>")
    else:
        processed += pixel
    return processed


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


class FollowUpIn(BaseModel):
    subject: str = ""
    body_html: str = ""
    delay_hours: int = 24
    status: str = "draft"


class RecipientRowIn(BaseModel):
    email: str
    name: Optional[str] = None
    merge: dict = Field(default_factory=dict)


class CampaignCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    subject: str = Field(default="", max_length=500)
    preheader: Optional[str] = Field(default=None, max_length=500)
    body_html: str = ""
    body_amp: Optional[str] = None     # AMP for Email source. Gmail renders this.
    body_text: Optional[str] = None
    preview_text: Optional[str] = Field(default=None, max_length=200)
    brand_color: Optional[str] = Field(default=None, max_length=20)
    # Sender identity (display) + reply routing.
    from_name: Optional[str] = None
    from_email: Optional[str] = None
    reply_to: Optional[str] = None
    # Marketing metadata.
    goal: Optional[str] = None
    tags: list[str] = []
    follow_ups: list[FollowUpIn] = []
    # Personalisation.
    merge_columns: list[str] = []
    # Arbitrary pasted / CSV recipients (NOT tied to CRM leads).
    recipients: list[RecipientRowIn] = []
    manual_emails: list[str] = []
    # CRM lead targeting.
    lead_ids: Optional[list[str]] = None
    stage_id: Optional[str] = None
    include_all_leads: bool = False
    # Throttle / senders.
    sender_account_ids: list[str] = []
    batch_size: int = 8
    seconds_between_sends: int = 30
    daily_limit: Optional[int] = None
    warmup_enabled: bool = True


class CampaignUpdateIn(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    preheader: Optional[str] = None
    body_html: Optional[str] = None
    body_amp: Optional[str] = None
    body_text: Optional[str] = None
    preview_text: Optional[str] = None
    brand_color: Optional[str] = None
    from_name: Optional[str] = None
    from_email: Optional[str] = None
    reply_to: Optional[str] = None
    goal: Optional[str] = None
    tags: Optional[list[str]] = None
    follow_ups: Optional[list[FollowUpIn]] = None
    sender_account_ids: Optional[list[str]] = None
    batch_size: Optional[int] = None
    seconds_between_sends: Optional[int] = None
    warmup_enabled: Optional[bool] = None


_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _split_emails(raw) -> list[str]:
    """Defensive split: any string may be comma/newline/semicolon joined.
    Returns lowercased, regex-validated single addresses only — this is the
    data-leak guard the provided module relies on so no composite address
    ever reaches the transport as one `to`."""
    out: list[str] = []
    items = raw if isinstance(raw, list) else [str(raw or "")]
    for item in items:
        for part in re.split(r"[\n,;]+", str(item)):
            clean = part.strip().lower()
            if clean and _EMAIL_RE.match(clean):
                out.append(clean)
    return out


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
    # Live engagement per campaign in ONE grouped query (same source the
    # detail-page stats endpoint uses) so the list's open/click rates match
    # the report exactly — and never come back NaN from a missing field.
    ids = [c.id for c in rows]
    agg: dict[str, dict[str, int]] = {}
    if ids:
        for cid, st, n in (
            db.query(
                CampaignRecipient.campaign_id,
                CampaignRecipient.status,
                func.count(CampaignRecipient.id),
            )
            .filter(CampaignRecipient.campaign_id.in_(ids))
            .group_by(CampaignRecipient.campaign_id, CampaignRecipient.status)
            .all()
        ):
            agg.setdefault(cid, {})[st] = n

    # Resolve each campaign's sender mailbox(es) so the UI can group campaigns
    # by connected account (same model as the Inbox sidebar). We surface:
    #   - the configured pool (sender_account_ids on the campaign), and
    #   - the actually-used senders observed in CampaignRecipient rows
    # The union (configured ∪ used) becomes `senders` — a list of
    # {id, address, provider, label}.
    acct_rows = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider.in_(("smtp", "gmail", "resend", "sendgrid")),
        )
        .all()
    )
    acct_by_id = {a.id: a for a in acct_rows}

    used_by_campaign: dict[str, set[str]] = {}
    if ids:
        # 1) Recipients that explicitly recorded which account sent them.
        for cid, aid in (
            db.query(
                CampaignRecipient.campaign_id,
                CampaignRecipient.sender_account_id,
            )
            .filter(
                CampaignRecipient.campaign_id.in_(ids),
                CampaignRecipient.sender_account_id.isnot(None),
            )
            .distinct()
            .all()
        ):
            used_by_campaign.setdefault(cid, set()).add(aid)
        # 2) Fallback for older recipient rows that never stored sender_account_id:
        # follow the linked EmailMessage.from_address and match it to a
        # ConnectedAccount.external_id (which is the mailbox address).
        addr_to_acct = {
            (a.external_id or "").lower(): a.id
            for a in acct_rows
            if a.external_id
        }
        if addr_to_acct:
            from_rows = (
                db.query(
                    CampaignRecipient.campaign_id,
                    func.lower(EmailMessage.from_address),
                )
                .join(EmailMessage, EmailMessage.id == CampaignRecipient.message_id)
                .filter(
                    CampaignRecipient.campaign_id.in_(ids),
                    EmailMessage.from_address.isnot(None),
                )
                .distinct()
                .all()
            )
            for cid, addr in from_rows:
                aid = addr_to_acct.get(addr or "")
                if aid:
                    used_by_campaign.setdefault(cid, set()).add(aid)

    out = []
    for c in rows:
        sc = agg.get(c.id, {})
        total = sum(sc.values())
        pending = sc.get("pending", 0) + sc.get("sending", 0)
        sent = total - pending
        opened = sc.get("opened", 0) + sc.get("clicked", 0)
        clicked = sc.get("clicked", 0)
        bounced = sc.get("bounced", 0) + sc.get("failed", 0)
        open_rate = round((opened / sent) * 100) if sent > 0 else 0
        click_rate = round((clicked / sent) * 100) if sent > 0 else 0
        bounce_rate = round((bounced / sent) * 100) if sent > 0 else 0

        # Sender mailboxes: configured pool ∪ actually-used senders
        sender_ids: list[str] = []
        for aid in (c.sender_account_ids or []):
            if aid and aid not in sender_ids:
                sender_ids.append(aid)
        for aid in used_by_campaign.get(c.id, set()):
            if aid not in sender_ids:
                sender_ids.append(aid)
        senders = [
            {
                "id": acct_by_id[aid].id,
                "address": acct_by_id[aid].external_id,
                "provider": acct_by_id[aid].provider,
                "label": acct_by_id[aid].label,
            }
            for aid in sender_ids
            if aid in acct_by_id
        ]

        out.append(
            {
                "id": c.id,
                "name": c.name,
                "subject": c.subject,
                "status": c.status,
                "total_recipients": c.total_recipients,
                "sent_count": sent,
                "failed_count": c.failed_count,
                "skipped_count": c.skipped_count,
                # Live engagement — drives the list's OPEN RATE column.
                "opened_count": opened,
                "clicked_count": clicked,
                "bounced_count": bounced,
                "open_rate": open_rate,
                "click_rate": click_rate,
                "bounce_rate": bounce_rate,
                # Connected mailbox(es) this campaign sends through — used by
                # the frontend to group the campaigns table by sender.
                "senders": senders,
                "created_at": c.created_at,
                "started_at": c.started_at,
                "finished_at": c.finished_at,
            }
        )
    return out


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
        body_amp=(body.body_amp or "").strip() or None,
        body_text=body.body_text,
        preview_text=(body.preview_text or "").strip() or None,
        brand_color=(body.brand_color or "").strip() or None,
        from_name=(body.from_name or "").strip() or None,
        from_email=(body.from_email or "").strip() or None,
        reply_to=(body.reply_to or "").strip() or None,
        goal=body.goal,
        tags=body.tags or [],
        follow_ups=[f.model_dump() for f in body.follow_ups],
        merge_columns=body.merge_columns or [],
        recipient_data=[r.model_dump() for r in body.recipients],
        recipient_sources={
            "manual_emails": body.manual_emails,
            "include_all_leads": body.include_all_leads,
            "lead_ids": body.lead_ids,
            "stage_id": body.stage_id,
        },
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

    suppressed = {
        s.email.lower()
        for s in db.query(Suppression).filter(
            Suppression.workspace_id == ctx.workspace_id
        )
    }

    # Dedup across every recipient source. First-seen wins so an explicit
    # merge row beats a bare manual/lead address.
    seen: set[str] = set()
    skipped_suppressed = 0
    added = 0

    def _add(email: str, name: Optional[str], merge: dict, lead_id: Optional[str]):
        nonlocal added, skipped_suppressed
        e = (email or "").strip().lower()
        if not e or not _EMAIL_RE.match(e) or e in seen:
            return
        seen.add(e)
        if e in suppressed:
            skipped_suppressed += 1
            return
        db.add(
            CampaignRecipient(
                campaign_id=c.id,
                lead_id=lead_id,
                email=e,
                name=name,
                merge_data=merge or {},
                status="pending",
            )
        )
        added += 1

    # 1) Explicit CSV / pasted rows with merge data.
    for row in body.recipients:
        for e in _split_emails(row.email):
            _add(e, row.name, dict(row.merge or {}), None)

    # 2) Plain manual emails (no merge).
    for e in _split_emails(body.manual_emails):
        _add(e, None, {}, None)

    # 3) CRM leads (by id / stage / all).
    if body.lead_ids or body.stage_id or body.include_all_leads:
        q = db.query(Lead).filter(
            Lead.workspace_id == ctx.workspace_id, Lead.email.isnot(None)
        )
        if body.lead_ids:
            q = q.filter(Lead.id.in_(body.lead_ids))
        if body.stage_id:
            q = q.filter(Lead.stage_id == body.stage_id)
        for lead in q.all():
            merge = {
                "first_name": (lead.first_name or "").strip(),
                "last_name": (lead.last_name or "").strip(),
                "full_name": (lead.full_name or "").strip(),
                "title": (lead.title or "").strip(),
            }
            _add(lead.email, lead.full_name, merge, lead.id)

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
    return _campaign_dict(c)


def _campaign_dict(c: Campaign) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "subject": c.subject,
        "preheader": c.preheader,
        "body_html": c.body_html,
        "body_amp": c.body_amp,
        "body_text": c.body_text,
        "preview_text": c.preview_text,
        "brand_color": c.brand_color,
        "from_name": c.from_name,
        "from_email": c.from_email,
        "reply_to": c.reply_to,
        "goal": c.goal,
        "tags": c.tags or [],
        "follow_ups": c.follow_ups or [],
        "merge_columns": c.merge_columns or [],
        "recipient_data": c.recipient_data or [],
        "recipient_sources": c.recipient_sources or {},
        "links": c.links or [],
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
        "opened_count": c.opened_count,
        "clicked_count": c.clicked_count,
        "bounced_count": c.bounced_count,
        "unsubscribed_count": c.unsubscribed_count,
        "error": c.error,
        "created_at": c.created_at,
    }


@router.patch("/{campaign_id}")
def update_campaign(
    campaign_id: str,
    body: CampaignUpdateIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Edit a draft/paused campaign's content + throttle. Recipients are not
    re-resolved here (they're a create-time snapshot)."""
    c = _own_campaign(db, ctx, campaign_id)
    data = body.model_dump(exclude_unset=True)
    if "follow_ups" in data and data["follow_ups"] is not None:
        data["follow_ups"] = [
            f if isinstance(f, dict) else f.model_dump() for f in body.follow_ups
        ]
    for field in (
        "name", "subject", "preheader", "body_html", "body_text",
        "body_amp", "preview_text", "brand_color",
        "from_name", "from_email", "reply_to", "goal", "tags", "follow_ups",
        "sender_account_ids", "warmup_enabled",
    ):
        if field in data and data[field] is not None:
            setattr(c, field, data[field])
    if data.get("batch_size") is not None:
        c.batch_size = max(1, min(50, data["batch_size"]))
    if data.get("seconds_between_sends") is not None:
        c.seconds_between_sends = max(0, min(3600, data["seconds_between_sends"]))
    db.commit()
    db.refresh(c)
    return _campaign_dict(c)


@router.post("/{campaign_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Clone a campaign's content + recipients into a fresh draft."""
    src = _own_campaign(db, ctx, campaign_id)
    dup = Campaign(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        name=f"{src.name} (copy)",
        subject=src.subject,
        preheader=src.preheader,
        body_html=src.body_html,
        body_text=src.body_text,
        from_name=src.from_name,
        from_email=src.from_email,
        reply_to=src.reply_to,
        goal=src.goal,
        tags=list(src.tags or []),
        follow_ups=list(src.follow_ups or []),
        merge_columns=list(src.merge_columns or []),
        recipient_data=list(src.recipient_data or []),
        recipient_sources=dict(src.recipient_sources or {}),
        recipient_filter=dict(src.recipient_filter or {}),
        sender_account_ids=list(src.sender_account_ids or []),
        batch_size=src.batch_size,
        seconds_between_sends=src.seconds_between_sends,
        warmup_enabled=src.warmup_enabled,
        status="draft",
    )
    db.add(dup)
    db.flush()
    added = 0
    for r in db.query(CampaignRecipient).filter(
        CampaignRecipient.campaign_id == src.id
    ):
        db.add(
            CampaignRecipient(
                campaign_id=dup.id,
                lead_id=r.lead_id,
                email=r.email,
                name=r.name,
                merge_data=dict(r.merge_data or {}),
                status="pending",
            )
        )
        added += 1
    dup.total_recipients = added
    db.commit()
    db.refresh(dup)
    return {"id": dup.id, "name": dup.name, "status": dup.status, "total_recipients": added}


_GOAL_BENCHMARKS = {
    "newsletter": (25, 3, "Newsletter"),
    "promotional": (20, 5, "Promotional Offer"),
    "reengagement": (15, 2, "Re-engagement"),
    "vendor_remind": (30, 4, "Vendor Reminder"),
    "verification": (35, 8, "Verification Drive"),
    "listing_drive": (28, 6, "Listing Drive"),
    "announcement": (30, 3, "Announcement"),
    "custom": (20, 3, "Custom"),
}


@router.get("/{campaign_id}/stats")
def campaign_stats(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Post-send deliverability report: rates vs goal benchmark + a plain-
    English analysis. Drives the Campaign Detail report panel."""
    c = _own_campaign(db, ctx, campaign_id)
    rows = (
        db.query(CampaignRecipient.status, func.count(CampaignRecipient.id))
        .filter(CampaignRecipient.campaign_id == campaign_id)
        .group_by(CampaignRecipient.status)
        .all()
    )
    status_counts = {s: n for s, n in rows}
    total = sum(status_counts.values())
    pending = status_counts.get("pending", 0) + status_counts.get("sending", 0)
    # Pre-suppressed recipients (status=failed with no delivery attempt) are
    # intentional skips — they were on the workspace's suppression list at
    # launch because they previously hard-bounced. Lumping them into the
    # campaign's bounce rate is misleading: it makes a freshly-launched
    # campaign of 200 emails read "100% bounced" the instant 10 addresses
    # are skipped, and trips the "Critical Attention" badge before a single
    # email has gone out. Skipped is its own bucket; bounces are only true
    # post-delivery hard failures (status=bounced).
    skipped = c.skipped_count or 0
    delivered = status_counts.get("sent", 0) + status_counts.get("delivered", 0) + status_counts.get("opened", 0) + status_counts.get("clicked", 0)
    bounced = status_counts.get("bounced", 0)
    # `attempted` is what we actually tried to deliver — the only honest
    # denominator for an open/click/bounce rate.
    attempted = delivered + bounced
    # Keep `sent` for backward-compat consumers but redefine it to mean
    # "attempted delivery" rather than "anything that left pending".
    sent = attempted
    opened = status_counts.get("opened", 0) + status_counts.get("clicked", 0)
    clicked = status_counts.get("clicked", 0)

    def pct(n: int, denom: int) -> int:
        return round((n / denom) * 100) if denom > 0 else 0

    open_rate = pct(opened, attempted)
    click_rate = pct(clicked, attempted)
    bounce_rate = pct(bounced, attempted)
    delivery_rate = pct(delivered, attempted)

    open_t, click_t, label = _GOAL_BENCHMARKS.get(c.goal or "", (20, 3, "General"))
    went_well: list[str] = []
    needs_work: list[str] = []
    # Don't render a verdict before there are real attempts to score against.
    # A freshly-launched campaign with 0 delivery attempts (everything still
    # pending, plus some pre-suppressed) shouldn't be flagged "critical" —
    # there's literally nothing to measure yet.
    SCORING_FLOOR = 10  # need at least 10 attempted deliveries for a verdict
    if attempted < SCORING_FLOOR:
        if pending > 0:
            performance = "pending"
            went_well.append(
                f"Campaign is queued — {pending} email{'s' if pending != 1 else ''} waiting to send."
                + (f" ({skipped} skipped from your suppression list — these previously hard-bounced and are auto-protected.)" if skipped else "")
            )
        else:
            performance = "pending"
            needs_work.append("Not enough delivery data yet — performance metrics will appear once sending finishes.")
        goal_achieved = 0
    else:
        performance = "good"
        if open_rate >= open_t:
            went_well.append(f"Open rate {open_rate}% beat the {open_t}% {label} target.")
        elif open_rate >= open_t * 0.7:
            performance = "average"
            needs_work.append(f"Open rate {open_rate}% is close to the {open_t}% target — sharpen the subject line.")
        else:
            performance = "critical"
            needs_work.append(f"Open rate {open_rate}% is below the {open_t}% target — try a more compelling subject line.")
        if click_rate >= click_t:
            went_well.append(f"Click rate {click_rate}% met the {click_t}% target.")
        else:
            needs_work.append(f"Click rate {click_rate}% is below target — strengthen your CTA.")
            if performance != "critical":
                performance = "average"
        if bounce_rate > 10:
            performance = "critical"
            needs_work.append(f"High bounce rate {bounce_rate}% — clean your list.")
        elif bounce_rate <= 2 and attempted > 5:
            went_well.append(f"Excellent list quality — only {bounce_rate}% bounced.")
        goal_achieved = min(99, round((open_rate / open_t) * 50 + (click_rate / click_t) * 50))

    return {
        "campaign": {"name": c.name, "subject": c.subject, "status": c.status, "goal": c.goal, "sent_at": c.started_at},
        "stats": {
            "total": total, "sent": sent, "attempted": attempted, "delivered": delivered,
            "opened": opened, "clicked": clicked, "bounced": bounced,
            "skipped": skipped, "pending": pending,
            "open_rate": open_rate, "click_rate": click_rate, "bounce_rate": bounce_rate, "delivery_rate": delivery_rate,
        },
        "status_counts": status_counts,
        "performance": performance,
        "what_went_well": went_well,
        "what_needs_work": needs_work,
        "analysis": went_well + needs_work,
        "goal_achieved": goal_achieved,
        "goal_label": label,
        "benchmarks": {"open_target": open_t, "click_target": click_t},
        "links": c.links or [],
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


@router.post("/{campaign_id}/prepare-tick")
def prepare_tick(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Prepare the next batch for external sending (Next.js nodemailer layer).

    Returns rendered, tracking-injected email jobs WITH SMTP/API credentials
    so the caller (Vercel serverless) can send them without a separate creds
    lookup. Recipients are marked ``sending``; call /commit-tick with results
    to transition them to sent/failed and update campaign counters."""
    c = _own_campaign(db, ctx, campaign_id)
    return _prepare_tick_batch(db, c, ctx_user_id=ctx.user_id)


@router.post("/{campaign_id}/commit-tick")
def commit_tick(
    campaign_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Record send results from an external sender (Next.js nodemailer layer).

    ``body.results`` is a list of
    ``{recipient_id, message_id, ok, error}`` dicts.
    Updates CampaignRecipient + EmailMessage rows and campaign counters."""
    c = _own_campaign(db, ctx, campaign_id)
    return _commit_tick_results(db, c, body.get("results") or [], ctx_user_id=ctx.user_id)


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

    settings = get_settings()
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
        # Recipients may be CRM leads OR arbitrary pasted/CSV addresses. When
        # there's a lead, prefer its fields; otherwise fall back to the
        # per-recipient merge_data captured at create time.
        lead = db.get(Lead, r.lead_id) if r.lead_id else None
        if lead is not None:
            subject = _render_token(campaign.subject or "", lead)
            body_html = _render_token(campaign.body_html or "", lead)
            body_text = (
                _render_token(campaign.body_text or "", lead)
                if campaign.body_text else None
            )
        else:
            merge = dict(r.merge_data or {})
            subject = _render_merge(campaign.subject or "", merge, r.email)
            body_html = _render_merge(campaign.body_html or "", merge, r.email)
            body_text = (
                _render_merge(campaign.body_text or "", merge, r.email)
                if campaign.body_text else None
            )

        thread = EmailThread(
            workspace_id=campaign.workspace_id,
            lead_id=lead.id if lead is not None else None,
            subject=subject,
        )
        db.add(thread)
        db.flush()
        msg = EmailMessage(
            workspace_id=campaign.workspace_id,
            thread_id=thread.id,
            lead_id=lead.id if lead is not None else None,
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

        # Inject open/click tracking now that we know the recipient row id.
        # `campaign.links` is the shared registry — same URL → same tracking
        # id across recipients. Re-assign so SQLAlchemy flags the JSONB dirty.
        links = list(campaign.links or [])
        msg.body_html = _inject_tracking(
            body_html, settings.public_api_url, campaign.id, r.id, links
        )
        campaign.links = links
        db.flush()

        # Dispatch through the existing transport layer with the rotated
        # sender pinned — this picks the right stack (Resend, SendGrid, Gmail
        # HTTPS, or SMTP via the Vercel relay) and stamps msg.status / error.
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
                account=sender,
            )
            if result.ok:
                r.status = "sent"
                r.sent_at = datetime.now(timezone.utc)
                warmup.sent_today += 1
                warmup.total_sent += 1
                campaign.sent_count = (campaign.sent_count or 0) + 1
                sent += 1
                if lead is not None:
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


def _prepare_tick_batch(
    db: Session, campaign: Campaign, ctx_user_id: Optional[str] = None
) -> dict:
    """Prepare the next batch without sending. Returns email jobs with SMTP/API
    credentials for the Next.js tier to dispatch via nodemailer."""
    settings = get_settings()
    campaign.last_tick_at = datetime.now(timezone.utc)

    if campaign.status != "sending":
        db.commit()
        return {"jobs": [], "campaign_status": campaign.status}

    eligible = _eligible_senders(db, campaign)
    if not eligible:
        db.commit()
        return {"jobs": [], "campaign_status": "sending", "note": "warmup_capped"}

    suppressed = {
        s.email.lower()
        for s in db.query(Suppression).filter(
            Suppression.workspace_id == campaign.workspace_id
        )
    }

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
        db.commit()
        return {"jobs": [], "campaign_status": campaign.status}

    jobs: list[dict] = []
    rotation_index = campaign.rotation_index or 0

    for r in batch:
        if (r.email or "").lower() in suppressed:
            r.status = "skipped"
            r.error = "suppressed"
            campaign.skipped_count = (campaign.skipped_count or 0) + 1
            continue

        sender = None
        for i in range(len(eligible)):
            cand_acct, cand_warm = eligible[(rotation_index + i) % len(eligible)]
            if cand_warm.sent_today < _warmup_daily_cap(cand_warm):
                sender = cand_acct
                rotation_index = (rotation_index + i + 1) % len(eligible)
                break
        if not sender:
            break

        lead = db.get(Lead, r.lead_id) if r.lead_id else None
        if lead:
            subject = _render_token(campaign.subject or "", lead)
            body_html = _render_token(campaign.body_html or "", lead)
            body_text = (
                _render_token(campaign.body_text or "", lead)
                if campaign.body_text else None
            )
            body_amp = (
                _render_token(campaign.body_amp or "", lead)
                if campaign.body_amp else None
            )
        else:
            merge = dict(r.merge_data or {})
            subject = _render_merge(campaign.subject or "", merge, r.email)
            body_html = _render_merge(campaign.body_html or "", merge, r.email)
            body_text = (
                _render_merge(campaign.body_text or "", merge, r.email)
                if campaign.body_text else None
            )
            body_amp = (
                _render_merge(campaign.body_amp or "", merge, r.email)
                if campaign.body_amp else None
            )

        thread = EmailThread(
            workspace_id=campaign.workspace_id,
            lead_id=lead.id if lead else None,
            subject=subject,
        )
        db.add(thread)
        db.flush()
        msg = EmailMessage(
            workspace_id=campaign.workspace_id,
            thread_id=thread.id,
            lead_id=lead.id if lead else None,
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

        links = list(campaign.links or [])
        tracked_html = _inject_tracking(
            body_html, settings.public_api_url, campaign.id, r.id, links
        )
        msg.body_html = tracked_html
        campaign.links = links
        db.flush()

        # Build provider-specific send config (never stored browser-side —
        # these are returned to the Next.js serverless function only).
        cfg = sender.config or {}
        send_config: dict = {"provider": sender.provider}
        if sender.provider == "smtp":
            send_config["smtp"] = {
                "host": cfg.get("host", ""),
                "port": int(cfg.get("port", 587)),
                "username": sender.external_id or cfg.get("username", ""),
                "password": sender.access_token or "",
                "from_email": sender.external_id or "",
            }
        elif sender.provider == "resend":
            send_config["resend_api_key"] = sender.access_token or ""
        elif sender.provider == "sendgrid":
            send_config["sendgrid_api_key"] = sender.access_token or ""

        jobs.append({
            "recipient_id": r.id,
            "message_id": msg.id,
            "to": r.email,
            "from_name": campaign.from_name or "",
            "from_email": sender.external_id or "",
            "subject": subject,
            "html": tracked_html,
            "text": body_text or "",
            "amp_html": body_amp or "",
            "preview_text": campaign.preview_text or "",
            "send_config": send_config,
        })

    campaign.rotation_index = rotation_index
    db.commit()
    return {"jobs": jobs, "campaign_status": campaign.status}


def _commit_tick_results(
    db: Session, campaign: Campaign, results: list, ctx_user_id: Optional[str] = None
) -> dict:
    """Apply send results from an external sender and update campaign counters."""
    sent = failed = skipped = 0

    for res in results:
        rid = res.get("recipient_id")
        ok = bool(res.get("ok"))
        error = str(res.get("error") or "")

        r = (
            db.query(CampaignRecipient)
            .filter(CampaignRecipient.id == rid)
            .first()
        )
        if not r:
            continue

        msg = (
            db.query(EmailMessage).filter(EmailMessage.id == r.message_id).first()
            if r.message_id else None
        )

        if ok:
            r.status = "sent"
            r.sent_at = datetime.now(timezone.utc)
            if msg:
                msg.status = "sent"
            campaign.sent_count = (campaign.sent_count or 0) + 1
            sent += 1
            # Bump warmup counters for the sender that actually sent this email
            # so the ramp curve advances in real time and `_eligible_senders`
            # starts skipping it once today's cap is hit.
            if r.sender_account_id:
                warmup = _warmup_for_account(
                    db, campaign.workspace_id, r.sender_account_id
                )
                warmup.sent_today = (warmup.sent_today or 0) + 1
                warmup.total_sent = (warmup.total_sent or 0) + 1
            if r.lead_id:
                lead = db.get(Lead, r.lead_id)
                if lead:
                    db.add(Activity(
                        workspace_id=campaign.workspace_id,
                        lead_id=lead.id,
                        actor_id=ctx_user_id or campaign.user_id,
                        type="campaign_sent",
                        payload={
                            "campaign_id": campaign.id,
                            "subject": r.message_id,
                        },
                    ))
        else:
            r.status = "failed"
            r.error = error[:500]
            if msg:
                msg.status = "failed"
                msg.error = r.error
            campaign.failed_count = (campaign.failed_count or 0) + 1
            failed += 1
            low_err = error.lower()
            if any(s in low_err for s in ("550", "bounce", "rejected", "invalid recipient")):
                db.add(Suppression(
                    workspace_id=campaign.workspace_id,
                    email=(r.email or "").lower(),
                    reason="bounce",
                    source_campaign_id=campaign.id,
                ))

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
