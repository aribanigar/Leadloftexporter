"""add image_url to content_assets

Lets a Content Hub asset (esp. WhatsApp) carry a product photo that rides along
as the WhatsApp media caption when sent.

Revision ID: 0024_content_asset_image
Revises: 0023_recipient_send_after
"""
from alembic import op
import sqlalchemy as sa

revision = "0024_content_asset_image"
down_revision = "0023_recipient_send_after"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("content_assets", sa.Column("image_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("content_assets", "image_url")
