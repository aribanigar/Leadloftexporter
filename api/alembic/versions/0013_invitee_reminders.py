"""Invitee appointment reminders.

Adds:
  * ``event_types.reminder_offsets`` — minutes-before-start at which to email
    the invitee (default 24h + 1h).
  * ``reminders.recipient_email`` — send a reminder to an external address
    (the booking invitee) rather than the owning user's own inbox.
  * ``reminders.booking_id`` — link invitee reminders to their booking so
    cancelling the booking cancels them.

Revision ID: 0013_invitee_reminders
Revises: 0012_scheduling
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0013_invitee_reminders"
down_revision = "0012_scheduling"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_types",
        sa.Column("reminder_offsets", JSONB(), nullable=False, server_default="[1440, 60]"),
    )
    op.add_column("reminders", sa.Column("recipient_email", sa.String(length=320), nullable=True))
    op.add_column(
        "reminders",
        sa.Column("booking_id", sa.String(length=36), sa.ForeignKey("bookings.id", ondelete="CASCADE"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reminders", "booking_id")
    op.drop_column("reminders", "recipient_email")
    op.drop_column("event_types", "reminder_offsets")
