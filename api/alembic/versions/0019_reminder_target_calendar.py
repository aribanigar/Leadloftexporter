"""Per-reminder target calendar (multi-calendar assignment).

Adds ``reminders.target_calendar_id`` so a user who syncs several Google
calendars can assign each reminder/task to a specific one (null = the account's
default write calendar).

Revision ID: 0019_reminder_target_calendar
Revises: 0018_pre_meeting_brief
"""
from alembic import op
import sqlalchemy as sa


revision = "0019_reminder_target_calendar"
down_revision = "0018_pre_meeting_brief"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reminders", sa.Column("target_calendar_id", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("reminders", "target_calendar_id")
