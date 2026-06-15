"""search_scrapers: standing background LinkedIn-search scrapers per workspace.

Matches LeadLoft's "LinkedIn Scraper Settings" — paste a search URL,
set a daily save cap + total cap, leads are scraped over time.

Revision ID: 0003_search_scrapers
Revises: 0002_lead_avatar_text
Create Date: 2026-05-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB  # noqa: F401 (kept for parity)


revision = "0003_search_scrapers"
down_revision = "0002_lead_avatar_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "search_scrapers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(160)),
        sa.Column("search_url", sa.Text, nullable=False),
        sa.Column("daily_save_cap", sa.Integer, nullable=False, server_default="30"),
        sa.Column("total_save_cap", sa.Integer, nullable=False, server_default="1000"),
        sa.Column("saved_today", sa.Integer, nullable=False, server_default="0"),
        sa.Column("saved_total", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_run_at", sa.DateTime(timezone=True)),
        sa.Column("last_run_day", sa.String(10)),
        sa.Column(
            "playbook_id",
            sa.String(36),
            sa.ForeignKey("playbooks.id", ondelete="SET NULL"),
        ),
        sa.Column("segment_id", sa.String(36)),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_search_scrapers_workspace", "search_scrapers", ["workspace_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_search_scrapers_workspace", table_name="search_scrapers")
    op.drop_table("search_scrapers")
