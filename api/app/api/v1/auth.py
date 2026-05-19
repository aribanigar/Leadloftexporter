from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from slugify import slugify
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.models import Membership, User, Workspace
from app.schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut
from app.schemas.auth import WorkspaceContext
from app.services.bootstrap import seed_workspace_defaults

router = APIRouter(prefix="/auth", tags=["auth"])


def _build_token(db: Session, user: User) -> TokenResponse:
    memberships = db.query(Membership).filter(Membership.user_id == user.id).all()
    contexts: list[WorkspaceContext] = []
    for m in memberships:
        ws = db.get(Workspace, m.workspace_id)
        if not ws:
            continue
        contexts.append(WorkspaceContext(id=ws.id, name=ws.name, slug=ws.slug, role=m.role))
    current = contexts[0].id if contexts else None
    token = create_access_token(subject=user.id)
    return TokenResponse(
        access_token=token,
        user=UserOut.model_validate(user),
        workspaces=contexts,
        current_workspace_id=current,
    )


def _unique_slug(db: Session, base: str) -> str:
    base = slugify(base) or "workspace"
    candidate = base
    i = 2
    while db.query(Workspace).filter(Workspace.slug == candidate).first() is not None:
        candidate = f"{base}-{i}"
        i += 1
    return candidate


@router.post("/register", response_model=TokenResponse)
def register(body: RegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    if db.query(User).filter(User.email == body.email.lower()).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "email_in_use")
    user = User(
        email=body.email.lower(),
        password_hash=hash_password(body.password),
        first_name=body.first_name,
        last_name=body.last_name,
    )
    db.add(user)
    db.flush()

    ws_name = body.workspace_name or (
        f"{body.first_name}'s Workspace" if body.first_name else body.email.split("@")[0]
    )
    workspace = Workspace(
        name=ws_name,
        slug=_unique_slug(db, ws_name),
        plan="trial",
        trial_ends_at=datetime.now(timezone.utc) + timedelta(days=14),
    )
    db.add(workspace)
    db.flush()
    db.add(Membership(user_id=user.id, workspace_id=workspace.id, role="owner"))
    seed_workspace_defaults(db, workspace.id)
    db.commit()
    db.refresh(user)
    return _build_token(db, user)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "inactive_user")
    return _build_token(db, user)


@router.get("/me", response_model=TokenResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> TokenResponse:
    return _build_token(db, user)
