"""WhatsApp Web (Baileys) — proxy to the Node sidecar.

Why this router exists
    The existing ``whatsapp.py`` integrates the official Meta WhatsApp
    Business Cloud API. That requires a Meta business verification and a
    pre-approved message template for anything sent outside the 24-hour
    customer-service window — which makes it impossible for the typical
    self-serve user to actually send cold outreach.

    This module is the **WhatsApp Web** route: the user pairs their phone
    by scanning a QR code (exactly like web.whatsapp.com) and we send
    messages over the same multi-device WebSocket protocol via Baileys.

Architecture
    Baileys is Node-only, so the actual connection runs in the
    ``/whatsapp`` sidecar (a small Express server). This FastAPI router is
    a thin proxy: it forwards the workspace context and a shared sidecar
    token, and passes the JSON response through. The frontend keeps a
    single ``/api/v1/...`` shape so the React Query hooks don't need to
    know about the sidecar.

Configuration
    WA_SIDECAR_URL   — base URL of the Node sidecar (e.g. https://wa.internal:8001)
    WA_SIDECAR_TOKEN — shared secret, sent as ``X-Sidecar-Token``

    If ``WA_SIDECAR_URL`` is unset the router returns a structured
    "not_configured" response on every endpoint so the frontend can show a
    helpful onboarding state without crashing.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Lead

router = APIRouter(prefix="/whatsapp-web", tags=["whatsapp-web"])


def _sidecar_url() -> Optional[str]:
    url = (os.getenv("WA_SIDECAR_URL") or "").strip()
    return url.rstrip("/") if url else None


def _sidecar_token() -> str:
    return (os.getenv("WA_SIDECAR_TOKEN") or "").strip()


def _headers(ctx: AuthContext) -> dict[str, str]:
    headers = {
        "X-Workspace-Id": ctx.workspace_id,
        "Content-Type": "application/json",
    }
    tok = _sidecar_token()
    if tok:
        headers["X-Sidecar-Token"] = tok
    return headers


async def _proxy(
    method: str,
    path: str,
    ctx: AuthContext,
    json_body: Optional[dict] = None,
    params: Optional[dict] = None,
) -> Any:
    base = _sidecar_url()
    if not base:
        # Surface a structured error instead of a 500 so the frontend can
        # render "WhatsApp not configured" UI.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "whatsapp_sidecar_not_configured",
        )
    try:
        # Media payloads (base64) can be a few MB; we accept up to 24MB at
        # the sidecar's express layer, so allow a long enough timeout for
        # the round-trip + WhatsApp upload.
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.request(
                method,
                f"{base}{path}",
                headers=_headers(ctx),
                json=json_body,
                params=params,
            )
    except httpx.RequestError as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"whatsapp_sidecar_unreachable: {e}",
        )
    # Propagate the sidecar's HTTP status verbatim so the frontend can
    # distinguish "not connected" (400) from "auth failed" (401) etc.
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        raise HTTPException(resp.status_code, detail)
    try:
        return resp.json()
    except Exception:
        return {"ok": True}


# ─── Accounts ────────────────────────────────────────────────────────────


@router.get("/accounts")
async def list_accounts(ctx: AuthContext = Depends(get_workspace_context)):
    """List every paired WhatsApp number for this workspace plus live status
    (status='ready'/'qr'/'connecting'/'disconnected', qrDataUrl when waiting
    for the phone to scan)."""
    return await _proxy("GET", "/accounts", ctx)


class AccountIn(BaseModel):
    label: Optional[str] = Field(default=None, max_length=80)


@router.post("/accounts")
async def add_account(
    body: AccountIn,
    ctx: AuthContext = Depends(get_workspace_context),
):
    """Provision a new slot; the sidecar will immediately start Baileys and
    surface a QR via ``GET /accounts/{id}/status``."""
    return await _proxy("POST", "/accounts", ctx, {"label": body.label or ""})


@router.put("/accounts/{account_id}")
async def rename_account(
    account_id: str,
    body: AccountIn,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("PUT", f"/accounts/{account_id}", ctx, {"label": body.label or ""})


@router.delete("/accounts/{account_id}")
async def delete_account(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("DELETE", f"/accounts/{account_id}", ctx)


@router.get("/accounts/{account_id}/status")
async def account_status(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("GET", f"/accounts/{account_id}/status", ctx)


@router.post("/accounts/{account_id}/reconnect")
async def reconnect_account(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("POST", f"/accounts/{account_id}/reconnect", ctx)


@router.post("/accounts/{account_id}/logout")
async def logout_account(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("POST", f"/accounts/{account_id}/logout", ctx)


# ─── Send + campaigns ────────────────────────────────────────────────────


class MediaIn(BaseModel):
    base64: str = Field(min_length=4)
    mimetype: str = Field(min_length=1)
    filename: Optional[str] = None


class SendIn(BaseModel):
    account_id: Optional[str] = None
    phone: str = Field(min_length=4)
    # Either message OR media (or both — caption + image) must be present.
    # The sidecar enforces this; we keep both optional here.
    message: Optional[str] = Field(default=None, max_length=4000)
    media: Optional[MediaIn] = None
    country_code: Optional[str] = "91"


@router.post("/send")
async def send_one(
    body: SendIn,
    ctx: AuthContext = Depends(get_workspace_context),
):
    payload: dict[str, Any] = {
        "accountId": body.account_id,
        "phone": body.phone,
        "message": body.message or "",
        "countryCode": body.country_code or "91",
    }
    if body.media:
        payload["media"] = {
            "base64": body.media.base64,
            "mimetype": body.media.mimetype,
            "filename": body.media.filename or "",
        }
    return await _proxy("POST", "/send", ctx, payload)


# ─── Inbox / chats ───────────────────────────────────────────────────────


@router.get("/chats")
async def list_chats(
    account_id: Optional[str] = None,
    ctx: AuthContext = Depends(get_workspace_context),
):
    """List 1:1 conversations for the given (or default-ready) account, most
    recent message first. Group chats and status posts are excluded server-side
    so the inbox stays focused on lead conversations."""
    params = {"accountId": account_id} if account_id else None
    return await _proxy("GET", "/chats", ctx, params=params)


@router.get("/chats/{phone}")
async def get_chat(
    phone: str,
    account_id: Optional[str] = None,
    ctx: AuthContext = Depends(get_workspace_context),
):
    """Fetch the message thread for a single contact (last 200 messages, oldest
    first). Reading a chat resets its unread counter."""
    params = {"accountId": account_id} if account_id else None
    return await _proxy("GET", f"/chats/{phone}", ctx, params=params)


class StartCampaignIn(BaseModel):
    account_id: Optional[str] = None
    message: str = Field(min_length=1, max_length=4000)
    # Free-form contacts uploaded from CSV / manual entry. Frontend can also
    # send `lead_ids` / `stage_id` instead and we resolve them server-side.
    contacts: Optional[list[dict[str, Any]]] = None
    lead_ids: Optional[list[str]] = None
    stage_id: Optional[str] = None
    delay_min: int = 5000
    delay_max: int = 12000
    country_code: Optional[str] = "91"


def _phone_digits(raw: str | None) -> str:
    return re.sub(r"\D", "", raw or "")


@router.post("/campaigns/start")
async def start_campaign(
    body: StartCampaignIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Start a bulk WhatsApp campaign.

    Two recipient modes are supported:
      1. ``contacts`` — list of {phone, name?, ...mergeTokens?} from the UI.
      2. ``lead_ids`` or ``stage_id`` — pull leads straight from the CRM
         pipeline. This is the "Fetch from pipeline" UX. We resolve them to
         contact rows here so the sidecar stays stateless about the CRM.
    """
    contacts: list[dict[str, Any]] = list(body.contacts or [])

    if body.lead_ids or body.stage_id:
        q = (
            db.query(Lead)
            .options(joinedload(Lead.company))  # type: ignore[attr-defined]
            .filter(Lead.workspace_id == ctx.workspace_id)
        )
        if body.lead_ids:
            q = q.filter(Lead.id.in_(body.lead_ids))
        if body.stage_id:
            q = q.filter(Lead.stage_id == body.stage_id)
        for lead in q.all():
            digits = _phone_digits(lead.phone)
            if not digits:
                continue
            first = (lead.first_name or "").strip()
            if not first and lead.full_name:
                first = lead.full_name.strip().split(" ")[0]
            company = ""
            if lead.company_id and getattr(lead, "company", None):
                company = (lead.company.name or "").strip()
            contacts.append(
                {
                    "phone": digits,
                    "name": (lead.full_name or first or digits),
                    "first_name": first or "there",
                    "last_name": (lead.last_name or "").strip(),
                    "full_name": (lead.full_name or first or "there").strip(),
                    "title": (lead.title or "").strip(),
                    "company": company,
                    "email": (lead.email or "").strip(),
                }
            )

    if not contacts:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "no_contacts_with_phone",
        )

    return await _proxy(
        "POST",
        "/campaigns/start",
        ctx,
        {
            "accountId": body.account_id,
            "message": body.message,
            "contacts": contacts,
            "delayMin": body.delay_min,
            "delayMax": body.delay_max,
            "countryCode": body.country_code or "91",
        },
    )


@router.get("/campaigns")
async def list_campaigns(ctx: AuthContext = Depends(get_workspace_context)):
    return await _proxy("GET", "/campaigns", ctx)


@router.get("/campaigns/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("GET", f"/campaigns/{campaign_id}", ctx)


@router.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("POST", f"/campaigns/{campaign_id}/pause", ctx)


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("POST", f"/campaigns/{campaign_id}/resume", ctx)


@router.post("/campaigns/{campaign_id}/cancel")
async def cancel_campaign(
    campaign_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
):
    return await _proxy("POST", f"/campaigns/{campaign_id}/cancel", ctx)
