"""Content Hub — multi-business marketing-asset library.

A workspace owns many **businesses** (Google-Drive-style folders). Each
business gets a dynamic slug and holds a library of reusable **assets**:
HTML emails, WhatsApp messages, captions, SMS, or "other".

Routes (all JWT-Bearer + X-Workspace-Id scoped):

    GET    /content-hub/businesses                       list + per-business counts
    POST   /content-hub/businesses                       create (name -> unique slug)
    GET    /content-hub/businesses/{ref}                  one business by slug OR id (+ stats)
    PATCH  /content-hub/businesses/{business_id}          rename / rebrand
    DELETE /content-hub/businesses/{business_id}          delete (cascades assets)

    GET    /content-hub/businesses/{business_id}/assets   list assets (+ type stats)
    POST   /content-hub/businesses/{business_id}/assets   create asset
    GET    /content-hub/assets/{asset_id}                 read
    PATCH  /content-hub/assets/{asset_id}                 update
    DELETE /content-hub/assets/{asset_id}                 delete

Email sending of an asset is handled client-side via the existing Vercel
SMTP bridge (`/api/outreach/send`) — no send endpoint lives here.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import ContentAsset, ContentBusiness


router = APIRouter(prefix="/content-hub", tags=["content-hub"])

ASSET_TYPES = ("html_email", "whatsapp", "caption", "sms", "other")


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _slugify(name: str) -> str:
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "business"


def _unique_slug(db: Session, workspace_id: str, name: str, exclude_id: Optional[str] = None) -> str:
    base = _slugify(name)
    candidate = base
    n = 2
    while True:
        q = db.query(ContentBusiness).filter(
            ContentBusiness.workspace_id == workspace_id,
            ContentBusiness.slug == candidate,
        )
        if exclude_id:
            q = q.filter(ContentBusiness.id != exclude_id)
        if not q.first():
            return candidate
        candidate = f"{base}-{n}"
        n += 1


def _norm_tags(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def _type_stats(db: Session, business_id: str) -> dict:
    rows = (
        db.query(ContentAsset.type, func.count(ContentAsset.id))
        .filter(ContentAsset.business_id == business_id)
        .group_by(ContentAsset.type)
        .all()
    )
    by_type = {t: c for t, c in rows}
    return {
        "total": sum(by_type.values()),
        "email": by_type.get("html_email", 0),
        "whatsapp": by_type.get("whatsapp", 0),
        "caption": by_type.get("caption", 0),
        "sms": by_type.get("sms", 0),
        "other": by_type.get("other", 0),
    }


def _biz_dict(c: ContentBusiness, stats: Optional[dict] = None) -> dict:
    d = {
        "id": c.id,
        "name": c.name,
        "slug": c.slug,
        "description": c.description or "",
        "brand_color": c.brand_color or "#00361a",
        "accent_color": c.accent_color or "",
        "tone": c.tone or "",
        "logo_url": c.logo_url or "",
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }
    if stats is not None:
        d["stats"] = stats
    return d


def _asset_dict(a: ContentAsset) -> dict:
    return {
        "id": a.id,
        "_id": a.id,  # keep zip-compatible key for the ported UI
        "business_id": a.business_id,
        "title": a.title,
        "type": a.type,
        "content": a.content or "",
        "subject": a.subject or "",
        "platform": a.platform or "",
        "tags": a.tags or [],
        "notes": a.notes or "",
        "createdAt": a.created_at.isoformat() if a.created_at else None,
        "updatedAt": a.updated_at.isoformat() if a.updated_at else None,
    }


def _own_business(db: Session, ctx: AuthContext, ref: str) -> ContentBusiness:
    """Resolve a business by id first, then by slug, within the workspace."""
    c = (
        db.query(ContentBusiness)
        .filter(ContentBusiness.id == ref, ContentBusiness.workspace_id == ctx.workspace_id)
        .first()
    )
    if not c:
        c = (
            db.query(ContentBusiness)
            .filter(ContentBusiness.slug == ref, ContentBusiness.workspace_id == ctx.workspace_id)
            .first()
        )
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "business_not_found")
    return c


def _own_asset(db: Session, ctx: AuthContext, asset_id: str) -> ContentAsset:
    a = (
        db.query(ContentAsset)
        .filter(ContentAsset.id == asset_id, ContentAsset.workspace_id == ctx.workspace_id)
        .first()
    )
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "asset_not_found")
    return a


# ──────────────────────────────────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────────────────────────────────


class BusinessIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = None
    brand_color: Optional[str] = Field(default=None, max_length=20)
    accent_color: Optional[str] = Field(default=None, max_length=20)
    tone: Optional[str] = Field(default=None, max_length=40)
    logo_url: Optional[str] = Field(default=None, max_length=500)


class BusinessUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = None
    brand_color: Optional[str] = Field(default=None, max_length=20)
    accent_color: Optional[str] = Field(default=None, max_length=20)
    tone: Optional[str] = Field(default=None, max_length=40)
    logo_url: Optional[str] = Field(default=None, max_length=500)


class AssetIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    type: str = "html_email"
    content: str
    subject: Optional[str] = None
    platform: Optional[str] = None
    tags: Optional[object] = None
    notes: Optional[str] = None


class AssetUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    type: Optional[str] = None
    content: Optional[str] = None
    subject: Optional[str] = None
    platform: Optional[str] = None
    tags: Optional[object] = None
    notes: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────────
# Business routes
# ──────────────────────────────────────────────────────────────────────────


@router.get("/businesses")
def list_businesses(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(ContentBusiness)
        .filter(ContentBusiness.workspace_id == ctx.workspace_id)
        .order_by(ContentBusiness.created_at.desc())
        .all()
    )
    # One grouped query for all counts, keyed by business.
    count_rows = (
        db.query(ContentAsset.business_id, func.count(ContentAsset.id))
        .filter(ContentAsset.workspace_id == ctx.workspace_id)
        .group_by(ContentAsset.business_id)
        .all()
    )
    counts = {bid: c for bid, c in count_rows}
    out = []
    for c in rows:
        d = _biz_dict(c)
        d["asset_count"] = counts.get(c.id, 0)
        out.append(d)
    return {"businesses": out}


@router.post("/businesses", status_code=status.HTTP_201_CREATED)
def create_business(
    body: BusinessIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_required")
    c = ContentBusiness(
        workspace_id=ctx.workspace_id,
        name=name,
        slug=_unique_slug(db, ctx.workspace_id, name),
        description=body.description,
        brand_color=body.brand_color or "#00361a",
        accent_color=body.accent_color,
        tone=body.tone,
        logo_url=body.logo_url,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    d = _biz_dict(c)
    d["asset_count"] = 0
    return d


@router.get("/businesses/{ref}")
def get_business(
    ref: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_business(db, ctx, ref)
    return _biz_dict(c, stats=_type_stats(db, c.id))


@router.patch("/businesses/{business_id}")
def update_business(
    business_id: str,
    body: BusinessUpdate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_business(db, ctx, business_id)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "name_required")
        if new_name != c.name:
            c.slug = _unique_slug(db, ctx.workspace_id, new_name, exclude_id=c.id)
        c.name = new_name
        data.pop("name")
    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    db.refresh(c)
    return _biz_dict(c, stats=_type_stats(db, c.id))


@router.delete("/businesses/{business_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_business(
    business_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_business(db, ctx, business_id)
    db.delete(c)
    db.commit()
    return None


# ──────────────────────────────────────────────────────────────────────────
# Asset routes
# ──────────────────────────────────────────────────────────────────────────


@router.get("/businesses/{business_id}/assets")
def list_assets(
    business_id: str,
    type: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    biz = _own_business(db, ctx, business_id)
    q = db.query(ContentAsset).filter(ContentAsset.business_id == biz.id)
    if type and type != "all":
        q = q.filter(ContentAsset.type == type)
    if search:
        like = f"%{search.strip()}%"
        q = q.filter(
            ContentAsset.title.ilike(like)
            | ContentAsset.subject.ilike(like)
            | ContentAsset.notes.ilike(like)
        )
    rows = q.order_by(ContentAsset.created_at.desc()).all()
    return {
        "business": _biz_dict(biz),
        "assets": [_asset_dict(a) for a in rows],
        "stats": _type_stats(db, biz.id),
    }


@router.post("/businesses/{business_id}/assets", status_code=status.HTTP_201_CREATED)
def create_asset(
    business_id: str,
    body: AssetIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    biz = _own_business(db, ctx, business_id)
    if (body.type or "") not in ASSET_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_type")
    if not body.title.strip() or not (body.content or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "title_and_content_required")
    a = ContentAsset(
        workspace_id=ctx.workspace_id,
        business_id=biz.id,
        title=body.title.strip(),
        type=body.type,
        content=body.content,
        subject=(body.subject or None),
        platform=(body.platform or None),
        tags=_norm_tags(body.tags),
        notes=(body.notes or None),
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _asset_dict(a)


@router.get("/assets/{asset_id}")
def get_asset(
    asset_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    return _asset_dict(_own_asset(db, ctx, asset_id))


@router.patch("/assets/{asset_id}")
def update_asset(
    asset_id: str,
    body: AssetUpdate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    a = _own_asset(db, ctx, asset_id)
    data = body.model_dump(exclude_unset=True)
    if "type" in data and data["type"] is not None and data["type"] not in ASSET_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_type")
    if "tags" in data:
        data["tags"] = _norm_tags(data["tags"])
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
        if not data["title"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "title_required")
    # Empty-string subject/platform/notes become NULL for cleanliness.
    for k in ("subject", "platform", "notes"):
        if k in data and data[k] == "":
            data[k] = None
    for k, v in data.items():
        setattr(a, k, v)
    db.commit()
    db.refresh(a)
    return _asset_dict(a)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    a = _own_asset(db, ctx, asset_id)
    db.delete(a)
    db.commit()
    return None
