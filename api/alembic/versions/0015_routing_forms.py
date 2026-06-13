"""Routing forms.

A qualifying form whose answers route a prospect to an event type or an
external URL.

Revision ID: 0015_routing_forms
Revises: 0014_workflows
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0015_routing_forms"
down_revision = "0014_workflows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "routing_forms",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("slug", sa.String(length=160), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("fields", JSONB(), nullable=False, server_default="[]"),
        sa.Column("rules", JSONB(), nullable=False, server_default="[]"),
        sa.Column("default_action", JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("workspace_id", "slug", name="uq_routing_form_slug"),
    )
    op.create_index("ix_routing_forms_workspace_id", "routing_forms", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_routing_forms_workspace_id", table_name="routing_forms")
    op.drop_table("routing_forms")
