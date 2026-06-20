#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the LeadLoft Content Hub (Neon Postgres).

Why HTTP and not psycopg2: Postgres port 5432 is blocked inside Claude Code /
sandbox containers, but Neon exposes a SQL-over-HTTPS endpoint on 443 that always
works through an egress proxy. This script therefore uses ONLY the Python stdlib
(urllib/json/uuid) — no `pip install`, nothing to break inside a routine run.

ENV (required):
  DATABASE_URL   postgresql://USER:PASS@HOST/DB?sslmode=require   (Neon)
  HUB_WORKSPACE  workspace uuid

USAGE:
  python publish.py --manifest content/qckserve/qckserve-2026-06-20.json
  python publish.py --manifest <file> --dry-run         # print, don't write
  python publish.py --manifest <file> --skip-existing    # skip dup titles
  python publish.py --inspect                            # list businesses + schema

MANIFEST (json):
  {
    "date": "2026-06-20",            # optional, defaults to today (UTC)
    "business": "qckserve",          # slug, defaults to qckserve
    "topic": "Sell your car free in Lucknow",
    "items": [
      { "channel": "html_email", "subject": "...", "content": "<html>...",
        "amp_content": null, "image_url": null, "platform": null,
        "tags": ["vehicles","promo"], "notes": null, "title": null },
      { "channel": "whatsapp",  "content": "..." , "tags": ["vehicles"] },
      { "channel": "caption",   "platform": "instagram", "content": "..." },
      { "channel": "sms",       "content": "..." },
      { "channel": "other",     "title": "... (Image Prompt)", "content": "<mj prompt>",
        "notes": "midjourney", "tags": ["image-prompt"] }
    ]
  }
