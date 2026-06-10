"""LinkedIn side-panel bridge.

The CRM web app cannot iframe LinkedIn (X-Frame-Options blocks it) and the
backend cannot call LinkedIn's private APIs without putting the user's
account at risk. The bridge solves this by treating the user's own browser
extension as a private LinkedIn proxy:

1. Frontend asks for a fresh snapshot of a lead's LinkedIn profile.
2. Backend creates an ExtensionJob (kind="bridge_profile") with the lead's
   linkedin_url. The job is workspace-scoped and short-lived.
3. The extension's background poll picks it up and runs the existing
   ``scrapeProfileWithContact`` flow in a background LinkedIn tab — the same
   path used by the per-card Save chip. Result is POSTed back via the
   existing ``POST /extension/jobs/{id}/result`` endpoint.
4. Frontend polls ``GET /linkedin-bridge/snapshot/{job_id}`` every 2 s.
   When the job's status flips to ``done`` we serve the parsed payload.

Because the same flow already powers Save All Leads, no new content-script
code is strictly required — adding the "bridge_profile" kind to the
extension's job dispatcher (see ``automate.js``) is what wires the path
end-to-end. The endpoints below are intentionally tolerant of unknown kinds
so the frontend ships before the extension catches up.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import (
    Activity,
    ConnectedAccount,
    ExtensionJob,
    Lead,
    Membership,
)

router = APIRouter(prefix="/linkedin-bridge", tags=["linkedin-bridge"])


def _linkedin_connected(db: Session, ctx: AuthContext) -> bool:
    return (
        db.query(ConnectedAccount.id)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider == "linkedin",
            ConnectedAccount.status == "active",
        )
        .first()
        is not None
    )


@router.get("/status")
def bridge_status(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Is the bridge available right now? Available means: the Chrome
    extension has authenticated against this workspace in the last 10
    minutes — proxied via the ConnectedAccount(provider=linkedin) row that
    ``/extension/me`` upserts on every call."""
    acct = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.provider == "linkedin",
        )
        .first()
    )
    if not acct:
        return {"available": False, "reason": "extension_not_paired"}
    fresh = acct.updated_at and acct.updated_at >= datetime.now(timezone.utc) - timedelta(
        minutes=10
    )
    return {
        "available": bool(fresh) and acct.status == "active",
        "last_seen": acct.updated_at,
        "reason": None if fresh else "extension_offline",
    }


class SnapshotRequest(BaseModel):
    lead_id: str
    surface: str = "profile"  # profile | inbox | search


@router.post("/snapshot")
def request_snapshot(
    body: SnapshotRequest,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Enqueue a bridge job for the lead. Returns the job id so the
    frontend can poll the snapshot endpoint."""
    lead = (
        db.query(Lead)
        .filter(Lead.id == body.lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")
    if not (lead.linkedin_url or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "lead_has_no_linkedin_url")
    if not _linkedin_connected(db, ctx):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "extension_not_paired: install the LeadCaptura extension and sign in via Settings → API Keys",
        )

    # Recent identical job — return its id to keep polling instead of double-queueing.
    recent_cutoff = datetime.now(timezone.utc) - timedelta(seconds=90)
    existing = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.lead_id == lead.id,
            ExtensionJob.kind == "bridge_profile",
            ExtensionJob.created_at >= recent_cutoff,
            ExtensionJob.status.in_(("queued", "claimed", "done")),
        )
        .order_by(ExtensionJob.created_at.desc())
        .first()
    )
    if existing:
        return {"id": existing.id, "status": existing.status}

    owner_id = lead.owner_id
    if not owner_id:
        m = (
            db.query(Membership)
            .filter(Membership.workspace_id == ctx.workspace_id)
            .first()
        )
        owner_id = m.user_id if m else ctx.user_id

    job = ExtensionJob(
        workspace_id=ctx.workspace_id,
        user_id=owner_id,
        lead_id=lead.id,
        kind="bridge_profile",
        payload={
            "linkedin_url": lead.linkedin_url,
            "surface": body.surface,
            "reason": "linkedin_bridge_snapshot",
        },
        status="queued",
    )
    db.add(job)
    db.commit()
    return {"id": job.id, "status": "queued"}


@router.get("/snapshot/{job_id}")
def read_snapshot(
    job_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Poll the result of a bridge job. Status ``done`` means the payload is
    ready; ``queued``/``claimed`` mean keep polling; anything else is a
    terminal failure the UI should surface."""
    job = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.id == job_id,
            ExtensionJob.workspace_id == ctx.workspace_id,
        )
        .first()
    )
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job_not_found")
    result = job.result or {}
    return {
        "id": job.id,
        "status": job.status,
        "claimed_at": job.claimed_at,
        "completed_at": job.completed_at,
        "linkedin_url": (job.payload or {}).get("linkedin_url"),
        # Snapshot is whatever the extension posted: profile sections, contact info, etc.
        "snapshot": result.get("snapshot") or result.get("profile") or result,
        "error": job.error,
    }


class SendMessageIn(BaseModel):
    lead_id: str
    body: str


@router.post("/send-message")
def send_message(
    body: SendMessageIn,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Queue a LinkedIn message via the extension — same path the Messaging
    page's bulk send uses, but from the Lead Detail / side-panel surface so
    the user can fire off a single message in the flow of replying to a
    timeline event."""
    lead = (
        db.query(Lead)
        .filter(Lead.id == body.lead_id, Lead.workspace_id == ctx.workspace_id)
        .first()
    )
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")
    if not (lead.linkedin_url or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "lead_has_no_linkedin_url")
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "message_required")
    job = ExtensionJob(
        workspace_id=ctx.workspace_id,
        user_id=lead.owner_id or ctx.user_id,
        lead_id=lead.id,
        kind="message",
        payload={"linkedin_url": lead.linkedin_url, "body": text, "lead_name": lead.full_name},
        status="queued",
    )
    db.add(job)
    db.add(
        Activity(
            workspace_id=ctx.workspace_id,
            lead_id=lead.id,
            actor_id=ctx.user_id,
            type="linkedin_message_queued",
            payload={"job_id": job.id, "preview": text[:200]},
        )
    )
    db.commit()
    return {"id": job.id, "status": "queued"}
