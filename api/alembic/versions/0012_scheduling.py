"""Scheduling: bookable event types + bookings.

Adds ``event_types`` (reusable bookable meeting templates with weekly
availability) and ``bookings`` (confirmed slots from the public booking page).
Availability slots are computed at request time from the owner's weekly hours
minus calendar busy times and existing bookings.

Revision ID: 0012_scheduling
Revises: 0011_calendar_reminders
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0012_scheduling"
down_revision = "0011_calendar_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_types",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("slug", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("duration_minutes", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("location_type", sa.String(length=30), nullable=False, server_default="google_meet"),
        sa.Column("location_details", sa.String(length=500), nullable=True),
        sa.Column("buffer_before_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("buffer_after_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("min_notice_minutes", sa.Integer(), nullable=False, server_default="120"),
        sa.Column("date_range_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("slot_interval_minutes", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("timezone", sa.String(length=64), nullable=False, server_default="UTC"),
        sa.Column("color", sa.String(length=20), nullable=False, server_default="#3b82f6"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("availability", JSONB(), nullable=False, server_default="{}"),
        sa.Column("questions", JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("workspace_id", "slug", name="uq_event_type_slug"),
    )
    op.create_index("ix_event_types_workspace_id", "event_types", ["workspace_id"])
    op.create_index("ix_event_types_owner_id", "event_types", ["owner_id"])

    op.create_table(
        "bookings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type_id", sa.String(length=36), sa.ForeignKey("event_types.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("lead_id", sa.String(length=36), sa.ForeignKey("leads.id", ondelete="SET NULL"), nullable=True),
        sa.Column("invitee_name", sa.String(length=200), nullable=False),
        sa.Column("invitee_email", sa.String(length=320), nullable=False),
        sa.Column("invitee_phone", sa.String(length=60), nullable=True),
        sa.Column("invitee_timezone", sa.String(length=64), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="confirmed"),
        sa.Column("answers", JSONB(), nullable=False, server_default="{}"),
        sa.Column("calendar_account_id", sa.String(length=36), sa.ForeignKey("connected_accounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("external_event_id", sa.String(length=255), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_bookings_workspace_id", "bookings", ["workspace_id"])
    op.create_index("ix_bookings_event_type_id", "bookings", ["event_type_id"])
    op.create_index("ix_bookings_event_start", "bookings", ["event_type_id", "start_at"])
    op.create_index("ix_bookings_workspace_start", "bookings", ["workspace_id", "start_at"])


def downgrade() -> None:
    op.drop_index("ix_bookings_workspace_start", table_name="bookings")
    op.drop_index("ix_bookings_event_start", table_name="bookings")
    op.drop_index("ix_bookings_event_type_id", table_name="bookings")
    op.drop_index("ix_bookings_workspace_id", table_name="bookings")
    op.drop_table("bookings")
    op.drop_index("ix_event_types_owner_id", table_name="event_types")
    op.drop_index("ix_event_types_workspace_id", table_name="event_types")
    op.drop_table("event_types")
