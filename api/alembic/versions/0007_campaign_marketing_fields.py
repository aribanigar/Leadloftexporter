"""Rich email-marketing fields: sender identity, merge/personalisation,
follow-ups, click-tracking links, and per-recipient engagement tracking.

Extends the campaign module so the visual builder can drive arbitrary-email
sends (not just CRM leads), open/click tracking pixels, merge tags, and
deliverability stats.

Revision ID: 0007_campaign_marketing_fields
Revises: 0006_email_marketing
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0007_campaign_marketing_fields"
down_revision = "0006_email_marketing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── campaigns ──────────────────────────────────────────────────────────
    op.add_column("campaigns", sa.Column("from_name", sa.String(length=240), nullable=True))
    op.add_column("campaigns", sa.Column("from_email", sa.String(length=320), nullable=True))
    op.add_column("campaigns", sa.Column("reply_to", sa.String(length=320), nullable=True))
    op.add_column("campaigns", sa.Column("goal", sa.String(length=40), nullable=True))
    op.add_column("campaigns", sa.Column("tags", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaigns", sa.Column("follow_ups", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaigns", sa.Column("merge_columns", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaigns", sa.Column("recipient_data", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaigns", sa.Column("recipient_sources", JSONB(), nullable=False, server_default="{}"))
    op.add_column("campaigns", sa.Column("links", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaigns", sa.Column("opened_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("campaigns", sa.Column("clicked_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("campaigns", sa.Column("bounced_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("campaigns", sa.Column("unsubscribed_count", sa.Integer(), nullable=False, server_default="0"))

    # ── campaign_recipients ────────────────────────────────────────────────
    # lead_id becomes nullable so campaigns can target pasted/CSV emails.
    op.alter_column("campaign_recipients", "lead_id", existing_type=sa.String(length=36), nullable=True)
    op.add_column("campaign_recipients", sa.Column("name", sa.String(length=240), nullable=True))
    op.add_column("campaign_recipients", sa.Column("merge_data", JSONB(), nullable=False, server_default="{}"))
    op.add_column("campaign_recipients", sa.Column("open_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("campaign_recipients", sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("campaign_recipients", sa.Column("click_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("campaign_recipients", sa.Column("clicked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("campaign_recipients", sa.Column("clicked_links", JSONB(), nullable=False, server_default="[]"))
    op.add_column("campaign_recipients", sa.Column("bounce_reason", sa.Text(), nullable=True))
    op.add_column("campaign_recipients", sa.Column("bounced_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for col in (
        "bounced_at", "bounce_reason", "clicked_links", "clicked_at",
        "click_count", "opened_at", "open_count", "merge_data", "name",
    ):
        op.drop_column("campaign_recipients", col)
    op.alter_column("campaign_recipients", "lead_id", existing_type=sa.String(length=36), nullable=False)

    for col in (
        "unsubscribed_count", "bounced_count", "clicked_count", "opened_count",
        "links", "recipient_sources", "recipient_data", "merge_columns",
        "follow_ups", "tags", "goal", "reply_to", "from_email", "from_name",
    ):
        op.drop_column("campaigns", col)
