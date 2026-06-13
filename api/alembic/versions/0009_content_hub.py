"""Content Hub — businesses (folders) + content assets.

Adds two tables:

- ``content_businesses`` — a Google-Drive-style folder per business/client.
  Carries a slug (unique per workspace) and light brand attributes
  (brand_color / accent_color / tone / logo_url) so the same folder can
  later supply on-brand defaults to the AI campaign writer.
- ``content_assets`` — reusable marketing assets living inside a business:
  HTML emails, WhatsApp messages, captions, SMS, or "other". Each carries
  optional subject (email), platform (caption), JSON tags, and notes.

Pure additive.

Revision ID: 0009_content_hub
Revises: 0008_campaign_amp_for_email
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0009_content_hub"
down_revision = "0008_campaign_amp_for_email"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "content_businesses",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(length=36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=140), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("brand_color", sa.String(length=20), nullable=False, server_default="#00361a"),
        sa.Column("accent_color", sa.String(length=20), nullable=True),
        sa.Column("tone", sa.String(length=40), nullable=True),
        sa.Column("logo_url", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("workspace_id", "slug", name="uq_content_biz_slug"),
    )
    op.create_index("ix_content_biz_workspace", "content_businesses", ["workspace_id"])

    op.create_table(
        "content_assets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(length=36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "business_id",
            sa.String(length=36),
            sa.ForeignKey("content_businesses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False, server_default="html_email"),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("subject", sa.String(length=300), nullable=True),
        sa.Column("platform", sa.String(length=40), nullable=True),
        sa.Column("tags", JSONB(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_content_asset_biz_type", "content_assets", ["business_id", "type"])
    op.create_index("ix_content_asset_workspace", "content_assets", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_content_asset_workspace", table_name="content_assets")
    op.drop_index("ix_content_asset_biz_type", table_name="content_assets")
    op.drop_table("content_assets")
    op.drop_index("ix_content_biz_workspace", table_name="content_businesses")
    op.drop_table("content_businesses")
