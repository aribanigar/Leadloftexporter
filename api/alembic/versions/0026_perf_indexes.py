"""performance indexes on hot, fast-growing tables

Adds the indexes that back the hot read paths which were degrading as data
accumulated ("CRM slow after data is saved"):

- email_messages is the fastest-growing table but only had (workspace_id) and
  (provider_message_id) indexed. The lead timeline, dashboard stats, inbox
  thread grouping, bulk-send dedup and status counts all filter/order/group by
  columns that were unindexed, so each was a sequential scan of the workspace's
  entire email history.
- call_logs.lead_id was unindexed → the timeline's call sub-query scanned every
  call log in the workspace.
- leads had no (workspace_id, created_at) index to support the default
  ORDER BY created_at DESC of the Pipeline/Prospecting list.

All statements use CREATE INDEX IF NOT EXISTS so the migration is idempotent and
safe to re-run. Kept as plain (non-CONCURRENT) creates so they run inside
Alembic's transaction; the tables are small enough that the brief lock on boot
is negligible, and this avoids the CONCURRENTLY-outside-transaction complication.

Revision ID: 0026_perf_indexes
Revises: 0025_company_finder
"""
from alembic import op

revision = "0026_perf_indexes"
down_revision = "0025_company_finder"
branch_labels = None
depends_on = None


# (name, raw CREATE INDEX body) — kept as raw SQL so the functional
# lower(from_address) index is expressible alongside the plain composites.
_INDEXES = [
    ("ix_email_ws_lead",
     "CREATE INDEX IF NOT EXISTS ix_email_ws_lead ON email_messages (workspace_id, lead_id)"),
    ("ix_email_ws_dir_created",
     "CREATE INDEX IF NOT EXISTS ix_email_ws_dir_created ON email_messages (workspace_id, direction, created_at)"),
    ("ix_email_ws_status",
     "CREATE INDEX IF NOT EXISTS ix_email_ws_status ON email_messages (workspace_id, status)"),
    ("ix_email_thread",
     "CREATE INDEX IF NOT EXISTS ix_email_thread ON email_messages (thread_id)"),
    ("ix_email_from_lower",
     "CREATE INDEX IF NOT EXISTS ix_email_from_lower ON email_messages (lower(from_address))"),
    ("ix_call_logs_lead_id",
     "CREATE INDEX IF NOT EXISTS ix_call_logs_lead_id ON call_logs (lead_id)"),
    ("ix_leads_workspace_created",
     "CREATE INDEX IF NOT EXISTS ix_leads_workspace_created ON leads (workspace_id, created_at)"),
]


def upgrade() -> None:
    for _name, ddl in _INDEXES:
        op.execute(ddl)


def downgrade() -> None:
    for name, _ddl in _INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
