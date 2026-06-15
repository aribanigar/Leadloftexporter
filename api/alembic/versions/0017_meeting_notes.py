"""Meeting notes (AI notetaker upload flow).

Stores an uploaded recording / pasted transcript turned into a transcript +
summary + action items.

Revision ID: 0017_meeting_notes
Revises: 0016_round_robin
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0017_meeting_notes"
down_revision = "0016_round_robin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "meeting_notes",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("lead_id", sa.String(length=36), sa.ForeignKey("leads.id", ondelete="SET NULL"), nullable=True),
        sa.Column("booking_id", sa.String(length=36), sa.ForeignKey("bookings.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("action_items", JSONB(), nullable=False, server_default="[]"),
        sa.Column("source", sa.String(length=20), nullable=False, server_default="audio"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="done"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_meeting_notes_workspace_id", "meeting_notes", ["workspace_id"])
    op.create_index("ix_meeting_notes_workspace_created", "meeting_notes", ["workspace_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_meeting_notes_workspace_created", table_name="meeting_notes")
    op.drop_index("ix_meeting_notes_workspace_id", table_name="meeting_notes")
    op.drop_table("meeting_notes")
