"""WhatsApp Business Cloud API integration.

Self-contained — does NOT touch the existing integrations router. Credentials
(access token + phone-number id) live in a ConnectedAccount row with
provider="whatsapp". Outbound text messages go through the Meta Graph API.

Note on Meta's rules: business-initiated text messages only deliver inside the
24-hour customer-service window; outside it, Meta requires a pre-approved
message template. We send `type:text` and surface Meta's error verbatim when a
template is required, so the user always knows why a send didn't go through.
"""

import re
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import ConnectedAccount, Lead

router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])

GRAPH = "https://graph.facebook.com/v21.0"
MAX_PER_SEND = 100


def _account(db: Session, ctx: AuthContext) -> Optional[ConnectedAccount]:
    return (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider == "whatsapp",
        )
        .first()
    )


def _render(template: str, lead: Lead) -> str:
    first = (lead.first_name or "").strip()
    if not first and lead.full_name:
        first = lead.full_name.strip().split(" ")[0]
    company = ""
    if lead.company_id and getattr(lead, "company", None):
        company = (lead.company.name or "").strip()
    tokens = {
        "{first_name}": first or "there",
        "{last_name}": (lead.last_name or "").strip(),
        "{full_name}": (lead.full_name or first or "there").strip(),
        "{title}": (lead.title or "").strip(),
        "{company}": company,
    }
    out = template
    for token, value in tokens.items():
        out = out.replace(token, value)
    return out


@router.get("/config")
def get_config(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    acct = _account(db, ctx)
    if not acct or acct.status != "active":
        return {"connected": False}
    return {
        "connected": True,
        "phone_number_id": acct.external_id,
        "display": (acct.config or {}).get("display") or acct.label,
    }


class WaConfigIn(BaseModel):
    access_token: str = Field(min_length=10)
    phone_number_id: str = Field(min_length=3)


@router.post("/config")
def save_config(
    body: WaConfigIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    token = body.access_token.strip()
    pnid = body.phone_number_id.strip()
    if not token or not pnid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "token_and_phone_number_id_required")

    # Verify the credentials by reading the phone number's metadata.
    display = None
    try:
        with httpx.Client(timeout=15) as client:
            r = client.get(
                f"{GRAPH}/{pnid}",
                params={"fields": "display_phone_number,verified_name"},
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code >= 400:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Could not verify WhatsApp credentials: {r.text[:200]}",
            )
        data = r.json()
        display = data.get("display_phone_number") or data.get("verified_name")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"WhatsApp verify error: {e}")

    acct = _account(db, ctx)
    if acct:
        acct.user_id = ctx.user_id
        acct.access_token = token
        acct.external_id = pnid
        acct.config = {**(acct.config or {}), "display": display}
        acct.status = "active"
    else:
        acct = ConnectedAccount(
            workspace_id=ctx.workspace_id,
            user_id=ctx.user_id,
            provider="whatsapp",
            label="WhatsApp Business",
            external_id=pnid,
            access_token=token,
            config={"display": display},
            status="active",
        )
        db.add(acct)
    db.commit()
    return {"connected": True, "phone_number_id": pnid, "display": display}


@router.delete("/config")
def delete_config(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    acct = _account(db, ctx)
    if acct:
        db.delete(acct)
        db.commit()
    return {"connected": False}


class WaSendIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    lead_ids: Optional[list[str]] = None
    stage_id: Optional[str] = None


@router.post("/send")
def send(
    body: WaSendIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Send a WhatsApp text to every (or selected) pipeline lead with a phone,
    personalizing {first_name}/{company}/etc. per recipient. Sent synchronously
    server-side via Meta Graph; capped at MAX_PER_SEND per call."""
    acct = _account(db, ctx)
    if not acct or acct.status != "active":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "whatsapp_not_connected")
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "message_required")

    q = (
        db.query(Lead)
        .options(joinedload(Lead.company))  # type: ignore[attr-defined]
        .filter(Lead.workspace_id == ctx.workspace_id)
    )
    if body.lead_ids:
        q = q.filter(Lead.id.in_(body.lead_ids))
    if body.stage_id:
        q = q.filter(Lead.stage_id == body.stage_id)
    leads = q.all()

    sent = 0
    failed = 0
    skipped_no_phone = 0
    errors: list[str] = []

    with httpx.Client(timeout=20) as client:
        for lead in leads:
            if sent + failed >= MAX_PER_SEND:
                break
            num = re.sub(r"\D", "", lead.phone or "")
            if not num:
                skipped_no_phone += 1
                continue
            try:
                r = client.post(
                    f"{GRAPH}/{acct.external_id}/messages",
                    headers={"Authorization": f"Bearer {acct.access_token}"},
                    json={
                        "messaging_product": "whatsapp",
                        "recipient_type": "individual",
                        "to": num,
                        "type": "text",
                        "text": {"preview_url": False, "body": _render(msg, lead)},
                    },
                )
                if r.status_code < 300:
                    sent += 1
                else:
                    failed += 1
                    if len(errors) < 3:
                        err_text = r.text[:200]
                        try:
                            meta = r.json()
                            meta_err = meta.get("error", meta)
                            code = meta_err.get("code")
                            msg = meta_err.get("message", "")
                            if code == 133010:
                                err_text = f"Phone not registered on WhatsApp (#{code})"
                            elif code == 131030:
                                err_text = f"Message blocked by recipient (#{code})"
                            elif code == 130429:
                                err_text = f"Rate limit reached — slow down (#{code})"
                            elif code == 131047:
                                err_text = f"Outside 24-hour window — use an approved template (#{code})"
                            elif code == 132001:
                                err_text = f"Template not found (#{code})"
                            elif msg:
                                err_text = msg[:120]
                        except Exception:
                            pass
                        errors.append(err_text)
            except Exception as e:
                failed += 1
                if len(errors) < 3:
                    errors.append(str(e)[:200])

    return {
        "sent": sent,
        "failed": failed,
        "skipped_no_phone": skipped_no_phone,
        "total": len(leads),
        "errors": errors,
    }
