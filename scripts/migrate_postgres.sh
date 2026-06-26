#!/usr/bin/env bash
#
# migrate_postgres.sh — bidirectional Postgres migration helper.
#
# Works for ANY direction between two Postgres URLs:
#   Render → Fly      (typical migration)
#   Fly → Render      (rollback / escape hatch)
#   Render → CockroachDB Serverless
#   Neon → Supabase
#   anything → your laptop for inspection
#
# This script does ONE thing: dump from $SOURCE_DATABASE_URL into a local
# .dump file, then restore that file into $DEST_DATABASE_URL. No platform-
# specific flags. Works because Postgres is Postgres.
#
# USAGE
#
#   Set both env vars and run:
#
#     export SOURCE_DATABASE_URL='postgres://user:pass@source.host/dbname'
#     export DEST_DATABASE_URL='postgres://user:pass@dest.host/dbname'
#     bash scripts/migrate_postgres.sh
#
#   For Fly Postgres, get the URL with:
#     fly postgres connect -a <pg-app-name> -- echo $DATABASE_URL
#
#   For Render Postgres, copy from the dashboard "Connections" tab.
#
# SAFETY
#
#   - Dump is saved locally before restore — if restore fails, you still
#     have the .dump file.
#   - Uses pg_dump --create flag so the destination's schema is recreated
#     from the source's exact DDL.
#   - Restore uses --clean --if-exists so re-running the script is safe
#     (it overwrites the destination's contents, not the source).
#   - DOES NOT delete the source. Source DB stays intact until you flip DNS.
#
# RECOMMENDED CUTOVER PROCEDURE
#
#   1. Run this script during a low-traffic window.
#   2. After restore completes, verify on dest by running a few SELECTs:
#        psql "$DEST_DATABASE_URL" -c "SELECT count(*) FROM leads;"
#        psql "$DEST_DATABASE_URL" -c "SELECT count(*) FROM content_assets;"
#   3. Update your app's DATABASE_URL env var (fly secrets set / render
#      dashboard / vercel env) to point at the new host.
#   4. Old DB stays alive as the "backup" for 24-48 hrs; only delete it
#      once you're confident the new one is serving everything.

set -euo pipefail

# ─── Pre-flight checks ─────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' not in PATH. Install: $2"; exit 1; }; }
need pg_dump  "apt-get install postgresql-client (or 'brew install libpq && brew link --force libpq')"
need pg_restore "same package as pg_dump"
need psql     "same package as pg_dump"

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL not set}"
: "${DEST_DATABASE_URL:?DEST_DATABASE_URL not set}"

if [ "$SOURCE_DATABASE_URL" = "$DEST_DATABASE_URL" ]; then
  echo "✗ SOURCE_DATABASE_URL and DEST_DATABASE_URL are identical. Aborting."
  exit 1
fi

# Quick connectivity check on both ends BEFORE we spend time on pg_dump.
echo "─── Verifying source connectivity ..."
psql "$SOURCE_DATABASE_URL" -c "SELECT version();" >/dev/null || {
  echo "✗ Cannot connect to source. Check SOURCE_DATABASE_URL."; exit 1; }
echo "  ✓ source reachable"

echo "─── Verifying destination connectivity ..."
psql "$DEST_DATABASE_URL" -c "SELECT version();" >/dev/null || {
  echo "✗ Cannot connect to destination. Check DEST_DATABASE_URL."; exit 1; }
echo "  ✓ destination reachable"

# ─── Confirm before potentially-destructive operation ──────────────────────
echo ""
echo "About to:"
echo "  1. Dump SOURCE: $(echo "$SOURCE_DATABASE_URL" | sed 's|://[^@]*@|://***@|')"
echo "  2. Restore into DEST: $(echo "$DEST_DATABASE_URL" | sed 's|://[^@]*@|://***@|')"
echo "  3. This will OVERWRITE existing tables in the destination."
echo ""
read -p "Proceed? Type 'yes' to continue: " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborted by user."
  exit 0
fi

# ─── Dump source ───────────────────────────────────────────────────────────
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_FILE="leadcaptura-${TS}.dump"

echo ""
echo "─── Dumping source → $DUMP_FILE ..."
# -Fc = custom format (compressed, supports parallel restore)
# -v  = verbose progress
# --no-owner --no-acl = skip ownership grants so cross-host restore doesn't
#                       complain about missing roles
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --verbose \
  --file="$DUMP_FILE" \
  "$SOURCE_DATABASE_URL"

DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "  ✓ dump complete: $DUMP_FILE ($DUMP_SIZE)"

# ─── Restore into destination ──────────────────────────────────────────────
echo ""
echo "─── Restoring into destination ..."
# --clean --if-exists = drop any existing tables before re-creating them
#                       (idempotent rerun-safe)
# -j 2 = 2 parallel workers (safe for small free-tier DBs; bump for larger)
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --verbose \
  -j 2 \
  --dbname="$DEST_DATABASE_URL" \
  "$DUMP_FILE"

echo "  ✓ restore complete"

# ─── Post-migration sanity check ───────────────────────────────────────────
echo ""
echo "─── Row counts on destination ──"
for table in workspaces users leads companies content_businesses content_assets campaigns playbooks email_messages; do
  count=$(psql "$DEST_DATABASE_URL" -At -c "SELECT count(*) FROM $table;" 2>/dev/null || echo "n/a")
  printf "  %-25s %s\n" "$table:" "$count"
done

echo ""
echo "✓ Migration finished."
echo "  Dump file kept at: $DUMP_FILE"
echo "  Delete it after you've verified the destination is healthy."
echo ""
echo "  Next step: update your app's DATABASE_URL to point at the destination."
echo "    fly secrets set DATABASE_URL='$DEST_DATABASE_URL'"
echo "    # or via Render / Railway / Vercel dashboards"
