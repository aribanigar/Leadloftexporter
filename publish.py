#!/usr/bin/env python3
"""
publish.py - seed Hudace content into the LeadLoft content hub (Neon Postgres).

Schema (discovered 2026-06-19):
  item table  : content_assets  (id, workspace_id, business_id, title, type, content,
                                  subject, platform, tags, notes, image_url, created_at, updated_at)
  folder table: content_businesses (id, workspace_id, name, slug, ...)
  id          : varchar NOT NULL (no default) — we generate UUID v4
  tags        : jsonb NOT NULL                — defaulted to []

Transport: Neon HTTP SQL API (port 443) — port 5432 is blocked in this environment.

USAGE
  python publish.py --discover
  python publish.py --folder hudace batch.json

ENV (required)
  DATABASE_URL   Neon Postgres URL (host extracted for HTTP API)
  HUB_WORKSPACE  workspace UUID
"""
import os, sys, json, argparse, uuid, re
import urllib.request, urllib.parse

# ── connection ────────────────────────────────────────────────────────────────
_DB_URL = os.environ.get("DATABASE_URL", "")
_WS     = os.environ.get("HUB_WORKSPACE", "")

def _host_from_url(url):
    m = re.search(r"@([^/]+)/", url)
    return m.group(1) if m else ""

def _creds_from_url(url):
    m = re.search(r"://([^:]+):([^@]+)@", url)
    if m:
        return m.group(1), m.group(2)
    return "", ""

_HOST = _host_from_url(_DB_URL)
_USER, _PASS = _creds_from_url(_DB_URL)

def sql(query, params=None):
    """Execute a single SQL statement via Neon HTTP API. Returns dict with rows/fields."""
    if not _HOST:
        raise SystemExit("DATABASE_URL not set or could not parse host.")
    if params:
        # Simple positional substitution — escape single quotes in values
        def _esc(v):
            if v is None:
                return "NULL"
            if isinstance(v, bool):
                return "TRUE" if v else "FALSE"
            if isinstance(v, (int, float)):
                return str(v)
            if isinstance(v, (dict, list)):
                return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'"
            return "'" + str(v).replace("'", "''") + "'"
        parts = query.split("%s")
        if len(parts) - 1 != len(params):
            raise ValueError(f"Parameter count mismatch: {len(params)} params for query with {len(parts)-1} placeholders")
        query = "".join(p + (_esc(v) if i < len(params) else "") for i, (p, v) in enumerate(zip(parts, params + [None])))
    url = f"https://{_HOST}/sql"
    db_path = re.search(r"/([^?]+)", _DB_URL.split("@", 1)[-1])
    db_name = db_path.group(1) if db_path else "neondb"
    conn_str = f"postgresql://{_USER}:{_PASS}@{_HOST}/{db_name}?sslmode=require"
    payload = json.dumps({"query": query}).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Neon-Connection-String": conn_str,
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def discover():
    res = sql("select table_name from information_schema.tables where table_schema='public' order by table_name")
    tables = [row["table_name"] for row in res["rows"]]
    print("TABLES:", tables)
    for t in ["content_assets", "content_businesses"]:
        if t in tables:
            r2 = sql(f"select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='{t}' order by ordinal_position")
            print(f"\n--- {t} ---")
            for row in r2["rows"]:
                print(f"  {row['column_name']} | {row['data_type']} | nullable={row['is_nullable']} | default={row['column_default']}")


def ensure_business(name):
    """Return the content_businesses.id for `name` in the workspace, creating it if absent."""
    slug = name.lower().replace(" ", "-")
    r = sql("select id from content_businesses where workspace_id=%s and slug=%s", [_WS, slug])
    if r["rows"]:
        return r["rows"][0]["id"]
    new_id = str(uuid.uuid4())
    sql(
        "insert into content_businesses (id, workspace_id, name, slug, brand_color) values (%s, %s, %s, %s, %s)",
        [new_id, _WS, name.title(), slug, "#1B90FF"]
    )
    print(f"  Created business '{name}' id={new_id}")
    return new_id


def publish(folder_name, items):
    business_id = ensure_business(folder_name)
    created = skipped = 0
    for item in items:
        title = item["title"]
        # Idempotency check
        r = sql("select 1 from content_assets where workspace_id=%s and business_id=%s and title=%s",
                [_WS, business_id, title])
        if r["rows"]:
            skipped += 1
            continue
        item_id = str(uuid.uuid4())
        body = item.get("body") or item.get("body_html") or ""
        itype = item.get("type", "email")
        image_url = item.get("image_url") or ""
        sql(
            "insert into content_assets (id, workspace_id, business_id, title, type, content, image_url, tags) values (%s, %s, %s, %s, %s, %s, %s, %s)",
            [item_id, _WS, business_id, title, itype, body, image_url, []]
        )
        created += 1
    print(f"OK  folder='{folder_name}' business_id={business_id} created={created} skipped={skipped}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--folder", default="hudace")
    ap.add_argument("batch", nargs="?", help="path to batch.json")
    a = ap.parse_args()
    if not _WS:
        sys.exit("HUB_WORKSPACE env var is required")
    if a.discover:
        discover()
    elif a.batch:
        with open(a.batch) as f:
            items = json.load(f)
        publish(a.folder, items)
    else:
        ap.print_help()
