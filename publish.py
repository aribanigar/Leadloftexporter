#!/usr/bin/env python3
"""
publish.py

Seeds generated content (html_email, whatsapp, caption, sms, other)
into the `content_hub` table for the QckServe workspace.

ASSUMPTIONS (verify/adjust against your real schema in Claude Code):
  content_hub(
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid not null,
    type          text not null,   -- enum: html_email | whatsapp | caption | sms | other
    title         text,
    body          text not null,   -- raw content (html for html_email, plain text otherwise)
    metadata      jsonb default '{}',
    status        text default 'draft',  -- draft | review | published
    source        text default 'claude_routine',
    created_at    timestamptz default now(),
    updated_at    timestamptz default now()
  )

Usage:
  python publish.py --file ./output/items.json
  python publish.py --file ./output/items.json --status draft

items.json format (a list of items the routine produced):
[
  {
    "type": "html_email",
    "title": "QckServe - Free Vehicle Listings",
    "body": "<html>...</html>",
    "metadata": {"angle": "zero_commission", "audience": "car_sellers"}
  },
  {
    "type": "whatsapp",
    "title": "Car sellers - daily nudge",
    "body": "bhai ek cheez batao...",
    "metadata": {"angle": "urgency"}
  }
]
"""

import os
import sys
import json
import argparse
from datetime import datetime, timezone

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("Missing dependency. Run: pip install psycopg2-binary --break-system-packages")
    sys.exit(1)

VALID_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}

WORKSPACE_ID = os.environ.get("HUB_WORKSPACE")
DATABASE_URL = os.environ.get("DATABASE_URL")


def get_connection():
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL env var not set.")
        sys.exit(1)
    return psycopg2.connect(DATABASE_URL)


def validate_item(item: dict) -> list:
    errors = []
    if item.get("type") not in VALID_TYPES:
        errors.append(f"invalid type '{item.get('type')}' - must be one of {VALID_TYPES}")
    if not item.get("body"):
        errors.append("missing 'body'")
    return errors


def insert_item(cur, item: dict, status: str):
    cur.execute(
        """
        INSERT INTO content_hub
            (workspace_id, type, title, body, metadata, status, source, created_at, updated_at)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            WORKSPACE_ID,
            item["type"],
            item.get("title"),
            item["body"],
            json.dumps(item.get("metadata", {})),
            status,
            "claude_routine",
            datetime.now(timezone.utc),
            datetime.now(timezone.utc),
        ),
    )
    return cur.fetchone()[0]


def main():
    parser = argparse.ArgumentParser(description="Seed generated content into content_hub")
    parser.add_argument("--file", required=True, help="path to items.json produced by the routine")
    parser.add_argument("--status", default="draft", choices=["draft", "review", "published"])
    parser.add_argument("--dry-run", action="store_true", help="validate only, do not write to DB")
    args = parser.parse_args()

    if not WORKSPACE_ID:
        print("ERROR: HUB_WORKSPACE env var not set.")
        sys.exit(1)

    if not os.path.exists(args.file):
        print(f"ERROR: file not found: {args.file}")
        sys.exit(1)

    with open(args.file, "r", encoding="utf-8") as f:
        items = json.load(f)

    if not isinstance(items, list):
        print("ERROR: items.json must contain a JSON array of items.")
        sys.exit(1)

    print(f"Loaded {len(items)} item(s) from {args.file}")

    # Validate all items first - fail loud, fail early, don't half-write a batch
    all_errors = {}
    for idx, item in enumerate(items):
        errs = validate_item(item)
        if errs:
            all_errors[idx] = errs

    if all_errors:
        print("\nValidation failed for the following items:")
        for idx, errs in all_errors.items():
            print(f"  [{idx}] {items[idx].get('title', '(no title)')}")
            for e in errs:
                print(f"      - {e}")
        print("\nFix the above and re-run. Nothing was written.")
        sys.exit(1)

    if args.dry_run:
        print("\nDry run OK. All items valid. No DB writes performed.")
        for item in items:
            print(f"  - [{item['type']}] {item.get('title', '(no title)')}")
        return

    conn = get_connection()
    inserted_ids = []
    try:
        with conn:
            with conn.cursor() as cur:
                for item in items:
                    new_id = insert_item(cur, item, args.status)
                    inserted_ids.append(new_id)
                    print(f"  inserted [{item['type']}] {item.get('title', '(no title)')} -> {new_id}")
        print(f"\nDone. Inserted {len(inserted_ids)} item(s) with status='{args.status}'.")
    except Exception as e:
        conn.rollback()
        print(f"\nERROR during insert, transaction rolled back: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
