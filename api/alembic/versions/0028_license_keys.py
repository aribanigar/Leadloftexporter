"""license keys — second activation credential for the Chrome extension

Revision ID: 0028_license_keys
Revises: 0027_campaign_attachments
Create Date: 2026-08-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0028_license_keys"
down_revision = "0027_campaign_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "license_keys",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(length=36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by_user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "assigned_user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("label", sa.String(length=120), nullable=True),
        sa.Column("key_prefix", sa.String(length=16), nullable=False),
        sa.Column("key_hash", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_license_keys_workspace_id", "license_keys", ["workspace_id"])
    op.create_index("ix_license_keys_assigned_user_id", "license_keys", ["assigned_user_id"])
    op.create_index("ix_license_keys_key_prefix", "license_keys", ["key_prefix"])


def downgrade() -> None:
    op.drop_index("ix_license_keys_key_prefix", table_name="license_keys")
    op.drop_index("ix_license_keys_assigned_user_id", table_name="license_keys")
    op.drop_index("ix_license_keys_workspace_id", table_name="license_keys")
    op.drop_table("license_keys")
