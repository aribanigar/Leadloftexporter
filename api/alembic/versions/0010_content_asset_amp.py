"""Content Hub assets: optional AMP-for-Email body.

Adds ``amp_content`` to ``content_assets``. When a ``html_email`` asset
has an AMP body, the SMTP bridge attaches it as the ``text/x-amp-html``
MIME alternative — Gmail renders it, every other client falls through to
the plain HTML body in ``content``.

Pure additive; nullable.

Revision ID: 0010_content_asset_amp
Revises: 0009_content_hub
"""
from alembic import op
import sqlalchemy as sa


revision = "0010_content_asset_amp"
down_revision = "0009_content_hub"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "content_assets",
        sa.Column("amp_content", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("content_assets", "amp_content")
