#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

TWO TRANSPORTS, auto-selected:
  * REST  — PostgREST over HTTPS, authenticated with SUPABASE_SERVICE_KEY.
            This is the ROUTINE path: Anthropic's cloud sandbox blocks the
            Postgres ports (5432/6543), so the only write path is HTTPS.
            Stdlib only — nothing to pip install.
  * DIRECT — psycopg2 over DATABASE_URL. Used only when no service key is set
            (local runs where 5432 is open). Auto-installs psycopg2-binary.

The Supabase project URL and business_id are derived automatically:
  - project URL from SUPABASE_URL, or from the <ref> in DATABASE_URL.
  - business_id resolved by slug ('qckserve') at run time.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_SERVICE_KEY  service_role key  -> selects the REST path (routine)
  SUPABASE_URL          https://<ref>.supabase.co (optional; derived if absent)

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-07-05.json
  python publish.py --manifest <file> --dry-run          # print, no network, no key needed
  python publish.py --manifest <file> --skip-existing     # skip dup titles

MANIFEST (json)
  { "date":"2026-07-05","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re
import urllib.request, urllib.error, urllib.parse

# --- baked-in defaults so it runs with minimal env setup (override via env / secrets) ---
DEFAULT_DATABASE_URL = ("postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz"
                        "@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres")
DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
# SECURITY: these are live write creds. Prefer setting them as routine secrets and
# rotating the password / service key in Supabase. Defaults are for convenience only.

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- url / project resolution -----------------------------
def project_ref_from_dburl(database_url):
    """Extract the Supabase project ref from postgres.<ref> in the DATABASE_URL."""
    m = re.search(r"postgres\.([a-z0-9]+)[:@]", database_url or "")
    return m.group(1) if m else None


def resolve_supabase_url(database_url):
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if url:
        return url
    ref = project_ref_from_dburl(database_url)
    if ref:
        return f"https://{ref}.supabase.co"
    return None


# ----------------------------- REST transport (PostgREST/HTTPS) -----------------------------
class RestHub:
    def __init__(self, base_url, service_key, workspace):
        self.base = base_url.rstrip("/") + "/rest/v1"
        self.key = service_key
        self.workspace = workspace

    def _req(self, method, path, params=None, body=None, prefer=None):
        url = f"{self.base}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, safe="=.,*()")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            if e.code == 402:
                sys.exit("ERROR: Supabase project is RESTRICTED (HTTP 402).\n"
                         "       PostgREST refused the request. The project owner must\n"
                         "       upgrade the plan or remove spend caps in the Supabase\n"
                         "       dashboard to restore service.\n"
                         f"       detail: {detail[:300]}")
            sys.exit(f"ERROR: PostgREST {method} {path} -> HTTP {e.code}\n       {detail[:400]}")
        except Exception as e:
            sys.exit("ERROR: could not reach PostgREST over HTTPS.\n"
                     f"       url={self.base}\n       detail: {e!r}")

    def list_businesses(self):
        rows = self._req("GET", "content_businesses",
                         params={"select": "name,slug,brand_color",
                                 "workspace_id": f"eq.{self.workspace}",
                                 "order": "name"})
        return [(r["name"], r["slug"], r.get("brand_color")) for r in rows]

    def resolve_business(self, slug):
        rows = self._req("GET", "content_businesses",
                         params={"select": "id,name,slug,brand_color",
                                 "workspace_id": f"eq.{self.workspace}",
                                 "slug": f"eq.{slug}", "limit": "1"})
        if not rows:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {self.workspace}.")
        r = rows[0]
        return {"id": r["id"], "name": r["name"], "slug": r["slug"], "brand_color": r.get("brand_color")}

    def title_exists(self, business_id, title):
        rows = self._req("GET", "content_assets",
                         params={"select": "id",
                                 "workspace_id": f"eq.{self.workspace}",
                                 "business_id": f"eq.{business_id}",
                                 "title": f"eq.{title}", "limit": "1"})
        return bool(rows)

    def insert_asset(self, row):
        res = self._req("POST", "content_assets", body=row, prefer="return=representation")
        if isinstance(res, list) and res:
            return res[0].get("id")
        return row["id"]

    def close(self):
        pass


# ----------------------------- DIRECT transport (psycopg2) -----------------------------
class DirectHub:
    def __init__(self, database_url, workspace):
        self.workspace = workspace
        psycopg2 = self._psycopg2()
        try:
            self.conn = psycopg2.connect(database_url, connect_timeout=15)
        except Exception as e:
            sys.exit("ERROR: could not connect to the database.\n"
                     "       Run this where port 5432 is open (laptop / VM / server), or\n"
                     "       set SUPABASE_SERVICE_KEY to use the HTTPS path. Anthropic's\n"
                     "       cloud routine sandbox blocks the Postgres ports.\n"
                     f"       detail: {e!r}")

    @staticmethod
    def _psycopg2():
        try:
            import psycopg2  # noqa: F401
        except ImportError:
            print("psycopg2 not found — installing psycopg2-binary…")
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                            "--break-system-packages", "psycopg2-binary"], check=False)
        import psycopg2
        return psycopg2

    def list_businesses(self):
        cur = self.conn.cursor()
        cur.execute("select name,slug,brand_color from content_businesses "
                    "where workspace_id=%s order by name", (self.workspace,))
        rows = cur.fetchall(); cur.close(); return rows

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

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


def make_hub(database_url, workspace):
    """REST when a service key is present (routine path), else direct psycopg2."""
    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if service_key:
        base = resolve_supabase_url(database_url)
        if not base:
            sys.exit("ERROR: SUPABASE_SERVICE_KEY set but could not resolve the Supabase\n"
                     "       project URL. Set SUPABASE_URL=https://<ref>.supabase.co.")
        return RestHub(base, service_key, workspace), "rest"
    return DirectHub(database_url, workspace), "direct"


# ----------------------------- shared -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def cmd_inspect(database_url, workspace):
    hub, mode = make_hub(database_url, workspace)
    print(f"Connected (mode={mode}). Workspace {workspace}\n\nBusinesses:")
    for name, slug, color in hub.list_businesses():
        print(f"  - {slug:<22} {name:<24} {color}")
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")
    hub.close()


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

    hub, mode = make_hub(database_url, workspace)
    biz = hub.resolve_business(slug)
    print(f"Transport: {mode}")
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and hub.title_exists(biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        new_id = hub.insert_asset(row)
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

    hub.close()
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
