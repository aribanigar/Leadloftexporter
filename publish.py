#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

Two write paths, auto-selected:

  * PostgREST over HTTPS  — used when SUPABASE_SERVICE_KEY is set. This is the
    ROUTINE path: Anthropic's cloud sandbox blocks Postgres ports (5432/6543),
    so the only reachable write surface is Supabase's PostgREST API, which
    authenticates with the service_role key. Stdlib only — nothing to install.

  * Direct psycopg2       — used when no service key is set (local runs where
    port 5432 is open). Auto-installs psycopg2-binary if missing.

The Supabase project URL is derived from DATABASE_URL (or SUPABASE_URL if set),
and the qckserve business_id is resolved by slug, so nothing is hard-coded.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  SUPABASE_URL          https://<ref>.supabase.co        (optional; derived from DATABASE_URL)
  SUPABASE_SERVICE_KEY  service_role secret key          (enables the HTTPS path)
  HUB_WORKSPACE         workspace uuid

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-07-09.json
  python publish.py --manifest <file> --dry-run          # print, no network
  python publish.py --manifest <file> --skip-existing    # skip dup titles

MANIFEST (json)
  { "date":"2026-07-09","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re
import urllib.request, urllib.parse, urllib.error

# --- baked-in defaults so it runs with zero env setup (override via env / secrets) ---
DEFAULT_DATABASE_URL = ("postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz"
                        "@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres")
DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
# SECURITY: these are live write creds. Prefer setting DATABASE_URL/HUB_WORKSPACE/
# SUPABASE_SERVICE_KEY as env vars/secrets and rotating them in Supabase.

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- url helpers -----------------------------
def project_url_from_db(database_url):
    """Derive https://<ref>.supabase.co from a Supabase pooler DATABASE_URL."""
    if os.environ.get("SUPABASE_URL"):
        return os.environ["SUPABASE_URL"].rstrip("/")
    # user looks like postgres.<ref> ; ref is the project reference
    m = re.search(r"postgres\.([a-z0-9]+)[:@]", database_url)
    if not m:
        sys.exit("ERROR: could not derive project ref from DATABASE_URL; set SUPABASE_URL.")
    return f"https://{m.group(1)}.supabase.co"


# ----------------------------- REST (HTTPS) path -----------------------------
class Rest:
    def __init__(self, base, key):
        self.base = base.rstrip("/") + "/rest/v1"
        self.key = key

    def _req(self, method, path, params=None, body=None, prefer=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params, safe="=.,*()")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8")
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            sys.exit(f"ERROR: PostgREST {method} {path} -> HTTP {e.code}\n       {detail}")
        except urllib.error.URLError as e:
            sys.exit(f"ERROR: could not reach PostgREST at {self.base}\n       detail: {e!r}")

    def get(self, path, params=None):
        return self._req("GET", path, params=params)

    def insert(self, path, row):
        return self._req("POST", path, body=row, prefer="return=representation")


def rest_resolve_business(rest, workspace, slug):
    rows = rest.get("/content_businesses", {
        "workspace_id": f"eq.{workspace}", "slug": f"eq.{slug}",
        "select": "id,name,slug,brand_color", "limit": "1"})
    if not rows:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
    r = rows[0]
    return {"id": r["id"], "name": r["name"], "slug": r["slug"], "brand_color": r.get("brand_color")}


def rest_title_exists(rest, workspace, business_id, title):
    rows = rest.get("/content_assets", {
        "workspace_id": f"eq.{workspace}", "business_id": f"eq.{business_id}",
        "title": f"eq.{title}", "select": "id", "limit": "1"})
    return bool(rows)


def rest_insert_asset(rest, row):
    out = rest.insert("/content_assets", row)
    return (out[0]["id"] if out else row["id"])


def rest_list_businesses(rest, workspace):
    rows = rest.get("/content_businesses", {
        "workspace_id": f"eq.{workspace}", "select": "name,slug,brand_color", "order": "name"})
    return [(r["name"], r["slug"], r.get("brand_color")) for r in rows]


# ----------------------------- direct DB path -----------------------------
def _psycopg2():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("psycopg2 not found — installing psycopg2-binary…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                        "--break-system-packages", "psycopg2-binary"], check=False)
    import psycopg2
    return psycopg2


def connect(database_url):
    psycopg2 = _psycopg2()
    try:
        return psycopg2.connect(database_url, connect_timeout=15)
    except Exception as e:
        sys.exit("ERROR: could not connect to the database.\n"
                 "       Run this where port 5432 is open (laptop / VM / server), or set\n"
                 "       SUPABASE_SERVICE_KEY to use the HTTPS/PostgREST path.\n"
                 f"       detail: {e!r}")


def db_resolve_business(conn, workspace, slug):
    cur = conn.cursor()
    cur.execute("select id,name,slug,brand_color from content_businesses "
                "where workspace_id=%s and slug=%s limit 1", (workspace, slug))
    r = cur.fetchone(); cur.close()
    if not r:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
    return {"id": r[0], "name": r[1], "slug": r[2], "brand_color": r[3]}


def db_title_exists(conn, workspace, business_id, title):
    cur = conn.cursor()
    cur.execute("select 1 from content_assets where workspace_id=%s and business_id=%s "
                "and title=%s limit 1", (workspace, business_id, title))
    r = cur.fetchone(); cur.close(); return bool(r)


def db_insert_asset(conn, row):
    cur = conn.cursor()
    cur.execute(
        "insert into content_assets "
        "(id,workspace_id,business_id,title,type,content,amp_content,subject,platform,tags,notes,image_url) "
        "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) returning id",
        (row["id"], row["workspace_id"], row["business_id"], row["title"], row["type"],
         row["content"], row.get("amp_content"), row.get("subject"), row.get("platform"),
         json.dumps(row.get("tags") or []), row.get("notes"), row.get("image_url")))
    new_id = cur.fetchone()[0]; conn.commit(); cur.close(); return new_id


def db_list_businesses(conn, workspace):
    cur = conn.cursor()
    cur.execute("select name,slug,brand_color from content_businesses "
                "where workspace_id=%s order by name", (workspace,))
    rows = cur.fetchall(); cur.close(); return rows


# ----------------------------- shared -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def backend(database_url):
    """Return ('rest', Rest) or ('db', None-marker)."""
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        return "rest", Rest(project_url_from_db(database_url), key)
    return "db", None


def cmd_inspect(database_url, workspace):
    mode, rest = backend(database_url)
    print(f"Mode: {mode}   Workspace: {workspace}\n\nBusinesses:")
    if mode == "rest":
        rows = rest_list_businesses(rest, workspace)
    else:
        conn = connect(database_url); rows = db_list_businesses(conn, workspace); conn.close()
    for name, slug, color in rows:
        print(f"  - {slug:<22} {name:<24} {color}")
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")


def cmd_publish(database_url, workspace, args):
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

    mode, rest = backend(database_url)
    if mode == "rest":
        biz = rest_resolve_business(rest, workspace, slug)
    else:
        conn = connect(database_url); biz = db_resolve_business(conn, workspace, slug)
    print(f"Mode: {mode}   Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        if mode == "rest":
            if args.skip_existing and rest_title_exists(rest, workspace, biz["id"], title):
                print(f"  ~ skip (exists): {title}"); skipped += 1; continue
            new_id = rest_insert_asset(rest, row)
        else:
            if args.skip_existing and db_title_exists(conn, workspace, biz["id"], title):
                print(f"  ~ skip (exists): {title}"); skipped += 1; continue
            new_id = db_insert_asset(conn, row)
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

    if mode == "db":
        conn.close()
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

    database_url = os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)
    workspace = os.environ.get("HUB_WORKSPACE", DEFAULT_HUB_WORKSPACE)

    if args.inspect:
        return cmd_inspect(database_url, workspace)
    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")
    return cmd_publish(database_url, workspace, args)


if __name__ == "__main__":
    main()
