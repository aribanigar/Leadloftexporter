"""API surface for the Chrome extension.

Auth uses X-API-Key. These endpoints are what the user's browser hits when they
hover/save a LinkedIn profile, scroll a search/Sales Nav page, or when the
extension polls for queued automated actions to execute in-page.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_extension_context
from app.models import ApiKey, ConnectedAccount, ExtensionJob, Lead, LinkedInMessage, Membership, Playbook, SavedView, User
from app.schemas import (
    ExtensionJobOut,
    ExtensionJobResult,
    ExtensionSyncProfile,
    ExtensionSyncSearch,
    LeadIngestResponse,
)
from app.schemas.lead import CompanyMini, LeadOut
from app.services.leads import ingest_lead
from app.services.outreach import enroll_lead

router = APIRouter(prefix="/extension", tags=["extension"])


def _bump_api_key(db: Session, ctx: AuthContext) -> None:
    db.query(ApiKey).filter(
        ApiKey.workspace_id == ctx.workspace_id, ApiKey.user_id == ctx.user_id
    ).update({ApiKey.last_used_at: datetime.now(timezone.utc)})


def _mark_linkedin_connected(db: Session, ctx: AuthContext) -> None:
    """Extension authenticating proves LinkedIn is active in the user's browser."""
    existing = (
        db.query(ConnectedAccount)
        .filter(
            ConnectedAccount.workspace_id == ctx.workspace_id,
            ConnectedAccount.user_id == ctx.user_id,
            ConnectedAccount.provider == "linkedin",
        )
        .first()
    )
    if existing:
        existing.status = "active"
    else:
        db.add(
            ConnectedAccount(
                workspace_id=ctx.workspace_id,
                user_id=ctx.user_id,
                provider="linkedin",
                label="Chrome Extension",
                status="active",
            )
        )


def _serialize_lead(lead) -> LeadOut:
    out = LeadOut.model_validate(lead)
    if lead.company_id and getattr(lead, "company", None):
        out.company = CompanyMini.model_validate(lead.company)
    return out


@router.get("/me")
def extension_me(ctx: AuthContext = Depends(get_extension_context), db: Session = Depends(get_db)):
    _bump_api_key(db, ctx)
    _mark_linkedin_connected(db, ctx)
    db.commit()
    return {
        "user": {"id": ctx.user_id, "email": ctx.user.email},
        "workspace": {"id": ctx.workspace.id, "name": ctx.workspace.name, "slug": ctx.workspace.slug},
        "settings": (ctx.workspace.settings or {}).get("outreach", {}),
    }


@router.post("/sync/profile", response_model=LeadIngestResponse)
def sync_profile(
    body: ExtensionSyncProfile,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    lead, created = ingest_lead(db, ctx.workspace_id, ctx.user_id, body.model_dump())
    db.commit()
    db.refresh(lead)
    return LeadIngestResponse(lead=_serialize_lead(lead), created=created)


@router.post("/sync/search")
def sync_search(
    body: ExtensionSyncSearch,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    created_count = 0
    updated_count = 0
    skipped_count = 0
    ids: list[str] = []
    errors: list[dict] = []
    for profile in body.profiles:
        # Per-profile savepoint: one bad row (FK error, encoding glitch,
        # whatever) must not abort the whole batch. Without this, the user
        # sees "Failed: Internal Server Error" on Save All Leads even when
        # 99% of profiles are perfectly valid.
        try:
            with db.begin_nested():
                lead, created = ingest_lead(
                    db, ctx.workspace_id, ctx.user_id, profile.model_dump()
                )
                ids.append(lead.id)
                if created:
                    created_count += 1
                else:
                    updated_count += 1
        except Exception as e:
            skipped_count += 1
            errors.append({"linkedin_url": profile.linkedin_url, "error": str(e)[:200]})
    db.commit()
    return {
        "imported": len(ids),
        "created": created_count,
        "updated": updated_count,
        "skipped": skipped_count,
        "lead_ids": ids,
        "errors": errors[:20],  # cap response size
    }


@router.get("/jobs/next", response_model=list[ExtensionJobOut])
def claim_jobs(
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
    limit: int = 1,
):
    """Hands the extension the next queued action (connect/message/visit) to execute
    in the user's own browser at a human pace."""
    _bump_api_key(db, ctx)
    now = datetime.now(timezone.utc)
    rows = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.user_id == ctx.user_id,
            ExtensionJob.status == "queued",
        )
        .filter((ExtensionJob.not_before.is_(None)) | (ExtensionJob.not_before <= now))
        .order_by(ExtensionJob.created_at.asc())
        .limit(max(1, min(limit, 5)))
        .all()
    )
    for r in rows:
        r.status = "claimed"
        r.claimed_at = now
    db.commit()
    return [ExtensionJobOut.model_validate(r) for r in rows]


