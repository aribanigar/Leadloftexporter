"""Booking-lifecycle automations.

A Workflow fires when a booking event occurs (created / cancelled / completed /
no_show) and runs its ordered list of actions against the booking + matched
lead. Mirrors GReminders "Automations": send a follow-up, create a task, move
the lead's stage, tag it, or schedule another reminder.

Execution is best-effort and isolated per action so one bad action never aborts
the booking flow or the rest of the workflow.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Booking, EventType, Lead, PipelineStage, Task, User, Workflow
from app.services import reminders as rsvc

log = logging.getLogger(__name__)

TRIGGERS = {"booking_created", "booking_cancelled", "meeting_completed", "meeting_no_show"}
ACTION_TYPES = {"send_email", "create_task", "move_stage", "add_tag", "schedule_reminder"}


def run_for_booking(db: Session, *, trigger: str, booking: Booking) -> int:
    """Run all active workflows for a trigger against a booking. Returns the
    number of actions executed."""
    if trigger not in TRIGGERS:
        return 0
    workflows = (
        db.query(Workflow)
        .filter(
            Workflow.workspace_id == booking.workspace_id,
            Workflow.trigger == trigger,
            Workflow.active.is_(True),
        )
        .all()
    )
    if not workflows:
        return 0

    event_type = db.get(EventType, booking.event_type_id)
    lead = db.get(Lead, booking.lead_id) if booking.lead_id else None
    ctx = _context(db, booking, event_type, lead)

    ran = 0
    for wf in workflows:
        # Optional event-type scoping.
        filt_et = (wf.filters or {}).get("event_type_id")
        if filt_et and filt_et != booking.event_type_id:
            continue
        for action in wf.actions or []:
            try:
                if _run_action(db, action, booking=booking, lead=lead, event_type=event_type, ctx=ctx):
                    ran += 1
            except Exception as exc:  # noqa: BLE001
                log.warning("workflow %s action %s failed: %s", wf.id, action.get("type"), exc)
    db.commit()
    return ran


def _context(db: Session, booking: Booking, event_type: Optional[EventType], lead: Optional[Lead]) -> dict:
    owner = db.get(User, booking.owner_id) if booking.owner_id else None
    owner_name = ""
    if owner:
        owner_name = (f"{owner.first_name or ''} {owner.last_name or ''}".strip()) or owner.email
    return {
        "invitee_name": booking.invitee_name,
        "invitee_email": booking.invitee_email,
        "event_name": event_type.name if event_type else "meeting",
        "owner_name": owner_name,
        "start": booking.start_at.strftime("%A, %b %d at %H:%M UTC"),
        "lead_name": (lead.full_name if lead else booking.invitee_name) or booking.invitee_name,
    }


def _merge(text: str, ctx: dict) -> str:
    out = text or ""
    for k, v in ctx.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _run_action(
    db: Session,
    action: dict,
    *,
    booking: Booking,
    lead: Optional[Lead],
    event_type: Optional[EventType],
    ctx: dict,
) -> bool:
    atype = (action or {}).get("type")
    params = (action or {}).get("params") or {}
    if atype not in ACTION_TYPES:
        return False

    if atype == "send_email":
        return _act_send_email(db, booking, params, ctx)
    if atype == "create_task":
        return _act_create_task(db, booking, lead, params, ctx)
    if atype == "move_stage":
        return _act_move_stage(db, lead, params)
    if atype == "add_tag":
        return _act_add_tag(db, lead, params)
    if atype == "schedule_reminder":
        return _act_schedule_reminder(db, booking, lead, params, ctx)
    return False


def _act_send_email(db: Session, booking: Booking, params: dict, ctx: dict) -> bool:
    from app.services.email_sender import _pick_account, send_via_account

    account = _pick_account(db, booking.workspace_id, booking.owner_id)
    if not account:
        return False
    to = params.get("to", "invitee")
    to_addr = booking.invitee_email if to == "invitee" else (account.external_id or (account.config or {}).get("from_email"))
    if not to_addr:
        return False
    subject = _merge(params.get("subject") or f"Re: {ctx['event_name']}", ctx)
    body = _merge(params.get("body") or "", ctx)
    html = "<p>" + body.replace("\n", "<br/>") + "</p>"
    res = send_via_account(account, to_addr, subject, body, html)
    return bool(res.ok)


def _act_create_task(db: Session, booking: Booking, lead: Optional[Lead], params: dict, ctx: dict) -> bool:
    due_hours = params.get("due_in_hours")
    due_at = None
    if due_hours is not None:
        try:
            due_at = datetime.now(timezone.utc) + timedelta(hours=float(due_hours))
        except (TypeError, ValueError):
            due_at = None
    db.add(
        Task(
            workspace_id=booking.workspace_id,
            lead_id=lead.id if lead else None,
            assignee_id=booking.owner_id,
            title=_merge(params.get("title") or f"Follow up with {ctx['lead_name']}", ctx),
            notes=_merge(params.get("notes") or "", ctx) or None,
            type=params.get("task_type", "todo"),
            due_at=due_at,
        )
    )
    return True


def _act_move_stage(db: Session, lead: Optional[Lead], params: dict) -> bool:
    if not lead:
        return False
    stage = None
    if params.get("stage_id"):
        stage = db.get(PipelineStage, params["stage_id"])
    elif params.get("stage_slug"):
        stage = (
            db.query(PipelineStage)
            .filter(PipelineStage.workspace_id == lead.workspace_id, PipelineStage.slug == params["stage_slug"])
            .first()
        )
    if not stage or stage.workspace_id != lead.workspace_id:
        return False
    lead.stage_id = stage.id
    return True


def _act_add_tag(db: Session, lead: Optional[Lead], params: dict) -> bool:
    tag = (params.get("tag") or "").strip()
    if not lead or not tag:
        return False
    tags = list(lead.tags or [])
    if tag not in tags:
        tags.append(tag)
        lead.tags = tags
    return True


def _act_schedule_reminder(db: Session, booking: Booking, lead: Optional[Lead], params: dict, ctx: dict) -> bool:
    try:
        offset = float(params.get("offset_minutes", 60))
    except (TypeError, ValueError):
        offset = 60
    # Positive offset = after the meeting; relative to booking start.
    remind_at = booking.start_at + timedelta(minutes=offset)
    to = params.get("to", "owner")
    recipient = booking.invitee_email if to == "invitee" else None
    rsvc.create_reminder(
        db,
        workspace_id=booking.workspace_id,
        user_id=booking.owner_id,
        title=_merge(params.get("title") or f"Follow up: {ctx['lead_name']}", ctx),
        body=_merge(params.get("body") or "", ctx),
        remind_at=remind_at,
        channel="email" if recipient else "calendar",
        source="booking",
        lead_id=lead.id if lead else None,
        recipient_email=recipient,
        booking_id=booking.id,
        commit=False,
    )
    return True
