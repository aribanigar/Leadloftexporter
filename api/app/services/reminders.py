"""Reminder engine + AI daily agenda.

A *reminder* is a time-based nudge delivered to the USER (whose calendar/inbox
it lands in), as opposed to outreach which targets leads. Reminders are created
three ways:

1. **Manually** from the UI ("remind me to call X at 3pm").
2. **By CRM signals** — an inbound reply, a pipeline stage change, or a new note
   auto-creates a follow-up reminder (the "make my day from inbox/pipeline/notes"
   behaviour). These hooks are best-effort: they never raise into the request.
3. **By the daily-agenda job** — once a day per user we gather the day's open
   threads, due tasks, fresh replies and notes into a clear, prioritized
   "who to talk to & about what" plan (deterministic, no AI) and deliver it.

Delivery mirrors the EnrollmentStepRun pattern: rows sit ``pending`` until
``remind_at`` passes, then ``tick_reminders`` (Celery beat) delivers them —
writing a Google Calendar event for ``channel="calendar"`` or sending mail for
``channel="email"`` — and flips them to ``sent``/``failed``. The whole system
works over plain email/SMTP with no calendar connected; calendar delivery is an
optional upgrade.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

try:  # stdlib on 3.9+, but guard anyway
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

from sqlalchemy.orm import Session

from app.models import (
    Activity,
    ConnectedAccount,
    Lead,
    Note,
    Reminder,
    Task,
    Workspace,
)
from app.services import google_calendar as gcal

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Account + config helpers
# --------------------------------------------------------------------------- #

def calendar_account_for(db: Session, workspace_id: str, user_id: str) -> Optional[ConnectedAccount]:
    """The active Google Calendar connection for a user in a workspace."""
    return (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == workspace_id,
            ConnectedAccount.user_id == user_id,
            ConnectedAccount.provider == gcal.PROVIDER,
            ConnectedAccount.status == "active",
        )
        .order_by(ConnectedAccount.created_at.asc())
        .first()
    )


def _write_calendar_id(account: ConnectedAccount) -> str:
    cfg = account.config or {}
    return cfg.get("write_calendar_id") or "primary"


def conflict_calendar_ids(account: ConnectedAccount) -> list[str]:
    cfg = account.config or {}
    ids = cfg.get("conflict_calendar_ids")
    if ids:
        return list(ids)
    # Default: just the write calendar (usually "primary").
    return [_write_calendar_id(account)]


# Reminder preferences (agenda + auto-reminders) are stored PER-USER in
# ``workspace.settings["reminder_prefs"][user_id]`` — deliberately NOT on the
# calendar account, so the whole reminder/agenda system works over plain
# email/SMTP even when no calendar is connected. The calendar account only
# holds calendar-specific roles (write/conflict calendars).
DEFAULT_AGENDA = {"enabled": True, "hour": 8, "channels": ["email"]}
DEFAULT_AUTO = {"inbox_reply": True, "stage_change": True, "note": True, "default_offset_minutes": 60}


def _prefs_root(workspace: Workspace) -> dict:
    return (workspace.settings or {}).get("reminder_prefs", {}) or {}


def _user_prefs(workspace: Workspace, user_id: str) -> dict:
    return _prefs_root(workspace).get(user_id) or {}


def agenda_config(workspace: Workspace, user_id: str) -> dict:
    stored = _user_prefs(workspace, user_id).get("agenda") or {}
    tz = stored.get("timezone") or (workspace.settings or {}).get("outreach", {}).get("timezone") or "UTC"
    return {
        "enabled": bool(stored.get("enabled", DEFAULT_AGENDA["enabled"])),
        "hour": int(stored.get("hour", DEFAULT_AGENDA["hour"])),
        "timezone": tz,
        "channels": stored.get("channels") or list(DEFAULT_AGENDA["channels"]),
        "last_generated_date": stored.get("last_generated_date"),
    }


def auto_reminder_config(workspace: Workspace, user_id: str) -> dict:
    stored = _user_prefs(workspace, user_id).get("auto_reminders") or {}
    return {
        "inbox_reply": bool(stored.get("inbox_reply", DEFAULT_AUTO["inbox_reply"])),
        "stage_change": bool(stored.get("stage_change", DEFAULT_AUTO["stage_change"])),
        "note": bool(stored.get("note", DEFAULT_AUTO["note"])),
        "default_offset_minutes": int(stored.get("default_offset_minutes", DEFAULT_AUTO["default_offset_minutes"])),
    }


def set_prefs(
    db: Session,
    workspace: Workspace,
    user_id: str,
    *,
    agenda: Optional[dict] = None,
    auto_reminders: Optional[dict] = None,
) -> None:
    """Merge a patch into a user's reminder prefs and persist."""
    from sqlalchemy.orm.attributes import flag_modified

    settings = dict(workspace.settings or {})
    root = dict(settings.get("reminder_prefs", {}) or {})
    entry = dict(root.get(user_id, {}) or {})
    if agenda is not None:
        entry["agenda"] = {**(entry.get("agenda") or {}), **agenda}
    if auto_reminders is not None:
        entry["auto_reminders"] = {**(entry.get("auto_reminders") or {}), **auto_reminders}
    root[user_id] = entry
    settings["reminder_prefs"] = root
    workspace.settings = settings
    flag_modified(workspace, "settings")
    db.commit()


