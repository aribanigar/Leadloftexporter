"""Outreach engine: queueing email/LinkedIn actions, scheduling playbook steps,
and enforcing per-day workspace limits with humanised timing."""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.models import (
    Activity,
    EmailMessage,
    EmailThread,
    Enrollment,
    EnrollmentStepRun,
    ExtensionJob,
    Lead,
    LinkedInMessage,
    Playbook,
    PlaybookStep,
    Workspace,
)


# ---------- Outreach settings ----------


def outreach_settings(workspace: Workspace) -> dict:
    base = {
        "email_sending_pattern": "mimic_humans",
        "schedule": "any_day",
        "time_frame_start": "07:00",
        "time_frame_end": "19:00",
        "timezone": "Asia/Calcutta",
        "email_limit_per_day": 80,
        "linkedin_connect_limit": 15,
        "linkedin_message_limit": 30,
        "whatsapp_limit_per_day": 50,
        # Maximum emails the Celery drainer dispatches per minute so a 500-row
        # bulk send doesn't burst through SendGrid/Resend's rate limits.
        "email_drain_per_minute": 6,
    }
    base.update((workspace.settings or {}).get("outreach", {}))
    return base


# ---------- Daily quotas ----------


def _start_of_day_utc(now: Optional[datetime] = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def emails_sent_today(db: Session, workspace_id: str) -> int:
    return (
        db.query(func.count(EmailMessage.id))
        .filter(
            EmailMessage.workspace_id == workspace_id,
            EmailMessage.direction == "outbound",
            EmailMessage.sent_at.isnot(None),
            EmailMessage.sent_at >= _start_of_day_utc(),
        )
        .scalar()
        or 0
    )


def whatsapp_sent_today(db: Session, workspace_id: str) -> int:
    """Count WhatsApp messages sent today for daily-quota enforcement.

    WhatsApp sends are recorded as Activity rows of type ``whatsapp_sent`` —
    we don't (yet) have a dedicated WhatsApp message model, and Activity is
    already the system-wide audit table, so this keeps the schema small.
    """
    return (
        db.query(func.count(Activity.id))
        .filter(
            Activity.workspace_id == workspace_id,
            Activity.type == "whatsapp_sent",
            Activity.created_at >= _start_of_day_utc(),
        )
        .scalar()
        or 0
    )


def linkedin_actions_today(db: Session, workspace_id: str, kind: str) -> int:
    return (
        db.query(func.count(LinkedInMessage.id))
        .filter(
            LinkedInMessage.workspace_id == workspace_id,
            LinkedInMessage.kind == kind,
            LinkedInMessage.sent_at.isnot(None),
            LinkedInMessage.sent_at >= _start_of_day_utc(),
        )
        .scalar()
        or 0
    )


# ---------- Humanised scheduling ----------


def _parse_hhmm(s: str, fallback: time) -> time:
    try:
        h, m = s.split(":")
        return time(int(h), int(m))
    except Exception:
        return fallback


def humanise_run_at(workspace: Workspace, base_dt: datetime) -> datetime:
    """Move a desired run-time inside the configured time-frame and jitter it."""
    s = outreach_settings(workspace)
    start = _parse_hhmm(s["time_frame_start"], time(7, 0))
    end = _parse_hhmm(s["time_frame_end"], time(19, 0))
    # We compute everything in UTC because we don't ship timezone libs here.
    dt = base_dt.astimezone(timezone.utc)
    candidate = dt
    if candidate.time() < start:
        candidate = candidate.replace(hour=start.hour, minute=start.minute, second=0, microsecond=0)
    if candidate.time() > end:
        candidate = (candidate + timedelta(days=1)).replace(
            hour=start.hour, minute=start.minute, second=0, microsecond=0
        )
    if s["schedule"] == "weekdays":
        while candidate.weekday() >= 5:
            candidate += timedelta(days=1)
    # Jitter ±15 minutes
    candidate += timedelta(seconds=random.randint(-15 * 60, 15 * 60))
    return candidate


# ---------- Queue helpers ----------


def queue_email(
    db: Session,
    *,
    workspace_id: str,
    user_id: Optional[str],
    lead: Optional[Lead],
    to_address: str,
    subject: str,
    body_html: str,
    thread: Optional[EmailThread] = None,
) -> EmailMessage:
    if thread is None and lead is not None:
        thread = EmailThread(workspace_id=workspace_id, lead_id=lead.id, subject=subject)
        db.add(thread)
        db.flush()
    msg = EmailMessage(
        workspace_id=workspace_id,
        thread_id=thread.id if thread else None,
        lead_id=lead.id if lead else None,
        direction="outbound",
        from_address="",  # filled by sender
        to_address=to_address,
        subject=subject,
        body_html=body_html,
        body_text=None,
        status="queued",
    )
    db.add(msg)
    db.flush()
    db.add(
        Activity(
            workspace_id=workspace_id,
            lead_id=lead.id if lead else None,
            actor_id=user_id,
            type="email_queued",
            payload={"message_id": msg.id, "subject": subject},
        )
    )
    return msg


def queue_extension_job(
    db: Session,
    *,
    workspace_id: str,
    user_id: str,
    lead_id: Optional[str],
    kind: str,
    payload: dict,
    not_before: Optional[datetime] = None,
) -> ExtensionJob:
    job = ExtensionJob(
        workspace_id=workspace_id,
        user_id=user_id,
        lead_id=lead_id,
        kind=kind,
        payload=payload,
        not_before=not_before,
        status="queued",
    )
    db.add(job)
    db.flush()
    return job


# ---------- Enrollment ----------


def enroll_lead(db: Session, playbook: Playbook, lead: Lead) -> Enrollment:
    existing = (
        db.query(Enrollment)
        .filter(Enrollment.playbook_id == playbook.id, Enrollment.lead_id == lead.id)
        .first()
    )
    if existing:
        return existing
    enrollment = Enrollment(
        workspace_id=playbook.workspace_id,
        playbook_id=playbook.id,
        lead_id=lead.id,
        status="active",
        current_step=0,
    )
    db.add(enrollment)
    db.flush()
    steps: list[PlaybookStep] = sorted(playbook.steps, key=lambda s: s.position)
    if not steps:
        enrollment.status = "completed"
        return enrollment
    first = steps[0]
    run_at = humanise_run_at(playbook.workspace, datetime.now(timezone.utc) + timedelta(hours=first.wait_hours, days=first.wait_days))
    db.add(
        EnrollmentStepRun(
            workspace_id=playbook.workspace_id,
            enrollment_id=enrollment.id,
            step_id=first.id,
            run_at=run_at,
            status="pending",
        )
    )

    # If this lead has a LinkedIn URL but no email/phone, queue an
    # ExtensionJob so the next time the extension polls (i.e. the next time
    # the user has LinkedIn open in a tab) it visits the profile, opens
    # the Contact info modal, and back-fills email/phone/address. This is
    # what makes "Enroll" double as "Enrich" — playbooks can't send mail
    # to a leadeven a lead that has no email, and we don't want users to
    # remember to enrich first.
    needs_enrichment = (
        bool(lead.linkedin_url)
        and (not lead.email or not lead.phone)
        and "/in/" in (lead.linkedin_url or "")
    )
    if needs_enrichment:
        # Avoid duplicate queued jobs for the same profile
        already = (
            db.query(ExtensionJob)
            .filter(
                ExtensionJob.workspace_id == playbook.workspace_id,
                ExtensionJob.lead_id == lead.id,
                ExtensionJob.kind == "scrape_profile",
                ExtensionJob.status.in_(("queued", "claimed")),
            )
            .first()
        )
        if not already:
            # The lead's owner runs the job if present, otherwise the first
            # workspace member. user_id is non-null on ExtensionJob — we
            # can't queue an enrichment job for a workspace that has no
            # members. (Shouldn't happen in practice but defend anyway.)
            owner_id = lead.owner_id
            if not owner_id and playbook.workspace.memberships:
                owner_id = playbook.workspace.memberships[0].user_id
            if owner_id:
                db.add(
                    ExtensionJob(
                        workspace_id=playbook.workspace_id,
                        user_id=owner_id,
                        lead_id=lead.id,
                        kind="scrape_profile",
                        payload={
                            "linkedin_url": lead.linkedin_url,
                            "reason": "playbook_enrollment_enrich",
                            "playbook_id": playbook.id,
                        },
                        status="queued",
                    )
                )
    return enrollment


def advance_enrollment(db: Session, enrollment: Enrollment) -> Optional[EnrollmentStepRun]:
    pb: Playbook = db.get(Playbook, enrollment.playbook_id)  # type: ignore[assignment]
    steps = sorted(pb.steps, key=lambda s: s.position)
    nxt_idx = enrollment.current_step + 1
    if nxt_idx >= len(steps):
        enrollment.status = "completed"
        enrollment.completed_at = datetime.now(timezone.utc)
        return None
    enrollment.current_step = nxt_idx
    nxt_step = steps[nxt_idx]
    run_at = humanise_run_at(
        pb.workspace,
        datetime.now(timezone.utc) + timedelta(days=nxt_step.wait_days, hours=nxt_step.wait_hours),
    )
    run = EnrollmentStepRun(
        workspace_id=pb.workspace_id,
        enrollment_id=enrollment.id,
        step_id=nxt_step.id,
        run_at=run_at,
        status="pending",
    )
    db.add(run)
    return run
