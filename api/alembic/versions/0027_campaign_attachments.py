"""campaign email attachments

Revision ID: 0027_campaign_attachments
Revises: 0026_perf_indexes
Create Date: 2026-07-23
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0027_campaign_attachments"
down_revision = "0026_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "campaigns",
        sa.Column("attachments", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("campaigns", "attachments")
