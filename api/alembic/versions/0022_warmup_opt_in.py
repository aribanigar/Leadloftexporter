"""Warmup is opt-in — default OFF, reset existing rows.

Warmup used to default ON (enabled=True), which (once campaign sending was
re-coupled to it as an opt-in feature) would have re-capped every existing
sender at the ramp and blocked campaigns — the exact behaviour users did not
want. Flip it: warmup is now opt-in (default OFF), and we reset every existing
SenderWarmup row to disabled so campaigns keep sending freely. Users turn
warmup on per-inbox from Settings → Email Senders.

Revision ID: 0022_warmup_opt_in
Revises: 0021_password_reset
"""
from alembic import op
import sqlalchemy as sa


revision = "0022_warmup_opt_in"
down_revision = "0021_password_reset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # New rows default to disabled.
    op.alter_column(
        "sender_warmups", "enabled",
        server_default=sa.text("false"),
        existing_type=sa.Boolean(),
    )
    # Existing rows → opt out, so current senders keep sending freely.
    op.execute("UPDATE sender_warmups SET enabled = false")


def downgrade() -> None:
    op.alter_column(
        "sender_warmups", "enabled",
        server_default=sa.text("true"),
        existing_type=sa.Boolean(),
    )
