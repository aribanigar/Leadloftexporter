"""license keys — allow unclaimed (pre-signup invite) keys

Revision ID: 0029_license_key_invite
Revises: 0028_license_keys
Create Date: 2026-08-20

Makes license_keys.workspace_id nullable (widening, safe — every existing
row already has it set) and adds invite_email, so a key can be generated
BEFORE the person it's for has an account, then get bound to their
workspace/user at registration. See models/base.py:LicenseKey and
auth.py:register.
"""
import sqlalchemy as sa
from alembic import op

revision = "0029_license_key_invite"
down_revision = "0028_license_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("license_keys", "workspace_id", existing_type=sa.String(length=36), nullable=True)
    op.add_column("license_keys", sa.Column("invite_email", sa.String(length=255), nullable=True))
    op.create_index("ix_license_keys_invite_email", "license_keys", ["invite_email"])


def downgrade() -> None:
    op.drop_index("ix_license_keys_invite_email", table_name="license_keys")
    op.drop_column("license_keys", "invite_email")
    op.alter_column("license_keys", "workspace_id", existing_type=sa.String(length=36), nullable=False)
