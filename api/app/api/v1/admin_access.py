"""Platform-admin key issuance for OTHER users' own independent workspaces.

Every self-registered user (POST /auth/register) gets their own separate
workspace where they are "owner" — see auth.py:register. The per-workspace
key endpoints (workspaces.py:create_api_key, licenses.py:create_license_key)
are both restricted to one account and only ever operate on the CALLER's own
current workspace (ctx.workspace_id, resolved from their own Membership) —
so there was no way for that account to issue a key into someone ELSE's
self-registered workspace without first joining it as a member, which would
also hand them Membership-based read access to that workspace's leads and
campaigns. That defeats the actual requirement: the admin controls who gets
a working API key / license key, but never sees what a workspace does with
them once granted.

This router is the narrow bridge for that: given a target user's email,
look up the ONE workspace where they are "owner" (their own), and mint a key
scoped to it — without creating any Membership row for the admin and without
exposing anything about that workspace beyond its id/name. Every endpoint
here uses get_current_user (JWT only), never get_workspace_context, which is
exactly why this needs its own router instead of reusing workspaces.py /
licenses.py.
"""

import hashlib
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import ApiKey, LicenseKey, Membership, User, Workspace

router = APIRouter(prefix="/admin/access", tags=["admin-access"])

# Same account as workspaces.py:LICENSED_API_KEY_ADMIN_EMAIL and
# licenses.py:LICENSE_KEY_ISSUER_EMAIL — kept as its own literal here (rather
# than importing) so this file has no import-order dependency on either.
PLATFORM_ADMIN_EMAIL = "acemedia.qa@gmail.com"


def _require_platform_admin(user: User) -> None:
    if (user.email or "").strip().lower() != PLATFORM_ADMIN_EMAIL:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")


def _find_owned_workspace(db: Session, email: str) -> tuple[User, Workspace]:
    """The workspace where this email is "owner" — i.e. the one created for
    them at registration, not a team they were invited into elsewhere."""
    clean = (email or "").strip().lower()
    target = db.query(User).filter(User.email == clean).first()
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    m = (
        db.query(Membership)
        .filter(Membership.user_id == target.id, Membership.role == "owner")
        .first()
    )
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no_owned_workspace")
    ws = db.get(Workspace, m.workspace_id)
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace_not_found")
    return target, ws


class LookupOut(BaseModel):
    user_id: str
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    workspace_id: str
    workspace_name: str


@router.get("/lookup", response_model=LookupOut)
def lookup_user_workspace(
    email: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Find the workspace a given email owns, so the admin can confirm who
    they're about to grant a key to before issuing it. Returns ONLY identity
    fields — no leads, campaigns, or anything else about that workspace."""
    _require_platform_admin(user)
    target, ws = _find_owned_workspace(db, email)
    return LookupOut(
        user_id=target.id,
        email=target.email,
        first_name=target.first_name,
        last_name=target.last_name,
        workspace_id=ws.id,
        workspace_name=ws.name,
    )


class IssueApiKeyIn(BaseModel):
    email: EmailStr
    name: Optional[str] = None


@router.post("/api-keys")
def issue_api_key(
    body: IssueApiKeyIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_platform_admin(user)
    target, ws = _find_owned_workspace(db, body.email)
    raw = "lcx_" + secrets.token_urlsafe(32)
    prefix = raw[:12]
    record = ApiKey(
        workspace_id=ws.id,
        user_id=target.id,
        name=(body.name or "").strip() or "Chrome Extension",
        key_prefix=prefix,
        key_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    # Returned once — same reveal-once contract as workspaces.py:create_api_key.
    return {
        "id": record.id,
        "name": record.name,
        "key": raw,
        "key_prefix": prefix,
        "workspace_id": ws.id,
        "workspace_name": ws.name,
        "assigned_email": target.email,
    }


class InviteIn(BaseModel):
    email: EmailStr
    expires_at: Optional[datetime] = None


@router.post("/invite")
def invite_new_user(
    body: InviteIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Issue a license key for someone who DOESN'T have an account yet.
    Unlike issue_license_key above (which needs an existing owned workspace
    to bind to), this creates an unclaimed LicenseKey — workspace_id and
    assigned_user_id start NULL, pinned only to this email via invite_email.
    auth.py:register validates and claims it — filling in workspace_id +
    assigned_user_id — the moment that email actually registers, so the
    exact same key value works for signup, login, and the extension."""
    _require_platform_admin(user)
    clean_email = body.email.strip().lower()
    if db.query(User).filter(User.email == clean_email).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "email_already_has_account")
    raw = "lclk_" + secrets.token_urlsafe(32)
    prefix = raw[:12]
    record = LicenseKey(
        workspace_id=None,
        created_by_user_id=user.id,
        assigned_user_id=None,
        invite_email=clean_email,
        label=f"Invite for {clean_email}",
        key_prefix=prefix,
        key_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        status="active",
        expires_at=body.expires_at,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {"id": record.id, "key": raw, "key_prefix": prefix, "invite_email": clean_email}


class IssueLicenseKeyIn(BaseModel):
    email: EmailStr
    label: Optional[str] = None
    expires_at: Optional[datetime] = None


@router.post("/license-keys")
def issue_license_key(
    body: IssueLicenseKeyIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_platform_admin(user)
    target, ws = _find_owned_workspace(db, body.email)
    raw = "lclk_" + secrets.token_urlsafe(32)
    prefix = raw[:12]
    record = LicenseKey(
        workspace_id=ws.id,
        created_by_user_id=user.id,
        # Pinned to the target so this key can never be picked up by anyone
        # else in their workspace — matches how the target's own API key
        # (above) is also scoped to them specifically.
        assigned_user_id=target.id,
        label=(body.label or "").strip() or None,
        key_prefix=prefix,
        key_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        status="active",
        expires_at=body.expires_at,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    # Returned once — same reveal-once contract as licenses.py:create_license_key.
    return {
        "id": record.id,
        "label": record.label,
        "key": raw,
        "key_prefix": prefix,
        "workspace_id": ws.id,
        "workspace_name": ws.name,
        "assigned_email": target.email,
    }
