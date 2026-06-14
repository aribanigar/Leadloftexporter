"""Scheduling engine — availability slot computation + booking.

Slots are computed at request time from the event type's weekly availability
(in the owner's timezone), minus:
  * times in the past or inside the minimum-notice window,
  * the owner's calendar busy times (Google free/busy, when connected),
  * existing confirmed bookings,
each expanded by the event's before/after buffers.

Booking writes the meeting to the owner's calendar (if connected), records it,
matches-or-creates a Lead, emails the invitee a confirmation, and drops a
reminder on the owner so it surfaces in their day.
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Booking, EventType, Lead, Note, Workspace
from app.services import google_calendar as gcal
from app.services import reminders as rsvc

log = logging.getLogger(__name__)
_settings = get_settings()


def manage_url(booking: Booking) -> str:
    """Public self-service link an invitee uses to reschedule/cancel."""
    return f"{_settings.primary_frontend_origin}/book/manage/{booking.id}"

DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

DEFAULT_AVAILABILITY = {
    "mon": [{"start": "09:00", "end": "17:00"}],
    "tue": [{"start": "09:00", "end": "17:00"}],
    "wed": [{"start": "09:00", "end": "17:00"}],
    "thu": [{"start": "09:00", "end": "17:00"}],
    "fri": [{"start": "09:00", "end": "17:00"}],
    "sat": [],
    "sun": [],
}


def _parse_hhmm(s: str) -> time:
    h, m = (s or "00:00").split(":")[:2]
    return time(int(h), int(m))


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _host_ids(event_type: EventType) -> list[str]:
    """Candidate hosts for a booking: the configured host list, else the owner."""
    if event_type.assignment == "round_robin" and (event_type.host_ids or []):
        return list(event_type.host_ids)
    return [event_type.owner_id]


def _busy_for_host(
    db: Session,
    event_type: EventType,
    host_id: str,
    time_min: datetime,
    time_max: datetime,
) -> list[tuple[datetime, datetime]]:
    """One host's busy intervals (calendar free/busy + their confirmed bookings)."""
    out: list[tuple[datetime, datetime]] = []

    account = rsvc.calendar_account_for(db, event_type.workspace_id, host_id)
    if account:
        try:
            creds = gcal.ensure_credentials(db, account)
            if creds:
                cal_ids = rsvc.conflict_calendar_ids(account)
                for b in gcal.freebusy(creds, cal_ids, time_min, time_max):
                    s = _parse_iso(b.get("start"))
                    e = _parse_iso(b.get("end"))
                    if s and e:
                        out.append((s, e))
        except Exception as exc:  # noqa: BLE001
            log.warning("freebusy lookup failed for host %s: %s", host_id, exc)

    rows = (
        db.query(Booking)
        .filter(
            Booking.owner_id == host_id,
            Booking.workspace_id == event_type.workspace_id,
            Booking.status == "confirmed",
            Booking.end_at > time_min,
            Booking.start_at < time_max,
        )
        .all()
    )
    for r in rows:
        out.append((_aware(r.start_at), _aware(r.end_at)))
    return out


def _free_hosts_at(
    db: Session,
    event_type: EventType,
    start_utc: datetime,
    end_utc: datetime,
    busy_by_host: Optional[dict] = None,
) -> list[str]:
    """Which candidate hosts have no conflict for [start, end] (buffers applied)."""
    buf_before = event_type.buffer_before_minutes or 0
    buf_after = event_type.buffer_after_minutes or 0
    blocked_start = start_utc - timedelta(minutes=buf_before)
    blocked_end = end_utc + timedelta(minutes=buf_after)
    free: list[str] = []
    for host_id in _host_ids(event_type):
        busy = busy_by_host[host_id] if busy_by_host is not None else _busy_for_host(
            db, event_type, host_id, blocked_start - timedelta(hours=2), blocked_end + timedelta(hours=2)
        )
        if not any(_overlaps(blocked_start, blocked_end, bs, be) for bs, be in busy):
            free.append(host_id)
    return free


