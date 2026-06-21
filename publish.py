"""
publish.py
----------
Publishes the CollabMarket recruitment email into the content hub (Supabase/Postgres).

SECURITY: credentials are read from environment variables, never hardcoded.
Before running for real, ROTATE any password that has been shared in plaintext.

    export DATABASE_URL="postgresql://...:5432/postgres"
    export HUB_WORKSPACE="1a716353-9472-4c1d-ae89-f95052e8f015"
    export PIXABAY_API_KEY="..."

Workflow:
    1) Inspect the schema first (don't guess column names):
        python publish.py --inspect
    2) When the columns match what the INSERT expects, publish:
        python publish.py --publish --slug collab-market --type html_email
       Add --embed to inline images as base64 (heavier; Gmail may clip >102KB).

Content-hub type enum: html_email | whatsapp | caption | sms | other
"""

import os
import sys
import argparse
import psycopg2
from psycopg2.extras import RealDictCursor

from build_email import build_email

VALID_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}

# Candidate table names — the inspector will tell us which actually exists.
CANDIDATE_TABLES = ["content_hub", "content_hub_items", "contents", "hub_content", "content"]


def _conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("ERROR: DATABASE_URL not set in environment.")
    return psycopg2.connect(url)


def inspect():
    """Print tables that look like a content hub and their columns + enum values."""
    with _conn() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        print("== Tables containing 'content' or 'hub' ==")
        cur.execute("""
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog','information_schema')
              AND (table_name ILIKE '%content%' OR table_name ILIKE '%hub%')
            ORDER BY table_schema, table_name;
        """)
        rows = cur.fetchall()
        for r in rows:
            print(f"  {r['table_schema']}.{r['table_name']}")
        if not rows:
            print("  (none found — run a broader \\dt in psql)")

        print("\n== Columns for each candidate ==")
        for r in rows:
            cur.execute("""
                SELECT column_name, data_type, udt_name, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema=%s AND table_name=%s
                ORDER BY ordinal_position;
            """, (r['table_schema'], r['table_name']))
            cols = cur.fetchall()
            print(f"\n  -- {r['table_schema']}.{r['table_name']} --")
            for c in cols:
                print(f"     {c['column_name']:<22} {c['data_type']:<18} "
                      f"udt={c['udt_name']:<16} null={c['is_nullable']:<3} "
                      f"default={c['column_default']}")

        print("\n== Enum types defined in DB ==")
        cur.execute("""
            SELECT t.typname, string_agg(e.enumlabel, ' | ' ORDER BY e.enumsortorder) AS values
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid = t.oid
            GROUP BY t.typname ORDER BY t.typname;
        """)
        for e in cur.fetchall():
            print(f"  {e['typname']}: {e['values']}")

    print("\nNext: confirm the real table + column names, then edit INSERT_SQL "
          "in publish.py if they differ from the defaults, and run --publish.")


# --- Adjust these to match what --inspect reveals, if needed -----------------
TABLE = os.environ.get("HUB_TABLE", "content_hub")
INSERT_SQL = f"""
    INSERT INTO {TABLE}
        (workspace_id, slug, type, title, subject, body, status, created_at, updated_at)
    VALUES
        (%(workspace_id)s, %(slug)s, %(type)s, %(title)s, %(subject)s, %(body)s,
         %(status)s, now(), now())
    RETURNING id;
"""
# -----------------------------------------------------------------------------


def publish(slug, ctype, embed, status, dry_run):
    if ctype not in VALID_TYPES:
        sys.exit(f"ERROR: type must be one of {sorted(VALID_TYPES)}")

    workspace = os.environ.get("HUB_WORKSPACE")
    if not workspace:
        sys.exit("ERROR: HUB_WORKSPACE not set in environment.")

    html = build_email(embed=embed)
    record = {
        "workspace_id": workspace,
        "slug": slug,
        "type": ctype,
        "title": "Creator recruitment — get booked & paid",
        "subject": "Stop pitching brands in the DMs — let them book you",
        "body": html,
        "status": status,
    }

    print(f"Prepared record: slug={slug} type={ctype} "
          f"embed={embed} body={len(html):,} bytes status={status}")

    if dry_run:
        print("DRY RUN — not writing to DB. Remove --dry-run to insert.")
        with open("collabmarket_email.html", "w", encoding="utf-8") as f:
            f.write(html)
        print("Wrote local preview: collabmarket_email.html")
        return

    with _conn() as conn, conn.cursor() as cur:
        cur.execute(INSERT_SQL, record)
        new_id = cur.fetchone()[0]
        conn.commit()
        print(f"Published. New row id = {new_id}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--inspect", action="store_true", help="Print schema and exit")
    p.add_argument("--publish", action="store_true", help="Insert the email row")
    p.add_argument("--slug", default="collab-market")
    p.add_argument("--type", default="html_email")
    p.add_argument("--status", default="draft")
    p.add_argument("--embed", action="store_true", help="Inline images as base64")
    p.add_argument("--dry-run", action="store_true", help="Build but don't write")
    args = p.parse_args()

    if args.inspect:
        inspect()
    elif args.publish:
        publish(args.slug, args.type, args.embed, args.status, args.dry_run)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
