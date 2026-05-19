from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import ConnectedAccount, Integration

router = APIRouter(prefix="/integrations", tags=["integrations"])


@router.get("")
def list_integrations(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = db.query(Integration).filter(Integration.workspace_id == ctx.workspace_id).all()
    return [{"id": r.id, "provider": r.provider, "status": r.status, "config": r.config} for r in rows]


@router.get("/accounts")
def list_accounts(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(ConnectedAccount)
        .filter(ConnectedAccount.workspace_id == ctx.workspace_id)
        .all()
    )
    return [
        {
            "id": r.id,
            "provider": r.provider,
            "label": r.label,
            "external_id": r.external_id,
            "status": r.status,
            "config": r.config,
        }
        for r in rows
    ]


@router.post("/accounts")
def connect_account(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Generic connector for SMTP / LinkedIn cookie pairing.
    For OAuth providers (Gmail), use the dedicated callback flow on /integrations/gmail/*."""
    provider = body.get("provider")
    if provider not in {"smtp", "linkedin", "gmail"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid_provider")
    acct = ConnectedAccount(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        provider=provider,
        label=body.get("label"),
        external_id=body.get("external_id"),
        access_token=body.get("access_token"),
        refresh_token=body.get("refresh_token"),
        config=body.get("config", {}),
        status="active",
    )
    db.add(acct)
    db.commit()
    db.refresh(acct)
    return {"id": acct.id}


@router.delete("/accounts/{account_id}")
def delete_account(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    a = (
        db.query(ConnectedAccount)
        .filter(ConnectedAccount.id == account_id, ConnectedAccount.workspace_id == ctx.workspace_id)
        .first()
    )
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(a)
    db.commit()
    return {"ok": True}
