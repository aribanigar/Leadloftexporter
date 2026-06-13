"""Pre-meeting briefs.

Adds ``event_types.brief_offset_minutes`` — minutes before start to send the
host a brief with the lead's context (0 disables it).

Revision ID: 0018_pre_meeting_brief
Revises: 0017_meeting_notes
"""
from alembic import op
import sqlalchemy as sa


revision = "0018_pre_meeting_brief"
down_revision = "0017_meeting_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_types",
        sa.Column("brief_offset_minutes", sa.Integer(), nullable=False, server_default="30"),
    )


def downgrade() -> None:
    op.drop_column("event_types", "brief_offset_minutes")
