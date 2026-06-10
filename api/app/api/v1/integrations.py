"""Workspace integration endpoints.

Each provider follows the same shape:
  - POST /integrations/<provider>/connect   — save credentials, optionally test
  - POST /integrations/<provider>/test      — re-verify an existing connection
  - POST /integrations/<provider>/push      — for CRM providers, push leads out
  - DELETE /integrations/accounts/{id}      — disconnect

Credentials live in `ConnectedAccount` rows (one per workspace+user+provider).
The `config` JSONB holds provider-specific fields like SMTP host/port, the
HubSpot portal id, the Salesforce instance URL, or the Zapier webhook target.

For Gmail and SMTP we already have send-side support in
`app/services/email_sender.py`. HubSpot and Salesforce push contacts via
their public REST APIs using a long-lived access token the user pastes in
(no OAuth dance for now — that requires a registered OAuth app per vendor
and isn't blocking for "connect and send"). Zapier reuses the workspace
API key already exposed in Settings → API Keys.
"""
from __future__ import annotations

import asyncio
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import ConnectedAccount, Integration, Lead

router = APIRouter(prefix="/integrations", tags=["integrations"])


# ---------- Provider catalogue (read by frontend to render the grid) -------

PROVIDER_CATALOG = [
    {
        "id": "linkedin",
        "name": "LinkedIn",
        "description": "Pair the Chrome extension to enable LinkedIn capture & outreach.",
        "kind": "extension",
    },
    # Generic SMTP — exposed for users who self-host the backend or run
    # on a plan that allows outbound SMTP. On Render free/starter it'll
    # time out at connect-test; the error message tells the user why and
    # points at the HTTPS alternatives (Resend / SendGrid). The connect
    # endpoint validates the credentials before saving so a misconfigured
    # SMTP can't silently sit "active" without ever sending.
    {
        "id": "smtp",
        "name": "SMTP server",
        "description": "Send through your existing SMTP server (Hostinger, Zoho, Mailgun relay, self-hosted). Use port 465 (implicit TLS) or 587 (STARTTLS). Verified on connect.",
        "kind": "email",
    },
    {
        "id": "gmail",
        "name": "Gmail (App Password)",
        "description": "Connect a personal Gmail mailbox via an App Password. Sends through smtp.gmail.com on port 587 — only works on hosts that allow outbound SMTP.",
        "kind": "email",
    },
    {
        "id": "hubspot",
        "name": "HubSpot",
        "description": "Push leads to HubSpot contacts via Private App access token.",
        "kind": "crm",
    },
    {
        "id": "salesforce",
        "name": "Salesforce",
        "description": "Push leads to Salesforce via Connected App credentials.",
        "kind": "crm",
    },
    {
        "id": "resend",
        "name": "Resend",
        "description": "Send transactional + outreach emails over HTTPS (works on Render free tier — no SMTP). Free 3,000/mo, 1-minute signup.",
        "kind": "email",
    },
    {
        "id": "sendgrid",
        "name": "SendGrid",
        "description": "Send emails via SendGrid's HTTPS API (works on Render free tier — no SMTP). Free 100/day forever.",
        "kind": "email",
    },
    {
        "id": "apollo",
        "name": "Apollo.io",
        "description": "Fallback email + phone enrichment for leads our pattern-finder can't resolve (non-1st-degree connections, Gmail/M365 domains).",
        "kind": "enrichment",
    },
    {
        "id": "zapier",
        "name": "Zapier",
        "description": "Trigger any Zap from LeadCaptura — use the workspace API key.",
        "kind": "webhook",
    },
]


@router.get("/catalog")
def catalog():
    return PROVIDER_CATALOG


@router.get("")
def list_integrations(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
    rows = db.query(Integration).filter(Integration.workspace_id == ctx.workspace_id).all()
    return [
        {"id": r.id, "provider": r.provider, "status": r.status, "config": r.config}
        for r in rows
    ]


@router.get("/accounts")
def list_accounts(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
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
            "config": {k: v for k, v in (r.config or {}).items() if k != "_secrets"},
        }
        for r in rows
    ]


