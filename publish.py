#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

Two transports, picked automatically:

  * PostgREST over HTTPS  — used when SUPABASE_SERVICE_KEY is set. This is the
    ROUTINE path: Anthropic's cloud sandbox blocks Postgres ports (5432/6543),
    so the only write path is Supabase's REST API authenticated with the
    service_role key. Stdlib only — nothing to pip install.

  * Direct psycopg2       — used when no service key is present (local runs on a
    laptop / VM / server where port 5432 is open). Auto-installs psycopg2-binary.

The Supabase project URL is derived from DATABASE_URL (or SUPABASE_URL if set),
and the business is resolved by slug — nothing else is hard-coded.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_URL          (optional) https://<ref>.supabase.co  — else derived from DATABASE_URL
  SUPABASE_SERVICE_KEY  service_role key — presence selects the HTTPS/PostgREST path

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-07-04.json
  python publish.py --manifest <file> --dry-run          # print, no network, no key needed
  python publish.py --manifest <file> --skip-existing     # skip dup titles

MANIFEST (json)
  { "date":"2026-07-04","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re
import urllib.request, urllib.parse, urllib.error

# --- baked-in defaults so it runs with minimal env setup (override via env / secrets) ---
DEFAULT_DATABASE_URL = ("postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz"
                        "@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres")
DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
# SECURITY: the DB password / service key are live write creds. Prefer setting them as
# routine secrets and rotating in Supabase; defaults here are only for convenience.

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- url derivation -----------------------------
def project_ref_from_db_url(database_url):
    # postgresql://postgres.<ref>:<pass>@...  -> <ref>
    m = re.search(r"postgres\.([a-z0-9]+):", database_url or "")
    return m.group(1) if m else None


def supabase_base_url(database_url):
    env = os.environ.get("SUPABASE_URL")
    if env:
        return env.rstrip("/")
    ref = project_ref_from_db_url(database_url)
    if not ref:
        sys.exit("ERROR: could not derive Supabase URL — set SUPABASE_URL.")
    return f"https://{ref}.supabase.co"


# =========================================================================
#  PostgREST (HTTPS) transport — the routine/cloud path
# =========================================================================
class RestClient:
    def __init__(self, base_url, service_key):
        self.base = base_url.rstrip("/") + "/rest/v1"
        self.key = service_key

    def _headers(self, extra=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}",
             "Content-Type": "application/json"}
        if extra:
            h.update(extra)
        return h

    def _request(self, method, path, params=None, body=None, headers=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params, safe="*.,()")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=self._headers(headers))
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            sys.exit(f"ERROR: Supabase REST {method} {path} -> HTTP {e.code}\n"
                     f"       {detail}\n"
                     "       (402/egress-quota means the Supabase project is restricted — "
                     "upgrade the plan or remove spend caps in the dashboard.)")
        except urllib.error.URLError as e:
            sys.exit(f"ERROR: could not reach Supabase REST at {self.base}: {e.reason!r}")

    def resolve_business(self, workspace, slug):
        rows = self._request("GET", "/content_businesses", params={
            "workspace_id": f"eq.{workspace}", "slug": f"eq.{slug}",
            "select": "id,name,slug,brand_color", "limit": "1"})
        if not rows:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
        r = rows[0]
        return {"id": r["id"], "name": r["name"], "slug": r["slug"],
                "brand_color": r.get("brand_color")}

    def title_exists(self, workspace, business_id, title):
        rows = self._request("GET", "/content_assets", params={
            "workspace_id": f"eq.{workspace}", "business_id": f"eq.{business_id}",
            "title": f"eq.{title}", "select": "id", "limit": "1"})
        return bool(rows)

    def insert_asset(self, row):
        rows = self._request("POST", "/content_assets", body=row,
                             headers={"Prefer": "return=representation"})
        return rows[0]["id"] if rows else None

    def list_businesses(self, workspace):
        rows = self._request("GET", "/content_businesses", params={
            "workspace_id": f"eq.{workspace}",
            "select": "name,slug,brand_color", "order": "name"}) or []
        return [(r["name"], r["slug"], r.get("brand_color")) for r in rows]


# =========================================================================
#  psycopg2 (direct DB) transport — local / open-port path
# =========================================================================
def _psycopg2():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("psycopg2 not found — installing psycopg2-binary…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                        "--break-system-packages", "psycopg2-binary"], check=False)
    import psycopg2
    return psycopg2


class DirectClient:
    def __init__(self, database_url):
        psycopg2 = _psycopg2()
        try:
            self.conn = psycopg2.connect(database_url, connect_timeout=15)
        except Exception as e:
            sys.exit("ERROR: could not connect to the database.\n"
                     "       Run where port 5432 is open (laptop / VM / server), or set "
                     "SUPABASE_SERVICE_KEY to use the HTTPS path.\n"
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


def make_client(database_url):
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        base = supabase_base_url(database_url)
        print(f"mode=rest  ({base})")
        return RestClient(base, key)
    print("mode=direct (psycopg2)")
    return DirectClient(database_url)


# ----------------------------- shared -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def cmd_inspect(database_url, workspace):
    client = make_client(database_url)
    print(f"Workspace {workspace}\n\nBusinesses:")
    for name, slug, color in client.list_businesses(workspace):
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

    client = make_client(database_url)
    biz = client.resolve_business(workspace, slug)
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and client.title_exists(workspace, biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        new_id = client.insert_asset(row)
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