def compute_slots(
    db: Session,
    event_type: EventType,
    *,
    from_date: Optional[datetime] = None,
    days: Optional[int] = None,
) -> list[str]:
    """Return available start times (UTC ISO8601) for the event type."""
    tz = rsvc._zone(event_type.timezone or "UTC")
    now = datetime.now(timezone.utc)
    start_dt = from_date or now
    span = days or event_type.date_range_days or 30
    window_start = start_dt
    window_end = now + timedelta(days=span)

    duration = max(5, event_type.duration_minutes or 30)
    step = max(5, event_type.slot_interval_minutes or duration)
    buf_before = event_type.buffer_before_minutes or 0
    buf_after = event_type.buffer_after_minutes or 0
    min_notice = now + timedelta(minutes=event_type.min_notice_minutes or 0)

    # Pre-fetch each host's busy intervals once for the whole window.
    span_min = window_start - timedelta(days=1)
    span_max = window_end + timedelta(days=1)
    busy_by_host = {h: _busy_for_host(db, event_type, h, span_min, span_max) for h in _host_ids(event_type)}
    availability = event_type.availability or DEFAULT_AVAILABILITY

    slots: list[str] = []
    # Iterate day-by-day in the event timezone.
    day = now.astimezone(tz).date()
    last_day = window_end.astimezone(tz).date()
    while day <= last_day:
        key = DAY_KEYS[day.weekday()]
        windows = availability.get(key) or []
        for w in windows:
            try:
                w_start = _parse_hhmm(w["start"])
                w_end = _parse_hhmm(w["end"])
            except Exception:  # noqa: BLE001
                continue
            cursor = datetime.combine(day, w_start, tzinfo=tz)
            window_close = datetime.combine(day, w_end, tzinfo=tz)
            while cursor + timedelta(minutes=duration) <= window_close:
                start_utc = cursor.astimezone(timezone.utc)
                end_utc = start_utc + timedelta(minutes=duration)
                if start_utc >= min_notice and start_utc >= window_start and start_utc < window_end:
                    # Bookable if at least one host is free (collective availability).
                    if _free_hosts_at(db, event_type, start_utc, end_utc, busy_by_host):
                        slots.append(start_utc.isoformat())
                cursor += timedelta(minutes=step)
        day += timedelta(days=1)

    return sorted(set(slots))


def slot_is_available(db: Session, event_type: EventType, start_utc: datetime) -> bool:
    duration = max(5, event_type.duration_minutes or 30)
    end_utc = start_utc + timedelta(minutes=duration)
    if start_utc < datetime.now(timezone.utc) + timedelta(minutes=event_type.min_notice_minutes or 0):
        return False
    return bool(_free_hosts_at(db, event_type, start_utc, end_utc))


def _pick_host(db: Session, event_type: EventType, start_utc: datetime, end_utc: datetime) -> str:
    """Choose the assigned host: a free host with the fewest confirmed bookings
    (round-robin load-balancing); falls back to the owner."""
    free = _free_hosts_at(db, event_type, start_utc, end_utc)
    candidates = free or _host_ids(event_type)
    if not candidates:
        return event_type.owner_id

    def load(host_id: str) -> int:
        return (
            db.query(Booking)
            .filter(
                Booking.event_type_id == event_type.id,
                Booking.owner_id == host_id,
                Booking.status == "confirmed",
            )
            .count()
        )

    return min(candidates, key=load)


def create_booking(
    db: Session,
    event_type: EventType,
    *,
    start_utc: datetime,
    invitee_name: str,
    invitee_email: str,
    invitee_phone: str = "",
    invitee_timezone: str = "",
    answers: Optional[dict] = None,
) -> Booking:
    """Create a confirmed booking + side effects (lead, calendar, emails)."""
    duration = max(5, event_type.duration_minutes or 30)
    end_utc = start_utc + timedelta(minutes=duration)

    # Round-robin: assign the booking to a free host (load-balanced).
    host_id = _pick_host(db, event_type, start_utc, end_utc)

    booking = Booking(
        workspace_id=event_type.workspace_id,
        event_type_id=event_type.id,
        owner_id=host_id,
        invitee_name=invitee_name.strip()[:200],
        invitee_email=invitee_email.strip()[:320],
        invitee_phone=(invitee_phone or "").strip()[:60] or None,
        invitee_timezone=(invitee_timezone or "").strip()[:64] or None,
        start_at=start_utc,
        end_at=end_utc,
        status="confirmed",
        answers=answers or {},
    )
    db.add(booking)

    # Match-or-create the lead (a booking is a hot lead).
    lead = _match_or_create_lead(db, event_type, host_id, invitee_name, invitee_email, invitee_phone)
    if lead:
        booking.lead_id = lead.id

    db.flush()

    # Write the meeting to the owner's calendar (with the invitee as attendee).
    _write_calendar_event(db, event_type, booking)

    db.commit()
    db.refresh(booking)

    # Confirmation email to the invitee + a reminder for the owner +
    # automated appointment reminders to the invitee. All best-effort.
    _send_confirmation(db, event_type, booking)
    _owner_reminder(db, event_type, booking)
    _schedule_invitee_reminders(db, event_type, booking)
    _schedule_pre_meeting_brief(db, event_type, booking)
    _fire_workflows(db, "booking_created", booking)
    return booking


