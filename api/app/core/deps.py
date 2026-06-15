from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import decode_token
from app.models import ApiKey, Membership, User, Workspace
import hashlib


class AuthContext:
    def __init__(self, user: User, workspace: Workspace, membership: Membership):
        self.user = user
        self.workspace = workspace
        self.membership = membership

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
    db: Session = Depends(get_db),
) -> AuthContext:
    """Auth for Chrome extension calls — accepts X-API-Key bound to a workspace."""
    if not x_api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_api_key")
    key_prefix = x_api_key[:12]
    candidates = db.query(ApiKey).filter(ApiKey.key_prefix == key_prefix, ApiKey.revoked_at.is_(None)).all()
    hashed = _hash_api_key(x_api_key)
    api_key = next((k for k in candidates if k.key_hash == hashed), None)
    if not api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_api_key")
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
    return AuthContext(user=user, workspace=workspace, membership=membership)
