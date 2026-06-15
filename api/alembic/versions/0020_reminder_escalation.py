"""Relentless reminders — escalation until done.

Adds completion + escalation fields so a reminder keeps nudging (email) until
the user marks it done, instead of firing once:
  * done_at — when completed (null = still outstanding)
  * escalate — keep nudging until done
  * nudge_count — how many escalation nudges sent
  * next_nudge_at — when the next nudge is due

Revision ID: 0020_reminder_escalation
Revises: 0019_reminder_target_calendar
"""
from alembic import op
import sqlalchemy as sa


revision = "0020_reminder_escalation"
down_revision = "0019_reminder_target_calendar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reminders", sa.Column("done_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("reminders", sa.Column("escalate", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("reminders", sa.Column("nudge_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("reminders", sa.Column("next_nudge_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_reminders_nudge", "reminders", ["status", "next_nudge_at"])


def downgrade() -> None:
    op.drop_index("ix_reminders_nudge", table_name="reminders")
    op.drop_column("reminders", "next_nudge_at")
    op.drop_column("reminders", "nudge_count")
    op.drop_column("reminders", "escalate")
    op.drop_column("reminders", "done_at")
