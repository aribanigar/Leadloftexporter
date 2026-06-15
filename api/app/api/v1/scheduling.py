"""Scheduling management API (authenticated) — event-type CRUD + bookings.

The public, unauthenticated booking page lives in ``booking.py``.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Booking, EventType, Workflow
from app.services import scheduling as sched
from app.services import workflows as wf_svc

router = APIRouter(prefix="/event-types", tags=["scheduling"])


def _slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s or "meeting"


def _unique_slug(db: Session, workspace_id: str, base: str, exclude_id: Optional[str] = None) -> str:
    slug = base
    n = 1
    while True:
        q = db.query(EventType).filter(EventType.workspace_id == workspace_id, EventType.slug == slug)
        if exclude_id:
            q = q.filter(EventType.id != exclude_id)
        if not q.first():
            return slug
        n += 1
        slug = f"{base}-{n}"


def _serialize(et: EventType) -> dict:
    return {
        "id": et.id,
        "name": et.name,
        "slug": et.slug,
        "description": et.description,
        "duration_minutes": et.duration_minutes,
        "location_type": et.location_type,
        "location_details": et.location_details,
        "buffer_before_minutes": et.buffer_before_minutes,
        "buffer_after_minutes": et.buffer_after_minutes,
        "min_notice_minutes": et.min_notice_minutes,
        "date_range_days": et.date_range_days,
        "slot_interval_minutes": et.slot_interval_minutes,
        "timezone": et.timezone,
        "color": et.color,
        "active": et.active,
        "availability": et.availability or sched.DEFAULT_AVAILABILITY,
        "questions": et.questions or [],
        "reminder_offsets": et.reminder_offsets if et.reminder_offsets is not None else [1440, 60],
        "assignment": et.assignment or "single",
        "host_ids": et.host_ids or [],
        "brief_offset_minutes": et.brief_offset_minutes if et.brief_offset_minutes is not None else 30,
        "owner_id": et.owner_id,
    }


class EventTypeIn(BaseModel):
    name: str
    description: Optional[str] = None
    duration_minutes: int = 30
    location_type: str = "google_meet"
    location_details: Optional[str] = None
    buffer_before_minutes: int = 0
    buffer_after_minutes: int = 0
    min_notice_minutes: int = 120
    date_range_days: int = 30
    slot_interval_minutes: int = 30
    timezone: str = "UTC"
    color: str = "#3b82f6"
    active: bool = True
    availability: Optional[dict] = None
    questions: Optional[list] = None
    reminder_offsets: Optional[list] = None
    assignment: Optional[str] = None
    host_ids: Optional[list] = None
    brief_offset_minutes: Optional[int] = None
    slug: Optional[str] = None


@router.get("")
def list_event_types(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(EventType)
        .filter(EventType.workspace_id == ctx.workspace_id)
        .order_by(EventType.created_at.asc())
        .all()
    )
    from app.models import Membership, User

    members = (
        db.query(User)
        .join(Membership, Membership.user_id == User.id)
        .filter(Membership.workspace_id == ctx.workspace_id)
        .all()
    )
    return {
        "event_types": [_serialize(e) for e in rows],
        "workspace_slug": ctx.workspace.slug,
        "members": [
            {"id": u.id, "name": (f"{u.first_name or ''} {u.last_name or ''}".strip()) or u.email}
            for u in members
        ],
    }


@router.post("")
def create_event_type(
    body: EventTypeIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    if not body.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_required")
    base = _slugify(body.slug or body.name)
    slug = _unique_slug(db, ctx.workspace_id, base)
    et = EventType(
        workspace_id=ctx.workspace_id,
        owner_id=ctx.user_id,
        name=body.name.strip(),
        slug=slug,
        description=body.description,
        duration_minutes=body.duration_minutes,
        location_type=body.location_type,
        location_details=body.location_details,
        buffer_before_minutes=body.buffer_before_minutes,
        buffer_after_minutes=body.buffer_after_minutes,
        min_notice_minutes=body.min_notice_minutes,
        date_range_days=body.date_range_days,
        slot_interval_minutes=body.slot_interval_minutes,
        timezone=body.timezone,
        color=body.color,
        active=body.active,
        availability=body.availability or sched.DEFAULT_AVAILABILITY,
        questions=body.questions or [],
        reminder_offsets=body.reminder_offsets if body.reminder_offsets is not None else [1440, 60],
        assignment=body.assignment or "single",
        host_ids=body.host_ids or [],
        brief_offset_minutes=body.brief_offset_minutes if body.brief_offset_minutes is not None else 30,
    )
    db.add(et)
    db.commit()
    db.refresh(et)
    return _serialize(et)


def _get_owned(db: Session, ctx: AuthContext, event_type_id: str) -> EventType:
    et = (
        db.query(EventType)
        .filter(EventType.id == event_type_id, EventType.workspace_id == ctx.workspace_id)
        .first()
    )
    if not et:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return et


@router.get("/{event_type_id}")
def get_event_type(
    event_type_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    return _serialize(_get_owned(db, ctx, event_type_id))


@router.patch("/{event_type_id}")
def update_event_type(
    event_type_id: str,
    body: EventTypeIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    et = _get_owned(db, ctx, event_type_id)
    data = body.model_dump(exclude_unset=True)
    if "slug" in data and data["slug"]:
        et.slug = _unique_slug(db, ctx.workspace_id, _slugify(data.pop("slug")), exclude_id=et.id)
    elif "name" in data and not et.slug:
        et.slug = _unique_slug(db, ctx.workspace_id, _slugify(data["name"]), exclude_id=et.id)
    data.pop("slug", None)
    for k, v in data.items():
        setattr(et, k, v)
    db.commit()
    db.refresh(et)
    return _serialize(et)


@router.delete("/{event_type_id}")
def delete_event_type(
    event_type_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    et = _get_owned(db, ctx, event_type_id)
    db.delete(et)
    db.commit()
    return {"ok": True}


@router.get("/{event_type_id}/bookings")
def list_bookings(
    event_type_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _get_owned(db, ctx, event_type_id)
    rows = (
        db.query(Booking)
        .filter(Booking.event_type_id == event_type_id)
        .order_by(Booking.start_at.desc())
        .limit(200)
        .all()
    )
    return {"bookings": [_serialize_booking(b) for b in rows]}


def _serialize_booking(b: Booking) -> dict:
    return {
        "id": b.id,
        "invitee_name": b.invitee_name,
        "invitee_email": b.invitee_email,
        "invitee_phone": b.invitee_phone,
        "start_at": b.start_at,
        "end_at": b.end_at,
        "status": b.status,
        "disposition": b.disposition,
        "answers": b.answers or {},
        "lead_id": b.lead_id,
        "created_at": b.created_at,
    }


# Bookings cancel lives on a sibling router so the path isn't nested under a
# specific event type.
bookings_router = APIRouter(prefix="/bookings", tags=["scheduling"])


@bookings_router.delete("/{booking_id}")
def cancel_booking(
    booking_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    b = (
        db.query(Booking)
        .filter(Booking.id == booking_id, Booking.workspace_id == ctx.workspace_id)
        .first()
    )
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    sched.cancel_booking(db, b)
    return {"ok": True}


class DispositionIn(BaseModel):
    disposition: str  # completed | no_show


@bookings_router.patch("/{booking_id}/disposition")
def set_disposition(
    booking_id: str,
    body: DispositionIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    if body.disposition not in ("completed", "no_show"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_disposition")
    b = (
        db.query(Booking)
        .filter(Booking.id == booking_id, Booking.workspace_id == ctx.workspace_id)
        .first()
    )
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    sched.set_disposition(db, b, body.disposition)
    return {"ok": True, "disposition": b.disposition}


# --------------------------------------------------------------------------- #
# Workflows (booking-lifecycle automations)
# --------------------------------------------------------------------------- #

workflows_router = APIRouter(prefix="/workflows", tags=["workflows"])


def _serialize_workflow(w: Workflow) -> dict:
    return {
        "id": w.id,
        "name": w.name,
        "trigger": w.trigger,
        "active": w.active,
        "filters": w.filters or {},
        "actions": w.actions or [],
        "created_at": w.created_at,
    }


class WorkflowIn(BaseModel):
    name: str
    trigger: str
    active: bool = True
    filters: Optional[dict] = None
    actions: Optional[list] = None


@workflows_router.get("")
def list_workflows(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Workflow)
        .filter(Workflow.workspace_id == ctx.workspace_id)
        .order_by(Workflow.created_at.asc())
        .all()
    )
    return {"workflows": [_serialize_workflow(w) for w in rows], "triggers": sorted(wf_svc.TRIGGERS), "action_types": sorted(wf_svc.ACTION_TYPES)}


@workflows_router.post("")
def create_workflow(
    body: WorkflowIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    if body.trigger not in wf_svc.TRIGGERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_trigger")
    w = Workflow(
        workspace_id=ctx.workspace_id,
        name=body.name.strip() or "Workflow",
        trigger=body.trigger,
        active=body.active,
        filters=body.filters or {},
        actions=body.actions or [],
    )
    db.add(w)
    db.commit()
    db.refresh(w)
    return _serialize_workflow(w)


@workflows_router.patch("/{workflow_id}")
def update_workflow(
    workflow_id: str,
    body: WorkflowIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    w = (
        db.query(Workflow)
        .filter(Workflow.id == workflow_id, Workflow.workspace_id == ctx.workspace_id)
        .first()
    )
    if not w:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    data = body.model_dump(exclude_unset=True)
    if "trigger" in data and data["trigger"] not in wf_svc.TRIGGERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_trigger")
    for k, v in data.items():
        setattr(w, k, v)
    db.commit()
    db.refresh(w)
    return _serialize_workflow(w)


@workflows_router.delete("/{workflow_id}")
def delete_workflow(
    workflow_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    w = (
        db.query(Workflow)
        .filter(Workflow.id == workflow_id, Workflow.workspace_id == ctx.workspace_id)
        .first()
    )
    if not w:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(w)
    db.commit()
    return {"ok": True}