@router.delete("/accounts/{account_id}")
def delete_account(
    account_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    a = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.id == account_id,
            ConnectedAccount.workspace_id == ctx.workspace_id,
        )
        .first()
    )
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(a)
    db.commit()
    return {"ok": True}


def _upsert_account(
    db: Session,
    ctx: AuthContext,
    *,
    provider: str,
    label: Optional[str],
    external_id: Optional[str],
    access_token: Optional[str],
    refresh_token: Optional[str] = None,
    config: Optional[dict] = None,
) -> ConnectedAccount:
    existing = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.user_id == ctx.user_id,
            ConnectedAccount.provider == provider,
        )
        .first()
    )
    if existing:
        existing.label = label or existing.label
        existing.external_id = external_id or existing.external_id
        if access_token:
            existing.access_token = access_token
        if refresh_token:
            existing.refresh_token = refresh_token
        if config is not None:
            merged = dict(existing.config or {})
            merged.update(config)
            existing.config = merged
        existing.status = "active"
        db.commit()
        db.refresh(existing)
        return existing
    acct = ConnectedAccount(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        provider=provider,
        label=label,
        external_id=external_id,
        access_token=access_token,
        refresh_token=refresh_token,
        config=config or {},
        status="active",
    )
    db.add(acct)
    db.commit()
    db.refresh(acct)
    return acct


# ---------- SMTP ------------------------------------------------------------


async def _smtp_verify(host: str, port: int, username: str, password: str) -> None:
    """Open a TLS connection to the SMTP server and authenticate.

    Two TLS modes depending on the port:
      - **465**: implicit TLS — the connection is encrypted from byte 0,
        DO NOT call STARTTLS. Used by Hostinger, Zoho, many shared hosts.
      - **587 / 25**: STARTTLS — connect plain, then upgrade. Gmail's
        recommended port and the most common modern default.

    The old code always called STARTTLS, so port 465 servers (which
    reject any plain-text traffic) just timed out — that's the
    "smtp_connect_failed: Timed out connecting to smtp.hostinger.com
    on port 465" error.
    """
    import aiosmtplib

    use_implicit_tls = port == 465
    smtp = aiosmtplib.SMTP(
        hostname=host,
        port=port,
        timeout=15,
        use_tls=use_implicit_tls,
        start_tls=False,  # we issue STARTTLS manually below if needed
    )
    try:
        await smtp.connect()
        if not use_implicit_tls:
            # Port 587 / 25 — upgrade plain connection to TLS
            await smtp.starttls()
        await smtp.login(username, password)
    finally:
        try:
            await smtp.quit()
        except Exception:
            pass


