#!/usr/bin/env python3
"""
publish.py — Date Khaas content-hub publisher.

Pipeline:
  1. Read a content bundle (content.json) produced by the daily routine.
  2. Fetch Muslim-wedding images from the Pixabay API for items that ask for them.
  3. Write each item to disk under content-hub/date-khaas/<date>/ (for git history).
  4. Seed each item into the Supabase content-hub (via psycopg or REST API).
  5. Optionally git add/commit/push.

It does NOT hardcode your schema. On connect it:
  - locates the enum type whose labels match {html_email, whatsapp, caption, sms, other},
  - finds the table+column that uses that enum (your content table),
  - reads that table's real columns,
  - inserts only into columns that exist, casting enum/jsonb columns correctly.

Run `python publish.py --probe` first to print the discovered mapping (no writes).

Env (put in .env or export):
  DATABASE_URL        Postgres connection string (for direct psycopg path)
  SUPABASE_URL        Supabase project URL (https://xxx.supabase.co)
  SUPABASE_SERVICE_KEY  Supabase service_role JWT (for REST API path)
  HUB_WORKSPACE       workspace UUID
  PIXABAY_API_KEY     free key from https://pixabay.com/api/docs/
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
import uuid
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
# .env loader
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
        except Exception as e:
            print(f"  ! failed to download {url}: {e}", file=sys.stderr)
            continue
        results.append({
            "local_path": str(fpath.relative_to(ROOT)),
            "remote_url": h.get("largeImageURL"),
            "page_url": h.get("pageURL"),
            "author": h.get("user"),
            "pixabay_id": h.get("id"),
            "tags": h.get("tags"),
            "has_faces": bool(h.get("type") == "photo"),
            "license": "Pixabay Content License (free commercial use, no attribution required)",
        })
    print(f"  ↳ pixabay '{query}': {len(results)} image(s)")
    return results


# ----------------------------------------------------------------------------- #
# schema discovery — psycopg path
# ----------------------------------------------------------------------------- #

def discover_schema(cur):
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


# ----------------------------------------------------------------------------- #
# schema discovery — Supabase REST path
# ----------------------------------------------------------------------------- #

def _rest_headers(service_key):
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def discover_schema_rest(supabase_url, service_key):
    """Return (table, type_col, col_names_set) by fetching a sample row from the table."""
    if requests is None:
        raise SystemExit("`requests` not installed.")

    override_table = os.environ.get("CONTENT_TABLE", "content_assets")
    override_col = os.environ.get("CONTENT_TYPE_COLUMN", "type")

    # Discover columns by fetching one row (more reliable than OpenAPI GET params)
    h = _rest_headers(service_key)
    r = requests.get(f"{supabase_url}/rest/v1/{override_table}?limit=1", headers=h, timeout=15)
    if r.ok and r.json():
        col_names = set(r.json()[0].keys())
    else:
        # Fallback: known content_assets columns
        col_names = {"id", "workspace_id", "business_id", "title", "type", "content",
                     "amp_content", "subject", "platform", "tags", "notes", "image_url",
                     "created_at", "updated_at"}
        print(f"  ! Could not fetch sample row from '{override_table}'; using fallback column set.",
              file=sys.stderr)

    return override_table, override_col, col_names


def insert_via_rest(items, table, type_col, workspace, slug, status, supabase_url, service_key, dry_run=False):
    """Insert content items via Supabase PostgREST REST API.

    Schema-aware: discovers actual column names from the table before inserting,
    so it handles content_assets (content/platform/amp_content) correctly.
    """
    if requests is None:
        print("  ! `requests` not installed — skipping DB seed", file=sys.stderr)
        return []

    h = _rest_headers(service_key)
    url = f"{supabase_url}/rest/v1/{table}"
    business_id = os.environ.get("CONTENT_BUSINESS_ID")

    # Discover actual column names
    _, _, col_names = discover_schema_rest(supabase_url, service_key)
    print(f"  ↳ table '{table}': {len(col_names)} columns discovered")

    inserted = []
    for it in items:
        payload = {}

        # Supply id if column exists but has no DB default
        if "id" in col_names:
            payload["id"] = str(uuid.uuid4())

        # Workspace + business
        if "workspace_id" in col_names:
            payload["workspace_id"] = workspace
        if "business_id" in col_names and business_id:
            payload["business_id"] = business_id

        # Type
        if type_col in col_names:
            payload[type_col] = it["type"]

        # Title
        for col in ("title", "name", "headline"):
            if col in col_names:
                payload[col] = it.get("title")
                break

        # Body — prefer 'content', then 'body', then 'html'
        if "content" in col_names:
            if it.get("format") == "amp" and it.get("body_fallback"):
                # AMP email: content = plain-HTML fallback; amp_content = AMP body
                payload["content"] = it["body_fallback"]
                if "amp_content" in col_names:
                    payload["amp_content"] = it.get("body") or ""
            else:
                payload["content"] = it.get("body") or it.get("content") or ""
        elif "body" in col_names:
            payload["body"] = it.get("body") or ""
        elif "html" in col_names:
            payload["html"] = it.get("body") or ""

        # Subject
        for col in ("subject", "email_subject", "preview_subject"):
            if col in col_names:
                payload[col] = it.get("subject")
                break

        # Channel / platform
        for col in ("platform", "channel", "medium"):
            if col in col_names:
                payload[col] = it.get("channel")
                break

        # Tags
        if "tags" in col_names:
            payload["tags"] = [slug]

        # Image
        if "image_url" in col_names and it.get("images"):
            payload["image_url"] = it["images"][0].get("remote_url")

        # Status
        if "status" in col_names:
            payload["status"] = status

        # Slug
        if "slug" in col_names:
            payload["slug"] = slug

        # Metadata / notes — consolidate extras for audit trail
        md = dict(it.get("metadata") or {})
        for k in ("subject", "preheader", "channel", "format", "images", "research_sources", "cta_url"):
            if it.get(k) is not None:
                md.setdefault(k, it[k])
        md.setdefault("generated_by", "datekhaas-daily-routine")

        if "metadata" in col_names:
            payload["metadata"] = md
        elif "notes" in col_names:
            payload["notes"] = json.dumps(md, ensure_ascii=False)

        # Strip None values
        payload = {k: v for k, v in payload.items() if v is not None}

        if dry_run:
            print(f"\nDRY RUN REST payload ({it['type']}):")
            print(json.dumps(
                {k: (v[:100] if isinstance(v, str) else v) for k, v in payload.items()},
                indent=2, ensure_ascii=False
            ))
            continue

        r = requests.post(url, json=payload, headers=h, timeout=30)
        if not r.ok:
            print(f"  ! REST insert failed {r.status_code}: {r.text[:400]}", file=sys.stderr)
            continue

        result = r.json()
        if isinstance(result, list) and result:
            row = result[0]
        elif isinstance(result, dict):
            row = result
        else:
            row = {}
        rid = row.get("id") or row.get("uuid") or row.get("pk") or "?"
        inserted.append(str(rid))
        print(f"  ↳ inserted {it['type']:<11} id={rid}")

    return inserted


# ----------------------------------------------------------------------------- #
# insert builder — psycopg path
# ----------------------------------------------------------------------------- #

def pick(columns, aliases):
    for a in aliases:
        if a in columns:
            return a
    return None


def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'


def build_insert(table, type_col, columns, item, slug, workspace, status):
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

    id_col = pick(columns, ["id", "uuid", "pk"]) or cols[0].strip('"')
    sql = (f'INSERT INTO {quote_ident(table)} ({", ".join(cols)}) '
           f'VALUES ({", ".join(placeholders)}) '
           f'RETURNING {quote_ident(id_col)}')
    return sql, params


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
    ap.add_argument("--dry-run", action="store_true", help="build + print SQL/payload, do not write")
    ap.add_argument("--no-images", action="store_true", help="skip Pixabay fetch")
    ap.add_argument("--no-git", action="store_true", help="skip git commit")
    ap.add_argument("--images-per-item", type=int, default=3)
    ap.add_argument("--status", default="draft")
    ap.add_argument("--commit-message", default=None)
    args = ap.parse_args()

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY")
    workspace = os.environ.get("HUB_WORKSPACE", DEFAULT_WORKSPACE)

    # Prefer REST API when Supabase credentials are available (avoids direct TCP which
    # may be blocked by the container's network policy). Set FORCE_PSYCOPG=true to override.
    use_rest = bool(supabase_url and service_key and not os.environ.get("FORCE_PSYCOPG"))

    # ---- probe -------------------------------------------------------------- #
    if args.probe:
        if use_rest:
            print("path          : Supabase REST API")
            table, type_col, col_names = discover_schema_rest(supabase_url, service_key)
            print(f"content table : {table}")
            print(f"type column   : {type_col}")
            print(f"business_id   : {os.environ.get('CONTENT_BUSINESS_ID', 'not set')}")
            print("discovered columns:")
            for name in sorted(col_names):
                print(f"  {name}")
        elif dsn:
            if psycopg is None:
                sys.exit("psycopg not installed. Run: pip install 'psycopg[binary]'")
            with psycopg.connect(dsn, connect_timeout=20, prepare_threshold=None) as conn, conn.cursor() as cur:
                table, type_col, columns, enum = discover_schema(cur)
            print(f"path          : psycopg (DATABASE_URL)")
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
        else:
            sys.exit("No DATABASE_URL or SUPABASE_URL+SUPABASE_SERVICE_KEY set.")
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
        stem = (f"{i:02d}-{it['type']}-"
                f"{re.sub(r'[^a-z0-9]+', '-', (it.get('title') or 'untitled').lower()).strip('-')}")
        (day_dir / f"{stem}.json").write_text(json.dumps(it, indent=2, ensure_ascii=False))
        if it.get("body"):
            ext = "html" if "html" in it["type"] or it.get("format") == "amp" else "txt"
            (day_dir / f"{stem}.{ext}").write_text(it["body"])
        if it.get("body_fallback"):
            (day_dir / f"{stem}-fallback.html").write_text(it["body_fallback"])
    print(f"  ↳ wrote {len(items)} item file(s) to {day_dir.relative_to(ROOT)}")

    # ---- DB ----------------------------------------------------------------- #
    inserted = []
    if use_rest:
        table, type_col, _ = discover_schema_rest(supabase_url, service_key)
        inserted = insert_via_rest(items, table, type_col, workspace, DEFAULT_SLUG,
                                   args.status, supabase_url, service_key, dry_run=args.dry_run)
    elif dsn:
        if psycopg is None:
            sys.exit("psycopg not installed. Run: pip install 'psycopg[binary]'")
        with psycopg.connect(dsn, connect_timeout=20, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                table, type_col, columns, enum = discover_schema(cur)
                for it in items:
                    if it["type"] not in TARGET_ENUM_LABELS:
                        print(f"  ! '{it['type']}' not in enum {sorted(TARGET_ENUM_LABELS)}", file=sys.stderr)
                    sql, params = build_insert(table, type_col, columns, it,
                                               DEFAULT_SLUG, workspace, args.status)
                    if args.dry_run:
                        print("\nDRY RUN SQL:\n" + sql)
                        print("PARAMS:", [str(p)[:60] for p in params])
                        continue
                    cur.execute(sql, params)
                    rid = cur.fetchone()[0]
                    inserted.append(str(rid))
                    print(f"  ↳ inserted {it['type']:<11} id={rid}")
            if not args.dry_run:
                conn.commit()
    else:
        print("  ! No DATABASE_URL or SUPABASE_URL+SUPABASE_SERVICE_KEY — skipping DB seed", file=sys.stderr)

    # ---- git ---------------------------------------------------------------- #
    if not args.no_git and not args.dry_run:
        msg = args.commit_message or f"content(date-khaas): daily drop {today} ({len(items)} items)"
        sha = git_commit(msg)
    else:
        sha = None

    if inserted:
        print(f"\nDone. Seeded {len(inserted)} rows into the content hub.")
    if sha:
        print(f"Git SHA: {sha}")


if __name__ == "__main__":
    main()
