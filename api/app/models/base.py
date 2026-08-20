from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
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
    # Password reset — SHA-256 of the one-time token (raw token only leaves
    # the server in the reset email). Cleared once consumed.
    password_reset_token_hash: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    password_reset_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

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


class LicenseKey(Base, TimestampMixin):
    """Admin-issued activation credential the Chrome extension must present
    ALONGSIDE a personal ApiKey before get_extension_context (deps.py) lets
    any extension call through, and (see auth.py:register/login) that a
    person must hold to create or sign into an account at all. An ApiKey
    already determines whose account captured data belongs to
    (ApiKey.user_id -> Lead.owner_id etc.) — this table doesn't change that.
    It's a separate, admin-controlled gate. Hashed at rest, same pattern as
    ApiKey.

    Two lifecycles share this one table:
      1. Issued to an EXISTING account (admin_access.py / licenses.py):
         workspace_id + assigned_user_id are set immediately.
      2. Issued as an INVITE, before the person has an account at all
         (admin_access.py's /invite endpoint): workspace_id and
         assigned_user_id start NULL, invite_email optionally pins which
         email may redeem it. auth.py:register validates + "claims" it —
         filling in workspace_id/assigned_user_id — atomically with account
         creation, so the exact same key the admin handed out also works for
         the extension once registration succeeds. workspace_id is nullable
         specifically to allow this unclaimed state.
    """
    __tablename__ = "license_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[Optional[str]] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    created_by_user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Optional: pins this key to one specific team member. When set, the
    # ApiKey presented alongside it must belong to that same user — a second
    # integrity check on top of the ApiKey's own per-user attribution.
    assigned_user_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    # Only meaningful while unclaimed (workspace_id IS NULL): the email
    # allowed to redeem this invite at registration. NULL = any email may
    # claim it (first to submit it wins). Cleared once claimed.
    invite_email: Mapped[Optional[str]] = mapped_column(String(255), index=True)
    label: Mapped[Optional[str]] = mapped_column(String(120))
    key_prefix: Mapped[str] = mapped_column(String(16), index=True)
    key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | revoked
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
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
        # Supports the default list ORDER BY created_at DESC within a workspace
        # (Pipeline / Prospecting main list) so it's an index scan, not a sort of
        # the whole workspace's leads.
        Index("ix_leads_workspace_created", "workspace_id", "created_at"),
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
    # email_messages is the fastest-growing table (every send / campaign recipient /
    # manual email writes a row). These indexes back the hot read paths: the lead
    # timeline (workspace_id, lead_id), the dashboard stats + bulk-send dedup
    # (workspace_id, direction, created_at), inbox thread grouping (thread_id), and
    # the status counts (workspace_id, status). The functional lower(from_address)
    # index backs the inbox mailbox thread-count group-by — it can't be expressed
    # here (the column isn't in scope yet) so it lives only in migration 0026 as
    # ix_email_from_lower.
    __table_args__ = (
        Index("ix_email_ws_lead", "workspace_id", "lead_id"),
        Index("ix_email_ws_dir_created", "workspace_id", "direction", "created_at"),
        Index("ix_email_ws_status", "workspace_id", "status"),
        Index("ix_email_thread", "thread_id"),
    )

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