@router.post("/smtp/connect")
def smtp_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    host = (body.get("host") or "").strip()
    port = int(body.get("port") or 587)
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    from_email = (body.get("from_email") or username).strip()
    if not host or not username or not password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "host_username_password_required")
    try:
        asyncio.run(_smtp_verify(host, port, username, password))
    except Exception as exc:  # noqa: BLE001
        # Detect Render's outbound-SMTP block (manifests as a TCP timeout)
        # and rewrite the error so the user knows it's a hosting limit,
        # not a config typo. Render's free/starter tier blocks ports 25,
        # 465, and 587 to prevent customers from spamming. The only way
        # around it is an HTTP-based mail relay (Gmail OAuth, SendGrid,
        # Postmark, Mailgun) — or upgrading the Render plan.
        msg = str(exc)
        if "timed out" in msg.lower() or "TimeoutError" in msg:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                (
                    f"smtp_blocked_by_host: connecting to {host}:{port} timed out — "
                    "your backend host (Render) blocks outbound SMTP ports on its "
                    "free/starter plan. Use the Gmail connector (App Password — uses "
                    "Gmail's HTTPS API, not SMTP) or sign up for SendGrid/Postmark/"
                    "Mailgun and connect via their SMTP relay on port 2525 (which "
                    "Render allows). Or upgrade your Render plan to unblock 25/465/587."
                ),
            )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"smtp_connect_failed: {exc}")
    acct = _upsert_account(
        db,
        ctx,
        provider="smtp",
        label=f"SMTP ({from_email})",
        external_id=from_email,
        access_token=password,
        config={"host": host, "port": port, "username": username, "from_email": from_email},
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


# ---------- Gmail (app password, no OAuth) ---------------------------------
# For a real OAuth flow we'd need a registered Google OAuth client and
# token-exchange callback; for now the user generates a Gmail App Password
# at https://myaccount.google.com/apppasswords and pastes it. We route
# sends through SMTP under the hood.


@router.post("/gmail/connect")
def gmail_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    email = (body.get("email") or "").strip()
    app_password = (body.get("app_password") or "").strip()
    if not email or not app_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "email_and_app_password_required")
    try:
        asyncio.run(_smtp_verify("smtp.gmail.com", 587, email, app_password))
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "timed out" in msg.lower() or "TimeoutError" in msg:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                (
                    "smtp_blocked_by_host: connecting to smtp.gmail.com:587 timed "
                    "out — your backend host (Render) blocks outbound SMTP ports "
                    "on its free/starter plan. This affects Gmail too because "
                    "Gmail's App-Password connector uses SMTP. Fix: sign up for "
                    "SendGrid (free 100/day), Postmark, or Mailgun and connect "
                    "via their SMTP relay on port 2525 (Render allows 2525). "
                    "Alternatively upgrade your Render plan to unblock 25/465/587."
                ),
            )
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"gmail_login_failed: {exc} (Generate an App Password at https://myaccount.google.com/apppasswords)",
        )
    acct = _upsert_account(
        db,
        ctx,
        provider="gmail",
        label=f"Gmail ({email})",
        external_id=email,
        access_token=app_password,
        config={
            "host": "smtp.gmail.com",
            "port": 587,
            "username": email,
            "from_email": email,
            "via": "app_password",
        },
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


# ---------- HubSpot ---------------------------------------------------------


def _hubspot_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@router.post("/hubspot/connect")
def hubspot_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Connect HubSpot via Private App access token. User generates one at:
    HubSpot → Settings → Integrations → Private Apps → Create."""
    token = (body.get("access_token") or "").strip()
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "access_token_required")
    # Verify by calling /account-info/v3/details
    try:
        with httpx.Client(timeout=15) as client:
            r = client.get(
                "https://api.hubapi.com/account-info/v3/details",
                headers=_hubspot_headers(token),
            )
            if r.status_code == 401:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "hubspot_invalid_token")
            r.raise_for_status()
            portal = r.json()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"hubspot_verify_failed: {exc}")
    portal_id = str(portal.get("portalId") or "")
    acct = _upsert_account(
        db,
        ctx,
        provider="hubspot",
        label=f"HubSpot (portal {portal_id})" if portal_id else "HubSpot",
        external_id=portal_id or None,
        access_token=token,
        config={"portal_id": portal_id},
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


@router.post("/hubspot/push")
def hubspot_push(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
    """Push every workspace lead with an email to HubSpot contacts."""
    acct = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider == "hubspot",
            ConnectedAccount.status == "active",
        )
        .first()
    )
    if not acct:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "hubspot_not_connected")
    leads = (
        db.query(Lead)
        .filter(Lead.workspace_id == ctx.workspace_id, Lead.email.isnot(None))
        .all()
    )
    pushed = 0
    failed = 0
    errors: list[str] = []
    with httpx.Client(timeout=20, headers=_hubspot_headers(acct.access_token or "")) as client:
        for lead in leads:
            payload = {
                "properties": {
                    "email": lead.email,
                    "firstname": lead.first_name or "",
                    "lastname": lead.last_name or "",
                    "jobtitle": lead.title or "",
                    "phone": lead.phone or "",
                    "city": lead.location or "",
                    "linkedinbio": lead.linkedin_url or "",
                }
            }
            try:
                r = client.post(
                    "https://api.hubapi.com/crm/v3/objects/contacts", json=payload
                )
                # 409 == duplicate (email already exists). Update via search+patch.
                if r.status_code == 409:
                    search = client.post(
                        "https://api.hubapi.com/crm/v3/objects/contacts/search",
                        json={
                            "filterGroups": [
                                {
                                    "filters": [
                                        {
                                            "propertyName": "email",
                                            "operator": "EQ",
                                            "value": lead.email,
                                        }
                                    ]
                                }
                            ]
                        },
                    )
                    results = (search.json() or {}).get("results") or []
                    if results:
                        cid = results[0].get("id")
                        client.patch(
                            f"https://api.hubapi.com/crm/v3/objects/contacts/{cid}",
                            json=payload,
                        )
                        pushed += 1
                        continue
                r.raise_for_status()
                pushed += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                if len(errors) < 10:
                    errors.append(f"{lead.email}: {exc}")
    return {"pushed": pushed, "failed": failed, "errors": errors}


# ---------- Salesforce ------------------------------------------------------


@router.post("/salesforce/connect")
def salesforce_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Connect Salesforce via username + password + security token, using the
    OAuth password grant flow. User must have a Connected App created in
    Salesforce with consumer key + secret pasted in here."""
    instance_url = (body.get("instance_url") or "").rstrip("/")
    consumer_key = (body.get("consumer_key") or "").strip()
    consumer_secret = (body.get("consumer_secret") or "").strip()
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    security_token = (body.get("security_token") or "").strip()
    if not all([instance_url, consumer_key, consumer_secret, username, password]):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "instance_url_consumer_key_consumer_secret_username_password_required",
        )
    token_url = f"{instance_url}/services/oauth2/token"
    data = {
        "grant_type": "password",
        "client_id": consumer_key,
        "client_secret": consumer_secret,
        "username": username,
        "password": password + security_token,
    }
    try:
        with httpx.Client(timeout=20) as client:
            r = client.post(token_url, data=data)
            r.raise_for_status()
            tok = r.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"salesforce_auth_failed: {exc}")
    acct = _upsert_account(
        db,
        ctx,
        provider="salesforce",
        label=f"Salesforce ({username})",
        external_id=username,
        access_token=tok.get("access_token"),
        refresh_token=tok.get("refresh_token"),
        config={
            "instance_url": tok.get("instance_url") or instance_url,
            "consumer_key": consumer_key,
            "consumer_secret": consumer_secret,
            "username": username,
        },
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


@router.post("/salesforce/push")
def salesforce_push(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
    acct = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider == "salesforce",
            ConnectedAccount.status == "active",
        )
        .first()
    )
    if not acct:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "salesforce_not_connected")
    cfg = acct.config or {}
    instance_url = cfg.get("instance_url")
    if not instance_url or not acct.access_token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "salesforce_missing_credentials")
    leads = (
        db.query(Lead)
        .filter(Lead.workspace_id == ctx.workspace_id, Lead.email.isnot(None))
        .all()
    )
    pushed = 0
    failed = 0
    errors: list[str] = []
    headers = {
        "Authorization": f"Bearer {acct.access_token}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=20, headers=headers) as client:
        for lead in leads:
            payload = {
                "Email": lead.email,
                "FirstName": lead.first_name or "Unknown",
                "LastName": lead.last_name or (lead.full_name or "Lead"),
                "Title": lead.title or "",
                "Phone": lead.phone or "",
                "Company": (lead.company.name if lead.company else "LinkedIn Lead"),
                "LeadSource": "LeadCaptura",
            }
            try:
                r = client.post(
                    f"{instance_url}/services/data/v60.0/sobjects/Lead", json=payload
                )
                if r.status_code == 400 and "DUPLICATES_DETECTED" in r.text:
                    pushed += 1  # already exists — count as success
                    continue
                r.raise_for_status()
                pushed += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                if len(errors) < 10:
                    errors.append(f"{lead.email}: {exc}")
    return {"pushed": pushed, "failed": failed, "errors": errors}


# ---------- Zapier ----------------------------------------------------------
# Zapier doesn't need a dedicated connection: Zaps authenticate against our
# public REST API using a workspace API key (Settings → API Keys). The
# "Connect" action just records intent + shows the user the helper info.


@router.post("/zapier/connect")
def zapier_connect(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
    acct = _upsert_account(
        db,
        ctx,
        provider="zapier",
        label="Zapier",
        external_id=ctx.workspace_id,
        access_token=None,
        config={
            "webhook_base": "https://api.leadcaptura.com/api/v1",
            "auth_header": "X-API-Key",
        },
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


# ---------- Apollo (fallback email + phone enrichment) ---------------------


@router.post("/apollo/connect")
def apollo_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Connect Apollo.io as the enrichment fallback. User generates an
    API key in Apollo → Settings → Integrations → API. The /v1/people/match
    endpoint takes a LinkedIn URL and returns email + phone, even for
    non-1st-degree connections — this is what closes the gap with
    LeadLoft's "you don't need to be connected" claim.

    Free tier: 50 matches/month. Paid: from $49/mo with 5,000 matches.
    """
    token = (body.get("api_key") or body.get("access_token") or "").strip()
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "api_key_required")
    # Verify by calling /v1/auth/health
    try:
        with httpx.Client(timeout=12) as client:
            r = client.get(
                "https://api.apollo.io/v1/auth/health",
                headers={"X-Api-Key": token, "Cache-Control": "no-cache"},
            )
            if r.status_code == 401:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "apollo_invalid_key")
            if not r.is_success:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"apollo_verify_failed_http_{r.status_code}",
                )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"apollo_verify_failed: {exc}")
    acct = _upsert_account(
        db,
        ctx,
        provider="apollo",
        label="Apollo.io",
        external_id=None,
        access_token=token,
        config={},
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


# ---------- Resend (HTTPS email send — works on Render free) ---------------


@router.post("/resend/connect")
def resend_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Connect Resend for outbound email. Pure HTTPS — never SMTP — so it
    works on Render free tier where ports 25/465/587 are blocked.

    User generates an API key at https://resend.com/api-keys and verifies
    a sender domain (or uses Resend's onboarding@resend.dev for testing).
    Free tier: 3,000 emails/mo. No card required.
    """
    api_key = (body.get("api_key") or "").strip()
    from_email = (body.get("from_email") or "").strip()
    if not api_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "api_key_required")
    # Verify by calling /domains (lightweight, validates the key)
    try:
        with httpx.Client(timeout=12) as client:
            r = client.get(
                "https://api.resend.com/domains",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if r.status_code == 401:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "resend_invalid_key")
            if not r.is_success:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"resend_verify_failed_http_{r.status_code}",
                )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"resend_verify_failed: {exc}")
    label = f"Resend ({from_email})" if from_email else "Resend"
    acct = _upsert_account(
        db, ctx,
        provider="resend",
        label=label,
        external_id=from_email or None,
        access_token=api_key,
        config={"send_endpoint": "https://api.resend.com/emails"},
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}


