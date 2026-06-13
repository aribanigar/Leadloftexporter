"""Routing forms — authenticated CRUD + public evaluate.

A routing form asks qualifying questions, then matches its rules top-to-bottom
to route the visitor to an event type's booking page or an external URL
(falling back to ``default_action``).
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import RoutingForm, Workspace

router = APIRouter(prefix="/routing-forms", tags=["routing"])
public_router = APIRouter(prefix="/route", tags=["routing"])


def _slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "form"


def _unique_slug(db: Session, workspace_id: str, base: str, exclude_id: Optional[str] = None) -> str:
    slug, n = base, 1
    while True:
        q = db.query(RoutingForm).filter(RoutingForm.workspace_id == workspace_id, RoutingForm.slug == slug)
        if exclude_id:
            q = q.filter(RoutingForm.id != exclude_id)
        if not q.first():
            return slug
        n += 1
        slug = f"{base}-{n}"


def _serialize(f: RoutingForm) -> dict:
    return {
        "id": f.id,
        "name": f.name,
        "slug": f.slug,
        "active": f.active,
        "fields": f.fields or [],
        "rules": f.rules or [],
        "default_action": f.default_action or {},
    }


class RoutingFormIn(BaseModel):
    name: str
    active: bool = True
    fields: Optional[list] = None
    rules: Optional[list] = None
    default_action: Optional[dict] = None
    slug: Optional[str] = None


@router.get("")
def list_forms(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(RoutingForm)
        .filter(RoutingForm.workspace_id == ctx.workspace_id)
        .order_by(RoutingForm.created_at.asc())
        .all()
    )
    return {"forms": [_serialize(f) for f in rows], "workspace_slug": ctx.workspace.slug}


@router.post("")
def create_form(body: RoutingFormIn, ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_required")
    slug = _unique_slug(db, ctx.workspace_id, _slugify(body.slug or body.name))
    f = RoutingForm(
        workspace_id=ctx.workspace_id,
        name=body.name.strip(),
        slug=slug,
        active=body.active,
        fields=body.fields or [],
        rules=body.rules or [],
        default_action=body.default_action or {},
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return _serialize(f)


def _get(db: Session, ctx: AuthContext, form_id: str) -> RoutingForm:
    f = (
        db.query(RoutingForm)
        .filter(RoutingForm.id == form_id, RoutingForm.workspace_id == ctx.workspace_id)
        .first()
    )
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return f


@router.patch("/{form_id}")
def update_form(form_id: str, body: RoutingFormIn, ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    f = _get(db, ctx, form_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("slug"):
        f.slug = _unique_slug(db, ctx.workspace_id, _slugify(data.pop("slug")), exclude_id=f.id)
    data.pop("slug", None)
    for k, v in data.items():
        setattr(f, k, v)
    db.commit()
    db.refresh(f)
    return _serialize(f)


@router.delete("/{form_id}")
def delete_form(form_id: str, ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    f = _get(db, ctx, form_id)
    db.delete(f)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Public
# --------------------------------------------------------------------------- #

def _match(cond: dict, answers: dict) -> bool:
    field = cond.get("field")
    op = (cond.get("op") or "equals").lower()
    expected = str(cond.get("value", "")).strip().lower()
    actual = str(answers.get(field, "")).strip().lower()
    if op == "equals":
        return actual == expected
    if op == "not_equals":
        return actual != expected
    if op == "contains":
        return expected in actual
    return False


def _evaluate(form: RoutingForm, answers: dict) -> dict:
    for rule in form.rules or []:
        conds = rule.get("conditions") or []
        if conds and all(_match(c, answers) for c in conds):
            return rule.get("action") or {}
    return form.default_action or {}


@public_router.get("/{workspace_slug}/{form_slug}")
def public_form(workspace_slug: str, form_slug: str, db: Session = Depends(get_db)):
    ws = db.query(Workspace).filter(Workspace.slug == workspace_slug).first()
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    f = (
        db.query(RoutingForm)
        .filter(RoutingForm.workspace_id == ws.id, RoutingForm.slug == form_slug, RoutingForm.active.is_(True))
        .first()
    )
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return {"name": f.name, "slug": f.slug, "fields": f.fields or [], "workspace_slug": ws.slug}


class RouteSubmitIn(BaseModel):
    answers: dict


@public_router.post("/{workspace_slug}/{form_slug}")
def public_route(workspace_slug: str, form_slug: str, body: RouteSubmitIn, db: Session = Depends(get_db)):
    ws = db.query(Workspace).filter(Workspace.slug == workspace_slug).first()
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    f = (
        db.query(RoutingForm)
        .filter(RoutingForm.workspace_id == ws.id, RoutingForm.slug == form_slug, RoutingForm.active.is_(True))
        .first()
    )
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    action = _evaluate(f, body.answers or {})
    return {"action": action, "workspace_slug": ws.slug}
