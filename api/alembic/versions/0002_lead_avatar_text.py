"""widen lead.avatar_url to TEXT

LinkedIn's media CDN signs every profile-photo URL with a JWT in the query
string. The CDN rejects requests without a valid signature, so the URL must
be stored verbatim — and the signature commonly pushes the URL past the
old String(500) limit. Move to TEXT (unbounded) to fit.

Revision ID: 0002_lead_avatar_text
Revises: 0001_initial
Create Date: 2026-05-20
"""
from alembic import op
import sqlalchemy as sa


revision = "0002_lead_avatar_text"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "leads",
        "avatar_url",
        existing_type=sa.String(length=500),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "leads",
        "avatar_url",
        existing_type=sa.Text(),
        type_=sa.String(length=500),
        existing_nullable=True,
    )
