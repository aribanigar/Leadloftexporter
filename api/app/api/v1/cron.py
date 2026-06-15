"""External-cron trigger — run the periodic tasks over HTTP.

A free HTTP cron service (e.g. cron-job.org) pings ``/api/v1/cron/run``; this
runs the same logic the Celery beat schedule would (deliver due reminders +
escalation nudges, generate daily agendas, drain queued emails, advance
outreach + campaigns) — so reminders fire without a paid Celery worker.

Critical on a single free web worker: the heavy work runs in a **background
thread** and the HTTP handler returns immediately, so the cron call never blocks
(or times out and re-fires, piling up) and never starves real requests like
login. A re-entrancy guard ensures only one run is in flight at a time.

Auth: a shared secret in ``CRON_SECRET`` (``?token=`` or ``X-Cron-Token``). If
unset the endpoint is open (works out of the box) — set it in production.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, status

from app.core.config import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/cron", tags=["cron"])
_settings = get_settings()

# Re-entrancy guard: only one background run at a time. The timestamp lets a
# stuck run (process killed mid-flight) be superseded after a safety window.
_run_state = {"running": False, "since": 0.0}
_MAX_RUN_SECONDS = 240


def _authorized(token: Optional[str], header_token: Optional[str]) -> bool:
    secret = (_settings.cron_secret or "").strip()
    if not secret:
        return True
    return token == secret or header_token == secret


def _run_all() -> dict:
    """Invoke each periodic task synchronously, isolating failures."""
    from app.workers import tasks

    jobs = [
        ("tick_reminders", tasks.tick_reminders),
        ("send_queued_emails", tasks.send_queued_emails),
        ("generate_daily_agendas", tasks.generate_daily_agendas),
        ("tick_outreach_scheduler", tasks.tick_outreach_scheduler),
        ("tick_email_campaigns", tasks.tick_email_campaigns),
    ]
    out: dict = {}
    for name, fn in jobs:
        try:
            out[name] = fn()
        except Exception as exc:  # noqa: BLE001
            log.exception("cron task %s failed: %s", name, exc)
            out[name] = {"error": str(exc)[:200]}
    return out


def _run_in_background() -> None:
    try:
        _run_all()
    finally:
        _run_state["running"] = False
        _run_state["since"] = 0.0


@router.get("/run")
@router.post("/run")
def cron_run(
    token: Optional[str] = Query(default=None),
    x_cron_token: Optional[str] = Header(default=None, alias="X-Cron-Token"),
):
    if not _authorized(token, x_cron_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_cron_token")
    now = time.time()
    # Skip if a run is already in flight (and hasn't blown past the safety window).
    if _run_state["running"] and (now - _run_state["since"]) < _MAX_RUN_SECONDS:
        return {"ok": True, "skipped": "already_running"}
    _run_state["running"] = True
    _run_state["since"] = now
    threading.Thread(target=_run_in_background, daemon=True).start()
    return {"ok": True, "started": True}


@router.get("/health")
def cron_health():
    return {"ok": True}
