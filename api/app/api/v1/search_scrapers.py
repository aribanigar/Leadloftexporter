"""LinkedIn search-URL background scrapers — LeadLoft-style "save N/day
from this search URL" feature.

The user pastes a LinkedIn search URL (e.g.
https://www.linkedin.com/search/results/people/?keywords=marketing%20director%20qatar),
sets a per-day save cap and a total cap, optionally selects a playbook
to auto-enroll new leads into.

A daily Celery beat task (`tick_search_scrapers`) walks active scrapers,
rolls saved_today back to 0 on a new day, and queues an
`ExtensionJob(kind="scrape_search")` if the daily cap hasn't been hit.
The extension picks the job up when the user has LinkedIn open in a
foreground tab — `automate.js` navigates to the search URL, runs
`scrapeSearchResults`, posts the leads back, and the SearchScraper's
counters are bumped.

When `playbook_id` is set, every newly-saved lead is auto-enrolled in
that playbook via the existing `enroll_lead` service (which also
queues an enrichment ExtensionJob when the lead lacks email/phone).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import SearchScraper

router = APIRouter(prefix="/search-scrapers", tags=["search-scrapers"])


def _serialize(s: SearchScraper) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "search_url": s.search_url,
        "daily_save_cap": s.daily_save_cap,
        "total_save_cap": s.total_save_cap,
        "saved_today": s.saved_today,
        "saved_total": s.saved_total,
        "last_run_at": s.last_run_at,
        "last_run_day": s.last_run_day,
        "playbook_id": s.playbook_id,
        "segment_id": s.segment_id,
        "status": s.status,
        "created_at": s.created_at,
    }


@router.get("")
def list_scrapers(
    ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)
):
    rows = (
        db.query(SearchScraper)
        .filter(SearchScraper.workspace_id == ctx.workspace_id)
        .order_by(SearchScraper.created_at.desc())
        .all()
    )
    return [_serialize(r) for r in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_scraper(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    url = (body.get("search_url") or "").strip()
    if not url:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "search_url_required")
    if "linkedin.com/" not in url:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "search_url_must_be_a_linkedin_url"
        )

    daily = int(body.get("daily_save_cap") or 30)
    total = int(body.get("total_save_cap") or 1000)
    # Hard ceiling — daily cap can't exceed 100 (above this LinkedIn's
    # behavior heuristics start flagging the account).
    daily = max(1, min(daily, 100))
    total = max(1, min(total, 10000))

    s = SearchScraper(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        name=(body.get("name") or "").strip() or None,
        search_url=url,
        daily_save_cap=daily,
        total_save_cap=total,
        playbook_id=body.get("playbook_id") or None,
        segment_id=body.get("segment_id") or None,
        status="active",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _serialize(s)


@router.patch("/{scraper_id}")
def update_scraper(
    scraper_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    s = _get_or_404(db, scraper_id, ctx.workspace_id)
    for field in (
        "name", "daily_save_cap", "total_save_cap",
        "playbook_id", "segment_id", "status",
    ):
        if field in body:
            setattr(s, field, body[field])
    db.commit()
    db.refresh(s)
    return _serialize(s)


@router.delete("/{scraper_id}")
def delete_scraper(
    scraper_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    s = _get_or_404(db, scraper_id, ctx.workspace_id)
    db.delete(s)
    db.commit()
    return {"ok": True}


def _get_or_404(db: Session, scraper_id: str, workspace_id: str) -> SearchScraper:
    s = (
        db.query(SearchScraper)
        .filter(SearchScraper.id == scraper_id, SearchScraper.workspace_id == workspace_id)
        .first()
    )
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return s


def reset_daily_counters_if_new_day(s: SearchScraper) -> None:
    """Roll saved_today back to 0 when we've crossed into a new UTC day."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if s.last_run_day != today:
        s.saved_today = 0
        s.last_run_day = today
