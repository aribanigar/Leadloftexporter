#!/usr/bin/env python3
"""
publish.py — Date Khaas content-hub publisher.

Pipeline:
  1. Read a content bundle (content.json) produced by the daily routine.
  2. Fetch Muslim-wedding images from the Pixabay API for items that ask for them.
  3. Write each item to disk under content-hub/date-khaas/<date>/ (for git history).
  4. Seed each item into the Supabase content-hub table.
  5. Optionally git add/commit/push.

It does NOT hardcode your schema. On connect it:
  - locates the enum type whose labels match {html_email, whatsapp, caption, sms, other},
  - finds the table+column that uses that enum (your content table),
  - reads that table's real columns,
  - inserts only into columns that exist, casting enum/jsonb columns correctly.

Run `python publish.py --probe` first to print the discovered mapping (no writes).

Env (put in .env or export):
  DATABASE_URL        Supabase session pooler connection string (required for DB write)
  HUB_WORKSPACE       workspace UUID (written to a workspace column if one exists)
  PIXABAY_API_KEY     free key from https://pixabay.com/api/docs/ (required for images)
  CONTENT_TABLE       (optional) override auto-discovery, e.g. "content_items"
  CONTENT_TYPE_COLUMN (optional) override, e.g. "type"
  CONTENT_SLUG        (optional) project/collection slug, default "date-khaas"
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import psycopg
    from psycopg.types.json import Jsonb
except ImportError:
    psycopg = None

try:
    import requests
except ImportError:
    requests = None

# ----------------------------------------------------------------------------- #
# config
# ----------------------------------------------------------------------------- #

TARGET_ENUM_LABELS = {"html_email", "whatsapp", "caption", "sms", "other"}
DEFAULT_SLUG = os.environ.get("CONTENT_SLUG", "date-khaas")
DEFAULT_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
ROOT = Path(__file__).resolve().parent
CONTENT_DIR = ROOT / "content-hub" / "date-khaas"

# canonical field -> candidate column names (first that exists in the table wins)
FIELD_ALIASES = {
    "workspace":  ["workspace_id", "workspace", "workspaceid", "hub_workspace", "org_id"],
    "slug":       ["slug", "project", "project_slug", "collection", "folder", "board", "category"],
    "title":      ["title", "name", "headline", "label"],
    "subject":    ["subject", "email_subject", "preview_subject"],
    "body":       ["body", "content", "html", "body_html", "content_html", "markdown", "text", "copy", "message"],
    "status":     ["status", "state", "stage"],
    "channel":    ["channel", "platform", "medium"],
    "image_url":  ["image_url", "image", "media_url", "cover_image", "hero_image", "thumbnail"],
    "metadata":   ["metadata", "meta", "data", "attributes", "props", "extra"],
    "created_at": ["created_at", "createdat", "inserted_at", "created"],
    "updated_at": ["updated_at", "updatedat", "modified_at", "updated"],
}

# ----------------------------------------------------------------------------- #
# .env loader (no dependency)
# ----------------------------------------------------------------------------- #

def load_dotenv(path=".env"):
    p = ROOT / path
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ----------------------------------------------------------------------------- #
# pixabay
# ----------------------------------------------------------------------------- #

def fetch_pixabay(query, count, out_dir):
    """Download up to `count` images for `query`. Returns list of dicts."""
    key = os.environ.get("PIXABAY_API_KEY")
    if not key:
        print("  ! PIXABAY_API_KEY not set — skipping image fetch", file=sys.stderr)
        return []
    if requests is None:
        print("  ! `requests` not installed — skipping image fetch", file=sys.stderr)
        return []

    out_dir.mkdir(parents=True, exist_ok=True)
    params = {
        "key": key,
        "q": query,
        "image_type": "photo",
        "orientation": "horizontal",
        "safesearch": "true",
        "order": "popular",
        "per_page": max(3, min(count * 3, 50)),
    }
    r = requests.get("https://pixabay.com/api/", params=params, timeout=30)
    r.raise_for_status()
    hits = r.json().get("hits", [])[:count]

    results = []
    for i, h in enumerate(hits):
        url = h.get("largeImageURL") or h.get("webformatURL")
        if not url:
            continue
        ext = os.path.splitext(url.split("?")[0])[1] or ".jpg"
        slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
        fname = f"{slug}-{h.get('id', i)}{ext}"
        fpath = out_dir / fname
        try:
            img = requests.get(url, timeout=60)
            img.raise_for_status()
            fpath.write_bytes(img.content)
        except Exception as e:  # noqa: BLE001
            print(f"  ! failed to download {url}: {e}", file=sys.stderr)
            continue
        results.append({
            "local_path": str(fpath.relative_to(ROOT)),
            "remote_url": h.get("largeImageURL"),
            "page_url": h.get("pageURL"),
            "author": h.get("user"),
            "pixabay_id": h.get("id"),
            "tags": h.get("tags"),
            "license": "Pixabay Content License (free commercial use, no attribution required)",
        })
    print(f"  ↳ pixabay '{query}': {len(results)} image(s)")
    return results


# ----------------------------------------------------------------------------- #
# schema discovery
# ----------------------------------------------------------------------------- #

def discover_schema(cur):
    """Return (table, type_col, columns, type_enum) where columns maps name -> info dict."""
    cur.execute("""
        SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        GROUP BY t.typname;
    """)
    enum_types = {row[0]: set(row[1]) for row in cur.fetchall()}

    type_enum = None
    for name, labels in enum_types.items():
        if TARGET_ENUM_LABELS & labels:
            if not type_enum or len(TARGET_ENUM_LABELS & labels) > \
               len(TARGET_ENUM_LABELS & enum_types[type_enum]):
                type_enum = name
    if not type_enum:
        raise SystemExit("Could not find a content-type enum (html_email/whatsapp/…). "
                         "Set CONTENT_TABLE and CONTENT_TYPE_COLUMN to override.")

    override_table = os.environ.get("CONTENT_TABLE")
    override_col = os.environ.get("CONTENT_TYPE_COLUMN")
    if override_table and override_col:
        table, type_col = override_table, override_col
    else:
        cur.execute("""
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND udt_name = %s
            ORDER BY table_name;
        """, (type_enum,))
        rows = cur.fetchall()
        if not rows:
            raise SystemExit(f"No table uses enum '{type_enum}'.")
        table, type_col = rows[0]

    cur.execute("""
        SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
               COALESCE(t.typtype = 'e', false) AS is_enum
        FROM information_schema.columns c
        LEFT JOIN pg_type t ON t.typname = c.udt_name
        WHERE c.table_schema = 'public' AND c.table_name = %s
        ORDER BY c.ordinal_position;
    """, (table,))
    columns = {}
    for name, dtype, udt, nullable, default, is_enum in cur.fetchall():
        columns[name] = {
            "data_type": dtype, "udt": udt, "nullable": nullable == "YES",
            "default": default, "is_enum": bool(is_enum),
            "is_json": udt in ("json", "jsonb"),
        }
    return table, type_col, columns, type_enum


def pick(columns, aliases):
    for a in aliases:
        if a in columns:
            return a
    return None


# ----------------------------------------------------------------------------- #
# insert builder
# ----------------------------------------------------------------------------- #

def build_insert(table, type_col, columns, item, slug, workspace, status):
    """Return (sql, params). Only touches columns that exist."""
    canon_value = {
        "workspace": workspace,
        "slug": slug,
        "title": item.get("title"),
        "subject": item.get("subject"),
        "body": item.get("body") or item.get("content") or "",
        "status": item.get("status", status),
        "channel": item.get("channel"),
        "image_url": (item.get("images") or [{}])[0].get("remote_url") if item.get("images") else None,
        "metadata": item.get("metadata") or {},
        "created_at": dt.datetime.now(dt.timezone.utc),
        "updated_at": dt.datetime.now(dt.timezone.utc),
    }
    md = dict(canon_value["metadata"])
    for k in ("subject", "preheader", "channel", "format", "images", "research_sources", "cta_url"):
        if item.get(k) is not None:
            md.setdefault(k, item.get(k))
    md.setdefault("generated_by", "datekhaas-daily-routine")
    canon_value["metadata"] = md

    cols, placeholders, params = [], [], []

    type_value = item["type"]
    type_info = columns.get(type_col, {})
    cols.append(quote_ident(type_col))
    placeholders.append(f'%s::"{type_info.get("udt", type_col)}"' if type_info.get("is_enum") else "%s")
    params.append(type_value)

    used = {type_col}
    for canon, aliases in FIELD_ALIASES.items():
        col = pick(columns, aliases)
        if not col or col in used:
            continue
        val = canon_value.get(canon)
        if val is None:
            continue
        info = columns[col]
        if info["is_json"]:
            placeholders.append("%s")
            params.append(Jsonb(val))
        elif info["is_enum"]:
            placeholders.append(f'%s::"{info["udt"]}"')
            params.append(val)
        else:
            placeholders.append("%s")
            params.append(val)
        cols.append(quote_ident(col))
        used.add(col)

    sql = (f'INSERT INTO {quote_ident(table)} ({", ".join(cols)}) '
           f'VALUES ({", ".join(placeholders)}) '
           f'RETURNING {quote_ident(pick(columns, ["id", "uuid", "pk"]) or cols[0].strip(chr(34)))}')
    return sql, params


def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'


# ----------------------------------------------------------------------------- #
# git
# ----------------------------------------------------------------------------- #

def git(*args, check=True):
    return subprocess.run(["git", *args], cwd=ROOT, check=check,
                          capture_output=True, text=True)


def git_commit(message):
    try:
        git("rev-parse", "--is-inside-work-tree")
    except subprocess.CalledProcessError:
        print("  ! not a git repo — skipping commit", file=sys.stderr)
        return None
    git("add", "content-hub/date-khaas")
    status = git("status", "--porcelain", "content-hub/date-khaas").stdout.strip()
    if not status:
        print("  ↳ git: nothing to commit")
        return None
    git("commit", "-m", message)
    sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"  ↳ git commit {sha}")
    try:
        git("push", "-u", "origin", git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip())
        print("  ↳ git push ok")
    except subprocess.CalledProcessError as e:
        print(f"  ! git push failed (commit is local): {e.stderr.strip()}", file=sys.stderr)
    return sha


# ----------------------------------------------------------------------------- #
# main
# ----------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Date Khaas content-hub publisher")
    ap.add_argument("--bundle", default="content.json", help="path to content bundle JSON")
    ap.add_argument("--probe", action="store_true", help="print discovered schema and exit")
    ap.add_argument("--dry-run", action="store_true", help="build + print SQL, do not write")
    ap.add_argument("--no-images", action="store_true", help="skip Pixabay fetch")
    ap.add_argument("--no-git", action="store_true", help="skip git commit")
    ap.add_argument("--images-per-item", type=int, default=3)
    ap.add_argument("--status", default="draft")
    ap.add_argument("--commit-message", default=None)
    args = ap.parse_args()

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    workspace = os.environ.get("HUB_WORKSPACE", DEFAULT_WORKSPACE)

    if psycopg is None:
        sys.exit("psycopg not installed. Run: pip install 'psycopg[binary]'")

    # ---- probe -------------------------------------------------------------- #
    if args.probe:
        if not dsn:
            sys.exit("DATABASE_URL not set")
        with psycopg.connect(dsn, connect_timeout=20, prepare_threshold=None) as conn, conn.cursor() as cur:
            table, type_col, columns, enum = discover_schema(cur)
        print(f"content table : {table}")
        print(f"type column   : {type_col}  (enum: {enum})")
        print("field mapping :")
        for canon, aliases in FIELD_ALIASES.items():
            print(f"  {canon:<11} -> {pick(columns, aliases)}")
        print("all columns   :")
        for name, info in columns.items():
            flags = ",".join(f for f, v in
                             [("enum", info["is_enum"]), ("json", info["is_json"])] if v)
            print(f"  {name:<22} {info['data_type']:<26} {flags}")
        return

    # ---- load bundle -------------------------------------------------------- #
    bundle_path = ROOT / args.bundle
    if not bundle_path.exists():
        sys.exit(f"bundle not found: {bundle_path}")
    bundle = json.loads(bundle_path.read_text())
    items = bundle["items"] if isinstance(bundle, dict) else bundle
    today = dt.date.today().isoformat()
    day_dir = CONTENT_DIR / today
    day_dir.mkdir(parents=True, exist_ok=True)

    # ---- images ------------------------------------------------------------- #
    if not args.no_images:
        img_dir = day_dir / "images"
        cache = {}
        for it in items:
            q = it.get("image_query")
            if not q:
                continue
            if q not in cache:
                cache[q] = fetch_pixabay(q, args.images_per_item, img_dir)
            it["images"] = cache[q]

    # ---- write files for git ------------------------------------------------ #
    for i, it in enumerate(items, 1):
        stem = f"{i:02d}-{it['type']}-{re.sub(r'[^a-z0-9]+','-', (it.get('title') or 'untitled').lower()).strip('-')}"
        (day_dir / f"{stem}.json").write_text(json.dumps(it, indent=2, ensure_ascii=False))
        if it.get("body"):
            ext = "html" if "html" in it["type"] or it.get("format") == "amp" else "txt"
            (day_dir / f"{stem}.{ext}").write_text(it["body"])
        if it.get("body_fallback"):
            (day_dir / f"{stem}-fallback.html").write_text(it["body_fallback"])
    print(f"  ↳ wrote {len(items)} item file(s) to {day_dir.relative_to(ROOT)}")

    # ---- DB ----------------------------------------------------------------- #
    inserted = []
    if not dsn:
        print("  ! DATABASE_URL not set — skipping DB seed", file=sys.stderr)
    else:
        with psycopg.connect(dsn, connect_timeout=20, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                table, type_col, columns, enum = discover_schema(cur)
                valid = {r for r in TARGET_ENUM_LABELS}
                for it in items:
                    if it["type"] not in TARGET_ENUM_LABELS:
                        print(f"  ! '{it['type']}' not in enum {sorted(valid)} — "
                              f"map it to one of those", file=sys.stderr)
                    sql, params = build_insert(table, type_col, columns, it,
                                               DEFAULT_SLUG, workspace, args.status)
                    if args.dry_run:
                        print("\nDRY RUN SQL:\n" + sql)
                        print("PARAMS:", [str(p)[:60] for p in params])
                        continue
                    cur.execute(sql, params)
                    rid = cur.fetchone()[0]
                    inserted.append(rid)
                    print(f"  ↳ inserted {it['type']:<11} id={rid}")
            if not args.dry_run:
                conn.commit()

    # ---- git ---------------------------------------------------------------- #
    if not args.no_git and not args.dry_run:
        msg = args.commit_message or f"content(date-khaas): daily drop {today} ({len(items)} items)"
        git_commit(msg)

    if inserted:
        print(f"\nDone. Seeded {len(inserted)} rows into the content hub.")


if __name__ == "__main__":
    main()
