"""backfill stage_id on leads that were saved before a default stage existed.

Any lead with stage_id IS NULL is parked on its workspace's first pipeline
stage (lowest position) so it shows up in the Pipeline board/list. The
application layer (pipeline.list_stages) repeats this self-heal on every load,
but this migration fixes the existing backlog in one pass.

Revision ID: 0005_backfill_stage_ids
Revises: 0004_company_email_patterns
Create Date: 2026-05-27
"""
from alembic import op
import sqlalchemy as sa


revision = "0005_backfill_stage_ids"
down_revision = "0004_company_email_patterns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE leads
            SET stage_id = (
                SELECT id FROM pipeline_stages
                WHERE pipeline_stages.workspace_id = leads.workspace_id
                ORDER BY position ASC
                LIMIT 1
            )
            WHERE stage_id IS NULL
            AND EXISTS (
                SELECT 1 FROM pipeline_stages
                WHERE pipeline_stages.workspace_id = leads.workspace_id
            )
            """
        )
    )


def downgrade() -> None:
    # Non-reversible data backfill; nothing to undo.
    pass
