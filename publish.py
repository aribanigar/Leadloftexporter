"""
publish.py
----------
Publishes the CollabMarket recruitment email into content_assets via
Supabase's REST API (HTTPS, port 443 — psycopg2 / port 5432 is blocked
in remote execution environments).

Env:
    SUPABASE_URL          e.g. https://xyz.supabase.co
    SUPABASE_SERVICE_KEY  service-role JWT
    HUB_WORKSPACE         workspace UUID
    PIXABAY_API_KEY       for build_email
    HUB_BUSINESS_ID       optional override (defaults to workspace's known business)
"""

import os
import sys
import uuid
import json
import argparse
import requests

from build_email import build_email

VALID_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}

# Fallback business_id observed in this workspace's existing rows.
DEFAULT_BUSINESS_ID = "7ab57d94-9f43-40e4-b6a0-1ca6575ce24c"


def _headers():
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not key:
        sys.exit("ERROR: SUPABASE_SERVICE_KEY not set.")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _base():
    url = os.environ.get("SUPABASE_URL")
    if not url:
        sys.exit("ERROR: SUPABASE_URL not set.")
    return url.rstrip("/")


def inspect():
    """Print content_assets columns via the REST OpenAPI spec."""
    r = requests.get(f"{_base()}/rest/v1/", headers=_headers(), timeout=10)
    r.raise_for_status()
    spec = r.json()
    defn = spec.get("definitions", {}).get("content_assets", {})
    if not defn:
        print("content_assets not found in spec — available:", list(spec.get("definitions", {}).keys()))
        return
    print("=== content_assets columns ===")
    for col, info in defn.get("properties", {}).items():
        print(f"  {col}: {info}")


def publish(ctype, embed, dry_run):
    if ctype not in VALID_TYPES:
        sys.exit(f"ERROR: type must be one of {sorted(VALID_TYPES)}")

    workspace = os.environ.get("HUB_WORKSPACE")
    if not workspace:
        sys.exit("ERROR: HUB_WORKSPACE not set.")

    business_id = os.environ.get("HUB_BUSINESS_ID", DEFAULT_BUSINESS_ID)

    html = build_email(embed=embed)
    record = {
        "id":           str(uuid.uuid4()),
        "workspace_id": workspace,
        "business_id":  business_id,
        "type":         ctype,
        "title":        "[2026-06-22] CollabMarket | Creator Recruitment",
        "subject":      "Stop pitching brands in the DMs — let them book you",
        "content":      html,
        "platform":     "email",
        "tags":         [],
    }

    print(f"Prepared record: id={record['id']} type={ctype} "
          f"embed={embed} content={len(html):,} bytes")

    if dry_run:
        print("DRY RUN — not writing to DB.")
        with open("collabmarket_email.html", "w", encoding="utf-8") as f:
            f.write(html)
        print("Wrote local preview: collabmarket_email.html")
        return

    r = requests.post(
        f"{_base()}/rest/v1/content_assets",
        headers=_headers(),
        data=json.dumps(record),
        timeout=30,
    )
    if not r.ok:
        sys.exit(f"ERROR {r.status_code}: {r.text}")
    result = r.json()
    new_id = result[0]["id"] if isinstance(result, list) else result.get("id")
    print(f"Published. New row id = {new_id}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--inspect", action="store_true")
    p.add_argument("--publish", action="store_true")
    p.add_argument("--type",    default="html_email")
    p.add_argument("--embed",   action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if args.inspect:
        inspect()
    elif args.publish:
        publish(args.type, args.embed, args.dry_run)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
