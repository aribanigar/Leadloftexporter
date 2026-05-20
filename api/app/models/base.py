from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now()
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[Optional[str]] = mapped_column(String(80))
    last_name: Mapped[Optional[str]] = mapped_column(String(80))
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    plan: Mapped[str] = mapped_column(String(40), default="trial")
    trial_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    settings: Mapped[dict] = mapped_column(JSONB, default=dict)

    memberships: Mapped[list["Membership"]] = relationship(back_populates="workspace", cascade="all, delete-orphan")


class Membership(Base, TimestampMixin):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "workspace_id", name="uq_user_workspace"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="member")  # owner | admin | member

    user: Mapped[User] = relationship(back_populates="memberships")
    workspace: Mapped[Workspace] = relationship(back_populates="memberships")


class ApiKey(Base, TimestampMixin):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80), default="default")
    key_prefix: Mapped[str] = mapped_column(String(16), index=True)
    key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Company(Base, TimestampMixin):
    __tablename__ = "companies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    domain: Mapped[Optional[str]] = mapped_column(String(200), index=True)
    website: Mapped[Optional[str]] = mapped_column(String(500))
    linkedin_url: Mapped[Optional[str]] = mapped_column(String(500), index=True)
    industry: Mapped[Optional[str]] = mapped_column(String(120))
    size: Mapped[Optional[str]] = mapped_column(String(40))
    headcount: Mapped[Optional[int]] = mapped_column(Integer)
    description: Mapped[Optional[str]] = mapped_column(Text)
    phone: Mapped[Optional[str]] = mapped_column(String(60))
    location: Mapped[Optional[str]] = mapped_column(String(200))
    data: Mapped[dict] = mapped_column(JSONB, default=dict)


