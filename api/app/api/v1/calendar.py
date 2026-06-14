"""Calendar sync + reminders API.

Google Calendar connection (real OAuth), availability (free/busy), reminder
CRUD, and the AI daily agenda. Outlook/Microsoft will reuse the same router +
Reminder model in a fast-follow.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.core.security import create_access_token, decode_token
from app.models import ConnectedAccount, Lead, Reminder, Workspace
from app.services import google_calendar as gcal
from app.services import reminders as rsvc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/calendar", tags=["calendar"])
_settings = get_settings()


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #

def _serialize_reminder(r: Reminder) -> dict:
    return {
        "id": r.id,
        "title": r.title,
        "body": r.body,
        "remind_at": r.remind_at,
        "duration_minutes": r.duration_minutes,
        "channel": r.channel,
        "status": r.status,
        "source": r.source,
        "lead_id": r.lead_id,
        "external_event_id": r.external_event_id,
        "target_calendar_id": r.target_calendar_id,
        "payload": r.payload or {},
        "sent_at": r.sent_at,
        "error": r.error,
        "created_at": r.created_at,
        "done_at": r.done_at,
        "escalate": r.escalate,
        "nudge_count": r.nudge_count,
    }


# --------------------------------------------------------------------------- #
# Connection status + OAuth
# --------------------------------------------------------------------------- #

def _ws_google_creds(workspace) -> tuple[str, str]:
    """Resolve the Google OAuth client for a workspace: a UI-saved (BYO) pair in
    workspace.settings['google_oauth'], else the server env vars."""
    g = (workspace.settings or {}).get("google_oauth") or {}
    return gcal.resolve_client(g.get("client_id"), g.get("client_secret"))


@router.get("/status")
def calendar_status(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
    connected = account is not None
    cid, csec = _ws_google_creds(ctx.workspace)
    has_ws_creds = bool(((ctx.workspace.settings or {}).get("google_oauth") or {}).get("client_id"))
    return {
        "configured": bool(cid and csec),
        "server_configured": gcal.is_configured(),
        "has_workspace_credentials": has_ws_creds,
        "connected": connected,
        "provider": "google_calendar" if connected else None,
        # Reminder prefs live per-user and work over email/SMTP even with no
        # calendar connected, so they're returned independently of `calendar`.
        "delivery": rsvc.delivery_options(db, ctx.workspace_id, ctx.user_id),
        "prefs": {
            "agenda": rsvc.agenda_config(ctx.workspace, ctx.user_id),
            "auto_reminders": rsvc.auto_reminder_config(ctx.workspace, ctx.user_id),
        },
        "calendar": (
            {
                "id": account.id,
                "email": account.external_id,
                "label": account.label,
                "status": account.status,
                "write_calendar_id": rsvc._write_calendar_id(account),
                "conflict_calendar_ids": rsvc.conflict_calendar_ids(account),
                "calendars": (account.config or {}).get("calendars", []),
            }
            if account
            else None
        ),
        "redirect_uri": _settings.resolved_google_redirect_uri,
    }


class GoogleCredsIn(BaseModel):
    client_id: str
    client_secret: str


@router.post("/google-credentials")
def save_google_credentials(
    body: GoogleCredsIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Save a per-workspace Google OAuth client (BYO) so the Connect button works
    with no backend env vars. Admin/owner only."""
    from sqlalchemy.orm.attributes import flag_modified

    if ctx.membership.role not in {"owner", "admin"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin_only")
    cid = (body.client_id or "").strip()
    csec = (body.client_secret or "").strip()
    if not cid or not csec:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "client_id_and_secret_required")
    settings = dict(ctx.workspace.settings or {})
    settings["google_oauth"] = {"client_id": cid, "client_secret": csec}
    ctx.workspace.settings = settings
    flag_modified(ctx.workspace, "settings")
    db.commit()
    return {"ok": True, "redirect_uri": _settings.resolved_google_redirect_uri}


@router.get("/connect/google")
def connect_google(ctx: AuthContext = Depends(get_workspace_context)):
    """Return the Google consent URL. The frontend opens it; Google redirects
    back to the callback below with a signed state we minted here."""
    cid, csec = _ws_google_creds(ctx.workspace)
    if not (cid and csec):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "google_calendar_not_configured: add a Google OAuth client (Client ID + Secret) here, or set "
            "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the backend.",
        )
    state = create_access_token(
        subject=ctx.user_id,
        extra={"ws": ctx.workspace_id, "purpose": "gcal_oauth"},
        expires_minutes=15,
    )
    return {"url": gcal.build_consent_url(state, client_id=cid, client_secret=csec)}


