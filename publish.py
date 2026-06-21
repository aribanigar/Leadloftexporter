"""
publish.py
----------
Publishes the CollabMarket recruitment email into the content hub (Supabase).

Credentials come from environment variables — never hardcode secrets.

    export SUPABASE_URL="https://cmdnezltteldysoxyjzh.supabase.co"
    export SUPABASE_SERVICE_KEY="sb_secret_..."
    export HUB_WORKSPACE="1a716353-9472-4c1d-ae89-f95052e8f015"
    export PIXABAY_API_KEY="..."

Workflow:
    1) Inspect the schema:  python publish.py --inspect
    2) Dry-run build:        python publish.py --publish --dry-run
    3) Publish for real:     python publish.py --publish

Content-hub type enum (from live DB): html_email | whatsapp | caption | sms | other
Platform values seen in DB:           email | whatsapp | linkedin | outreach
"""

import os
import sys
import argparse
import requests

from build_email import build_email

VALID_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}

# Confirmed from live schema inspection (2026-06-21)
TABLE        = "content_assets"
BUSINESS_ID  = "bb716234-9b5d-4a97-81d0-d501bd1b6a3d"   # "Collab Market" row in content_businesses


def _headers():
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not key:
        sys.exit("ERROR: SUPABASE_SERVICE_KEY not set in environment.")
    return {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
    }


def _base():
    url = os.environ.get("SUPABASE_URL")
    if not url:
        sys.exit("ERROR: SUPABASE_URL not set in environment.")
    return url.rstrip("/")


def inspect():
    """Print content-related tables and their columns via the REST OpenAPI spec."""
    spec = requests.get(f"{_base()}/rest/v1/", headers=_headers(), timeout=15).json()
    print("== All tables ==")
    for name in sorted(spec.get("definitions", {})):
        print(f"  {name}")

    print("\n== content_assets columns ==")
    defn = spec["definitions"].get("content_assets", {})
    for col, meta in defn.get("properties", {}).items():
        print(f"  {col:<28} {meta.get('type','?'):<12} {meta.get('format','')}")

    print("\n== content_businesses in workspace ==")
    ws = os.environ.get("HUB_WORKSPACE", "")
    rows = requests.get(
        f"{_base()}/rest/v1/content_businesses",
        headers=_headers(),
        params={"workspace_id": f"eq.{ws}", "select": "id,name,slug"},
        timeout=15,
    ).json()
    for r in rows:
        print(f"  {r['id']}  {r['name']}  ({r['slug']})")


def publish(ctype, embed, dry_run):
    if ctype not in VALID_TYPES:
        sys.exit(f"ERROR: type must be one of {sorted(VALID_TYPES)}")

    workspace = os.environ.get("HUB_WORKSPACE")
    if not workspace:
        sys.exit("ERROR: HUB_WORKSPACE not set in environment.")

    html = build_email(embed=embed)
    record = {
        "workspace_id": workspace,
        "business_id":  BUSINESS_ID,
        "type":         ctype,
        "platform":     "email",
        "title":        "Creator recruitment — get booked & paid",
        "subject":      "Stop pitching brands in the DMs — let them book you",
        "content":      html,
    }

    print(f"Prepared record: type={ctype} embed={embed} content={len(html):,} bytes")

    if dry_run:
        print("DRY RUN — not writing to DB.")
        with open("collabmarket_email.html", "w", encoding="utf-8") as f:
            f.write(html)
        print("Wrote local preview: collabmarket_email.html")
        return

    resp = requests.post(
        f"{_base()}/rest/v1/{TABLE}",
        headers=_headers(),
        json=record,
        timeout=30,
    )
    if not resp.ok:
        sys.exit(f"ERROR inserting row: {resp.status_code} {resp.text}")
    new_row = resp.json()
    new_id = new_row[0]["id"] if isinstance(new_row, list) else new_row.get("id")
    print(f"Published. New row id = {new_id}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--inspect",  action="store_true", help="Print schema and exit")
    p.add_argument("--publish",  action="store_true", help="Insert the email row")
    p.add_argument("--type",     default="html_email")
    p.add_argument("--embed",    action="store_true", help="Inline images as base64")
    p.add_argument("--dry-run",  action="store_true", help="Build but don't write")
    args = p.parse_args()

    if args.inspect:
        inspect()
    elif args.publish:
        publish(args.type, args.embed, args.dry_run)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
