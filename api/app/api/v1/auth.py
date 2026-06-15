from datetime import datetime, timedelta, timezone
import hashlib
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from slugify import slugify
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.models import EmailMessage, Membership, User, Workspace
from app.schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut
from app.schemas.auth import WorkspaceContext
from app.services.bootstrap import seed_workspace_defaults

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

PASSWORD_RESET_TTL_MINUTES = 30


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
    try:
        seed_workspace_defaults(db, workspace.id)
    except Exception:
        pass  # seed failures are non-fatal; defaults can be missing but user still registers
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


# ─── Password reset ─────────────────────────────────────────────────────────
# Two-step flow:
#   1. POST /auth/forgot-password { email } — stores a hashed token on the
#      user row, emails the user a reset link with the raw token.
#   2. POST /auth/reset-password   { token, password } — verifies the token,
#      sets the new password, clears the token.
#
# Security:
#   * The raw token never persists; we store SHA-256(token).
#   * 30-minute TTL.
#   * /forgot-password ALWAYS returns 200 — never reveal whether an email
#     exists in the database (standard anti-enumeration).
#   * Best-effort email send via the user's own workspace's connected sender.
#     If they have no sender connected, the endpoint still returns 200 and
#     logs the failure. The dev_reset_link field below is only included when
#     debug is on, so tests/dev can use it without a real mailbox.


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=8, max_length=128)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _send_password_reset_email(db: Session, user: User, reset_url: str) -> bool:
    """Queue + send the reset email via any workspace the user belongs to that
    has a connected sender. Returns True on send. Never raises — caller treats
    a False as "couldn't deliver" without failing the request."""
    try:
        from app.services.email_sender import send_email_message

        memberships = db.query(Membership).filter(Membership.user_id == user.id).all()
        if not memberships:
            return False
        for m in memberships:
            ws = db.get(Workspace, m.workspace_id)
            if not ws:
                continue
            subject = "Reset your LeadCaptura password"
            body_html = (
                f"<p>Hi{(' ' + user.first_name) if user.first_name else ''},</p>"
                f"<p>We received a request to reset your LeadCaptura password. "
                f"Click the link below to set a new one — it expires in {PASSWORD_RESET_TTL_MINUTES} minutes.</p>"
                f"<p><a href='{reset_url}' "
                f"style='display:inline-block;padding:10px 18px;background:#00361a;"
                f"color:#fff;border-radius:6px;text-decoration:none;font-weight:600'>Reset password</a></p>"
                f"<p style='color:#6b7280;font-size:12px'>If the button doesn't work, paste this URL "
                f"into your browser:<br><code>{reset_url}</code></p>"
                f"<p style='color:#6b7280;font-size:12px'>If you didn't request this, you can safely "
                f"ignore this email — your password won't change.</p>"
            )
            body_text = (
                f"Reset your LeadCaptura password.\n\n"
                f"Open this link within {PASSWORD_RESET_TTL_MINUTES} minutes:\n{reset_url}\n\n"
                f"If you didn't request this, ignore this email."
            )
            msg = EmailMessage(
                workspace_id=ws.id,
                direction="outbound",
                from_address="",  # filled by the sender from the connected account
                to_address=user.email,
                subject=subject,
                body_html=body_html,
                body_text=body_text,
                status="queued",
            )
            db.add(msg)
            db.flush()
            result = send_email_message(db, msg, ws, user_id=user.id)
            db.commit()
            if getattr(result, "ok", False):
                return True
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning("password reset email failed for %s: %s", user.email, exc)
        return False


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest, db: Session = Depends(get_db)) -> dict:
    """Always returns 200 with a generic message — never reveals whether the
    email exists in the database. If a matching active user is found, generates
    a one-time token, stores SHA-256(token), and emails them the link."""
    settings = get_settings()
    generic = {"ok": True, "message": "If that email exists, a reset link has been sent."}

    email = body.email.lower().strip()
    user = db.query(User).filter(User.email == email).first()
    if not user or not user.is_active:
        return generic

    raw_token = secrets.token_urlsafe(32)
    user.password_reset_token_hash = _hash_token(raw_token)
    user.password_reset_expires_at = datetime.now(timezone.utc) + timedelta(minutes=PASSWORD_RESET_TTL_MINUTES)
    db.commit()

    reset_url = f"{settings.primary_frontend_origin}/reset-password?token={raw_token}"
    sent = _send_password_reset_email(db, user, reset_url)

    response: dict = dict(generic)
    if not sent:
        # We couldn't deliver. Tell the user *generically* so we still don't
        # leak account existence, but log it for the operator.
        log.info("password reset created for %s but no email channel available", email)
    if getattr(settings, "debug", False):
        # Dev/test escape hatch — surfaces the link so it can be used without
        # a real mailbox. Disabled in production by the debug flag.
        response["dev_reset_link"] = reset_url
    return response


@router.post("/reset-password", response_model=TokenResponse)
def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)) -> TokenResponse:
    token_hash = _hash_token(body.token)
    user = db.query(User).filter(User.password_reset_token_hash == token_hash).first()
    if not user or not user.password_reset_expires_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_or_expired_token")
    if user.password_reset_expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_or_expired_token")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "inactive_user")

    user.password_hash = hash_password(body.password)
    user.password_reset_token_hash = None
    user.password_reset_expires_at = None
    db.commit()
    db.refresh(user)
    return _build_token(db, user)
