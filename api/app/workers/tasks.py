"""Celery tasks: scheduler tick that dispatches due playbook steps."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.db import session_scope
from app.models import (
    Activity,
    ConnectedAccount,
    EmailMessage,
    EmailThread,
    Enrollment,
    EnrollmentStepRun,
    Lead,
    Playbook,
    PlaybookStep,
    Template,
    Workspace,
)
from app.services.ai_writer import generate_email_for_lead
from app.services.email_sender import send_email_message, _pick_account
from app.services.outreach import (
    advance_enrollment,
    linkedin_actions_today,
    outreach_settings,
    queue_extension_job,
)
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)


def _render_template_body(template: Template | None, lead: Lead) -> tuple[str, str]:
    if not template:
        return "", ""
    subj = template.subject or ""
    body = template.body or ""
    name = lead.first_name or (lead.full_name or "").split(" ")[0] or "there"
    repl = {
        "{{first_name}}": name,
        "{{last_name}}": lead.last_name or "",
        "{{full_name}}": lead.full_name or name,
        "{{title}}": lead.title or "",
        "{{company}}": lead.company.name if lead.company else "",
        "{{location}}": lead.location or "",
    }
    for k, v in repl.items():
        subj = subj.replace(k, v)
        body = body.replace(k, v)
    return subj, body


def _process_run(db: Session, run: EnrollmentStepRun) -> None:
    step = db.get(PlaybookStep, run.step_id)
    enrollment = db.get(Enrollment, run.enrollment_id)
    if not (step and enrollment):
        run.status = "skipped"
        return
    if enrollment.status != "active":
        run.status = "skipped"
        return
    lead = db.get(Lead, enrollment.lead_id)
    workspace = db.get(Workspace, enrollment.workspace_id)
    if not (lead and workspace):
        run.status = "skipped"
        return

    kind = step.kind
    run.status = "running"
    run.attempts += 1
    try:
        if kind == "automated_email":
            if not lead.email:
                if step.config.get("skip_if_no_email", True):
                    run.status = "skipped"
                    run.result = {"reason": "no_email"}
                    advance_enrollment(db, enrollment)
                    return
            template = db.get(Template, step.template_id) if step.template_id else None
            if template:
                subj, body = _render_template_body(template, lead)
            elif step.config.get("ai"):
                generated = generate_email_for_lead(
                    lead,
                    instruction=step.config.get("instruction", "Cold outreach"),
                    tone=step.config.get("tone", "professional"),
                    workspace=workspace,
                )
                subj = generated["subject"]
                body = generated["body_html"]
            else:
                subj = step.config.get("subject", "Hi")
                body = step.config.get("body", "")
            thread = EmailThread(workspace_id=workspace.id, lead_id=lead.id, subject=subj)
            db.add(thread)
            db.flush()
            msg = EmailMessage(
                workspace_id=workspace.id,
                thread_id=thread.id,
                lead_id=lead.id,
                direction="outbound",
                from_address="",
                to_address=lead.email or "",
                subject=subj,
                body_html=body,
                body_text=None,
                status="queued",
            )
            db.add(msg)
            db.flush()
            result = send_email_message(db, msg, workspace)
            run.result = {"message_id": msg.id, "ok": result.ok, "error": result.error}
        elif kind == "manual_email":
            run.result = {"deferred": True}
        elif kind == "task":
            from app.models import Task as TaskModel

            db.add(
                TaskModel(
                    workspace_id=workspace.id,
                    lead_id=lead.id,
                    title=step.config.get("title", "Follow up"),
                    notes=step.config.get("notes"),
                    type="todo",
                )
            )
            run.result = {"task_created": True}
        elif kind == "call":
            from app.models import Task as TaskModel

            db.add(
                TaskModel(
                    workspace_id=workspace.id,
                    lead_id=lead.id,
                    title=step.config.get("title", f"Call {lead.full_name or 'lead'}"),
                    type="call",
                )
            )
            run.result = {"call_task_created": True}
        elif kind in ("automated_connect", "automated_message"):
            limits_key = "linkedin_connect_limit" if kind == "automated_connect" else "linkedin_message_limit"
            kind_key = "connect" if kind == "automated_connect" else "message"
            limit = outreach_settings(workspace).get(limits_key, 15 if kind == "automated_connect" else 30)
            if linkedin_actions_today(db, workspace.id, kind_key) >= limit:
                # Reschedule for tomorrow at humanised time
                run.status = "pending"
                run.run_at = datetime.now(timezone.utc) + timedelta(days=1)
                return
            template = db.get(Template, step.template_id) if step.template_id else None
            body = step.config.get("body", "")
            if template:
                _, body = _render_template_body(template, lead)
            payload = {"linkedin_url": lead.linkedin_url, "body": body, "lead_name": lead.full_name}
            from app.models import Membership

            owner_id = lead.owner_id
            if not owner_id:
                m = db.query(Membership).filter(Membership.workspace_id == workspace.id).first()
                owner_id = m.user_id if m else None
            if not owner_id:
                run.status = "failed"
                run.error = "no_user_to_run_action"
                return
            job = queue_extension_job(
                db,
                workspace_id=workspace.id,
                user_id=owner_id,
                lead_id=lead.id,
                kind=kind_key,
                payload=payload,
            )
            run.result = {"job_id": job.id}
        elif kind == "bounceshield":
            run.result = {"verified": True}  # stub
        elif kind in ("enrich", "enrich_ai"):
            run.result = {"enriched": False}  # stub for v1
        else:
            run.result = {"unknown_kind": kind}
        run.status = "done"
        db.add(
            Activity(
                workspace_id=workspace.id,
                lead_id=lead.id,
                type=f"step_{kind}",
                payload={"step_id": step.id, "run_id": run.id},
            )
        )
        advance_enrollment(db, enrollment)
    except Exception as exc:  # noqa: BLE001
        run.status = "failed"
        run.error = str(exc)
        log.exception("step processing failed")


@celery_app.task
def tick_outreach_scheduler() -> dict:
    """Find due step runs and dispatch them."""
    processed = 0
    with session_scope() as db:
        now = datetime.now(timezone.utc)
        rows = (
            db.query(EnrollmentStepRun)
            .filter(EnrollmentStepRun.status == "pending", EnrollmentStepRun.run_at <= now)
            .order_by(EnrollmentStepRun.run_at.asc())
            .limit(200)
            .all()
        )
        for r in rows:
            _process_run(db, r)
            processed += 1
    return {"processed": processed}


@celery_app.task
def send_queued_emails() -> dict:
    """Drain queued EmailMessage rows respecting per-workspace pacing + daily cap.

    Runs every minute on the beat schedule. For each workspace with queued mail
    we send at most ``email_drain_per_minute`` rows so a 500-message bulk send
    paces out over the workspace's configured outreach window instead of
    bursting through provider rate limits. ``send_email_message`` already
    enforces the daily limit and stamps ``status``/``sent_at``/``error`` —
    we just feed it queued rows in chronological order, grouped by workspace.
    """
    from app.services.outreach import emails_sent_today, outreach_settings

    sent = 0
    skipped_throttled = 0
    skipped_over_cap = 0
    with session_scope() as db:
        # Group queued mail by workspace so the per-minute throttle is correctly
        # applied even when one workspace's queue is huge and another's is small.
        # We cap per workspace at email_drain_per_minute and at daily_cap minus
        # already-sent today.
        rows = (
            db.query(EmailMessage)
            .filter(EmailMessage.status == "queued")
            .order_by(EmailMessage.created_at.asc())
            .limit(500)
            .all()
        )
        per_workspace: dict[str, list[EmailMessage]] = {}
        for r in rows:
            per_workspace.setdefault(r.workspace_id, []).append(r)
        for workspace_id, msgs in per_workspace.items():
            ws = db.get(Workspace, workspace_id)
            if not ws:
                continue
            settings = outreach_settings(ws)
            per_min = int(settings.get("email_drain_per_minute", 6))
            daily_cap = int(settings.get("email_limit_per_day", 80))
            today = emails_sent_today(db, ws.id)
            for msg in msgs[:per_min]:
                if today >= daily_cap:
                    skipped_over_cap += 1
                    continue
                result = send_email_message(db, msg, ws)
                if result.ok:
                    sent += 1
                    today += 1
            skipped_throttled += max(0, len(msgs) - per_min)
    return {
        "sent": sent,
        "skipped_throttled": skipped_throttled,
        "skipped_over_cap": skipped_over_cap,
    }


@celery_app.task
def poll_inbound_email() -> dict:
    """Poll Gmail/IMAP for replies. Stub for v1 — wire up Gmail Pub/Sub in prod."""
    return {"polled": 0}


@celery_app.task
def tick_search_scrapers() -> dict:
    """For each active SearchScraper, queue a single scrape_search
    ExtensionJob if there isn't one queued/claimed already and the daily
    save cap hasn't been hit. The extension drains the queue when the
    user has LinkedIn open in a foreground tab.

    Rolls saved_today back to 0 when we cross into a new UTC day.
    Sets status="completed" when total_save_cap is reached.
    """
    from datetime import datetime, timezone

    from app.core.db import SessionLocal
    from app.models import ExtensionJob, SearchScraper

    queued = 0
    with SessionLocal() as db:
        scrapers = (
            db.query(SearchScraper)
            .filter(SearchScraper.status == "active")
            .all()
        )
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        for s in scrapers:
            # Roll the daily counter when a new day starts
            if s.last_run_day != today:
                s.saved_today = 0
                s.last_run_day = today
            # Skip when total cap is exhausted
            if s.saved_total >= s.total_save_cap:
                s.status = "completed"
                continue
            # Skip when daily cap is hit
            if s.saved_today >= s.daily_save_cap:
                continue
            # Skip if there's already a pending job for this scraper
            existing = (
                db.query(ExtensionJob)
                .filter(
                    ExtensionJob.workspace_id == s.workspace_id,
                    ExtensionJob.user_id == s.user_id,
                    ExtensionJob.kind == "scrape_search",
                    ExtensionJob.status.in_(("queued", "claimed")),
                )
                .first()
            )
            if existing:
                continue
            db.add(
                ExtensionJob(
                    workspace_id=s.workspace_id,
                    user_id=s.user_id,
                    kind="scrape_search",
                    payload={
                        "search_url": s.search_url,
                        "scraper_id": s.id,
                        "max_results": min(
                            s.daily_save_cap - s.saved_today,
                            s.total_save_cap - s.saved_total,
                            25,  # one batch per tick; never more than 25 in one go
                        ),
                    },
                    status="queued",
                )
            )
            queued += 1
        db.commit()
    return {"queued": queued}


@celery_app.task
def tick_email_campaigns() -> dict:
    """Advance every active email campaign by one batch.

    Calls into the same _process_tick helper the frontend hits via the
    /campaigns/{id}/tick endpoint — both paths share the row-locked
    "claim pending → mark sending → mark sent/failed" loop, so concurrent
    calls (Celery + browser poll) can't double-send.
    """
    from app.api.v1.campaigns import _process_tick
    from app.models import Campaign

    processed = 0
    with session_scope() as db:
        rows = (
            db.query(Campaign)
            .filter(Campaign.status == "sending")
            .order_by(Campaign.last_tick_at.asc().nullsfirst())
            .limit(50)
            .all()
        )
        for c in rows:
            try:
                _process_tick(db, c)
                processed += 1
            except Exception as exc:  # noqa: BLE001
                log.exception("campaign tick failed for %s: %s", c.id, exc)
                # CRITICAL: roll back so this campaign's partial writes don't
                # leave the SHARED session in an aborted-transaction state —
                # otherwise EVERY subsequent campaign in this run also fails and
                # multiple campaigns appear "stuck".
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass
                # Bump last_tick_at so a persistently-failing campaign sorts to
                # the BACK of the queue next run instead of being picked first
                # (least-recently-ticked) and starving the healthy ones again.
                try:
                    fresh = db.get(Campaign, c.id)
                    if fresh is not None:
                        fresh.last_tick_at = datetime.now(timezone.utc)
                        db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
    return {"processed": processed}


@celery_app.task
def tick_reminders() -> dict:
    """Deliver due reminders + escalation nudges. First delivery hits email AND
    calendar; owner reminders then keep re-emailing with rising urgency until
    marked done (process_due_reminders owns the loop)."""
    from app.services import reminders as rsvc

    with session_scope() as db:
        return rsvc.process_due_reminders(db)


@celery_app.task
def generate_daily_agendas() -> dict:
    """Once per local morning, build each user's daily agenda.

    Iterates over every user who has reminder prefs set (stored per-user in
    workspace.settings["reminder_prefs"]) — works for calendar AND email/SMTP
    users alike. Runs hourly; generate_daily_agenda() is idempotent per
    (user, day) and only fires when the user's configured agenda hour has
    arrived in their timezone, so an hourly beat lands one agenda per user/day.
    """
    from app.models import Workspace
    from app.services import reminders as rsvc

    generated = 0
    with session_scope() as db:
        workspaces = db.query(Workspace).all()
        for ws in workspaces:
            prefs_root = (ws.settings or {}).get("reminder_prefs") or {}
            for user_id, entry in prefs_root.items():
                agenda = (entry or {}).get("agenda") or {}
                if not agenda.get("enabled", True):
                    continue
                cfg = rsvc.agenda_config(ws, user_id)
                tz = rsvc._zone(cfg["timezone"])
                local_hour = datetime.now(timezone.utc).astimezone(tz).hour
                if local_hour != int(cfg.get("hour", 8)):
                    continue
                try:
                    rem = rsvc.generate_daily_agenda(db, workspace=ws, user_id=user_id)
                    if rem:
                        generated += 1
                except Exception as exc:  # noqa: BLE001
                    log.exception("daily agenda failed for user %s: %s", user_id, exc)
    return {"generated": generated}
