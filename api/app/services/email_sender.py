"""Send queued EmailMessage rows via Gmail OAuth, SMTP, or HTTPS API
providers (Resend / SendGrid). HTTPS providers are the only path that
works on Render's free/starter plan because Render blocks outbound
SMTP (25/465/587). All HTTPS providers use port 443 → never blocked.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
from email.message import EmailMessage as PyEmail
from typing import Optional

import aiosmtplib
import httpx
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
            ConnectedAccount.provider.in_(("gmail", "smtp", "resend", "sendgrid")),
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
    password = account.access_token
    try:
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=port,
            start_tls=(port != 465),
            use_tls=(port == 465),
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


def _resend_send(account: ConnectedAccount, to: str, subject: str, body_text: str, body_html: Optional[str]) -> SendResult:
    """POST to Resend's /emails endpoint. Pure HTTPS — never blocked.
    https://resend.com/docs/api-reference/emails/send-email
    """
    try:
        api_key = account.access_token or ""
        from_addr = account.external_id or "onboarding@resend.dev"
        payload = {"from": from_addr, "to": [to], "subject": subject}
        if body_html:
            payload["html"] = body_html
        if body_text:
            payload["text"] = body_text
        with httpx.Client(timeout=20) as client:
            r = client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if r.status_code >= 400:
                return SendResult(False, error=f"resend_http_{r.status_code}: {r.text[:300]}")
            data = r.json() or {}
            return SendResult(True, provider_message_id=str(data.get("id") or ""))
    except Exception as exc:  # noqa: BLE001
        return SendResult(False, error=f"resend_request_failed: {exc}")


def _sendgrid_send(account: ConnectedAccount, to: str, subject: str, body_text: str, body_html: Optional[str]) -> SendResult:
    """POST to SendGrid's /v3/mail/send. Pure HTTPS — never blocked.
    https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
    """
    try:
        api_key = account.access_token or ""
        from_addr = account.external_id or ""
        if not from_addr:
            return SendResult(False, error="sendgrid_no_from_address")
        content = []
        if body_text:
            content.append({"type": "text/plain", "value": body_text})
        if body_html:
            content.append({"type": "text/html", "value": body_html})
        if not content:
            content = [{"type": "text/plain", "value": "(empty)"}]
        payload = {
            "personalizations": [{"to": [{"email": to}]}],
            "from": {"email": from_addr},
            "subject": subject,
            "content": content,
        }
        with httpx.Client(timeout=20) as client:
            r = client.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if r.status_code >= 400:
                return SendResult(False, error=f"sendgrid_http_{r.status_code}: {r.text[:300]}")
            # SendGrid returns 202 with X-Message-Id header
            msg_id = r.headers.get("X-Message-Id") or ""
            return SendResult(True, provider_message_id=msg_id)
    except Exception as exc:  # noqa: BLE001
        return SendResult(False, error=f"sendgrid_request_failed: {exc}")


def send_email_message(
    db: Session, message: EmailMessage, workspace: Workspace, user_id: Optional[str] = None
) -> SendResult:
    if message.status not in {"queued", "failed"}:
        return SendResult(False, error="not_sendable")
    settings = outreach_settings(workspace)
    if emails_sent_today(db, workspace.id) >= settings["email_limit_per_day"]:
        return SendResult(False, error="daily_limit_reached")

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

    # HTTPS API providers — work on Render free tier
    if account.provider == "resend":
        result = _resend_send(
            account, message.to_address,
            message.subject or "(no subject)",
            message.body_text or "",
            message.body_html,
        )
    elif account.provider == "sendgrid":
        result = _sendgrid_send(
            account, message.to_address,
            message.subject or "(no subject)",
            message.body_text or "",
            message.body_html,
        )
    elif account.provider == "gmail":
        # Build py-email and send via Gmail HTTPS API
        py = PyEmail()
        py["From"] = account.external_id or "no-reply@example.com"
        py["To"] = message.to_address
        py["Subject"] = message.subject or "(no subject)"
        py.set_content(message.body_text or "")
        if message.body_html:
            py.add_alternative(message.body_html, subtype="html")
        result = _gmail_send(account, py)
    else:
        # SMTP fallback — won't work on Render free, surfaces clear error
        py = PyEmail()
        py["From"] = account.external_id or "no-reply@example.com"
        py["To"] = message.to_address
        py["Subject"] = message.subject or "(no subject)"
        py.set_content(message.body_text or "")
        if message.body_html:
            py.add_alternative(message.body_html, subtype="html")
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


