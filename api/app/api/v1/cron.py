"""External-cron trigger — run the periodic tasks over HTTP.

A free HTTP cron service (e.g. cron-job.org) pings ``/api/v1/cron/run`` every
minute; this runs the same logic the Celery beat schedule would (deliver due
reminders, generate daily agendas, drain queued emails, advance outreach +
campaigns) — so reminders fire without a paid Celery worker. The ping also keeps
a free Render web service awake.

Auth: a shared secret in ``CRON_SECRET`` (passed as ``?token=`` or the
``X-Cron-Token`` header). If ``CRON_SECRET`` is unset the endpoint is open (so it
works out of the box) — set the secret in production.

Idempotent + safe to call every minute: each sub-task is independently guarded,
and ``generate_daily_agendas`` only fires at each user's configured local hour.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, status

from app.core.config import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/cron", tags=["cron"])
_settings = get_settings()


def _authorized(token: Optional[str], header_token: Optional[str]) -> bool:
    secret = (_settings.cron_secret or "").strip()
    if not secret:
        return True  # open until a secret is configured
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


@router.get("/run")
@router.post("/run")
def cron_run(
    token: Optional[str] = Query(default=None),
    x_cron_token: Optional[str] = Header(default=None, alias="X-Cron-Token"),
):
    if not _authorized(token, x_cron_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_cron_token")
    return {"ok": True, "ran": _run_all()}


@router.get("/health")
def cron_health():
    """Lightweight keep-alive (no work) — also usable as the cron 'are you up' ping."""
    return {"ok": True}