class WhatsAppMessage(Base, TimestampMixin):
    """A single 1:1 WhatsApp message captured by the Baileys sidecar.

    The sidecar POSTs every real-time message (inbound reply OR our own
    outbound send) to ``/whatsapp-web/webhook/inbound``; the backend matches
    the phone to a Lead and writes one of these rows so the conversation
    surfaces in the Lead Detail timeline. ``provider_message_id`` is the
    WhatsApp message id and is unique per workspace so reconnect history
    replays don't create duplicates.
    """

    __tablename__ = "whatsapp_messages"
    __table_args__ = (
        UniqueConstraint("workspace_id", "provider_message_id", name="uq_wa_msg_provider"),
        Index("ix_wa_msg_lead_created", "lead_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    # Nullable: we still store messages from numbers that don't map to a lead
    # yet, so the row exists if the lead is created later (and to dedup).
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
    direction: Mapped[str] = mapped_column(String(10), default="inbound")  # inbound|outbound
    phone: Mapped[str] = mapped_column(String(40), index=True)
    contact_name: Mapped[Optional[str]] = mapped_column(String(200))
    body: Mapped[Optional[str]] = mapped_column(Text)
    msg_type: Mapped[str] = mapped_column(String(40), default="text")
    provider_message_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    provider_ts: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class CallLog(Base, TimestampMixin):
    __tablename__ = "call_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    # Indexed: the lead timeline filters call logs by lead_id; without this it was a
    # full scan of the workspace's call history on every Lead Detail open.
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"), index=True)
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


class Reminder(Base, TimestampMixin):
    """A time-based nudge delivered to the user (not the lead) via their synced
    calendar and/or email — the engine behind calendar-driven reminders and the
    AI daily agenda.

    Mirrors the EnrollmentStepRun "row with run_at + status, drained by a beat
    tick" pattern: `tick_reminders` picks up pending rows whose remind_at has
    passed and delivers them. `source` records what created it (a manual add, an
    inbound reply, a pipeline stage change, a note, or the daily-agenda job) so
    the UI can group and the engine can de-dupe.
    """

    __tablename__ = "reminders"
    __table_args__ = (
        Index("ix_reminders_due", "status", "remind_at"),
        Index("ix_reminders_workspace_user", "workspace_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    # The person the reminder is FOR (whose calendar/inbox it lands in).
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Optional CRM linkage — who/what the reminder is about.
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[Optional[str]] = mapped_column(Text)
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Length in minutes of the calendar block written for this reminder.
    duration_minutes: Mapped[int] = mapped_column(Integer, default=15)

    channel: Mapped[str] = mapped_column(String(20), default="calendar")  # calendar | email
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|scheduled|sent|failed|cancelled|skipped
    source: Mapped[str] = mapped_column(String(30), default="manual")
    # manual | inbox_reply | stage_change | note | daily_agenda | booking | booking_reminder

    # When set, the reminder is sent to this external address (e.g. a booking
    # invitee) instead of the owning user's own inbox. user_id still scopes
    # ownership + picks the sending account.
    recipient_email: Mapped[Optional[str]] = mapped_column(String(320))
    # Link to the booking that spawned this reminder (so cancelling a booking
    # cancels its pending invitee reminders).
    booking_id: Mapped[Optional[str]] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"))

    # The calendar account this lands on + the external (Google) event id once
    # written, so we can update/delete it idempotently.
    calendar_account_id: Mapped[Optional[str]] = mapped_column(ForeignKey("connected_accounts.id", ondelete="SET NULL"))
    external_event_id: Mapped[Optional[str]] = mapped_column(String(255))
    # Which Google calendar this reminder/task is written to (when channel is
    # calendar). Null → the account's default write calendar. Lets a user sync
    # several calendars and assign each reminder to a specific one.
    target_calendar_id: Mapped[Optional[str]] = mapped_column(String(255))

    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error: Mapped[Optional[str]] = mapped_column(Text)

    # Relentless delivery: keep nudging (email) until the user marks it done, so
    # a procrastinated task isn't missed after the first fire.
    done_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    escalate: Mapped[bool] = mapped_column(Boolean, default=True)
    nudge_count: Mapped[int] = mapped_column(Integer, default=0)
    next_nudge_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


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


class SearchScraper(Base, TimestampMixin):
    """A standing background scrape of a LinkedIn search URL.

    Same model as LeadLoft's "LinkedIn Scraper Settings" — paste a search
    URL, set a daily save cap + total cap, and the extension chips away
    at the search results over time. Each newly-found lead can auto-
    enroll into a playbook.

    The daily Celery beat tick produces ExtensionJob(kind="scrape_search")
    rows when current-day saves haven't yet hit the cap. The extension
    picks the job up when the user has LinkedIn open in a foreground tab.
    """

    __tablename__ = "search_scrapers"
    __table_args__ = (
        Index("ix_search_scrapers_workspace", "workspace_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    name: Mapped[Optional[str]] = mapped_column(String(160))
    search_url: Mapped[str] = mapped_column(Text, nullable=False)

    daily_save_cap: Mapped[int] = mapped_column(Integer, default=30)
    total_save_cap: Mapped[int] = mapped_column(Integer, default=1000)

    saved_today: Mapped[int] = mapped_column(Integer, default=0)
    saved_total: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_run_day: Mapped[Optional[str]] = mapped_column(String(10))  # YYYY-MM-DD

    playbook_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("playbooks.id", ondelete="SET NULL")
    )
    segment_id: Mapped[Optional[str]] = mapped_column(String(36))  # opt. tag

    status: Mapped[str] = mapped_column(String(20), default="active")
    # active | paused | completed | exhausted


class CompanyEmailPattern(Base, TimestampMixin):
    """Cache of the winning email-pattern per company domain.

    LeadLoft's pattern-inference moat: once a domain has been verified
    to use first.last@, every subsequent lead at that domain skips the
    SMTP probe and reuses the pattern instantly. With enough volume the
    cache approaches the accuracy of a paid B2B database — for free.

    Global across workspaces (not workspace-scoped): a pattern verified
    by user A applies to user B's leads at the same company. The
    `verified_count` field lets us preferentially trust patterns that
    have been confirmed multiple times.

    Pattern stored as a template string with {first} and {last} tokens:
      "{first}.{last}"  →  john.smith@domain
      "{f}{last}"       →  jsmith@domain
      "{first}"         →  john@domain
    """

    __tablename__ = "company_email_patterns"
    __table_args__ = (
        UniqueConstraint("domain", "pattern", name="uq_domain_pattern"),
        Index("ix_company_email_patterns_domain", "domain"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    domain: Mapped[str] = mapped_column(String(200), nullable=False)
    pattern: Mapped[str] = mapped_column(String(60), nullable=False)
    verified_count: Mapped[int] = mapped_column(Integer, default=1)
    last_verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


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


# ============================================================================
# EMAIL MARKETING — campaigns, recipients, sender warmup, suppressions
# ============================================================================
#
# Design intent: a campaign is an outbound broadcast that sends INDIVIDUAL
# emails (no BCC blast) to a list of leads, rotating across one or more
# connected sender accounts (SMTP / Resend / SendGrid / Gmail) with a
# per-sender warmup schedule and a global pause/resume control.
#
# The send loop is driven by /campaigns/{id}/tick which processes a small
# batch (~5–10 messages) per call. The endpoint is called by BOTH:
#   - The frontend's polling loop while the user watches the progress bar
#     (works on Render free tier where Celery workers don't run).
#   - The Celery beat schedule when a worker IS running (Starter plan).
# Both paths are idempotent — the CampaignRecipient.status row is the only
# source of truth, advancing only "pending" rows.


# ──────────────────────────────────────────────────────────────────────────
# Content Hub — Google-Drive-style folders ("businesses"), each holding a
# library of reusable marketing assets (HTML emails / WhatsApp / captions /
# SMS / other). A ContentBusiness also carries light brand attributes
# (brand_color / accent_color / tone) so the same folder can later feed the
# AI campaign writer with on-brand defaults.
# ──────────────────────────────────────────────────────────────────────────


class ContentBusiness(Base, TimestampMixin):
    __tablename__ = "content_businesses"
    __table_args__ = (
        Index("ix_content_biz_workspace", "workspace_id"),
        UniqueConstraint("workspace_id", "slug", name="uq_content_biz_slug"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(140), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    brand_color: Mapped[str] = mapped_column(String(20), default="#00361a")
    accent_color: Mapped[Optional[str]] = mapped_column(String(20))
    tone: Mapped[Optional[str]] = mapped_column(String(40))
    logo_url: Mapped[Optional[str]] = mapped_column(String(500))

    assets: Mapped[list["ContentAsset"]] = relationship(
        back_populates="business", cascade="all, delete-orphan"
    )


class ContentAsset(Base, TimestampMixin):
    __tablename__ = "content_assets"
    __table_args__ = (
        Index("ix_content_asset_biz_type", "business_id", "type"),
        Index("ix_content_asset_workspace", "workspace_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    business_id: Mapped[str] = mapped_column(
        ForeignKey("content_businesses.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # html_email | whatsapp | caption | sms | other
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="html_email")
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Optional AMP-for-Email body attached to an html_email asset. Gmail
    # renders this; every other client falls through to ``content`` (HTML).
    amp_content: Mapped[Optional[str]] = mapped_column(Text)
    subject: Mapped[Optional[str]] = mapped_column(String(300))   # email subject line
    platform: Mapped[Optional[str]] = mapped_column(String(40))   # caption platform
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    # Optional attached image (data: URL or remote URL). For whatsapp/sms assets
    # this is the product photo that rides along as the WhatsApp media caption.
    image_url: Mapped[Optional[str]] = mapped_column(Text)

    business: Mapped["ContentBusiness"] = relationship(back_populates="assets")


class Campaign(Base, TimestampMixin):
    __tablename__ = "campaigns"
    __table_args__ = (
        Index("ix_campaigns_workspace_status", "workspace_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(240), nullable=False)
    # Content
    subject: Mapped[str] = mapped_column(String(500), default="")
    preheader: Mapped[Optional[str]] = mapped_column(String(500))
    body_html: Mapped[str] = mapped_column(Text, default="")
    body_amp: Mapped[Optional[str]] = mapped_column(Text)        # AMP for Email
    body_text: Mapped[Optional[str]] = mapped_column(Text)
    preview_text: Mapped[Optional[str]] = mapped_column(String(200))
    brand_color: Mapped[Optional[str]] = mapped_column(String(20))
    # Sender identity (display only — the actual SMTP envelope-from is the
    # connected sender account picked by the rotation).
    from_name: Mapped[Optional[str]] = mapped_column(String(240))
    from_email: Mapped[Optional[str]] = mapped_column(String(320))
    reply_to: Mapped[Optional[str]] = mapped_column(String(320))
    # Marketing metadata (drives the builder's scoring + the stats benchmarks)
    goal: Mapped[Optional[str]] = mapped_column(String(40))
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    # Drip follow-ups — list of {subject, body_html, delay_hours, status}.
    follow_ups: Mapped[list] = mapped_column(JSONB, default=list)
    # Email attachments carried on every send: [{filename, content_type, data}]
    # where `data` is base64. Stored once on the campaign (not per recipient).
    attachments: Mapped[list] = mapped_column(JSONB, default=list)
    # Merge / personalisation. merge_columns is the list of available tokens
    # (e.g. ["name","city"]); recipient_data holds the raw pasted/CSV rows
    # ([{email, merge:{col:val}}]) before they're materialised into rows.
    merge_columns: Mapped[list] = mapped_column(JSONB, default=list)
    recipient_data: Mapped[list] = mapped_column(JSONB, default=list)
    # How the recipient set was assembled (manual emails / lead filters).
    recipient_sources: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Click-tracking link registry — [{tracking_id, original_url, clicks}].
    links: Mapped[list] = mapped_column(JSONB, default=list)
    # Recipients selection (snapshot at campaign-create time)
    recipient_filter: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Sender pool — list of ConnectedAccount.id strings to rotate across.
    # Empty list = let _pick_account choose per-send.
    sender_account_ids: Mapped[list] = mapped_column(JSONB, default=list)
    rotation_index: Mapped[int] = mapped_column(Integer, default=0)
    # Throttle / warmup
    batch_size: Mapped[int] = mapped_column(Integer, default=8)
    seconds_between_sends: Mapped[int] = mapped_column(Integer, default=30)
    warmup_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Lifecycle
    status: Mapped[str] = mapped_column(String(20), default="draft")
    # draft | scheduled | sending | paused | completed | cancelled | failed
    scheduled_for: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    paused_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    last_tick_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    # Counters — denormalised for cheap reads on the dashboard.
    total_recipients: Mapped[int] = mapped_column(Integer, default=0)
    sent_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, default=0)
    # Engagement counters — incremented by the public tracking endpoints.
    opened_count: Mapped[int] = mapped_column(Integer, default=0)
    clicked_count: Mapped[int] = mapped_column(Integer, default=0)
    bounced_count: Mapped[int] = mapped_column(Integer, default=0)
    unsubscribed_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text)


class CampaignRecipient(Base, TimestampMixin):
    """One row per (campaign × lead). The send loop advances rows in
    `status="pending"` order — each row is "claimed" by transitioning to
    `sending`, then to `sent`/`failed`/`skipped`."""

    __tablename__ = "campaign_recipients"
    __table_args__ = (
        Index(
            "ix_campaign_recipients_campaign_status",
            "campaign_id",
            "status",
        ),
        UniqueConstraint("campaign_id", "lead_id", name="uq_camp_recip_lead"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    campaign_id: Mapped[str] = mapped_column(
        ForeignKey("campaigns.id", ondelete="CASCADE"), index=True
    )
    # Nullable — campaigns can target arbitrary pasted/CSV emails that are
    # not tied to any Lead in the CRM. When null, personalisation comes from
    # `merge_data` instead of the Lead row.
    lead_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("leads.id", ondelete="CASCADE"), index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String(240))
    # Per-recipient merge values ({col: val}) for {token} substitution.
    merge_data: Mapped[dict] = mapped_column(JSONB, default=dict)
    sender_account_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("connected_accounts.id", ondelete="SET NULL")
    )
    message_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("email_messages.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # pending | sending | sent | opened | clicked | failed | skipped
    #          | bounced | unsubscribed
    # Human-paced scheduling: the earliest time this recipient may be sent. The
    # tick claims only rows whose send_after has passed, so a launch drips at
    # the campaign's seconds_between_sends (jittered) instead of bursting.
    # NULL = eligible immediately (back-compat for pre-0023 rows).
    send_after: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error: Mapped[Optional[str]] = mapped_column(Text)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # Engagement tracking — written by the public open/click endpoints.
    open_count: Mapped[int] = mapped_column(Integer, default=0)
    opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    click_count: Mapped[int] = mapped_column(Integer, default=0)
    clicked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    clicked_links: Mapped[list] = mapped_column(JSONB, default=list)
    bounce_reason: Mapped[Optional[str]] = mapped_column(Text)
    bounced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class SenderWarmup(Base, TimestampMixin):
    """Per-(account, day) warmup tracker. The daily cap starts low and
    ramps up over `ramp_days` (default 30). `sent_today` resets when
    `day_anchor` rolls over to a new UTC date.

    Cap curve (default): day 1 = 20 emails, doubles roughly every 3 days,
    capped at `daily_cap_ceiling` (default 2,000). This matches industry
    warmup playbooks (Mailgun, SendGrid, Postmark).
    """

    __tablename__ = "sender_warmups"
    __table_args__ = (
        UniqueConstraint(
            "connected_account_id", name="uq_sender_warmup_account"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    connected_account_id: Mapped[str] = mapped_column(
        ForeignKey("connected_accounts.id", ondelete="CASCADE"),
        index=True,
    )
    # Warmup is OPT-IN: default OFF so campaigns send freely; a user turns it
    # on per inbox to gradually ramp daily volume (overflow defers to the next
    # day, never fails).
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    ramp_days: Mapped[int] = mapped_column(Integer, default=30)
    daily_cap_ceiling: Mapped[int] = mapped_column(Integer, default=2000)
    sent_today: Mapped[int] = mapped_column(Integer, default=0)
    day_anchor: Mapped[Optional[str]] = mapped_column(String(10))  # YYYY-MM-DD
    total_sent: Mapped[int] = mapped_column(Integer, default=0)


class Suppression(Base, TimestampMixin):
    """Email addresses that must never be sent to.

    Populated by: (a) hard bounces, (b) recipient-click unsubscribe links,
    (c) manual import. The campaign send loop checks this table and marks
    matching recipients as `skipped` before they touch the SMTP transport.
    """

    __tablename__ = "suppressions"
    __table_args__ = (
        UniqueConstraint("workspace_id", "email", name="uq_suppression_email"),
        Index("ix_suppressions_workspace_email", "workspace_id", "email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    reason: Mapped[str] = mapped_column(String(40), default="manual")
    # manual | bounce | unsubscribe | complaint | failed_send
    source_campaign_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("campaigns.id", ondelete="SET NULL")
    )


class EventType(Base, TimestampMixin):
    """A reusable bookable meeting template — the GReminders/Calendly "event
    type". A prospect picks an open slot on its public page; we compute slots
    from the owner's weekly availability minus calendar busy times and existing
    bookings, then write the confirmed meeting to the owner's calendar.
    """

    __tablename__ = "event_types"
    __table_args__ = (UniqueConstraint("workspace_id", "slug", name="uq_event_type_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    slug: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    location_type: Mapped[str] = mapped_column(String(30), default="google_meet")
    # google_meet | phone | in_person | custom
    location_details: Mapped[Optional[str]] = mapped_column(String(500))
    buffer_before_minutes: Mapped[int] = mapped_column(Integer, default=0)
    buffer_after_minutes: Mapped[int] = mapped_column(Integer, default=0)
    min_notice_minutes: Mapped[int] = mapped_column(Integer, default=120)
    date_range_days: Mapped[int] = mapped_column(Integer, default=30)
    slot_interval_minutes: Mapped[int] = mapped_column(Integer, default=30)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    color: Mapped[str] = mapped_column(String(20), default="#3b82f6")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Weekly availability: {"mon": [{"start": "09:00", "end": "17:00"}], ...}
    availability: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Custom intake questions: [{"key","label","type","required"}]
    questions: Mapped[list] = mapped_column(JSONB, default=list)
    # Minutes-before-start at which to email the invitee a reminder.
    reminder_offsets: Mapped[list] = mapped_column(JSONB, default=lambda: [1440, 60])
    # Team scheduling: how bookings are assigned, and the candidate hosts.
    assignment: Mapped[str] = mapped_column(String(20), default="single")  # single | round_robin
    host_ids: Mapped[list] = mapped_column(JSONB, default=list)  # user ids; empty → just owner
    # Minutes before start to send the host a pre-meeting brief (0 = disabled).
    brief_offset_minutes: Mapped[int] = mapped_column(Integer, default=30)


class Booking(Base, TimestampMixin):
    """A confirmed booking against an EventType, made from the public page."""

    __tablename__ = "bookings"
    __table_args__ = (
        Index("ix_bookings_event_start", "event_type_id", "start_at"),
        Index("ix_bookings_workspace_start", "workspace_id", "start_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    event_type_id: Mapped[str] = mapped_column(ForeignKey("event_types.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="SET NULL"))

    invitee_name: Mapped[str] = mapped_column(String(200), nullable=False)
    invitee_email: Mapped[str] = mapped_column(String(320), nullable=False)
    invitee_phone: Mapped[Optional[str]] = mapped_column(String(60))
    invitee_timezone: Mapped[Optional[str]] = mapped_column(String(64))

    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="confirmed")  # confirmed | cancelled
    # Post-meeting outcome, set by the owner: completed | no_show (else None).
    disposition: Mapped[Optional[str]] = mapped_column(String(20))
    answers: Mapped[dict] = mapped_column(JSONB, default=dict)

    calendar_account_id: Mapped[Optional[str]] = mapped_column(ForeignKey("connected_accounts.id", ondelete="SET NULL"))
    external_event_id: Mapped[Optional[str]] = mapped_column(String(255))
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Workflow(Base, TimestampMixin):
    """A booking-lifecycle automation: when ``trigger`` fires, run ``actions``.

    Triggers: booking_created | booking_cancelled | meeting_completed |
    meeting_no_show. Actions are a JSON list of {type, params}; supported types:
    send_email, create_task, move_stage, add_tag, schedule_reminder.
    """

    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    trigger: Mapped[str] = mapped_column(String(40), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Optional scoping, e.g. {"event_type_id": "..."} to limit to one event type.
    filters: Mapped[dict] = mapped_column(JSONB, default=dict)
    actions: Mapped[list] = mapped_column(JSONB, default=list)


class RoutingForm(Base, TimestampMixin):
    """A qualifying form whose answers route a prospect to an event type or an
    external URL (GReminders/Calendly "routing forms")."""

    __tablename__ = "routing_forms"
    __table_args__ = (UniqueConstraint("workspace_id", "slug", name="uq_routing_form_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    slug: Mapped[str] = mapped_column(String(160), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Fields: [{"key","label","type":"text"|"select","options":[...],"required":bool}]
    fields: Mapped[list] = mapped_column(JSONB, default=list)
    # Rules: [{"conditions":[{"field","op","value"}], "action":{"type":"event"|"url","target"}}]
    rules: Mapped[list] = mapped_column(JSONB, default=list)
    # Fallback when no rule matches: {"type":"event"|"url","target"}
    default_action: Mapped[dict] = mapped_column(JSONB, default=dict)


class MeetingNote(Base, TimestampMixin):
    """A meeting recording turned into notes: an uploaded audio file (or pasted
    transcript) → transcript → summary + action items. The 'AI notetaker'
    pillar, done as an upload flow rather than an auto-joining bot."""

    __tablename__ = "meeting_notes"
    __table_args__ = (Index("ix_meeting_notes_workspace_created", "workspace_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    lead_id: Mapped[Optional[str]] = mapped_column(ForeignKey("leads.id", ondelete="SET NULL"))
    booking_id: Mapped[Optional[str]] = mapped_column(ForeignKey("bookings.id", ondelete="SET NULL"))

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    transcript: Mapped[Optional[str]] = mapped_column(Text)
    summary: Mapped[Optional[str]] = mapped_column(Text)
    action_items: Mapped[list] = mapped_column(JSONB, default=list)
    source: Mapped[str] = mapped_column(String(20), default="audio")  # audio | transcript
    status: Mapped[str] = mapped_column(String(20), default="done")  # done | failed
    error: Mapped[Optional[str]] = mapped_column(Text)


class CompanyFinderBusiness(Base, TimestampMixin):
    """A business scraped from Google Maps (via the extension's /search
    interception, or imported from a scraper CSV/JSON). Organised into a
    country → area → zone → street → building hierarchy derived from the
    address + lat/lng so the UI can group "businesses in the same building"."""

    __tablename__ = "company_finder_businesses"
    __table_args__ = (
        Index("ix_cfb_ws_category", "workspace_id", "category"),
        Index("ix_cfb_ws_country_area", "workspace_id", "country", "area"),
        Index("ix_cfb_ws_building", "workspace_id", "building_key"),
        UniqueConstraint("workspace_id", "dedup_key", name="uq_cfb_ws_dedup"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)

    name: Mapped[str] = mapped_column(String(400), nullable=False, default="")
    phone: Mapped[Optional[str]] = mapped_column(String(60))
    email: Mapped[Optional[str]] = mapped_column(String(400))
    website: Mapped[Optional[str]] = mapped_column(String(600))
    address: Mapped[Optional[str]] = mapped_column(Text)
    category: Mapped[Optional[str]] = mapped_column(String(300))  # niche / business type

    latitude: Mapped[Optional[float]] = mapped_column(Float)
    longitude: Mapped[Optional[float]] = mapped_column(Float)

    # Google identifiers (used for dedup + a maps link).
    place_id: Mapped[Optional[str]] = mapped_column(String(120))
    cid: Mapped[Optional[str]] = mapped_column(String(120))
    profile_url: Mapped[Optional[str]] = mapped_column(String(600))

    # Derived hierarchy.
    country: Mapped[Optional[str]] = mapped_column(String(120))
    area: Mapped[Optional[str]] = mapped_column(String(200))   # city
    zone: Mapped[Optional[str]] = mapped_column(String(200))   # neighbourhood / district
    street: Mapped[Optional[str]] = mapped_column(String(300))
    building: Mapped[Optional[str]] = mapped_column(String(300))
    # Stable group key for "same building" (rounded lat/lng, else normalised building).
    building_key: Mapped[Optional[str]] = mapped_column(String(120), index=True)

    socials: Mapped[dict] = mapped_column(JSONB, default=dict)   # {instagram:[],facebook:[],linkedin:[],...}
    hours: Mapped[dict] = mapped_column(JSONB, default=dict)
    rating: Mapped[Optional[str]] = mapped_column(String(20))
    rating_count: Mapped[Optional[str]] = mapped_column(String(40))

    source: Mapped[str] = mapped_column(String(20), default="extension")  # extension | import
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False, default="")
