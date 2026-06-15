"""Company Finder API — Google-Maps-scraped businesses, organised into a
country → area → zone → street → building hierarchy.

Two ingest paths feed the same store:
  * POST /company-finder/ingest   — live, from the browser extension (X-API-Key)
  * POST /company-finder/import   — CSV/JSON upload from the web app (JWT)

Read/query/export are JWT (web app) only.
"""
import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_extension_context, get_workspace_context
from app.models import CompanyFinderBusiness
from app.services import company_finder as svc

router = APIRouter(prefix="/company-finder", tags=["company-finder"])


def _serialize(b: CompanyFinderBusiness) -> dict:
    return {
        "id": b.id, "name": b.name, "phone": b.phone or "", "email": b.email or "",
        "website": b.website or "", "address": b.address or "", "category": b.category or "",
        "latitude": b.latitude, "longitude": b.longitude,
        "country": b.country or "", "area": b.area or "", "zone": b.zone or "",
        "street": b.street or "", "building": b.building or "", "building_key": b.building_key or "",
        "socials": b.socials or {}, "hours": b.hours or {},
        "rating": b.rating or "", "rating_count": b.rating_count or "",
        "profile_url": b.profile_url or "", "source": b.source,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


# ── Ingest (extension, X-API-Key) ───────────────────────────────────────────
@router.post("/ingest")
def ingest_extension(
    body: dict,
    ctx: AuthContext = Depends(get_extension_context),
    db: Session = Depends(get_db),
):
    items = body.get("businesses") or body.get("leads") or []
    return svc.ingest(db, ctx.workspace_id, items, source="extension")


# ── Import (web app, JWT) ───────────────────────────────────────────────────
@router.post("/import")
def import_web(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    items = body.get("businesses") or body.get("rows") or []
    return svc.ingest(db, ctx.workspace_id, items, source="import")


def _filtered(db: Session, ws: str, q, category, country, area, zone, building_key, has_email):
    query = db.query(CompanyFinderBusiness).filter(CompanyFinderBusiness.workspace_id == ws)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(
            CompanyFinderBusiness.name.ilike(like),
            CompanyFinderBusiness.address.ilike(like),
            CompanyFinderBusiness.category.ilike(like),
            CompanyFinderBusiness.email.ilike(like),
        ))
    if category:
        query = query.filter(CompanyFinderBusiness.category.ilike(f"%{category}%"))
    if country:
        query = query.filter(CompanyFinderBusiness.country == country)
    if area:
        query = query.filter(CompanyFinderBusiness.area == area)
    if zone:
        query = query.filter(CompanyFinderBusiness.zone == zone)
    if building_key:
        query = query.filter(CompanyFinderBusiness.building_key == building_key)
    if has_email:
        query = query.filter(CompanyFinderBusiness.email.isnot(None), CompanyFinderBusiness.email != "")
    return query


@router.get("/businesses")
def list_businesses(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    q: Optional[str] = None,
    category: Optional[str] = None,
    country: Optional[str] = None,
    area: Optional[str] = None,
    zone: Optional[str] = None,
    building_key: Optional[str] = None,
    has_email: bool = False,
    limit: int = Query(default=200, le=1000),
    offset: int = 0,
):
    ws = ctx.workspace_id
    query = _filtered(db, ws, q, category, country, area, zone, building_key, has_email)
    total = query.count()
    rows = (
        query.order_by(CompanyFinderBusiness.building_key, CompanyFinderBusiness.name)
        .offset(offset).limit(limit).all()
    )
    return {"items": [_serialize(b) for b in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/facets")
def facets(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Distinct values + counts for the filter chips and the hierarchy tree."""
    ws = ctx.workspace_id
    base = db.query(CompanyFinderBusiness).filter(CompanyFinderBusiness.workspace_id == ws)

    def top(col, limit=200):
        rows = (
            db.query(col, func.count())
            .filter(CompanyFinderBusiness.workspace_id == ws, col.isnot(None), col != "")
            .group_by(col).order_by(func.count().desc()).limit(limit).all()
        )
        return [{"value": v, "count": c} for v, c in rows]

    total = base.count()
    with_email = base.filter(CompanyFinderBusiness.email.isnot(None), CompanyFinderBusiness.email != "").count()
    buildings = (
        db.query(func.count(func.distinct(CompanyFinderBusiness.building_key)))
        .filter(CompanyFinderBusiness.workspace_id == ws).scalar() or 0
    )
    return {
        "total": total, "with_email": with_email, "buildings": buildings,
        "categories": top(CompanyFinderBusiness.category),
        "countries": top(CompanyFinderBusiness.country),
        "areas": top(CompanyFinderBusiness.area),
        "zones": top(CompanyFinderBusiness.zone),
    }


@router.get("/hierarchy")
def hierarchy(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """country → area → zone → building tree with per-node business counts and
    the building lat/lng key (so the UI can show 'N businesses in this building')."""
    ws = ctx.workspace_id
    rows = (
        db.query(
            CompanyFinderBusiness.country, CompanyFinderBusiness.area, CompanyFinderBusiness.zone,
            CompanyFinderBusiness.street, CompanyFinderBusiness.building, CompanyFinderBusiness.building_key,
            func.count(),
        )
        .filter(CompanyFinderBusiness.workspace_id == ws)
        .group_by(
            CompanyFinderBusiness.country, CompanyFinderBusiness.area, CompanyFinderBusiness.zone,
            CompanyFinderBusiness.street, CompanyFinderBusiness.building, CompanyFinderBusiness.building_key,
        )
        .all()
    )
    tree: dict = {}
    for country, area, zone, street, building, bkey, n in rows:
        c = tree.setdefault(country or "—", {"name": country or "—", "count": 0, "areas": {}})
        a = c["areas"].setdefault(area or "—", {"name": area or "—", "count": 0, "zones": {}})
        z = a["zones"].setdefault(zone or "—", {"name": zone or "—", "count": 0, "buildings": {}})
        bk = bkey or (building or "—")
        bnode = z["buildings"].setdefault(bk, {"name": building or street or "—", "key": bkey or "", "count": 0})
        bnode["count"] += n
        z["count"] += n
        a["count"] += n
        c["count"] += n

    def listify(d, child):
        out = []
        for v in d.values():
            if child:
                v[child] = listify(v[child], {"areas": "zones", "zones": "buildings", "buildings": None}[child])
            out.append(v)
        out.sort(key=lambda x: -x["count"])
        return out

    return {"countries": listify(tree, "areas")}


@router.get("/export.csv")
def export_csv(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    q: Optional[str] = None,
    category: Optional[str] = None,
    country: Optional[str] = None,
    area: Optional[str] = None,
    zone: Optional[str] = None,
    building_key: Optional[str] = None,
    has_email: bool = False,
):
    rows = _filtered(db, ctx.workspace_id, q, category, country, area, zone, building_key, has_email)\
        .order_by(CompanyFinderBusiness.country, CompanyFinderBusiness.area, CompanyFinderBusiness.zone,
                  CompanyFinderBusiness.building_key, CompanyFinderBusiness.name).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Name", "Category", "Phone", "Email", "Website", "Address",
                "Country", "Area", "Zone", "Street", "Building",
                "Latitude", "Longitude", "Rating", "Reviews", "Maps URL",
                "Instagram", "Facebook", "LinkedIn"])
    for b in rows:
        s = b.socials or {}
        w.writerow([
            b.name, b.category or "", b.phone or "", b.email or "", b.website or "", b.address or "",
            b.country or "", b.area or "", b.zone or "", b.street or "", b.building or "",
            b.latitude or "", b.longitude or "", b.rating or "", b.rating_count or "", b.profile_url or "",
            ",".join(s.get("instagram", [])), ",".join(s.get("facebook", [])), ",".join(s.get("linkedin", [])),
        ])
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=company-finder.csv"},
    )


@router.delete("/businesses")
def clear(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    building_key: Optional[str] = None,
):
    query = db.query(CompanyFinderBusiness).filter(CompanyFinderBusiness.workspace_id == ctx.workspace_id)
    if building_key:
        query = query.filter(CompanyFinderBusiness.building_key == building_key)
    n = query.delete(synchronize_session=False)
    db.commit()
    return {"deleted": n}


@router.post("/add-leads")
def add_to_pipeline(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Explicitly promote selected Company Finder businesses into the CRM
    (pipeline/prospecting). Until this is called, scraped businesses live ONLY
    in Company Finder and never appear as Leads."""
    from app.models import Activity, Lead
    from app.services.leads import default_stage, upsert_company

    ids = body.get("ids") or []
    rows = (
        db.query(CompanyFinderBusiness)
        .filter(CompanyFinderBusiness.workspace_id == ctx.workspace_id, CompanyFinderBusiness.id.in_(ids))
        .all()
    )
    stage = default_stage(db, ctx.workspace_id)
    stage_id = stage.id if stage else None
    created = 0
    for b in rows:
        company = upsert_company(db, ctx.workspace_id, name=b.name, website=b.website or None)
        lead = Lead(
            workspace_id=ctx.workspace_id,
            owner_id=ctx.user_id,
            stage_id=stage_id,
            company_id=company.id if company else None,
            full_name=b.name,
            email=b.email or None,
            phone=b.phone or None,
            location=", ".join(filter(None, [b.area, b.country])) or b.address,
            source="company_finder",
            custom={
                "website": b.website or "",
                "category": b.category or "",
                "address": b.address or "",
                "maps_url": b.profile_url or "",
                "building": b.building or "",
                **({"socials": b.socials} if b.socials else {}),
            },
        )
        db.add(lead)
        db.flush()
        db.add(Activity(
            workspace_id=ctx.workspace_id, lead_id=lead.id, actor_id=ctx.user_id,
            type="lead_created_company_finder", payload={"company_finder_id": b.id},
        ))
        created += 1
    db.commit()
    return {"created": created}
