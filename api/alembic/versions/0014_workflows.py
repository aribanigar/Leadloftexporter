"""Booking-lifecycle workflows + booking disposition.

Adds the ``workflows`` table (trigger → actions automations fired by booking
events) and ``bookings.disposition`` (completed | no_show) set by the owner
after the meeting.

Revision ID: 0014_workflows
Revises: 0013_invitee_reminders
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0014_workflows"
# Linearized after the concurrently-added WhatsApp migration so the chain has a
# single head (both originally branched off 0013_invitee_reminders).
down_revision = "0014_whatsapp_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bookings", sa.Column("disposition", sa.String(length=20), nullable=True))
    op.create_table(
        "workflows",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("trigger", sa.String(length=40), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("filters", JSONB(), nullable=False, server_default="{}"),
        sa.Column("actions", JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_workflows_workspace_id", "workflows", ["workspace_id"])
    op.create_index("ix_workflows_workspace_trigger", "workflows", ["workspace_id", "trigger"])


def downgrade() -> None:
    op.drop_index("ix_workflows_workspace_trigger", table_name="workflows")
    op.drop_index("ix_workflows_workspace_id", table_name="workflows")
    op.drop_table("workflows")
    op.drop_column("bookings", "disposition")
