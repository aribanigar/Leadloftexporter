"""Public booking page API — UNAUTHENTICATED.

These endpoints back the prospect-facing booking page at
``/book/<workspace>/<event>``. They expose only what's needed to render the
page and create a booking; everything is scoped by workspace slug + event slug
and never leaks workspace internals.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import Booking, EventType, User, Workspace
from app.services import scheduling as sched

router = APIRouter(prefix="/book", tags=["booking"])


def _resolve(db: Session, workspace_slug: str, event_slug: str) -> EventType:
    ws = db.query(Workspace).filter(Workspace.slug == workspace_slug).first()
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    et = (
        db.query(EventType)
        .filter(EventType.workspace_id == ws.id, EventType.slug == event_slug, EventType.active.is_(True))
        .first()
    )
    if not et:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return et


@router.get("/{workspace_slug}/{event_slug}")
def public_event(workspace_slug: str, event_slug: str, db: Session = Depends(get_db)):
    et = _resolve(db, workspace_slug, event_slug)
    owner = db.get(User, et.owner_id)
    owner_name = None
    if owner:
        owner_name = (f"{owner.first_name or ''} {owner.last_name or ''}".strip()) or owner.email
    return {
        "name": et.name,
        "slug": et.slug,
        "description": et.description,
        "duration_minutes": et.duration_minutes,
        "location_type": et.location_type,
        "location_details": et.location_details,
        "timezone": et.timezone,
        "color": et.color,
        "questions": et.questions or [],
        "owner_name": owner_name,
    }


@router.get("/{workspace_slug}/{event_slug}/slots")
def public_slots(
    workspace_slug: str,
    event_slug: str,
    from_: Optional[str] = Query(default=None, alias="from"),
    days: int = Query(default=14, le=60),
    db: Session = Depends(get_db),
):
    et = _resolve(db, workspace_slug, event_slug)
    from_dt = _parse(from_)
    slots = sched.compute_slots(db, et, from_date=from_dt, days=days)
    return {"slots": slots, "timezone": et.timezone, "duration_minutes": et.duration_minutes}


class PublicBookingIn(BaseModel):
    name: str
    email: str
    phone: str = ""
    timezone: str = ""
    start: str  # ISO8601 UTC start time (must be one of the offered slots)
    answers: Optional[dict] = None


@router.post("/{workspace_slug}/{event_slug}")
def public_book(
    workspace_slug: str,
    event_slug: str,
    body: PublicBookingIn,
    db: Session = Depends(get_db),
):
    et = _resolve(db, workspace_slug, event_slug)
    if not body.name.strip() or "@" not in body.email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_and_valid_email_required")
    start = _parse(body.start)
    if not start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_start")
    # Validate required custom questions.
    for q in et.questions or []:
        if q.get("required") and not (body.answers or {}).get(q.get("key")):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"missing_answer:{q.get('key')}")
    if not sched.slot_is_available(db, et, start):
        raise HTTPException(status.HTTP_409_CONFLICT, "slot_no_longer_available")
    booking = sched.create_booking(
        db,
        et,
        start_utc=start,
        invitee_name=body.name,
        invitee_email=body.email,
        invitee_phone=body.phone,
        invitee_timezone=body.timezone,
        answers=body.answers or {},
    )
    return {
        "id": booking.id,
        "status": booking.status,
        "start_at": booking.start_at,
        "end_at": booking.end_at,
        "event_name": et.name,
    }


def _parse(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# Invitee self-service: manage an existing booking (cancel / reschedule).
# The booking id is an unguessable UUID, used as the manage token.
# --------------------------------------------------------------------------- #

def _booking(db: Session, booking_id: str) -> Booking:
    b = db.get(Booking, booking_id)
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return b


@router.get("/manage/{booking_id}")
def manage_get(booking_id: str, db: Session = Depends(get_db)):
    b = _booking(db, booking_id)
    et = db.get(EventType, b.event_type_id)
    ws = db.get(Workspace, b.workspace_id)
    return {
        "id": b.id,
        "status": b.status,
        "start_at": b.start_at,
        "end_at": b.end_at,
        "invitee_name": b.invitee_name,
        "event_name": et.name if et else "meeting",
        "duration_minutes": et.duration_minutes if et else None,
        "workspace_slug": ws.slug if ws else None,
        "event_slug": et.slug if et else None,
    }


@router.post("/manage/{booking_id}/cancel")
def manage_cancel(booking_id: str, db: Session = Depends(get_db)):
    b = _booking(db, booking_id)
    if b.status == "confirmed":
        sched.cancel_booking(db, b)
    return {"ok": True, "status": b.status}


class RescheduleIn(BaseModel):
    start: str


@router.post("/manage/{booking_id}/reschedule")
def manage_reschedule(booking_id: str, body: RescheduleIn, db: Session = Depends(get_db)):
    b = _booking(db, booking_id)
    start = _parse(body.start)
    if not start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_start")
    if not sched.reschedule_booking(db, b, start):
        raise HTTPException(status.HTTP_409_CONFLICT, "slot_no_longer_available")
    return {"ok": True, "start_at": b.start_at, "end_at": b.end_at}