@router.get("/oauth/google/callback")
def google_callback(
    code: Optional[str] = Query(default=None),
    state: Optional[str] = Query(default=None),
    error: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """OAuth redirect target (hit by the browser, not XHR — no auth header, so we
    trust the signed `state`). Exchanges the code, stores tokens on a
    ConnectedAccount, caches the calendar list, and bounces back to the app."""
    frontend = _settings.primary_frontend_origin
    if error or not code or not state:
        return RedirectResponse(f"{frontend}/calendar?connected=error&reason={error or 'missing_code'}")
    try:
        payload = decode_token(state)
        if payload.get("purpose") != "gcal_oauth":
            raise ValueError("bad_purpose")
        user_id = payload.get("sub")
        workspace_id = payload.get("ws")
    except Exception:  # noqa: BLE001
        return RedirectResponse(f"{frontend}/calendar?connected=error&reason=invalid_state")

    workspace = db.get(Workspace, workspace_id)
    if not workspace:
        return RedirectResponse(f"{frontend}/calendar?connected=error&reason=workspace_not_found")
    client_id, client_secret = _ws_google_creds(workspace)
    if not (client_id and client_secret):
        return RedirectResponse(f"{frontend}/calendar?connected=error&reason=not_configured")

    try:
        tokens = gcal.exchange_code(code, client_id=client_id, client_secret=client_secret)
    except Exception as exc:  # noqa: BLE001
        log.warning("google oauth exchange failed: %s", exc)
        return RedirectResponse(f"{frontend}/calendar?connected=error&reason=exchange_failed")

    # Upsert the connection for this (workspace, user, provider).
    account = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == workspace_id,
            ConnectedAccount.user_id == user_id,
            ConnectedAccount.provider == gcal.PROVIDER,
        )
        .first()
    )
    if not account:
        account = ConnectedAccount(
            workspace_id=workspace_id,
            user_id=user_id,
            provider=gcal.PROVIDER,
            config={},
        )
        db.add(account)
    account.external_id = tokens.get("email") or account.external_id
    account.label = f"Google Calendar ({tokens.get('email') or 'connected'})"
    account.access_token = tokens.get("access_token")
    if tokens.get("refresh_token"):
        account.refresh_token = tokens["refresh_token"]
    account.token_expires_at = tokens.get("expiry")
    account.status = "active"
    db.flush()

    # Cache the calendar list + default the write/conflict calendars to primary.
    try:
        creds = gcal.ensure_credentials(db, account)
        cals = gcal.list_calendars(creds) if creds else []
    except Exception as exc:  # noqa: BLE001
        log.warning("calendar list after connect failed: %s", exc)
        cals = []
    primary_id = next((c["id"] for c in cals if c.get("primary")), (cals[0]["id"] if cals else "primary"))
    cfg = dict(account.config or {})
    cfg["calendars"] = cals
    # Persist the OAuth client this account was connected with so background
    # token refresh works even when creds live only in workspace settings.
    cfg["oauth_client_id"] = client_id
    cfg["oauth_client_secret"] = client_secret
    cfg.setdefault("write_calendar_id", primary_id)
    cfg.setdefault("conflict_calendar_ids", [primary_id])
    cfg.setdefault("agenda", {"enabled": True, "hour": 8, "channels": ["calendar"]})
    cfg.setdefault("auto_reminders", {"inbox_reply": True, "stage_change": True, "note": True, "default_offset_minutes": 60})
    account.config = cfg
    db.commit()

    return RedirectResponse(f"{frontend}/calendar?connected=google")


