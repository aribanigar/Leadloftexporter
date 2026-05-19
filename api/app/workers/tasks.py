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
    """Send any messages still in 'queued' that weren't sent inline (e.g., manual sends)."""
    sent = 0
    with session_scope() as db:
        rows = (
            db.query(EmailMessage)
            .filter(EmailMessage.status == "queued")
            .order_by(EmailMessage.created_at.asc())
            .limit(50)
            .all()
        )
        for msg in rows:
            ws = db.get(Workspace, msg.workspace_id)
            if not ws:
                continue
            send_email_message(db, msg, ws)
            sent += 1
    return {"sent": sent}


@celery_app.task
def poll_inbound_email() -> dict:
    """Poll Gmail/IMAP for replies. Stub for v1 — wire up Gmail Pub/Sub in prod."""
    return {"polled": 0}
