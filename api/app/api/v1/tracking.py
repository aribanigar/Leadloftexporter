"""Public open/click tracking endpoints for email campaigns.

These are deliberately UNAUTHENTICATED — they're hit by the recipient's
mail client (open pixel) and browser (click redirect), which carry no
workspace JWT. They identify the campaign + recipient purely by the opaque
ids embedded in the tracking URL, so there's nothing sensitive to leak: a
forged hit can at most nudge a counter.

URLs are built by `campaigns._inject_tracking`:
    GET /track/open/{campaign_id}/{recipient_id}
    GET /track/click/{campaign_id}/{tracking_id}?rid={recipient_id}
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models import Campaign, CampaignRecipient

router = APIRouter(prefix="/track", tags=["tracking"])

# 1×1 transparent GIF.
_PIXEL = bytes.fromhex(
    "47494638396101000100800000000000ffffff21f90401000000002c00000000"
    "010001000002024401003b"
)


@router.get("/open/{campaign_id}/{recipient_id}")
def track_open(campaign_id: str, recipient_id: str, db: Session = Depends(get_db)):
    try:
        r = db.get(CampaignRecipient, recipient_id)
        if r is not None and r.campaign_id == campaign_id:
            r.open_count = (r.open_count or 0) + 1
            if r.opened_at is None:
                r.opened_at = datetime.now(timezone.utc)
                # Only promote pending/sent → opened (never downgrade clicked).
                if r.status in ("sent", "pending", "sending"):
                    r.status = "opened"
                c = db.get(Campaign, campaign_id)
                if c is not None:
                    c.opened_count = (c.opened_count or 0) + 1
            db.commit()
    except Exception:  # noqa: BLE001 — tracking must never error to the client
        db.rollback()
    return Response(
        content=_PIXEL,
        media_type="image/gif",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, private"},
    )


@router.get("/click/{campaign_id}/{tracking_id}")
def track_click(
    campaign_id: str,
    tracking_id: str,
    rid: str = "",
    db: Session = Depends(get_db),
):
    target = "https://leadloftexporter.onrender.com"
    try:
        c = db.get(Campaign, campaign_id)
        if c is not None:
            links = list(c.links or [])
            for entry in links:
                if isinstance(entry, dict) and entry.get("tracking_id") == tracking_id:
                    target = entry.get("original_url") or target
                    entry["clicks"] = int(entry.get("clicks") or 0) + 1
                    break
            c.links = links
            if rid:
                r = db.get(CampaignRecipient, rid)
                if r is not None and r.campaign_id == campaign_id:
                    r.click_count = (r.click_count or 0) + 1
                    if r.clicked_at is None:
                        r.clicked_at = datetime.now(timezone.utc)
                        c.clicked_count = (c.clicked_count or 0) + 1
                    if r.status != "clicked":
                        # A click implies an open too.
                        if r.status in ("sent", "pending", "sending"):
                            c.opened_count = (c.opened_count or 0) + 1
                        r.status = "clicked"
                        if r.opened_at is None:
                            r.opened_at = datetime.now(timezone.utc)
                    clicked = list(r.clicked_links or [])
                    if target not in clicked:
                        clicked.append(target)
                        r.clicked_links = clicked
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return RedirectResponse(url=target, status_code=302)
