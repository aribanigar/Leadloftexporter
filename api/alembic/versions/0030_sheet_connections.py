"""google sheets connections for campaigns + template usage tracking

Revision ID: 0030_sheet_connections
Revises: 0029_license_key_invite

Adds sheet_connections + sheet_tabs (Campaigns' "import from a connected
Google Sheet, write last-emailed date back" feature — see
services/google_sheets.py, api/v1/sheets.py), campaigns.template_id (which
saved Template a campaign was started from — powers
GET /templates/last-used?domain=), and campaign_recipients.sheet_synced_at
(marks a row's outcome as already written back to its source sheet, so the
sync_sheet_tracking Celery task never double-writes).
"""
from alembic import op
import sqlalchemy as sa

revision = "0030_sheet_connections"
down_revision = "0029_license_key_invite"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sheet_connections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("label", sa.String(240), nullable=False),
        sa.Column("sheet_url", sa.Text(), nullable=False),
        sa.Column("spreadsheet_id", sa.String(120), nullable=False, index=True),
        sa.Column("status", sa.String(20), server_default="active"),
        sa.Column("last_error", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "sheet_tabs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("connection_id", sa.String(36), sa.ForeignKey("sheet_connections.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("gid", sa.String(40), nullable=False),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("header_row", sa.Integer(), server_default="1"),
        sa.Column("email_column", sa.String(120), server_default="email"),
        sa.Column("tracking_column", sa.String(120), server_default="Last Contacted"),
        sa.Column("row_count", sa.Integer(), server_default="0"),
        sa.Column("last_synced_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_unique_constraint("uq_sheet_tab_connection_gid", "sheet_tabs", ["connection_id", "gid"])

    op.add_column(
        "campaigns",
        sa.Column("template_id", sa.String(36), sa.ForeignKey("templates.id", ondelete="SET NULL")),
    )
    op.add_column(
        "campaign_recipients",
        sa.Column("sheet_synced_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_column("campaign_recipients", "sheet_synced_at")
    op.drop_column("campaigns", "template_id")
    op.drop_constraint("uq_sheet_tab_connection_gid", "sheet_tabs", type_="unique")
    op.drop_table("sheet_tabs")
    op.drop_table("sheet_connections")