channel == content_hub type. title auto-fills to "[date] topic (Channel)" when omitted.
"""

import argparse, json, os, sys, uuid, datetime
import urllib.request, urllib.error
from urllib.parse import urlparse

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {
    "html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
    "sms": "SMS", "other": "Other",
}


# ---------- Neon HTTP client (stdlib only) ----------
def _neon_host(database_url: str) -> str:
    host = urlparse(database_url).hostname
    if not host:
        sys.exit("ERROR: DATABASE_URL has no host")
    return host


def neon(sql: str, params=None, *, database_url: str, host: str):
    body = json.dumps({"query": sql, "params": params or []}).encode()
    req = urllib.request.Request(f"https://{host}/sql", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Neon-Connection-String", database_url)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: Neon HTTP {e.code}: {e.read().decode()[:500]}")
    except Exception as e:
        sys.exit(f"ERROR: Neon request failed: {e!r}")


# ---------- helpers ----------
def resolve_business(slug, *, workspace, **kw):
    out = neon(
        "select id, name, slug, brand_color from content_businesses "
        "where workspace_id=$1 and slug=$2 limit 1",
        [workspace, slug], **kw,
    )
    rows = out.get("rows", [])
    if not rows:
        sys.exit(f"ERROR: no business with slug '{slug}' in workspace {workspace}")
    return rows[0]


def title_exists(business_id, title, *, workspace, **kw):
    out = neon(
        "select 1 from content_assets where workspace_id=$1 and business_id=$2 and title=$3 limit 1",
        [workspace, business_id, title], **kw,
    )
    return bool(out.get("rows"))


def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    plat = item.get("platform")
    if item["channel"] == "caption" and plat:
        label = plat.capitalize()
    return f"[{date_str}] {topic} ({label})"


def insert_asset(row, *, workspace, **kw):
    out = neon(
        """
        insert into content_assets
          (id, workspace_id, business_id, title, type, content, amp_content,
           subject, platform, tags, notes, image_url)
        values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        returning id
        """,
        [
            row["id"], workspace, row["business_id"], row["title"], row["type"],
            row["content"], row.get("amp_content"), row.get("subject"),
            row.get("platform"), json.dumps(row.get("tags") or []),
            row.get("notes"), row.get("image_url"),
        ],
        workspace=workspace, **kw,
    )
    return out["rows"][0]["id"]


# ---------- commands ----------
def cmd_inspect(args, ctx):
    biz = neon(
        "select name, slug, brand_color from content_businesses where workspace_id=$1 order by name",
        [ctx["workspace"]], **ctx["db"],
    )
    print("Businesses in workspace:")
    for b in biz.get("rows", []):
        print(f"  - {b['slug']:<22} {b['name']:<24} {b['brand_color']}")
    cols = neon(
        "select column_name, udt_name, is_nullable from information_schema.columns "
        "where table_schema='public' and table_name='content_assets' order by ordinal_position",
        [], **ctx["db"],
    )
    print("\ncontent_assets columns:")
    for c in cols.get("rows", []):
        print(f"  {c['column_name']:<14} {c['udt_name']:<12} null={c['is_nullable']}")
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")


def cmd_publish(args, ctx):
    with open(args.manifest, encoding="utf-8") as f:
        man = json.load(f)

    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man.get("items") or []
    if not items:
        sys.exit("ERROR: manifest has no 'items'")

    biz = resolve_business(slug, workspace=ctx["workspace"], **ctx["db"])
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created, skipped = 0, 0
    for it in items:
        ch = (it.get("channel") or "").strip()
        if ch not in ALLOWED_TYPES:
            sys.exit(f"ERROR: item channel '{ch}' not in {sorted(ALLOWED_TYPES)}")
        if not it.get("content"):
            sys.exit(f"ERROR: item ({ch}) has empty 'content'")

        title = make_title(it, topic, date_str)

        if args.skip_existing and title_exists(
            biz["id"], title, workspace=ctx["workspace"], **ctx["db"]
        ):
            print(f"  ~ skip (exists): {title}")
            skipped += 1
            continue

        row = {
            "id": str(uuid.uuid4()),
            "business_id": biz["id"],
            "title": title,
            "type": ch,
            "content": it["content"],
            "amp_content": it.get("amp_content"),
            "subject": it.get("subject"),
            "platform": it.get("platform"),
            "tags": it.get("tags") or [],
            "notes": it.get("notes"),
            "image_url": it.get("image_url"),
        }

        if args.dry_run:
            preview = row["content"][:60].replace("\n", " ")
            print(f"  [dry] {ch:<10} {title}")
            print(f"        subject={row['subject']} platform={row['platform']} "
                  f"image={row['image_url']} tags={row['tags']}")
            print(f"        content: {preview}…")
        else:
            new_id = insert_asset(row, workspace=ctx["workspace"], **ctx["db"])
            print(f"  + {ch:<10} {title}  -> {new_id}")
        created += 1

    print(f"\nDone. {'would create' if args.dry_run else 'created'}={created} skipped={skipped}")
    if not args.dry_run:
        print(f"View: https://leadloftexporter.vercel.app/content-hub/{slug}")


def main():
    ap = argparse.ArgumentParser(description="Seed QckServe content into the Content Hub.")
    ap.add_argument("--manifest", help="path to manifest .json")
    ap.add_argument("--business", help="business slug (default from manifest or 'qckserve')")
    ap.add_argument("--dry-run", action="store_true", help="print, do not write")
    ap.add_argument("--skip-existing", action="store_true", help="skip rows whose title already exists")
    ap.add_argument("--inspect", action="store_true", help="list businesses + schema, then exit")
    args = ap.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    workspace = os.environ.get("HUB_WORKSPACE")
    if not database_url or not workspace:
        sys.exit("ERROR: set DATABASE_URL and HUB_WORKSPACE environment variables.")

    host = _neon_host(database_url)
    ctx = {"workspace": workspace, "db": {"database_url": database_url, "host": host}}

    if args.inspect:
        return cmd_inspect(args, ctx)
    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")
    return cmd_publish(args, ctx)


if __name__ == "__main__":
    main()
