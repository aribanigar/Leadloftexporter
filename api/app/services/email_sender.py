"""Send queued EmailMessage rows via Gmail OAuth or generic SMTP.

This is intentionally small — production should add per-account warmup,
DKIM checks, and bounce handling, but the core dispatch and quota model lives
here so the playbook engine can call it.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
from email.message import EmailMessage as PyEmail
from typing import Optional

import aiosmtplib
from sqlalchemy.orm import Session

from app.models import ConnectedAccount, EmailMessage, Workspace
from app.services.outreach import emails_sent_today, outreach_settings


class SendResult:
    def __init__(self, ok: bool, provider_message_id: Optional[str] = None, error: Optional[str] = None):
        self.ok = ok
        self.provider_message_id = provider_message_id
        self.error = error


def _pick_account(db: Session, workspace_id: str, user_id: str) -> Optional[ConnectedAccount]:
    return (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == workspace_id,
            ConnectedAccount.user_id == user_id,
            ConnectedAccount.provider.in_(("gmail", "smtp")),
            ConnectedAccount.status == "active",
        )
        .order_by(ConnectedAccount.updated_at.desc())
        .first()
    )


async def _smtp_send(account: ConnectedAccount, msg: PyEmail) -> SendResult:
    cfg = account.config or {}
    host = cfg.get("host", "smtp.gmail.com")
    port = int(cfg.get("port", 587))
    username = account.external_id or cfg.get("username")
    password = account.access_token  # stored encrypted in real prod
    try:
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=port,
            start_tls=True,
            username=username,
            password=password,
            timeout=20,
        )
        return SendResult(True, provider_message_id=msg["Message-ID"])
    except Exception as exc:  # noqa: BLE001
        return SendResult(False, error=str(exc))


def _gmail_send(account: ConnectedAccount, msg: PyEmail) -> SendResult:
    try:
        from googleapiclient.discovery import build
        from google.oauth2.credentials import Credentials

        creds = Credentials(token=account.access_token, refresh_token=account.refresh_token)
        service = build("gmail", "v1", credentials=creds)
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()
        return SendResult(True, provider_message_id=sent.get("id"))
    except Exception as exc:  # noqa: BLE001
        return SendResult(False, error=str(exc))


def send_email_message(
    db: Session, message: EmailMessage, workspace: Workspace, user_id: Optional[str] = None
) -> SendResult:
    if message.status not in {"queued", "failed"}:
        return SendResult(False, error="not_sendable")
    settings = outreach_settings(workspace)
    if emails_sent_today(db, workspace.id) >= settings["email_limit_per_day"]:
        return SendResult(False, error="daily_limit_reached")

    # If user_id not given, find via the lead's owner or workspace's first member.
    if not user_id:
        from app.models import Lead, Membership

        if message.lead_id:
            lead = db.get(Lead, message.lead_id)
            user_id = lead.owner_id if lead else None
        if not user_id:
            m = db.query(Membership).filter(Membership.workspace_id == workspace.id).first()
            user_id = m.user_id if m else ""
    account = _pick_account(db, workspace.id, user_id or "")
    if not account:
        message.status = "failed"
        message.error = "no_email_account_connected"
        return SendResult(False, error=message.error)

    py = PyEmail()
    py["From"] = account.external_id or "no-reply@example.com"
    py["To"] = message.to_address
    py["Subject"] = message.subject or "(no subject)"
    py.set_content(message.body_text or "")
    if message.body_html:
        py.add_alternative(message.body_html, subtype="html")

    if account.provider == "gmail":
        result = _gmail_send(account, py)
    else:
        result = asyncio.run(_smtp_send(account, py))

    message.from_address = account.external_id or ""
    if result.ok:
        message.status = "sent"
        message.sent_at = datetime.now(timezone.utc)
        message.provider_message_id = result.provider_message_id
        message.error = None
    else:
        message.status = "failed"
        message.error = result.error
    return result


