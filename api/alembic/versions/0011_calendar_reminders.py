"""Calendar-driven reminders + AI daily agenda.

Adds the ``reminders`` table — time-based nudges delivered to the USER (not the
lead) via their synced calendar and/or email. Calendar OAuth tokens reuse the
existing ``connected_accounts`` table (provider="google_calendar"); the
read/write calendar roles live in that row's ``config`` JSONB, so no schema
change is needed there.

Revision ID: 0011_calendar_reminders
Revises: 0010_content_asset_amp
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0011_calendar_reminders"
down_revision = "0010_content_asset_amp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("lead_id", sa.String(length=36), sa.ForeignKey("leads.id", ondelete="CASCADE"), nullable=True),
        sa.Column("task_id", sa.String(length=36), sa.ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("remind_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_minutes", sa.Integer(), nullable=False, server_default="15"),
        sa.Column("channel", sa.String(length=20), nullable=False, server_default="calendar"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("source", sa.String(length=30), nullable=False, server_default="manual"),
        sa.Column("calendar_account_id", sa.String(length=36), sa.ForeignKey("connected_accounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("external_event_id", sa.String(length=255), nullable=True),
        sa.Column("payload", JSONB(), nullable=False, server_default="{}"),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_reminders_workspace_id", "reminders", ["workspace_id"])
    op.create_index("ix_reminders_user_id", "reminders", ["user_id"])
    op.create_index("ix_reminders_due", "reminders", ["status", "remind_at"])
    op.create_index("ix_reminders_workspace_user", "reminders", ["workspace_id", "user_id"])


def downgrade() -> None:
    op.drop_index("ix_reminders_workspace_user", table_name="reminders")
    op.drop_index("ix_reminders_due", table_name="reminders")
    op.drop_index("ix_reminders_user_id", table_name="reminders")
    op.drop_index("ix_reminders_workspace_id", table_name="reminders")
    op.drop_table("reminders")
