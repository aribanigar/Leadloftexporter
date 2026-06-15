"""WhatsApp messages captured from the Baileys sidecar.

Adds ``whatsapp_messages`` — one row per 1:1 WhatsApp message (inbound reply
or our own outbound send) pushed by the sidecar webhook and matched to a
Lead by phone, so the conversation surfaces in the Lead Detail timeline.

``(workspace_id, provider_message_id)`` is unique so reconnect history
replays are idempotent.

Revision ID: 0014_whatsapp_messages
Revises: 0013_invitee_reminders
"""
from alembic import op
import sqlalchemy as sa


revision = "0014_whatsapp_messages"
down_revision = "0013_invitee_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "whatsapp_messages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("lead_id", sa.String(length=36), nullable=True),
        sa.Column("direction", sa.String(length=10), nullable=False, server_default="inbound"),
        sa.Column("phone", sa.String(length=40), nullable=False),
        sa.Column("contact_name", sa.String(length=200), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("msg_type", sa.String(length=40), nullable=False, server_default="text"),
        sa.Column("provider_message_id", sa.String(length=128), nullable=True),
        sa.Column("provider_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["lead_id"], ["leads.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "provider_message_id", name="uq_wa_msg_provider"),
    )
    op.create_index("ix_whatsapp_messages_workspace_id", "whatsapp_messages", ["workspace_id"])
    op.create_index("ix_whatsapp_messages_lead_id", "whatsapp_messages", ["lead_id"])
    op.create_index("ix_whatsapp_messages_phone", "whatsapp_messages", ["phone"])
    op.create_index("ix_whatsapp_messages_provider_message_id", "whatsapp_messages", ["provider_message_id"])
    op.create_index("ix_wa_msg_lead_created", "whatsapp_messages", ["lead_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_wa_msg_lead_created", table_name="whatsapp_messages")
    op.drop_index("ix_whatsapp_messages_provider_message_id", table_name="whatsapp_messages")
    op.drop_index("ix_whatsapp_messages_phone", table_name="whatsapp_messages")
    op.drop_index("ix_whatsapp_messages_lead_id", table_name="whatsapp_messages")
    op.drop_index("ix_whatsapp_messages_workspace_id", table_name="whatsapp_messages")
    op.drop_table("whatsapp_messages")
