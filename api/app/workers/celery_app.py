from celery import Celery
from celery.schedules import crontab

from app.core.config import get_settings

_settings = get_settings()

celery_app = Celery(
    "leadcaptura",
    broker=_settings.redis_url,
    backend=_settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_track_started=True,
    worker_max_tasks_per_child=200,
    broker_connection_retry_on_startup=True,
)

celery_app.conf.beat_schedule = {
    "tick-outreach-scheduler": {
        "task": "app.workers.tasks.tick_outreach_scheduler",
        "schedule": crontab(minute="*"),
    },
    # Drain manually-bulk-queued emails (Messaging → Email composer). The
    # scheduler tick above only touches Enrollment-driven sends; this task
    # picks up ad-hoc rows queued via POST /inbox/bulk-send.
    "drain-queued-emails": {
        "task": "app.workers.tasks.send_queued_emails",
        "schedule": crontab(minute="*"),
    },
    "poll-inbound-email": {
        "task": "app.workers.tasks.poll_inbound_email",
        "schedule": crontab(minute="*/5"),
    },
    # Every 15 minutes — find active SearchScrapers whose daily cap
    # isn't hit yet and queue a scrape_search ExtensionJob if one isn't
    # already queued/claimed. The extension picks up the job next time
    # the user has LinkedIn open in a foreground tab.
    "tick-search-scrapers": {
        "task": "app.workers.tasks.tick_search_scrapers",
        "schedule": crontab(minute="*/15"),
    },
    # Advance every "sending" campaign by one batch each minute. The same
    # /campaigns/{id}/tick endpoint runs from the frontend's poll loop on
    # the free tier where no worker exists; this just makes campaigns keep
    # advancing on Starter+ plans even when no browser tab is open.
    "tick-email-campaigns": {
        "task": "app.workers.tasks.tick_email_campaigns",
        "schedule": crontab(minute="*"),
    },
    # Deliver due calendar/email reminders (write the calendar block or send the
    # nudge) the moment their remind_at passes.
    "tick-reminders": {
        "task": "app.workers.tasks.tick_reminders",
        "schedule": crontab(minute="*"),
    },
    # Build each connected user's AI daily agenda. Hourly + idempotent-per-day:
    # the task only generates when the user's configured local agenda hour
    # arrives, so this naturally lands one agenda per user per day.
    "generate-daily-agendas": {
        "task": "app.workers.tasks.generate_daily_agendas",
        "schedule": crontab(minute="5"),
    },
}

import app.workers.tasks  # noqa: E402,F401
