"""Round-robin / team scheduling.

Adds ``event_types.assignment`` (single | round_robin) and ``host_ids`` (the
candidate hosts a booking can be assigned to).

Revision ID: 0016_round_robin
Revises: 0015_routing_forms
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0016_round_robin"
down_revision = "0015_routing_forms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("event_types", sa.Column("assignment", sa.String(length=20), nullable=False, server_default="single"))
    op.add_column("event_types", sa.Column("host_ids", JSONB(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("event_types", "host_ids")
    op.drop_column("event_types", "assignment")
