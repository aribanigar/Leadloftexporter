from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.core.security import hash_password
from app.models import Campaign, Membership, User

router = APIRouter(prefix="/workspaces/current/members", tags=["team"])

# Roles assignable through this router. "owner" is intentionally excluded —
# ownership is only ever granted by /auth/register creating a brand-new
# workspace, so there is always exactly one clear owner and no risk of a
# workspace being left without one via a team-management mis-click.
# "campaigns_only" is the new restricted role this feature adds: the member
# can sign in and use ONLY the Campaigns section (create/send/analyse) plus
# their own account settings — everything else in the app is hidden/blocked
# on the frontend. It is enforced the same way "admin"/"member" already were
# (a plain string on Membership.role — no migration needed).
ASSIGNABLE_ROLES = {"admin", "member", "campaigns_only"}


def _require_manager(ctx: AuthContext) -> None:
    """Only an owner or admin may view/add/edit/remove team members — mirrors
    the existing role gate in workspaces.py:update_current_workspace and
    calendar.py's Google-credential save (same `role not in {...}` idiom)."""
    if ctx.membership.role not in {"owner", "admin"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")


def _member_out(m: Membership, u: User, campaign_count: int) -> dict:
    return {
        "membership_id": m.id,
        "user_id": u.id,
        "email": u.email,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "role": m.role,
        "campaign_count": campaign_count,
        "created_at": m.created_at,
    }


@router.get("")
def list_members(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    """Every member of the current workspace, with role + how many campaigns
    each has created (Campaign.user_id is already set to the creator on
    every campaign — see campaigns.py:create_campaign — so this is a single
    grouped count, no new tracking needed)."""
    _require_manager(ctx)
    rows = (
        db.query(Membership, User)
        .join(User, User.id == Membership.user_id)
        .filter(Membership.workspace_id == ctx.workspace_id)
        .order_by(Membership.created_at.asc())
        .all()
    )
    counts = dict(
        db.query(Campaign.user_id, func.count(Campaign.id))
        .filter(Campaign.workspace_id == ctx.workspace_id)
        .group_by(Campaign.user_id)
        .all()
    )
    return [_member_out(m, u, counts.get(u.id, 0)) for m, u in rows]


class CreateMemberIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    first_name: str | None = None
    last_name: str | None = None
    role: str = "campaigns_only"


@router.post("", status_code=status.HTTP_201_CREATED)
def create_member(
    body: CreateMemberIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Create a brand-new team-member account scoped to THIS workspace.
    Mirrors auth.py:register's User-creation exactly (same hash_password,
    same email-uniqueness guard) but skips creating a new Workspace — the
    member joins the CALLER's workspace directly with the given role, so
    they can log in immediately with the email/password the admin set here.
    """
    _require_manager(ctx)
    role = (body.role or "campaigns_only").strip().lower()
    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_role")
    email = body.email.lower().strip()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "email_in_use")

    user = User(
        email=email,
        password_hash=hash_password(body.password),
        first_name=(body.first_name or "").strip() or None,
        last_name=(body.last_name or "").strip() or None,
    )
    db.add(user)
    db.flush()
    membership = Membership(user_id=user.id, workspace_id=ctx.workspace_id, role=role)
    db.add(membership)
    db.commit()
    db.refresh(membership)
    return _member_out(membership, user, 0)


class UpdateMemberIn(BaseModel):
    role: str


@router.patch("/{membership_id}")
def update_member_role(
    membership_id: str,
    body: UpdateMemberIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    _require_manager(ctx)
    role = (body.role or "").strip().lower()
    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_role")
    m = (
        db.query(Membership)
        .filter(Membership.id == membership_id, Membership.workspace_id == ctx.workspace_id)
        .first()
    )
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if m.role == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cannot_change_owner")
    m.role = role
    db.commit()
    db.refresh(m)
    u = db.get(User, m.user_id)
    campaign_count = (
        db.query(func.count(Campaign.id))
        .filter(Campaign.workspace_id == ctx.workspace_id, Campaign.user_id == m.user_id)
        .scalar()
        or 0
    )
    return _member_out(m, u, campaign_count)


@router.delete("/{membership_id}")
def remove_member(
    membership_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Revoke the member's access to THIS workspace. Deletes only the
    Membership row — never the User — so if they belong to any other
    workspace (or are re-invited later) their account and history there are
    untouched. Campaign rows they created stay exactly as they are (the
    Campaign.user_id foreign key is unaffected by removing a Membership)."""
    _require_manager(ctx)
    m = (
        db.query(Membership)
        .filter(Membership.id == membership_id, Membership.workspace_id == ctx.workspace_id)
        .first()
    )
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if m.role == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cannot_remove_owner")
    db.delete(m)
    db.commit()
    return {"ok": True}
