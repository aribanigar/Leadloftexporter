#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

Two write paths, auto-selected:

  * PostgREST over HTTPS  — used when SUPABASE_SERVICE_KEY is set. This is the
    ROUTINE path: Anthropic's cloud sandbox blocks Postgres ports (5432/6543),
    so the only write channel to Supabase is PostgREST, which authenticates with
    the service_role key. Stdlib only — nothing to pip install.

  * Direct DB (psycopg2) — fallback for local runs where 5432 is open and no
    service key is provided. Auto-installs psycopg2-binary if missing.

The Supabase project URL and the `qckserve` business_id are derived/resolved at
runtime (from DATABASE_URL / SUPABASE_URL and by slug), so nothing is hard-coded.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  SUPABASE_URL          https://<ref>.supabase.co   (optional; derived from DATABASE_URL)
  SUPABASE_SERVICE_KEY  service_role / sb_secret_ key  -> selects the REST path
  HUB_WORKSPACE         workspace uuid

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-06-28.json
  python publish.py --manifest <file> --dry-run         # print, no network
  python publish.py --manifest <file> --skip-existing    # skip dup titles

MANIFEST (json)
  { "date":"2026-06-28","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re

DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- url derivation -----------------------------
def derive_supabase_url(database_url, explicit):
    if explicit:
        return explicit.rstrip("/")
    # postgresql://postgres.<ref>:...@aws-...pooler.supabase.com:5432/postgres
    m = re.search(r"postgres\.([a-z0-9]+)[:@]", database_url or "")
    if m:
        return f"https://{m.group(1)}.supabase.co"
    return None


# ----------------------------- REST path (routine) -----------------------------
def _rest(url, key, method="GET", path="", params=None, body=None):
    import urllib.request, urllib.parse, urllib.error
    full = f"{url}/rest/v1/{path}"
    if params:
        full += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(full, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    if method == "POST":
        req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"ERROR: PostgREST {method} {path} -> HTTP {e.code}\n       {detail}")
    except Exception as e:
        sys.exit(f"ERROR: PostgREST request failed: {e!r}")


class RestBackend:
    mode = "rest"

    def __init__(self, url, key, workspace):
        self.url, self.key, self.workspace = url, key, workspace

    def resolve_business(self, slug):
        rows = _rest(self.url, self.key, path="content_businesses", params={
            "workspace_id": f"eq.{self.workspace}", "slug": f"eq.{slug}",
            "select": "id,name,slug,brand_color", "limit": "1"})
        if not rows:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {self.workspace}.")
        r = rows[0]
        return {"id": r["id"], "name": r["name"], "slug": r["slug"], "brand_color": r["brand_color"]}

    def title_exists(self, business_id, title):
        rows = _rest(self.url, self.key, path="content_assets", params={
            "workspace_id": f"eq.{self.workspace}", "business_id": f"eq.{business_id}",
            "title": f"eq.{title}", "select": "id", "limit": "1"})
        return bool(rows)

    def insert_asset(self, row):
        out = _rest(self.url, self.key, method="POST", path="content_assets", body={
            "id": row["id"], "workspace_id": row["workspace_id"], "business_id": row["business_id"],
            "title": row["title"], "type": row["type"], "content": row["content"],
            "amp_content": row.get("amp_content"), "subject": row.get("subject"),
            "platform": row.get("platform"), "tags": row.get("tags") or [],
            "notes": row.get("notes"), "image_url": row.get("image_url")})
        return out[0]["id"] if out else row["id"]

    def list_businesses(self):
        rows = _rest(self.url, self.key, path="content_businesses", params={
            "workspace_id": f"eq.{self.workspace}", "select": "name,slug,brand_color", "order": "name"})
        return [(r["name"], r["slug"], r["brand_color"]) for r in rows]

    def close(self):
        pass


# ----------------------------- direct DB path (local) -----------------------------
def _psycopg2():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("psycopg2 not found — installing psycopg2-binary…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                        "--break-system-packages", "psycopg2-binary"], check=False)
    import psycopg2
    return psycopg2


class PgBackend:
    mode = "direct-db"

    def __init__(self, database_url, workspace):
        psycopg2 = _psycopg2()
        try:
            self.conn = psycopg2.connect(database_url, connect_timeout=15)
        except Exception as e:
            sys.exit("ERROR: could not connect to the database.\n"
                     "       Run this where port 5432 is open, or set SUPABASE_SERVICE_KEY "
                     "to use the PostgREST/HTTPS path (required in the cloud routine sandbox).\n"
                     f"       detail: {e!r}")
        self.workspace = workspace

    def resolve_business(self, slug):
        cur = self.conn.cursor()
        cur.execute("select id,name,slug,brand_color from content_businesses "
                    "where workspace_id=%s and slug=%s limit 1", (self.workspace, slug))
        r = cur.fetchone(); cur.close()
        if not r:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {self.workspace}.")
        return {"id": r[0], "name": r[1], "slug": r[2], "brand_color": r[3]}

    def title_exists(self, business_id, title):
        cur = self.conn.cursor()
        cur.execute("select 1 from content_assets where workspace_id=%s and business_id=%s "
                    "and title=%s limit 1", (self.workspace, business_id, title))
        r = cur.fetchone(); cur.close(); return bool(r)

    def insert_asset(self, row):
        cur = self.conn.cursor()
        cur.execute(
            "insert into content_assets "
            "(id,workspace_id,business_id,title,type,content,amp_content,subject,platform,tags,notes,image_url) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) returning id",
            (row["id"], row["workspace_id"], row["business_id"], row["title"], row["type"],
             row["content"], row.get("amp_content"), row.get("subject"), row.get("platform"),
             json.dumps(row.get("tags") or []), row.get("notes"), row.get("image_url")))
        new_id = cur.fetchone()[0]; self.conn.commit(); cur.close(); return new_id

    def list_businesses(self):
        cur = self.conn.cursor()
        cur.execute("select name,slug,brand_color from content_businesses "
                    "where workspace_id=%s order by name", (self.workspace,))
        rows = cur.fetchall(); cur.close(); return rows

    def close(self):
        self.conn.close()


def make_backend(database_url, supabase_url, service_key, workspace):
    if service_key:
        url = derive_supabase_url(database_url, supabase_url)
        if not url:
            sys.exit("ERROR: SUPABASE_SERVICE_KEY set but could not derive SUPABASE_URL "
                     "(set SUPABASE_URL or a valid DATABASE_URL).")
        return RestBackend(url, service_key, workspace)
    return PgBackend(database_url, workspace)


# ----------------------------- shared -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def cmd_inspect(backend, workspace):
    print(f"Connected ({backend.mode}). Workspace {workspace}\n\nBusinesses:")
    for name, slug, color in backend.list_businesses():
        print(f"  - {slug:<22} {name:<24} {color}")
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")
    backend.close()


def cmd_publish(backend, workspace, args):
    with open(args.manifest, encoding="utf-8") as f:
        man = json.load(f)
    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man.get("items") or []
    if not items:
        sys.exit("ERROR: manifest has no 'items'.")

    for it in items:  # validate before touching the network
        ch = (it.get("channel") or "").strip()
        if ch not in ALLOWED_TYPES:
            sys.exit(f"ERROR: channel '{ch}' not in {sorted(ALLOWED_TYPES)}.")
        if not it.get("content"):
            sys.exit(f"ERROR: item ({ch}) has empty 'content'.")

    if args.dry_run:
        print(f"[dry] business={slug}  date={date_str}  topic={topic}  items={len(items)}")
        for it in items:
            print(f"  [dry] {it['channel']:<10} {make_title(it, topic, date_str)}")
        print(f"\n[dry] would create={len(items)} (no network touched)")
        return

    print(f"Mode: {backend.mode}")
    biz = backend.resolve_business(slug)
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and backend.title_exists(biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        new_id = backend.insert_asset(row)
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

    backend.close()
    print(f"\nDone. created={created} skipped={skipped}")
    print(f"View: https://leadloftexporter.vercel.app/content-hub/{slug}")


def main():
    ap = argparse.ArgumentParser(description="Seed QckServe content into the Content Hub.")
    ap.add_argument("--manifest", help="path to manifest .json")
    ap.add_argument("--business", help="business slug (default from manifest or 'qckserve')")
    ap.add_argument("--dry-run", action="store_true", help="print, no network")
    ap.add_argument("--skip-existing", action="store_true", help="skip rows whose title already exists")
    ap.add_argument("--inspect", action="store_true", help="list businesses, then exit")
    args = ap.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY")
    workspace = os.environ.get("HUB_WORKSPACE", DEFAULT_HUB_WORKSPACE)

    if args.dry_run and not args.inspect:
        # dry-run needs no backend / network
        return cmd_publish(None, workspace, args)

    backend = make_backend(database_url, supabase_url, service_key, workspace)

    if args.inspect:
        return cmd_inspect(backend, workspace)
    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")
    return cmd_publish(backend, workspace, args)


if __name__ == "__main__":
    main()
