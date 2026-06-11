"""email_marketing: campaigns, recipients, sender warmup, suppressions.

Adds the schema for the bulk email-marketing surface:
  - campaigns: one row per broadcast (subject, body, sender pool,
    throttle/warmup config, lifecycle status)
  - campaign_recipients: one row per (campaign × lead) — the unit of
    progress the send-tick loop advances
  - sender_warmups: per-ConnectedAccount daily-cap ramp (day 1 = 20,
    doubles every 3 days, capped at daily_cap_ceiling) so connected
    SMTPs don't get flagged for sudden volume
  - suppressions: workspace-scoped unique-email list of addresses we
    must never send to (hard bounces, unsubs, complaints, manual)

Revision ID: 0006_email_marketing
Revises: 0005_backfill_stage_ids
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0006_email_marketing"
down_revision = "0005_backfill_stage_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── campaigns ───────────────────────────────────────────────────────────
    op.create_table(
        "campaigns",
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
        sa.Column("name", sa.String(240), nullable=False),
        sa.Column("subject", sa.String(500), server_default=""),
        sa.Column("preheader", sa.String(500), nullable=True),
        sa.Column("body_html", sa.Text(), server_default=""),
        sa.Column("body_text", sa.Text(), nullable=True),
        sa.Column(
            "recipient_filter",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "sender_account_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("rotation_index", sa.Integer(), server_default="0"),
        sa.Column("batch_size", sa.Integer(), server_default="8"),
        sa.Column("seconds_between_sends", sa.Integer(), server_default="30"),
        sa.Column(
            "warmup_enabled", sa.Boolean(), server_default=sa.text("true")
        ),
        sa.Column("status", sa.String(20), server_default="draft"),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_tick_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("total_recipients", sa.Integer(), server_default="0"),
        sa.Column("sent_count", sa.Integer(), server_default="0"),
        sa.Column("failed_count", sa.Integer(), server_default="0"),
        sa.Column("skipped_count", sa.Integer(), server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index(
        "ix_campaigns_workspace_id", "campaigns", ["workspace_id"]
    )
    op.create_index(
        "ix_campaigns_user_id", "campaigns", ["user_id"]
    )
    op.create_index(
        "ix_campaigns_workspace_status",
        "campaigns",
        ["workspace_id", "status"],
    )

    # ── campaign_recipients ─────────────────────────────────────────────────
    op.create_table(
        "campaign_recipients",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "campaign_id",
            sa.String(36),
            sa.ForeignKey("campaigns.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "lead_id",
            sa.String(36),
            sa.ForeignKey("leads.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column(
            "sender_account_id",
            sa.String(36),
            sa.ForeignKey("connected_accounts.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "message_id",
            sa.String(36),
            sa.ForeignKey("email_messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("campaign_id", "lead_id", name="uq_camp_recip_lead"),
    )
    op.create_index(
        "ix_campaign_recipients_campaign_id",
        "campaign_recipients",
        ["campaign_id"],
    )
    op.create_index(
        "ix_campaign_recipients_lead_id",
        "campaign_recipients",
        ["lead_id"],
    )
    op.create_index(
        "ix_campaign_recipients_campaign_status",
        "campaign_recipients",
        ["campaign_id", "status"],
    )

    # ── sender_warmups ──────────────────────────────────────────────────────
    op.create_table(
        "sender_warmups",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "connected_account_id",
            sa.String(36),
            sa.ForeignKey("connected_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true")),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("ramp_days", sa.Integer(), server_default="30"),
        sa.Column("daily_cap_ceiling", sa.Integer(), server_default="2000"),
        sa.Column("sent_today", sa.Integer(), server_default="0"),
        sa.Column("day_anchor", sa.String(10), nullable=True),
        sa.Column("total_sent", sa.Integer(), server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "connected_account_id", name="uq_sender_warmup_account"
        ),
    )
    op.create_index(
        "ix_sender_warmups_workspace_id",
        "sender_warmups",
        ["workspace_id"],
    )
    op.create_index(
        "ix_sender_warmups_connected_account_id",
        "sender_warmups",
        ["connected_account_id"],
    )

    # ── suppressions ────────────────────────────────────────────────────────
    op.create_table(
        "suppressions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("reason", sa.String(40), server_default="manual"),
        sa.Column(
            "source_campaign_id",
            sa.String(36),
            sa.ForeignKey("campaigns.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint(
            "workspace_id", "email", name="uq_suppression_email"
        ),
    )
    op.create_index(
        "ix_suppressions_workspace_id", "suppressions", ["workspace_id"]
    )
    op.create_index(
        "ix_suppressions_workspace_email",
        "suppressions",
        ["workspace_id", "email"],
    )


def downgrade() -> None:
    op.drop_table("suppressions")
    op.drop_table("sender_warmups")
    op.drop_table("campaign_recipients")
    op.drop_table("campaigns")
