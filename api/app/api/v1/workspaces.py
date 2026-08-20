import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context, get_current_user
from app.core.security import hash_password
from app.models import ApiKey, Membership, SavedView, User, Workspace
from app.schemas import WorkspaceOut

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

# API keys determine which account a captured lead is attributed to
# (ApiKey.user_id -> Lead.owner_id) and, alongside a license key
# (see licenses.py), let the Chrome extension activate. Key *creation* is
# restricted to this single account so signing up alone can't self-issue a
# working credential; existing keys already issued to other users keep
# working (list/use/revoke below are untouched) and nothing else about auth
# changes.
LICENSED_API_KEY_ADMIN_EMAIL = "acemedia.qa@gmail.com"


@router.get("/current", response_model=WorkspaceOut)
def get_current_workspace(ctx: AuthContext = Depends(get_workspace_context)) -> WorkspaceOut:
    return WorkspaceOut.model_validate(ctx.workspace)


@router.patch("/current", response_model=WorkspaceOut)
def update_current_workspace(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    if ctx.membership.role not in {"owner", "admin"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    ws = ctx.workspace
    if "name" in body:
        ws.name = body["name"]
    if "settings" in body and isinstance(body["settings"], dict):
        merged = dict(ws.settings or {})
        merged.update(body["settings"])
        ws.settings = merged
    db.commit()
    db.refresh(ws)
    return WorkspaceOut.model_validate(ws)


@router.get("/current/views")
def list_views(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(SavedView)
        .filter(SavedView.workspace_id == ctx.workspace_id)
        .order_by(SavedView.position.asc(), SavedView.created_at.asc())
        .all()
    )
    return [
        {
            "id": v.id,
            "name": v.name,
            "icon": v.icon,
            "filters": v.filters,
            "columns": v.columns,
            "sort": v.sort,
            "is_shared": v.is_shared,
            "user_id": v.user_id,
            "position": v.position,
        }
        for v in rows
    ]


@router.post("/current/views")
def create_view(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    v = SavedView(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        name=body.get("name", "Untitled view"),
        icon=body.get("icon"),
        filters=body.get("filters", {}),
        columns=body.get("columns", []),
        sort=body.get("sort", {}),
        is_shared=bool(body.get("is_shared", False)),
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"id": v.id}


# ---- API keys (for the Chrome extension) ----


def _is_key_admin(ctx: AuthContext) -> bool:
    return (ctx.user.email or "").strip().lower() == LICENSED_API_KEY_ADMIN_EMAIL


@router.get("/current/api-keys")
def list_api_keys(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    # The admin issues keys on behalf of teammates (create_api_key below
    # accepts a target user_id) so they need to see every key in the
    # workspace, with whose it is, to manage what they've handed out.
    # Everyone else only ever sees their own — unchanged from before.
    admin_view = _is_key_admin(ctx)
    q = db.query(ApiKey).filter(ApiKey.workspace_id == ctx.workspace_id)
    if not admin_view:
        q = q.filter(ApiKey.user_id == ctx.user_id)
    rows = q.order_by(ApiKey.created_at.desc()).all()
    users = {}
    if admin_view and rows:
        user_ids = {k.user_id for k in rows}
        users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}
    return [
        {
            "id": k.id,
            "name": k.name,
            "key_prefix": k.key_prefix,
            "last_used_at": k.last_used_at,
            "revoked_at": k.revoked_at,
            "created_at": k.created_at,
            **({"user_email": users[k.user_id].email} if admin_view and k.user_id in users else {}),
        }
        for k in rows
    ]


@router.post("/current/api-keys")
def create_api_key(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    if not _is_key_admin(ctx):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "api_key_creation_restricted")
    # The admin can issue a key for themselves (default) or for any teammate
    # already in this workspace via body.user_id — the key is still created
    # under THAT person's user_id (that's what makes their captured leads
    # save to their own account, ApiKey.user_id -> Lead.owner_id), the admin
    # just hands it to them directly instead of them self-serving it.
    target_user_id = body.get("user_id") or ctx.user_id
    if target_user_id != ctx.user_id:
        target_membership = (
            db.query(Membership)
            .filter(Membership.user_id == target_user_id, Membership.workspace_id == ctx.workspace_id)
            .first()
        )
        if not target_membership:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "target_not_in_workspace")

    raw = "lcx_" + secrets.token_urlsafe(32)
    prefix = raw[:12]
    import hashlib

    record = ApiKey(
        workspace_id=ctx.workspace_id,
        user_id=target_user_id,
        name=body.get("name", "Chrome Extension"),
        key_prefix=prefix,
        key_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    # Returned once. Frontend must store/copy it.
    return {"id": record.id, "name": record.name, "key": raw, "key_prefix": prefix, "user_id": target_user_id}


@router.delete("/current/api-keys/{key_id}")
def delete_api_key(
    key_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Hard-delete a single API key. Replaces the previous soft-revoke
    behavior — soft-revoked keys cluttered the dashboard, and the
    auth path already enforces `revoked_at IS NULL` so the user still
    cannot use the deleted token even with the row removed."""
    k = (
        db.query(ApiKey)
        .filter(ApiKey.id == key_id, ApiKey.workspace_id == ctx.workspace_id)
        .first()
    )
    if not k:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(k)
    db.commit()
    return {"ok": True}


@router.delete("/current/api-keys")
def wipe_api_keys(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Bulk hard-delete every API key for this workspace+user. Used by
    the API Keys page's "Wipe all" action so the user can start over
    with a clean dashboard."""
    deleted = (
        db.query(ApiKey)
        .filter(ApiKey.workspace_id == ctx.workspace_id, ApiKey.user_id == ctx.user_id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": deleted}
