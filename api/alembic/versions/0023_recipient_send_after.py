"""Campaign recipients: per-recipient send_after for human-paced sending.

Campaigns stored seconds_between_sends but never enforced it — the tick burst
batch_size emails at once, which trips provider rate limits and looks robotic
(ban risk). This adds a scheduled send time per recipient so a launch drips at
the configured pace (with jitter), spread across inboxes — enabling human-like,
concurrent sending. NULL = send immediately (back-compat for old rows).

Revision ID: 0023_recipient_send_after
Revises: 0022_warmup_opt_in
"""
from alembic import op
import sqlalchemy as sa


revision = "0023_recipient_send_after"
down_revision = "0022_warmup_opt_in"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "campaign_recipients",
        sa.Column("send_after", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_campaign_recipients_due",
        "campaign_recipients",
        ["campaign_id", "status", "send_after"],
    )


def downgrade() -> None:
    op.drop_index("ix_campaign_recipients_due", table_name="campaign_recipients")
    op.drop_column("campaign_recipients", "send_after")