# ---------- SendGrid (HTTPS email send — works on Render free) -------------


@router.post("/sendgrid/connect")
def sendgrid_connect(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Connect SendGrid for outbound email via their HTTPS API. Same
    rationale as Resend — bypasses Render's SMTP block. Free 100/day.

    User creates an API key in SendGrid → Settings → API Keys (needs
    "Mail Send" permission). Must also verify a Sender Identity in
    SendGrid → Settings → Sender Authentication.
    """
    api_key = (body.get("api_key") or "").strip()
    from_email = (body.get("from_email") or "").strip()
    if not api_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "api_key_required")
    if not from_email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "from_email_required")
    # Verify the key
    try:
        with httpx.Client(timeout=12) as client:
            r = client.get(
                "https://api.sendgrid.com/v3/scopes",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if r.status_code == 401:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "sendgrid_invalid_key")
            if not r.is_success:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"sendgrid_verify_failed_http_{r.status_code}",
                )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"sendgrid_verify_failed: {exc}")
    acct = _upsert_account(
        db, ctx,
        provider="sendgrid",
        label=f"SendGrid ({from_email})",
        external_id=from_email,
        access_token=api_key,
        config={"send_endpoint": "https://api.sendgrid.com/v3/mail/send"},
    )
    return {"id": acct.id, "status": acct.status, "label": acct.label}
