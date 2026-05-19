from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Activity, Company, Lead, PipelineStage


def _domain_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    s = url.strip()
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    s = s.split("/")[0].lower()
    if s.startswith("www."):
        s = s[4:]
    return s or None


def upsert_company(
    db: Session,
    workspace_id: str,
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
    website: Optional[str] = None,
    linkedin_url: Optional[str] = None,
    extra: Optional[dict] = None,
) -> Optional[Company]:
    if not (name or domain or website or linkedin_url):
        return None
    domain = domain or _domain_from_url(website)
    q = db.query(Company).filter(Company.workspace_id == workspace_id)
    company: Optional[Company] = None
    if linkedin_url:
        company = q.filter(Company.linkedin_url == linkedin_url).first()
    if not company and domain:
        company = q.filter(Company.domain == domain).first()
    if not company and name:
        company = q.filter(Company.name == name).first()
    if not company:
        company = Company(
            workspace_id=workspace_id,
            name=name or domain or "Unknown",
            domain=domain,
            website=website,
            linkedin_url=linkedin_url,
            data=extra or {},
        )
        db.add(company)
        db.flush()
    else:
        if not company.domain and domain:
            company.domain = domain
        if not company.website and website:
            company.website = website
        if not company.linkedin_url and linkedin_url:
            company.linkedin_url = linkedin_url
        if extra:
            merged = dict(company.data or {})
            merged.update(extra)
            company.data = merged
    return company


def default_stage(db: Session, workspace_id: str) -> Optional[PipelineStage]:
    return (
        db.query(PipelineStage)
        .filter(PipelineStage.workspace_id == workspace_id)
        .order_by(PipelineStage.position.asc())
        .first()
    )


def normalize_linkedin(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    s = url.split("?")[0].rstrip("/").lower()
    return s


def ingest_lead(
    db: Session,
    workspace_id: str,
    owner_id: Optional[str],
    payload: dict,
    source: str = "extension",
) -> tuple[Lead, bool]:
    """Upsert a lead from a scraped LinkedIn profile blob.

    Returns (lead, created_bool).
    """
    linkedin = normalize_linkedin(payload.get("linkedin_url"))
    existing: Optional[Lead] = None
    if linkedin:
        existing = (
            db.query(Lead)
            .filter(Lead.workspace_id == workspace_id, Lead.linkedin_url == linkedin)
            .first()
        )

    company = upsert_company(
        db,
        workspace_id,
        name=payload.get("company_name"),
        domain=payload.get("company_domain"),
        website=payload.get("company_url"),
    )

    full_name = payload.get("full_name") or " ".join(
        filter(None, [payload.get("first_name"), payload.get("last_name")])
    ) or None

    now = datetime.now(timezone.utc)
    created = False
    if existing:
        lead = existing
        # Merge non-empty fields
        for attr in (
            "first_name",
            "last_name",
            "title",
            "headline",
            "location",
            "avatar_url",
            "phone",
        ):
            val = payload.get(attr)
            if val and not getattr(lead, attr):
                setattr(lead, attr, val)
        if full_name and not lead.full_name:
            lead.full_name = full_name
        if payload.get("email") and not lead.email:
            lead.email = payload["email"]
        if company and not lead.company_id:
            lead.company_id = company.id
        merged_custom = dict(lead.custom or {})
        merged_custom.update({k: v for k, v in (payload.get("raw") or {}).items() if v is not None})
        lead.custom = merged_custom
    else:
        stage = default_stage(db, workspace_id)
        lead = Lead(
            workspace_id=workspace_id,
            owner_id=owner_id,
            stage_id=stage.id if stage else None,
            company_id=company.id if company else None,
            first_name=payload.get("first_name"),
            last_name=payload.get("last_name"),
            full_name=full_name,
            title=payload.get("title") or payload.get("headline"),
            headline=payload.get("headline"),
            email=payload.get("email"),
            phone=payload.get("phone"),
            linkedin_url=linkedin,
            location=payload.get("location"),
            avatar_url=payload.get("avatar_url"),
            source=source,
            custom=payload.get("raw") or {},
        )
        db.add(lead)
        created = True
    db.flush()
    db.add(
        Activity(
            workspace_id=workspace_id,
            lead_id=lead.id,
            actor_id=owner_id,
            type="lead_captured" if created else "lead_updated",
            payload={"source": source, "linkedin_url": linkedin},
        )
    )
    lead.last_activity_at = now
    return lead, created