# ---- delivery availability (calendar OR email/SMTP) ----

def email_account_for(db: Session, workspace_id: str, user_id: str):
    from app.services.email_sender import _pick_account

    return _pick_account(db, workspace_id, user_id)


def delivery_options(db: Session, workspace_id: str, user_id: str) -> dict:
    return {
        "calendar": calendar_account_for(db, workspace_id, user_id) is not None,
        "email": email_account_for(db, workspace_id, user_id) is not None,
    }


def effective_channel(db: Session, workspace_id: str, user_id: str, requested: str) -> Optional[str]:
    """Resolve the channel a reminder can actually be delivered on, falling back
    when the requested one isn't available. Returns None if nothing is set up."""
    opts = delivery_options(db, workspace_id, user_id)
    if requested == "calendar" and opts["calendar"]:
        return "calendar"
    if requested == "email" and opts["email"]:
        return "email"
    if opts["calendar"]:
        return "calendar"
    if opts["email"]:
        return "email"
    return None


def _zone(name: str):
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


# --------------------------------------------------------------------------- #
# Creation
# --------------------------------------------------------------------------- #

def create_reminder(
    db: Session,
    *,
    workspace_id: str,
    user_id: str,
    title: str,
    remind_at: datetime,
    body: str = "",
    channel: str = "calendar",
    source: str = "manual",
    lead_id: Optional[str] = None,
    task_id: Optional[str] = None,
    duration_minutes: int = 15,
    payload: Optional[dict] = None,
    commit: bool = True,
) -> Reminder:
    if remind_at.tzinfo is None:
        remind_at = remind_at.replace(tzinfo=timezone.utc)
    rem = Reminder(
        workspace_id=workspace_id,
        user_id=user_id,
        lead_id=lead_id,
        task_id=task_id,
        title=title[:300],
        body=body or "",
        remind_at=remind_at,
        duration_minutes=duration_minutes,
        channel=channel if channel in {"calendar", "email"} else "calendar",
        source=source,
        payload=payload or {},
        status="pending",
    )
    db.add(rem)
    if commit:
        db.commit()
        db.refresh(rem)
    return rem


def _has_recent_reminder(db: Session, workspace_id: str, user_id: str, source: str, lead_id: Optional[str], within_hours: int = 12) -> bool:
    """De-dupe guard so a chatty thread doesn't spawn a pile of reminders."""
    if not lead_id:
        return False
    since = datetime.now(timezone.utc) - timedelta(hours=within_hours)
    q = (
        db.query(Reminder.id)
        .filter(
            Reminder.workspace_id == workspace_id,
            Reminder.user_id == user_id,
            Reminder.lead_id == lead_id,
            Reminder.source == source,
            Reminder.status.in_(["pending", "scheduled"]),
            Reminder.created_at >= since,
        )
        .first()
    )
    return q is not None


