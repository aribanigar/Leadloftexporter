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
    "poll-inbound-email": {
        "task": "app.workers.tasks.poll_inbound_email",
        "schedule": crontab(minute="*/5"),
    },
}

import app.workers.tasks  # noqa: E402,F401