class PipelineStage(Base, TimestampMixin):
    __tablename__ = "pipeline_stages"
    __table_args__ = (UniqueConstraint("workspace_id", "slug", name="uq_stage_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0)
    color: Mapped[str] = mapped_column(String(20), default="#3b82f6")
    is_won: Mapped[bool] = mapped_column(Boolean, default=False)
    is_lost: Mapped[bool] = mapped_column(Boolean, default=False)


class Tag(Base, TimestampMixin):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("workspace_id", "name", name="uq_tag_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#94a3b8")


class LeadField(Base, TimestampMixin):
    __tablename__ = "lead_fields"
    __table_args__ = (UniqueConstraint("workspace_id", "key", name="uq_field_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[str] = mapped_column(String(30), default="text")  # text|number|date|url|enum|multi|bool
    options: Mapped[dict] = mapped_column(JSONB, default=dict)
    position: Mapped[int] = mapped_column(Integer, default=0)
    visible_default: Mapped[bool] = mapped_column(Boolean, default=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)


class SavedView(Base, TimestampMixin):
    __tablename__ = "saved_views"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    icon: Mapped[Optional[str]] = mapped_column(String(40))
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False)
    filters: Mapped[dict] = mapped_column(JSONB, default=dict)
    columns: Mapped[list] = mapped_column(JSONB, default=list)
    sort: Mapped[dict] = mapped_column(JSONB, default=dict)
    position: Mapped[int] = mapped_column(Integer, default=0)


class Lead(Base, TimestampMixin):
    __tablename__ = "leads"
    __table_args__ = (
        UniqueConstraint("workspace_id", "linkedin_url", name="uq_lead_linkedin"),
        Index("ix_leads_workspace_stage", "workspace_id", "stage_id"),
        Index("ix_leads_workspace_owner", "workspace_id", "owner_id"),
        Index("ix_leads_workspace_email", "workspace_id", "email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    stage_id: Mapped[Optional[str]] = mapped_column(ForeignKey("pipeline_stages.id", ondelete="SET NULL"))
    company_id: Mapped[Optional[str]] = mapped_column(ForeignKey("companies.id", ondelete="SET NULL"))

    first_name: Mapped[Optional[str]] = mapped_column(String(120))
    last_name: Mapped[Optional[str]] = mapped_column(String(120))
    full_name: Mapped[Optional[str]] = mapped_column(String(240), index=True)
    title: Mapped[Optional[str]] = mapped_column(String(240))
    email: Mapped[Optional[str]] = mapped_column(String(255))
    email_status: Mapped[Optional[str]] = mapped_column(String(30))  # unknown|valid|risky|invalid|catchall
    phone: Mapped[Optional[str]] = mapped_column(String(60))
    linkedin_url: Mapped[Optional[str]] = mapped_column(String(500), index=True)
    location: Mapped[Optional[str]] = mapped_column(String(200))
    headline: Mapped[Optional[str]] = mapped_column(Text)
    # TEXT (unbounded) — LinkedIn's media CDN URLs include a signed JWT in
    # the query string that the CDN validates on every request. Stripping
    # the query returns a 403 placeholder image, so we must store the URL
    # verbatim, and the signature pushes the URL past String(500).
    avatar_url: Mapped[Optional[str]] = mapped_column(Text)

    estimated_value: Mapped[Optional[int]] = mapped_column(Integer)  # cents
    close_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    source: Mapped[Optional[str]] = mapped_column(String(40))  # extension|csv|api|manual

    custom: Mapped[dict] = mapped_column(JSONB, default=dict)
    tags: Mapped[list] = mapped_column(JSONB, default=list)

    last_activity_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_outbound_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_inbound_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    company: Mapped[Optional["Company"]] = relationship(lazy="joined")
    stage: Mapped[Optional["PipelineStage"]] = relationship(lazy="joined")


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    assignee_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    type: Mapped[str] = mapped_column(String(30), default="todo")  # todo|call|email|linkedin
    status: Mapped[str] = mapped_column(String(20), default="open")  # open|done|skipped
    due_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Note(Base, TimestampMixin):
    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text, nullable=False)


class Activity(Base, TimestampMixin):
    __tablename__ = "activities"
    __table_args__ = (Index("ix_activities_lead_created", "lead_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)


class EmailThread(Base, TimestampMixin):
    __tablename__ = "email_threads"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    provider_thread_id: Mapped[Optional[str]] = mapped_column(String(255), index=True)
    last_message_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class EmailMessage(Base, TimestampMixin):
    __tablename__ = "email_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    thread_id: Mapped[Optional[str]] = mapped_column(ForeignKey("email_threads.id", ondelete="CASCADE"))
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    direction: Mapped[str] = mapped_column(String(10))  # outbound|inbound
    from_address: Mapped[str] = mapped_column(String(255))
    to_address: Mapped[str] = mapped_column(String(255))
    cc: Mapped[Optional[str]] = mapped_column(String(500))
    bcc: Mapped[Optional[str]] = mapped_column(String(500))
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    body_html: Mapped[Optional[str]] = mapped_column(Text)
    body_text: Mapped[Optional[str]] = mapped_column(Text)
    provider_message_id: Mapped[Optional[str]] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|sent|delivered|opened|clicked|replied|bounced|failed
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    replied_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error: Mapped[Optional[str]] = mapped_column(Text)


class LinkedInMessage(Base, TimestampMixin):
    __tablename__ = "linkedin_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20))  # connect|message
    direction: Mapped[str] = mapped_column(String(10), default="outbound")
    body: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    replied_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class CallLog(Base, TimestampMixin):
    __tablename__ = "call_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    outcome: Mapped[str] = mapped_column(String(40), default="connected")
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[Optional[str]] = mapped_column(Text)


class Template(Base, TimestampMixin):
    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    channel: Mapped[str] = mapped_column(String(20), default="email")  # email|linkedin_connect|linkedin_message
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    variables: Mapped[list] = mapped_column(JSONB, default=list)


class Playbook(Base, TimestampMixin):
    __tablename__ = "playbooks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger: Mapped[str] = mapped_column(String(30), default="manual")  # manual|on_create|on_stage
    trigger_config: Mapped[dict] = mapped_column(JSONB, default=dict)
    daily_enrollment_limit: Mapped[int] = mapped_column(Integer, default=30)
    track_opens: Mapped[bool] = mapped_column(Boolean, default=True)
    contact_unverified: Mapped[bool] = mapped_column(Boolean, default=False)
    eject_on_reply: Mapped[bool] = mapped_column(Boolean, default=True)
    fallback_to_email_domain: Mapped[bool] = mapped_column(Boolean, default=True)
    find_phone_numbers: Mapped[bool] = mapped_column(Boolean, default=False)

    # AI deal router
    on_positive_reply_stage: Mapped[Optional[str]] = mapped_column(String(36))
    on_negative_reply_stage: Mapped[Optional[str]] = mapped_column(String(36))
    on_no_reply_stage: Mapped[Optional[str]] = mapped_column(String(36))

    steps: Mapped[list["PlaybookStep"]] = relationship(
        back_populates="playbook", cascade="all, delete-orphan", order_by="PlaybookStep.position"
    )
    workspace: Mapped["Workspace"] = relationship(lazy="joined")


class PlaybookStep(Base, TimestampMixin):
    __tablename__ = "playbook_steps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    playbook_id: Mapped[str] = mapped_column(ForeignKey("playbooks.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    # automated_email | manual_email | task | call | automated_connect | automated_message
    # bounceshield | enrich | enrich_ai
    wait_days: Mapped[int] = mapped_column(Integer, default=0)
    wait_hours: Mapped[int] = mapped_column(Integer, default=0)
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    template_id: Mapped[Optional[str]] = mapped_column(ForeignKey("templates.id", ondelete="SET NULL"))

    playbook: Mapped[Playbook] = relationship(back_populates="steps")


class Enrollment(Base, TimestampMixin):
    __tablename__ = "enrollments"
    __table_args__ = (UniqueConstraint("playbook_id", "lead_id", name="uq_enrollment"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    playbook_id: Mapped[str] = mapped_column(ForeignKey("playbooks.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|paused|completed|ejected
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    ejected_reason: Mapped[Optional[str]] = mapped_column(String(80))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class EnrollmentStepRun(Base, TimestampMixin):
    __tablename__ = "enrollment_step_runs"
    __table_args__ = (Index("ix_step_runs_due", "status", "run_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    enrollment_id: Mapped[str] = mapped_column(ForeignKey("enrollments.id", ondelete="CASCADE"), index=True)
    step_id: Mapped[str] = mapped_column(ForeignKey("playbook_steps.id", ondelete="CASCADE"))
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|running|done|failed|skipped
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text)


class ConnectedAccount(Base, TimestampMixin):
    __tablename__ = "connected_accounts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)  # gmail|smtp|linkedin
    label: Mapped[Optional[str]] = mapped_column(String(160))
    external_id: Mapped[Optional[str]] = mapped_column(String(255), index=True)  # email or linkedin urn
    access_token: Mapped[Optional[str]] = mapped_column(Text)
    refresh_token: Mapped[Optional[str]] = mapped_column(Text)
    token_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="active")


class ExtensionJob(Base, TimestampMixin):
    __tablename__ = "extension_jobs"
    __table_args__ = (Index("ix_ext_jobs_workspace_status", "workspace_id", "status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    # visit_profile | connect | message | scrape_search | scrape_profile
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|claimed|done|failed|expired
    claimed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    not_before: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text)


class Integration(Base, TimestampMixin):
    __tablename__ = "integrations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="active")


class Credit(Base, TimestampMixin):
    __tablename__ = "credits"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # enrichment|email_verify|ai
    delta: Mapped[int] = mapped_column(Integer)
    reason: Mapped[Optional[str]] = mapped_column(String(120))