@router.post("/jobs/{job_id}/result")
def submit_result(
    job_id: str,
    body: ExtensionJobResult,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    _bump_api_key(db, ctx)
    job = (
        db.query(ExtensionJob)
        .filter(
            ExtensionJob.id == job_id,
            ExtensionJob.workspace_id == ctx.workspace_id,
            ExtensionJob.user_id == ctx.user_id,
        )
        .first()
    )
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    job.status = body.status if body.status in {"done", "failed", "skipped"} else "done"
    job.completed_at = datetime.now(timezone.utc)
    job.result = body.result or {}
    job.error = body.error

    # Reflect into LinkedInMessage where applicable
    if job.kind in {"connect", "message"} and job.lead_id and body.status == "done":
        rec = LinkedInMessage(
            workspace_id=ctx.workspace_id,
            lead_id=job.lead_id,
            kind=job.kind,
            direction="outbound",
            body=(job.payload or {}).get("body"),
            status="sent",
            sent_at=datetime.now(timezone.utc),
        )
        db.add(rec)
    db.commit()
    return {"ok": True}


@router.get("/options")
def options(ctx: AuthContext = Depends(get_extension_context), db: Session = Depends(get_db)):
    """Populate the bottom-toolbar dropdowns: Segment / Playbook / User."""
    playbooks = (
        db.query(Playbook)
        .filter(Playbook.workspace_id == ctx.workspace_id, Playbook.is_active.is_(True))
        .order_by(Playbook.created_at.desc())
        .all()
    )
    segments = (
        db.query(SavedView)
        .filter(SavedView.workspace_id == ctx.workspace_id, SavedView.is_shared.is_(True))
        .order_by(SavedView.position.asc())
        .all()
    )
    members = (
        db.query(Membership, User)
        .join(User, User.id == Membership.user_id)
        .filter(Membership.workspace_id == ctx.workspace_id)
        .all()
    )
    return {
        "user": {"id": ctx.user_id, "email": ctx.user.email, "name": (ctx.user.first_name or ctx.user.email.split("@")[0])},
        "workspace": {"id": ctx.workspace.id, "name": ctx.workspace.name, "slug": ctx.workspace.slug},
        "playbooks": [{"id": p.id, "name": p.name, "steps_count": len(p.steps)} for p in playbooks],
        "segments": [{"id": s.id, "name": s.name, "icon": s.icon} for s in segments],
        "users": [
            {
                "id": u.id,
                "name": (u.first_name or u.email.split("@")[0]),
                "email": u.email,
                "role": m.role,
            }
            for (m, u) in members
        ],
    }


@router.post("/enroll")
def enroll_batch(
    body: dict,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    """Bulk-enroll a list of saved leads into a playbook. Called by the
    extension immediately after Save All Leads when the user has selected a
    Playbook in the bottom toolbar."""
    playbook_id = body.get("playbook_id")
    lead_ids: list[str] = body.get("lead_ids") or []
    if not playbook_id or not lead_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "playbook_id_and_lead_ids_required")
    pb = (
        db.query(Playbook)
        .filter(Playbook.id == playbook_id, Playbook.workspace_id == ctx.workspace_id)
        .first()
    )
    if not pb:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "playbook_not_found")
    enrolled = []
    for lid in lead_ids:
        lead = db.query(Lead).filter(Lead.id == lid, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            continue
        e = enroll_lead(db, pb, lead)
        enrolled.append(e.id)
    db.commit()
    return {"enrolled": enrolled, "count": len(enrolled)}


@router.get("/health")
def health():
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}
