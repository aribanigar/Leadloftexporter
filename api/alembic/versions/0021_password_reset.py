"""Password reset — token columns on users.

Adds two columns so a user can request a reset link and use it:
  * password_reset_token_hash — SHA-256 of the token (raw token only ever
    leaves the server inside the email link; we store the hash).
  * password_reset_expires_at — UTC expiry; old tokens are rejected.

A single index on the hash supports the lookup on /auth/reset-password.

Revision ID: 0021_password_reset
Revises: 0020_reminder_escalation
"""
from alembic import op
import sqlalchemy as sa


revision = "0021_password_reset"
down_revision = "0020_reminder_escalation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_reset_token_hash", sa.String(length=128), nullable=True))
    op.add_column("users", sa.Column("password_reset_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_users_reset_hash", "users", ["password_reset_token_hash"])


def downgrade() -> None:
    op.drop_index("ix_users_reset_hash", table_name="users")
    op.drop_column("users", "password_reset_expires_at")
    op.drop_column("users", "password_reset_token_hash")
