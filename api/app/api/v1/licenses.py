"""License Keys — the admin-issued second credential the Chrome extension
must present (alongside a personal API key) to activate. See LicenseKey in
models/base.py and get_extension_context in core/deps.py for enforcement.
"""
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import LicenseKey, Membership, User

router = APIRouter(prefix="/workspaces/current/license-keys", tags=["license-keys"])


def _require_manager(ctx: AuthContext) -> None:
    """Only an owner or admin may generate/revoke/reset/delete license keys —
    same gate + idiom as team.py:_require_manager."""
    if ctx.membership.role not in {"owner", "admin"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_raw() -> tuple[str, str, str]:
    """Returns (raw_key, prefix, hash). Distinct prefix ("lclk_") from API
    keys ("lcx_") so the two are never visually confused."""
    raw = "lclk_" + secrets.token_urlsafe(32)
    return raw, raw[:12], _hash(raw)


def _effective_status(lk: LicenseKey) -> str:
    if lk.status == "revoked":
        return "revoked"
    if lk.expires_at and lk.expires_at <= datetime.now(timezone.utc):
        return "expired"
    return "active"


def _out(lk: LicenseKey, assigned: Optional[User]) -> dict:
    return {
        "id": lk.id,
        "label": lk.label,
        "key_prefix": lk.key_prefix,
        "status": _effective_status(lk),
        "assigned_user_id": lk.assigned_user_id,
        "assigned_user_email": assigned.email if assigned else None,
        "assigned_user_name": (
            (f"{assigned.first_name or ''} {assigned.last_name or ''}".strip() or assigned.email)
            if assigned
            else None
        ),
        "expires_at": lk.expires_at,
        "last_used_at": lk.last_used_at,
        "created_at": lk.created_at,
        "revoked_at": lk.revoked_at,
    }


def _validate_assignee(db: Session, ctx: AuthContext, user_id: Optional[str]) -> None:
    if not user_id:
        return
    m = (
        db.query(Membership)
        .filter(Membership.user_id == user_id, Membership.workspace_id == ctx.workspace_id)
        .first()
    )
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "assignee_not_in_workspace")


@router.get("")
def list_license_keys(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    _require_manager(ctx)
    rows = (
        db.query(LicenseKey)
        .filter(LicenseKey.workspace_id == ctx.workspace_id)
        .order_by(LicenseKey.created_at.desc())
        .all()
    )
    user_ids = {r.assigned_user_id for r in rows if r.assigned_user_id}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return [_out(r, users.get(r.assigned_user_id)) for r in rows]


class CreateLicenseKeyIn(BaseModel):
    label: Optional[str] = None
    assigned_user_id: Optional[str] = None
    expires_at: Optional[datetime] = None


@router.post("", status_code=status.HTTP_201_CREATED)
def create_license_key(
    body: CreateLicenseKeyIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _require_manager(ctx)
    _validate_assignee(db, ctx, body.assigned_user_id)
    raw, prefix, hashed = _generate_raw()
    record = LicenseKey(
        workspace_id=ctx.workspace_id,
        created_by_user_id=ctx.user_id,
        assigned_user_id=body.assigned_user_id,
        label=(body.label or "").strip() or None,
        key_prefix=prefix,
        key_hash=hashed,
        status="active",
        expires_at=body.expires_at,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    assigned = db.get(User, record.assigned_user_id) if record.assigned_user_id else None
    out = _out(record, assigned)
    out["key"] = raw  # returned once — caller must copy it now
    return out


class UpdateLicenseKeyIn(BaseModel):
    label: Optional[str] = None
    status: Optional[str] = None  # "active" | "revoked"
    assigned_user_id: Optional[str] = None
    clear_assigned_user: bool = False
    expires_at: Optional[datetime] = None
    clear_expiry: bool = False


@router.patch("/{key_id}")
def update_license_key(
    key_id: str,
    body: UpdateLicenseKeyIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Covers revoke/reactivate (status), reassigning or clearing the pinned
    teammate, and setting or clearing the expiry date."""
    _require_manager(ctx)
    lk = (
        db.query(LicenseKey)
        .filter(LicenseKey.id == key_id, LicenseKey.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lk:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if body.label is not None:
        lk.label = body.label.strip() or None
    if body.status is not None:
        if body.status not in {"active", "revoked"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_status")
        lk.status = body.status
        lk.revoked_at = datetime.now(timezone.utc) if body.status == "revoked" else None
    if body.clear_assigned_user:
        lk.assigned_user_id = None
    elif body.assigned_user_id is not None:
        _validate_assignee(db, ctx, body.assigned_user_id)
        lk.assigned_user_id = body.assigned_user_id
    if body.clear_expiry:
        lk.expires_at = None
    elif body.expires_at is not None:
        lk.expires_at = body.expires_at
    db.commit()
    db.refresh(lk)
    assigned = db.get(User, lk.assigned_user_id) if lk.assigned_user_id else None
    return _out(lk, assigned)


@router.post("/{key_id}/reset")
def reset_license_key(
    key_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Rotate the secret in place: same row (keeps label/assignment/expiry/
    history), brand-new raw key value. The old key stops working the instant
    this commits. Also un-revokes the row, since issuing a fresh secret to
    someone only makes sense if it's meant to work again."""
    _require_manager(ctx)
    lk = (
        db.query(LicenseKey)
        .filter(LicenseKey.id == key_id, LicenseKey.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lk:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    raw, prefix, hashed = _generate_raw()
    lk.key_prefix = prefix
    lk.key_hash = hashed
    lk.status = "active"
    lk.revoked_at = None
    db.commit()
    db.refresh(lk)
    assigned = db.get(User, lk.assigned_user_id) if lk.assigned_user_id else None
    out = _out(lk, assigned)
    out["key"] = raw
    return out


@router.delete("/{key_id}")
def delete_license_key(
    key_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _require_manager(ctx)
    lk = (
        db.query(LicenseKey)
        .filter(LicenseKey.id == key_id, LicenseKey.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lk:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(lk)
    db.commit()
    return {"ok": True}
