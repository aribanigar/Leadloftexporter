"""initial schema — autogen via metadata.create_all

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-19
"""
from alembic import op

from app.core.db import Base
import app.models  # noqa: F401

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
