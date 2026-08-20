from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import decode_token
from app.models import ApiKey, LicenseKey, Membership, User, Workspace
import hashlib


class AuthContext:
    def __init__(
        self,
        user: User,
        workspace: Workspace,
        membership: Membership,
        license_key: Optional[LicenseKey] = None,
    ):
        self.user = user
        self.workspace = workspace
        self.membership = membership
        # Only set for extension calls (get_extension_context) — the
        # LicenseKey row that was validated for this request, so callers can
        # bump its last_used_at without a second lookup. None for web-app
        # (JWT) requests, which don't use license keys at all.
        self.license_key = license_key

    @property
    def workspace_id(self) -> str:
        return self.workspace.id

    @property
    def user_id(self) -> str:
        return self.user.id


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer(authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_token")
    try:
        payload = decode_token(token)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "inactive_user")
    return user


def get_workspace_context(
    user: User = Depends(get_current_user),
    x_workspace_id: Optional[str] = Header(default=None, alias="X-Workspace-Id"),
    db: Session = Depends(get_db),
) -> AuthContext:
    if not x_workspace_id:
        # Fall back to first membership
        m = db.query(Membership).filter(Membership.user_id == user.id).first()
        if not m:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "no_workspace")
    else:
        m = (
            db.query(Membership)
            .filter(Membership.user_id == user.id, Membership.workspace_id == x_workspace_id)
            .first()
        )
        if not m:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "workspace_forbidden")
    workspace = db.get(Workspace, m.workspace_id)
    if not workspace:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace_not_found")
    return AuthContext(user=user, workspace=workspace, membership=m)


def _hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_extension_context(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    x_license_key: Optional[str] = Header(default=None, alias="X-License-Key"),
    db: Session = Depends(get_db),
) -> AuthContext:
    """Auth for Chrome extension calls — requires X-API-Key (bound to a
    workspace + user, as before) AND X-License-Key: an admin-issued
    activation credential (Settings -> License Keys) that gates whether the
    extension is allowed to run at all, independent of the API key's own
    per-user attribution. Both must be present and valid; the license key
    must belong to the SAME workspace as the API key, and if an admin pinned
    it to one specific teammate, the API key must belong to that same user.
    See LicenseKey in models/base.py."""
    if not x_api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_api_key")
    if not x_license_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_license_key")

    key_prefix = x_api_key[:12]
    candidates = db.query(ApiKey).filter(ApiKey.key_prefix == key_prefix, ApiKey.revoked_at.is_(None)).all()
    hashed = _hash_api_key(x_api_key)
    api_key = next((k for k in candidates if k.key_hash == hashed), None)
    if not api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_api_key")

    lic_prefix = x_license_key[:12]
    lic_candidates = db.query(LicenseKey).filter(LicenseKey.key_prefix == lic_prefix).all()
    lic_hashed = _hash_api_key(x_license_key)
    license_key = next((k for k in lic_candidates if k.key_hash == lic_hashed), None)
    if not license_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_license_key")
    if license_key.status == "revoked":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "license_key_revoked")
    if license_key.expires_at and license_key.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "license_key_expired")
    if license_key.workspace_id != api_key.workspace_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "license_key_wrong_workspace")
    if license_key.assigned_user_id and license_key.assigned_user_id != api_key.user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "license_key_wrong_account")

    user = db.get(User, api_key.user_id)
    workspace = db.get(Workspace, api_key.workspace_id)
    if not user or not workspace:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_api_key")
    membership = (
        db.query(Membership)
        .filter(Membership.user_id == user.id, Membership.workspace_id == workspace.id)
        .first()
    )
    if not membership:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no_membership")
    return AuthContext(user=user, workspace=workspace, membership=membership, license_key=license_key)