# --------------------------------------------------------------------------- #
# Signal hooks (best-effort — never raise into the calling request)
# --------------------------------------------------------------------------- #

def _lead_label(lead: Optional[Lead]) -> str:
    if not lead:
        return "a lead"
    name = lead.full_name or (f"{lead.first_name or ''} {lead.last_name or ''}".strip()) or lead.email or "a lead"
    company = lead.company.name if lead.company else None
    return f"{name}{f' ({company})' if company else ''}"


def _signal_reminder(db: Session, *, workspace_id: str, user_id: str, lead: Optional[Lead], source: str, title: str, body: str) -> None:
    try:
        workspace = db.get(Workspace, workspace_id)
        if not workspace:
            return
        ar = auto_reminder_config(workspace, user_id)
        if source in ar and not ar.get(source, True):
            return
        # Need somewhere to deliver — a calendar OR an email/SMTP account.
        requested = (agenda_config(workspace, user_id).get("channels") or ["email"])[0]
        channel = effective_channel(db, workspace_id, user_id, requested)
        if not channel:
            return
        if _has_recent_reminder(db, workspace_id, user_id, source, lead.id if lead else None):
            return
        offset = ar.get("default_offset_minutes", 60)
        remind_at = datetime.now(timezone.utc) + timedelta(minutes=offset)
        create_reminder(
            db,
            workspace_id=workspace_id,
            user_id=user_id,
            title=title,
            body=body,
            remind_at=remind_at,
            channel=channel,
            source=source,
            lead_id=lead.id if lead else None,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("signal reminder (%s) skipped: %s", source, exc)


def on_inbound_reply(db: Session, *, workspace_id: str, user_id: str, lead: Optional[Lead], preview: str = "") -> None:
    label = _lead_label(lead)
    _signal_reminder(
        db,
        workspace_id=workspace_id,
        user_id=user_id,
        lead=lead,
        source="inbox_reply",
        title=f"Reply: follow up with {label}",
        body=(f"{label} replied. {preview[:240]}" if preview else f"{label} replied — respond."),
    )


def on_stage_change(db: Session, *, workspace_id: str, user_id: str, lead: Optional[Lead], stage_name: str = "") -> None:
    label = _lead_label(lead)
    _signal_reminder(
        db,
        workspace_id=workspace_id,
        user_id=user_id,
        lead=lead,
        source="stage_change",
        title=f"Stage moved: {label}{f' → {stage_name}' if stage_name else ''}",
        body=f"{label} moved pipeline stage{f' to {stage_name}' if stage_name else ''}. Plan the next touch.",
    )


def on_note_added(db: Session, *, workspace_id: str, user_id: str, lead: Optional[Lead], note_body: str = "") -> None:
    label = _lead_label(lead)
    _signal_reminder(
        db,
        workspace_id=workspace_id,
        user_id=user_id,
        lead=lead,
        source="note",
        title=f"Note follow-up: {label}",
        body=(note_body[:240] or f"You added a note on {label} — act on it."),
    )


# --------------------------------------------------------------------------- #
# Delivery
# --------------------------------------------------------------------------- #

def deliver_reminder(db: Session, reminder: Reminder) -> bool:
    """Deliver one reminder. Returns True on success. Sets status + error."""
    if reminder.status not in {"pending", "failed", "scheduled"}:
        return False
    try:
        # If a calendar reminder has no calendar connected, fall back to email
        # so SMTP-only users still get the nudge.
        use_calendar = reminder.channel == "calendar" and calendar_account_for(
            db, reminder.workspace_id, reminder.user_id
        ) is not None
        if use_calendar:
            ok = _deliver_calendar(db, reminder)
        else:
            ok = _deliver_email(db, reminder)
    except Exception as exc:  # noqa: BLE001
        reminder.status = "failed"
        reminder.error = str(exc)[:500]
        db.commit()
        log.warning("reminder %s delivery failed: %s", reminder.id, exc)
        return False
    if ok:
        reminder.status = "sent"
        reminder.sent_at = datetime.now(timezone.utc)
        reminder.error = None
    db.commit()
    return ok


def _deliver_calendar(db: Session, reminder: Reminder) -> bool:
    account = calendar_account_for(db, reminder.workspace_id, reminder.user_id)
    if not account:
        reminder.status = "failed"
        reminder.error = "no_calendar_connected"
        return False
    creds = gcal.ensure_credentials(db, account)
    if not creds:
        reminder.status = "failed"
        reminder.error = "calendar_auth_failed"
        return False
    cal_id = _write_calendar_id(account)
    start = reminder.remind_at
    end = start + timedelta(minutes=reminder.duration_minutes or 15)
    if reminder.external_event_id:
        gcal.update_event(
            creds, cal_id, reminder.external_event_id,
            summary=reminder.title, description=reminder.body or "", start=start, end=end,
        )
    else:
        ev = gcal.create_event(
            creds, cal_id,
            summary=reminder.title, description=reminder.body or "", start=start, end=end,
        )
        reminder.external_event_id = ev.get("id")
        reminder.calendar_account_id = account.id
    return True


def _deliver_email(db: Session, reminder: Reminder) -> bool:
    # Lazy import avoids a circular import at module load (email_sender →
    # outreach → models, all fine, but keep the dependency edge explicit).
    from app.services.email_sender import _pick_account, send_via_account

    account = _pick_account(db, reminder.workspace_id, reminder.user_id)
    if not account:
        reminder.status = "failed"
        reminder.error = "no_email_account_connected"
        return False
    to_addr = account.external_id or (account.config or {}).get("from_email")
    if not to_addr:
        reminder.status = "failed"
        reminder.error = "no_recipient_address"
        return False
    body_text = reminder.body or reminder.title
    html = "<p>" + (body_text.replace("\n", "<br/>")) + "</p>"
    result = send_via_account(account, to_addr, f"⏰ {reminder.title}", body_text, html)
    if not result.ok:
        reminder.status = "failed"
        reminder.error = result.error
        return False
    return True


# --------------------------------------------------------------------------- #
# Daily agenda
# --------------------------------------------------------------------------- #

def _gather_signals(db: Session, workspace_id: str, user_id: str, tz) -> dict:
    """Collect today's actionable CRM signals for the agenda."""
    now = datetime.now(timezone.utc)
    today_local = now.astimezone(tz).date()
    end_of_day = datetime.combine(today_local, datetime.max.time()).replace(tzinfo=tz).astimezone(timezone.utc)
    since_24h = now - timedelta(hours=24)
    since_48h = now - timedelta(hours=48)

    # Tasks due today (open), assigned to this user or unassigned.
    due_tasks = (
        db.query(Task)
        .filter(
            Task.workspace_id == workspace_id,
            Task.status == "open",
            Task.due_at.isnot(None),
            Task.due_at <= end_of_day,
        )
        .order_by(Task.due_at.asc())
        .limit(25)
        .all()
    )

    # Leads that replied in the last 48h (awaiting our response).
    replied = (
        db.query(Lead)
        .filter(
            Lead.workspace_id == workspace_id,
            Lead.last_inbound_at.isnot(None),
            Lead.last_inbound_at >= since_48h,
        )
        .order_by(Lead.last_inbound_at.desc())
        .limit(15)
        .all()
    )

    # Recent stage changes (last 24h).
    stage_moves = (
        db.query(Activity)
        .filter(
            Activity.workspace_id == workspace_id,
            Activity.type == "stage_changed",
            Activity.created_at >= since_24h,
        )
        .order_by(Activity.created_at.desc())
        .limit(15)
        .all()
    )

    # Recent notes (last 24h).
    recent_notes = (
        db.query(Note)
        .filter(Note.workspace_id == workspace_id, Note.created_at >= since_24h)
        .order_by(Note.created_at.desc())
        .limit(15)
        .all()
    )

    return {
        "due_tasks": due_tasks,
        "replied": replied,
        "stage_moves": stage_moves,
        "recent_notes": recent_notes,
    }


def build_agenda_text(db: Session, signals: dict) -> tuple[str, int]:
    """Compose the agenda body — a clean, prioritized plain-text plan of who to
    talk to and about what. Deterministic, no AI. Returns (text, item_count).

    Ordering is the priority order: replies awaiting a response first, then
    tasks due today, then pipeline moves, then fresh notes.
    """
    sections: list[str] = []
    count = 0

    replied = signals["replied"]
    if replied:
        lines = [
            f"• {_lead_label(lead)} — replied {lead.last_inbound_at:%b %d %H:%M}, respond"
            for lead in replied
        ]
        sections.append("Reply to:\n" + "\n".join(lines))
        count += len(replied)

    due_tasks = signals["due_tasks"]
    if due_tasks:
        lines = []
        for t in due_tasks:
            lead = db.get(Lead, t.lead_id) if t.lead_id else None
            who = f" — {_lead_label(lead)}" if lead else ""
            lines.append(f"• {t.title}{who} (due {t.due_at:%H:%M})")
        sections.append("Tasks due:\n" + "\n".join(lines))
        count += len(due_tasks)

    stage_moves = signals["stage_moves"]
    if stage_moves:
        lines = []
        for a in stage_moves:
            lead = db.get(Lead, a.lead_id) if a.lead_id else None
            lines.append(f"• {_lead_label(lead)} — plan the next touch")
        sections.append("Moved stage:\n" + "\n".join(lines))
        count += len(stage_moves)

    recent_notes = signals["recent_notes"]
    if recent_notes:
        lines = []
        for n in recent_notes:
            lead = db.get(Lead, n.lead_id) if n.lead_id else None
            lines.append(f"• {_lead_label(lead)} — {n.body[:140]}")
        sections.append("Follow up on notes:\n" + "\n".join(lines))
        count += len(recent_notes)

    if count == 0:
        return ("You have no open conversations or due tasks today. Clear runway.", 0)

    header = f"Your day — {count} item{'s' if count != 1 else ''} to handle:\n"
    return (header + "\n\n".join(sections), count)


def generate_daily_agenda(
    db: Session,
    *,
    workspace: Workspace,
    user_id: str,
    force: bool = False,
) -> Optional[Reminder]:
    """Build today's agenda for a user and schedule it as a reminder.

    Works over email/SMTP or calendar — whichever is connected. Skips silently
    if agenda is disabled, there's no delivery channel, or today's agenda was
    already generated (unless ``force``)."""
    cfg = agenda_config(workspace, user_id)
    if not cfg["enabled"] and not force:
        return None

    requested = (cfg.get("channels") or ["email"])[0]
    channel = effective_channel(db, workspace.id, user_id, requested)
    if not channel:
        return None  # nowhere to deliver (no calendar, no email account)

    tz = _zone(cfg["timezone"])
    now_local = datetime.now(timezone.utc).astimezone(tz)
    today_str = now_local.date().isoformat()
    if not force and cfg.get("last_generated_date") == today_str:
        return None

    signals = _gather_signals(db, workspace.id, user_id, tz)
    body, count = build_agenda_text(db, signals)

    # Schedule at the configured hour today (local); if that's already past,
    # deliver now.
    target_local = now_local.replace(hour=cfg["hour"], minute=0, second=0, microsecond=0)
    if target_local < now_local:
        target_local = now_local
    remind_at = target_local.astimezone(timezone.utc)

    title = f"📋 Your day — {count} item{'s' if count != 1 else ''}" if count else "📋 Your day — clear"
    rem = create_reminder(
        db,
        workspace_id=workspace.id,
        user_id=user_id,
        title=title,
        body=body,
        remind_at=remind_at,
        channel=channel,
        source="daily_agenda",
        duration_minutes=30,
        payload={"item_count": count, "date": today_str},
        commit=False,
    )

    # Stamp last_generated_date in the user's prefs so we don't regenerate today.
    set_prefs(db, workspace, user_id, agenda={"last_generated_date": today_str})
    db.refresh(rem)
    return rem
