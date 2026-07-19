#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

Two write paths, chosen automatically:

  * HTTPS / PostgREST  (the routine path) — used when SUPABASE_SERVICE_KEY is set.
    Stdlib-only (urllib), so nothing to pip-install. Works inside Anthropic's
    cloud routine sandbox, where Postgres ports (5432/6543) are blocked.

  * Direct DB / psycopg2 (the local path) — used when no service key is set and
    DATABASE_URL points at an open 5432. Auto-installs psycopg2-binary.

The Supabase project URL is derived from DATABASE_URL's host (postgres.<ref>...),
so only the service key needs to be supplied for the HTTPS path.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_SERVICE_KEY  service_role key -> selects the HTTPS/PostgREST path
  SUPABASE_URL          optional override for the REST base (else derived from <ref>)

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-07-19.json
  python publish.py --manifest <file> --dry-run          # print, no network, no key needed
  python publish.py --manifest <file> --skip-existing     # skip dup titles

MANIFEST (json)
  { "date":"2026-07-19","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re
import urllib.request, urllib.parse, urllib.error

DEFAULT_DATABASE_URL = ("postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz"
                        "@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres")
DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- helpers -----------------------------
def project_ref(database_url):
    """postgresql://postgres.<ref>:... -> <ref>"""
    m = re.search(r"postgres\.([a-z0-9]+)[:@]", database_url)
    return m.group(1) if m else None


def rest_base(database_url):
    override = os.environ.get("SUPABASE_URL")
    if override:
        return override.rstrip("/")
    ref = project_ref(database_url)
    if not ref:
        sys.exit("ERROR: could not derive project ref from DATABASE_URL "
                 "(expected postgres.<ref>...). Set SUPABASE_URL explicitly.")
    return f"https://{ref}.supabase.co"


def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


# ----------------------------- REST backend -----------------------------
class RestBackend:
    mode = "rest"

    def __init__(self, database_url, service_key):
        self.base = rest_base(database_url)
        self.key = service_key

    def _req(self, method, path, params=None, body=None, prefer=None):
        url = f"{self.base}/rest/v1/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, safe="=.,*")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            sys.exit(f"ERROR: PostgREST {method} {path} -> HTTP {e.code}\n       {detail}")
        except urllib.error.URLError as e:
            sys.exit(f"ERROR: could not reach Supabase REST API at {self.base}.\n       {e.reason}")

    def resolve_business(self, workspace, slug):
        rows = self._req("GET", "content_businesses", {
            "select": "id,name,slug,brand_color",
            "workspace_id": f"eq.{workspace}", "slug": f"eq.{slug}", "limit": "1"})
        if not rows:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
        return rows[0]

    def title_exists(self, workspace, business_id, title):
        rows = self._req("GET", "content_assets", {
            "select": "id", "workspace_id": f"eq.{workspace}",
            "business_id": f"eq.{business_id}", "title": f"eq.{title}", "limit": "1"})
        return bool(rows)

    def insert_asset(self, row):
        res = self._req("POST", "content_assets", body=row, prefer="return=representation")
        return res[0]["id"] if res else row["id"]

    def list_businesses(self, workspace):
        rows = self._req("GET", "content_businesses", {
            "select": "name,slug,brand_color",
            "workspace_id": f"eq.{workspace}", "order": "name"})
        return [(r["name"], r["slug"], r.get("brand_color")) for r in rows]


# ----------------------------- DB backend -----------------------------
class DbBackend:
    mode = "direct-db"

    def __init__(self, database_url):
        try:
            import psycopg2  # noqa: F401
        except ImportError:
            print("psycopg2 not found — installing psycopg2-binary…")
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                            "--break-system-packages", "psycopg2-binary"], check=False)
        import psycopg2
        try:
            self.conn = psycopg2.connect(database_url, connect_timeout=15)
        except Exception as e:
            sys.exit("ERROR: could not connect to the database.\n"
                     "       Direct DB needs port 5432 open (laptop/VM/server); the cloud\n"
                     "       routine sandbox blocks it — set SUPABASE_SERVICE_KEY for the HTTPS path.\n"
                     f"       detail: {e!r}")

    def resolve_business(self, workspace, slug):
        cur = self.conn.cursor()
        cur.execute("select id,name,slug,brand_color from content_businesses "
                    "where workspace_id=%s and slug=%s limit 1", (workspace, slug))
        r = cur.fetchone(); cur.close()
        if not r:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
        return {"id": r[0], "name": r[1], "slug": r[2], "brand_color": r[3]}

    def title_exists(self, workspace, business_id, title):
        cur = self.conn.cursor()
        cur.execute("select 1 from content_assets where workspace_id=%s and business_id=%s "
                    "and title=%s limit 1", (workspace, business_id, title))
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

    def list_businesses(self, workspace):
        cur = self.conn.cursor()
        cur.execute("select name,slug,brand_color from content_businesses "
                    "where workspace_id=%s order by name", (workspace,))
        rows = cur.fetchall(); cur.close(); return rows


def make_backend(database_url):
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        return RestBackend(database_url, key)
    return DbBackend(database_url)


# ----------------------------- commands -----------------------------
def cmd_inspect(database_url, workspace):
    be = make_backend(database_url)
    print(f"Connected via {be.mode}. Workspace {workspace}\n\nBusinesses:")
    for name, slug, color in be.list_businesses(workspace):
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

    be = make_backend(database_url)
    biz = be.resolve_business(workspace, slug)
    print(f"Backend: {be.mode}")
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and be.title_exists(workspace, biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        new_id = be.insert_asset(row)
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

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