def cancel_booking(db: Session, booking: Booking) -> None:
    booking.status = "cancelled"
    booking.cancelled_at = datetime.now(timezone.utc)
    if booking.external_event_id and booking.calendar_account_id:
        from app.models import ConnectedAccount

        account = db.get(ConnectedAccount, booking.calendar_account_id)
        if account:
            creds = gcal.ensure_credentials(db, account)
            if creds:
                gcal.delete_event(creds, rsvc._write_calendar_id(account), booking.external_event_id)
    # Cancel any pending invitee reminders so we don't ping a cancelled meeting.
    from app.models import Reminder

    db.query(Reminder).filter(
        Reminder.booking_id == booking.id,
        Reminder.status.in_(["pending", "failed"]),
    ).update({"status": "cancelled"}, synchronize_session=False)
    db.commit()
    _fire_workflows(db, "booking_cancelled", booking)


def set_disposition(db: Session, booking: Booking, disposition: str) -> None:
    """Mark a meeting completed or no_show and fire the matching workflows."""
    if disposition not in ("completed", "no_show"):
        return
    booking.disposition = disposition
    db.commit()
    _fire_workflows(db, "meeting_completed" if disposition == "completed" else "meeting_no_show", booking)


def reschedule_booking(db: Session, booking: Booking, new_start: datetime) -> bool:
    """Move a confirmed booking to a new start time. Validates the slot, updates
    the calendar event, and re-queues the invitee reminders. Returns False if
    the slot isn't available."""
    if booking.status != "confirmed":
        return False
    event_type = db.get(EventType, booking.event_type_id)
    if not event_type or not slot_is_available(db, event_type, new_start):
        return False
    duration = max(5, event_type.duration_minutes or 30)
    booking.start_at = new_start
    booking.end_at = new_start + timedelta(minutes=duration)

    # Move the calendar event.
    if booking.external_event_id and booking.calendar_account_id:
        from app.models import ConnectedAccount

        account = db.get(ConnectedAccount, booking.calendar_account_id)
        if account:
            creds = gcal.ensure_credentials(db, account)
            if creds:
                try:
                    gcal.update_event(
                        creds, rsvc._write_calendar_id(account), booking.external_event_id,
                        start=booking.start_at, end=booking.end_at,
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("calendar move failed for booking %s: %s", booking.id, exc)

    # Re-queue invitee reminders + the host brief against the new time.
    from app.models import Reminder

    db.query(Reminder).filter(
        Reminder.booking_id == booking.id,
        Reminder.source.in_(["booking_reminder", "pre_meeting_brief"]),
        Reminder.status.in_(["pending", "failed"]),
    ).update({"status": "cancelled"}, synchronize_session=False)
    db.commit()
    _schedule_invitee_reminders(db, event_type, booking)
    _schedule_pre_meeting_brief(db, event_type, booking)
    return True


def _fire_workflows(db: Session, trigger: str, booking: Booking) -> None:
    try:
        from app.services import workflows as wf

        wf.run_for_booking(db, trigger=trigger, booking=booking)
    except Exception as exc:  # noqa: BLE001
        log.warning("workflow run (%s) failed for booking %s: %s", trigger, booking.id, exc)


def _schedule_invitee_reminders(db: Session, event_type: EventType, booking: Booking) -> None:
    """Queue 'your meeting is coming up' emails to the invitee at each configured
    offset before the start (default 24h + 1h). Only future offsets are queued."""
    try:
        offsets = event_type.reminder_offsets or [1440, 60]
        now = datetime.now(timezone.utc)
        for minutes in offsets:
            try:
                minutes = int(minutes)
            except (TypeError, ValueError):
                continue
            remind_at = booking.start_at - timedelta(minutes=minutes)
            if remind_at <= now:
                continue
            when = booking.start_at.strftime("%A, %b %d at %H:%M UTC")
            lead = _human_offset(minutes)
            body = (
                f"Hi {booking.invitee_name},\n\n"
                f"This is a reminder that your {event_type.name} is {lead} — {when}.\n\n"
                f"{_meeting_description(event_type, booking)}\n\n"
                f"See you soon!"
            )
            rsvc.create_reminder(
                db,
                workspace_id=event_type.workspace_id,
                user_id=booking.owner_id,
                title=f"Reminder: {event_type.name} {lead}",
                body=body,
                remind_at=remind_at,
                channel="email",
                source="booking_reminder",
                lead_id=booking.lead_id,
                recipient_email=booking.invitee_email,
                booking_id=booking.id,
                commit=False,
            )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("invitee reminders not scheduled for booking %s: %s", booking.id, exc)


def _human_offset(minutes: int) -> str:
    if minutes % 1440 == 0:
        d = minutes // 1440
        return "tomorrow" if d == 1 else f"in {d} days"
    if minutes % 60 == 0:
        h = minutes // 60
        return f"in {h} hour{'s' if h != 1 else ''}"
    return f"in {minutes} minutes"


def _build_brief(db: Session, event_type: EventType, booking: Booking) -> str:
    """A deterministic pre-meeting brief: who the host is about to meet, drawn
    from the matched lead's CRM context + the invitee's intake answers."""
    lines = [f"Pre-meeting brief — {event_type.name} with {booking.invitee_name}", ""]
    lead = db.get(Lead, booking.lead_id) if booking.lead_id else None
    if lead:
        if lead.title:
            lines.append(f"Title: {lead.title}")
        if lead.company:
            lines.append(f"Company: {lead.company.name}")
        if lead.stage:
            lines.append(f"Pipeline stage: {lead.stage.name}")
        if lead.location:
            lines.append(f"Location: {lead.location}")
        if lead.last_activity_at:
            lines.append(f"Last activity: {lead.last_activity_at:%b %d %H:%M}")
        recent = (
            db.query(Note)
            .filter(Note.lead_id == lead.id)
            .order_by(Note.created_at.desc())
            .limit(3)
            .all()
        )
        if recent:
            lines.append("")
            lines.append("Recent notes:")
            for n in recent:
                lines.append(f"• {n.body[:160]}")
    else:
        lines.append(f"Contact: {booking.invitee_name} <{booking.invitee_email}>")
    if booking.answers:
        lines.append("")
        lines.append("They told us:")
        for k, v in booking.answers.items():
            lines.append(f"• {k}: {v}")
    return "\n".join(lines)


def _schedule_pre_meeting_brief(db: Session, event_type: EventType, booking: Booking) -> None:
    """Schedule a brief to the host shortly before the meeting (best-effort)."""
    try:
        offset = event_type.brief_offset_minutes if event_type.brief_offset_minutes is not None else 30
        if offset <= 0:
            return
        remind_at = booking.start_at - timedelta(minutes=offset)
        if remind_at <= datetime.now(timezone.utc):
            return
        workspace = db.get(Workspace, event_type.workspace_id)
        if not workspace:
            return
        channel = rsvc.effective_channel(
            db, event_type.workspace_id, booking.owner_id,
            (rsvc.agenda_config(workspace, booking.owner_id).get("channels") or ["email"])[0],
        )
        if not channel:
            return
        rsvc.create_reminder(
            db,
            workspace_id=event_type.workspace_id,
            user_id=booking.owner_id,
            title=f"Brief: {booking.invitee_name} — {event_type.name}",
            body=_build_brief(db, event_type, booking),
            remind_at=remind_at,
            channel=channel,
            source="pre_meeting_brief",
            lead_id=booking.lead_id,
            booking_id=booking.id,
            duration_minutes=10,
            escalate=False,
            commit=False,
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("pre-meeting brief not scheduled for booking %s: %s", booking.id, exc)


# --------------------------------------------------------------------------- #
# Side effects
# --------------------------------------------------------------------------- #

def _match_or_create_lead(db: Session, event_type: EventType, host_id: str, name: str, email: str, phone: str) -> Optional[Lead]:
    email = (email or "").strip().lower()
    if not email:
        return None
    lead = (
        db.query(Lead)
        .filter(Lead.workspace_id == event_type.workspace_id, Lead.email.ilike(email))
        .first()
    )
    if lead:
        lead.last_inbound_at = datetime.now(timezone.utc)
        return lead
    parts = (name or "").strip().split(" ", 1)
    lead = Lead(
        workspace_id=event_type.workspace_id,
        owner_id=host_id,
        first_name=parts[0] if parts else None,
        last_name=parts[1] if len(parts) > 1 else None,
        full_name=name.strip() or email,
        email=email,
        phone=(phone or "").strip() or None,
        source="booking",
        last_inbound_at=datetime.now(timezone.utc),
    )
    db.add(lead)
    db.flush()
    return lead


def _write_calendar_event(db: Session, event_type: EventType, booking: Booking) -> None:
    account = rsvc.calendar_account_for(db, event_type.workspace_id, booking.owner_id)
    if not account:
        return
    try:
        creds = gcal.ensure_credentials(db, account)
        if not creds:
            return
        summary = f"{event_type.name} — {booking.invitee_name}"
        desc = _meeting_description(event_type, booking)
        ev = gcal.create_event(
            creds,
            rsvc._write_calendar_id(account),
            summary=summary,
            description=desc,
            start=booking.start_at,
            end=booking.end_at,
        )
        booking.external_event_id = ev.get("id")
        booking.calendar_account_id = account.id
    except Exception as exc:  # noqa: BLE001
        log.warning("calendar write failed for booking %s: %s", booking.id, exc)


def _meeting_description(event_type: EventType, booking: Booking) -> str:
    lines = [
        f"Booked via {event_type.name}.",
        f"Invitee: {booking.invitee_name} <{booking.invitee_email}>",
    ]
    if booking.invitee_phone:
        lines.append(f"Phone: {booking.invitee_phone}")
    if event_type.location_type:
        loc = event_type.location_details or event_type.location_type.replace("_", " ").title()
        lines.append(f"Location: {loc}")
    for k, v in (booking.answers or {}).items():
        lines.append(f"{k}: {v}")
    return "\n".join(lines)


def _send_confirmation(db: Session, event_type: EventType, booking: Booking) -> None:
    try:
        from app.services.email_sender import send_via_account

        account = rsvc.email_account_for(db, event_type.workspace_id, booking.owner_id)
        if not account:
            return
        when = booking.start_at.strftime("%A, %b %d at %H:%M UTC")
        subject = f"Confirmed: {event_type.name} on {when}"
        body = (
            f"Hi {booking.invitee_name},\n\n"
            f"Your {event_type.name} ({event_type.duration_minutes} min) is confirmed for {when}.\n\n"
            f"{_meeting_description(event_type, booking)}\n\n"
            f"Need to change it? Reschedule or cancel here: {manage_url(booking)}\n\n"
            f"See you then!"
        )
        html = "<p>" + body.replace("\n\n", "</p><p>").replace("\n", "<br/>") + "</p>"
        send_via_account(account, booking.invitee_email, subject, body, html)
    except Exception as exc:  # noqa: BLE001
        log.warning("confirmation email failed for booking %s: %s", booking.id, exc)


def _owner_reminder(db: Session, event_type: EventType, booking: Booking) -> None:
    try:
        workspace = db.get(Workspace, event_type.workspace_id)
        if not workspace:
            return
        channel = rsvc.effective_channel(
            db, event_type.workspace_id, booking.owner_id,
            (rsvc.agenda_config(workspace, booking.owner_id).get("channels") or ["email"])[0],
        )
        if not channel:
            return
        rsvc.create_reminder(
            db,
            workspace_id=event_type.workspace_id,
            user_id=booking.owner_id,
            title=f"Meeting: {booking.invitee_name} — {event_type.name}",
            body=_meeting_description(event_type, booking),
            remind_at=booking.start_at,
            channel=channel,
            source="booking",
            lead_id=booking.lead_id,
            duration_minutes=event_type.duration_minutes or 30,
            escalate=False,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("owner reminder failed for booking %s: %s", booking.id, exc)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return _aware(dt)
    except Exception:  # noqa: BLE001
        return None
