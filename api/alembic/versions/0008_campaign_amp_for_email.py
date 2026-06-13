"""AMP for Email + preview text + brand color on campaigns.

Adds three nullable columns to ``campaigns`` so the builder can persist:

- ``body_amp``      — AMP for Email (interactive Gmail). Delivered as the
  ``text/x-amp-html`` MIME alternative alongside ``body_html``; non-AMP
  clients fall through to ``body_html`` automatically.
- ``preview_text``  — inbox preheader (≤200 chars).
- ``brand_color``   — hex color used by the AI generator and (future) visual
  builder for hero + CTA accents.

No data movement; pure additive.

Revision ID: 0008_campaign_amp_for_email
Revises: 0007_campaign_marketing_fields
"""
from alembic import op
import sqlalchemy as sa


revision = "0008_campaign_amp_for_email"
down_revision = "0007_campaign_marketing_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("campaigns", sa.Column("body_amp", sa.Text(), nullable=True))
    op.add_column("campaigns", sa.Column("preview_text", sa.String(length=200), nullable=True))
    op.add_column("campaigns", sa.Column("brand_color", sa.String(length=20), nullable=True))


def downgrade() -> None:
    for col in ("brand_color", "preview_text", "body_amp"):
        op.drop_column("campaigns", col)
