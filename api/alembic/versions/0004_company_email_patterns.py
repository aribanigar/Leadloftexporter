"""company_email_patterns: global cache of verified email patterns per domain.

Once a domain has been confirmed to use first.last@ (or any other format),
every future lead at that domain reuses the cached pattern instead of
re-probing via SMTP. Mirrors LeadLoft's per-company pattern memory.

Revision ID: 0004_company_email_patterns
Revises: 0003_search_scrapers
Create Date: 2026-05-20
"""
from alembic import op
import sqlalchemy as sa


revision = "0004_company_email_patterns"
down_revision = "0003_search_scrapers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "company_email_patterns",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("domain", sa.String(200), nullable=False),
        sa.Column("pattern", sa.String(60), nullable=False),
        sa.Column("verified_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("last_verified_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("domain", "pattern", name="uq_domain_pattern"),
    )
    op.create_index(
        "ix_company_email_patterns_domain", "company_email_patterns", ["domain"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_company_email_patterns_domain", table_name="company_email_patterns"
    )
    op.drop_table("company_email_patterns")
