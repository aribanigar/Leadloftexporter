"""company finder businesses (Google Maps scrape)

Revision ID: 0025_company_finder
Revises: 0024_content_asset_image
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0025_company_finder"
down_revision = "0024_content_asset_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "company_finder_businesses",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(400), nullable=False, server_default=""),
        sa.Column("phone", sa.String(60)),
        sa.Column("email", sa.String(400)),
        sa.Column("website", sa.String(600)),
        sa.Column("address", sa.Text()),
        sa.Column("category", sa.String(300)),
        sa.Column("latitude", sa.Float()),
        sa.Column("longitude", sa.Float()),
        sa.Column("place_id", sa.String(120)),
        sa.Column("cid", sa.String(120)),
        sa.Column("profile_url", sa.String(600)),
        sa.Column("country", sa.String(120)),
        sa.Column("area", sa.String(200)),
        sa.Column("zone", sa.String(200)),
        sa.Column("street", sa.String(300)),
        sa.Column("building", sa.String(300)),
        sa.Column("building_key", sa.String(120), index=True),
        sa.Column("socials", JSONB(), server_default="{}"),
        sa.Column("hours", JSONB(), server_default="{}"),
        sa.Column("rating", sa.String(20)),
        sa.Column("rating_count", sa.String(40)),
        sa.Column("source", sa.String(20), server_default="extension"),
        sa.Column("dedup_key", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_cfb_ws_category", "company_finder_businesses", ["workspace_id", "category"])
    op.create_index("ix_cfb_ws_country_area", "company_finder_businesses", ["workspace_id", "country", "area"])
    op.create_index("ix_cfb_ws_building", "company_finder_businesses", ["workspace_id", "building_key"])
    op.create_unique_constraint("uq_cfb_ws_dedup", "company_finder_businesses", ["workspace_id", "dedup_key"])


def downgrade() -> None:
    op.drop_table("company_finder_businesses")