@router.delete("/connection")
def disconnect(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
    if account:
        db.delete(account)
        db.commit()
    return {"ok": True}


@router.get("/calendars")
def list_calendars(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_connected")
    creds = gcal.ensure_credentials(db, account)
    if not creds:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "calendar_auth_failed")
    cals = gcal.list_calendars(creds)
    # Refresh the cache so the config page stays current.
    cfg = dict(account.config or {})
    cfg["calendars"] = cals
    account.config = cfg
    db.commit()
    return {
        "calendars": cals,
        "write_calendar_id": rsvc._write_calendar_id(account),
        "conflict_calendar_ids": rsvc.conflict_calendar_ids(account),
    }


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

class CalendarConfigIn(BaseModel):
    write_calendar_id: Optional[str] = None
    conflict_calendar_ids: Optional[list[str]] = None
    agenda: Optional[dict] = None
    auto_reminders: Optional[dict] = None


@router.patch("/config")
def update_config(
    body: CalendarConfigIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    # Reminder prefs (agenda + auto-reminders) are saved per-user regardless of
    # whether a calendar is connected — so SMTP-only users can configure them.
    if body.agenda is not None or body.auto_reminders is not None:
        rsvc.set_prefs(
            db, ctx.workspace, ctx.user_id,
            agenda=body.agenda, auto_reminders=body.auto_reminders,
        )
    # Calendar-specific roles only apply when a calendar is connected.
    account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
    if account and (body.write_calendar_id is not None or body.conflict_calendar_ids is not None):
        cfg = dict(account.config or {})
        if body.write_calendar_id is not None:
            cfg["write_calendar_id"] = body.write_calendar_id
        if body.conflict_calendar_ids is not None:
            cfg["conflict_calendar_ids"] = body.conflict_calendar_ids
        account.config = cfg
        db.commit()
    return {
        "agenda": rsvc.agenda_config(ctx.workspace, ctx.user_id),
        "auto_reminders": rsvc.auto_reminder_config(ctx.workspace, ctx.user_id),
        "write_calendar_id": rsvc._write_calendar_id(account) if account else None,
        "conflict_calendar_ids": rsvc.conflict_calendar_ids(account) if account else [],
    }


# --------------------------------------------------------------------------- #
# Availability
# --------------------------------------------------------------------------- #

@router.get("/availability")
def availability(
    from_: Optional[str] = Query(default=None, alias="from"),
    to: Optional[str] = Query(default=None),
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Merged busy intervals across the user's conflict-check calendars — the
    foundation the future booking engine will subtract open slots from."""
    account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_connected")
    creds = gcal.ensure_credentials(db, account)
    if not creds:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "calendar_auth_failed")
    now = datetime.now(timezone.utc)
    time_min = _parse_dt(from_) or now
    time_max = _parse_dt(to) or (now + timedelta(days=7))
    busy = gcal.freebusy(creds, rsvc.conflict_calendar_ids(account), time_min, time_max)
    return {"time_min": time_min, "time_max": time_max, "busy": busy}


# --------------------------------------------------------------------------- #
# Reminders
# --------------------------------------------------------------------------- #

@router.get("/reminders")
def list_reminders(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    q = db.query(Reminder).filter(
        Reminder.workspace_id == ctx.workspace_id,
        Reminder.user_id == ctx.user_id,
    )
    if status_filter:
        q = q.filter(Reminder.status == status_filter)
    rows = q.order_by(Reminder.remind_at.asc()).limit(limit).all()
    return {"reminders": [_serialize_reminder(r) for r in rows]}


class ReminderIn(BaseModel):
    title: str
    remind_at: datetime
    body: str = ""
    channel: str = "calendar"
    lead_id: Optional[str] = None
    duration_minutes: int = 15
    target_calendar_id: Optional[str] = None
    escalate: bool = True


@router.post("/reminders")
def create_reminder_endpoint(
    body: ReminderIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    if not body.title.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title_required")
    if body.lead_id:
        lead = db.query(Lead).filter(Lead.id == body.lead_id, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")
    rem = rsvc.create_reminder(
        db,
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        title=body.title.strip(),
        remind_at=body.remind_at,
        body=body.body,
        channel=body.channel,
        source="manual",
        lead_id=body.lead_id,
        duration_minutes=body.duration_minutes,
        target_calendar_id=body.target_calendar_id,
        escalate=body.escalate,
    )
    return _serialize_reminder(rem)


class ReminderPatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    remind_at: Optional[datetime] = None
    status: Optional[str] = None  # allow "cancelled"
    duration_minutes: Optional[int] = None
    escalate: Optional[bool] = None
    done: Optional[bool] = None  # mark complete → stops escalation nudges


@router.patch("/reminders/{reminder_id}")
def update_reminder(
    reminder_id: str,
    body: ReminderPatch,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rem = (
        db.query(Reminder)
        .filter(Reminder.id == reminder_id, Reminder.workspace_id == ctx.workspace_id, Reminder.user_id == ctx.user_id)
        .first()
    )
    if not rem:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    data = body.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in {"pending", "cancelled"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_status")
    # Mark done → stop the relentless nudges.
    if "done" in data:
        done = data.pop("done")
        if done:
            from datetime import timezone as _tz

            rem.done_at = datetime.now(_tz.utc)
            rem.next_nudge_at = None
        else:
            rem.done_at = None
    for k, v in data.items():
        setattr(rem, k, v)
    # If it was already written to the calendar and got rescheduled, push the
    # change out so the calendar block moves too.
    if "remind_at" in data and rem.external_event_id and rem.status == "sent":
        account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
        creds = gcal.ensure_credentials(db, account) if account else None
        if creds and account:
            start = rem.remind_at
            gcal.update_event(
                creds, rsvc._write_calendar_id(account), rem.external_event_id,
                summary=rem.title, description=rem.body or "",
                start=start, end=start + timedelta(minutes=rem.duration_minutes or 15),
            )
    db.commit()
    db.refresh(rem)
    return _serialize_reminder(rem)


@router.delete("/reminders/{reminder_id}")
def delete_reminder(
    reminder_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rem = (
        db.query(Reminder)
        .filter(Reminder.id == reminder_id, Reminder.workspace_id == ctx.workspace_id, Reminder.user_id == ctx.user_id)
        .first()
    )
    if not rem:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    # Best-effort remove the calendar block too.
    if rem.external_event_id:
        account = rsvc.calendar_account_for(db, ctx.workspace_id, ctx.user_id)
        creds = gcal.ensure_credentials(db, account) if account else None
        if creds and account:
            gcal.delete_event(creds, rsvc._write_calendar_id(account), rem.external_event_id)
    db.delete(rem)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Daily agenda
# --------------------------------------------------------------------------- #

@router.post("/agenda/generate")
def generate_agenda(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    # Works over email/SMTP or calendar — needs only one delivery channel.
    workspace = db.get(Workspace, ctx.workspace_id)
    rem = rsvc.generate_daily_agenda(db, workspace=workspace, user_id=ctx.user_id, force=True)
    if not rem:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "agenda_unavailable: connect a calendar or an email account to receive your agenda.",
        )
    return _serialize_reminder(rem)


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        return None
