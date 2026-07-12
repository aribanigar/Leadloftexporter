#!/usr/bin/env python3
"""
publish.py - seed daily QckServe content into the Content Hub (Supabase).

Two write paths, chosen automatically:

  * PostgREST over HTTPS  -- used when SUPABASE_SERVICE_KEY is set. Stdlib only,
    nothing to pip install. This is the ROUTINE path: Anthropic's cloud sandbox
    blocks Postgres ports 5432/6543, and Supabase's only HTTPS write path is
    PostgREST, authenticated with the service_role key.

  * Direct DB (psycopg2)  -- fallback when no service key is set (local runs on a
    laptop / VM / server where 5432 is open). Auto-installs psycopg2-binary.

The Supabase project URL is derived from DATABASE_URL's <ref> automatically
(https://<ref>.supabase.co), so nothing is hard-coded beyond convenience defaults.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_SERVICE_KEY  service_role key -> selects the PostgREST/HTTPS path
  SUPABASE_URL          optional, overrides the derived https://<ref>.supabase.co

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-07-12.json
  python publish.py --manifest <file> --dry-run          # print, no network
  python publish.py --manifest <file> --skip-existing     # skip dup titles

MANIFEST (json)
  { "date":"2026-07-12","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, re, sys, uuid, datetime, subprocess

# --- baked-in defaults so it runs with minimal env setup (override via env/secrets) ---
DEFAULT_DATABASE_URL = ("postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz"
                        "@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres")
DEFAULT_HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
# SECURITY: these are live write creds. Prefer setting them as env vars / routine
# secrets and rotating the password + service key in Supabase.

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- shared helpers -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def project_url_from_dburl(database_url):
    """postgresql://postgres.<ref>:...  ->  https://<ref>.supabase.co"""
    m = re.search(r"postgres\.([a-z0-9]+)[:@]", database_url or "")
    if not m:
        return None
    return f"https://{m.group(1)}.supabase.co"


# ============================ PostgREST / HTTPS path ============================
class RestClient:
    def __init__(self, base_url, service_key):
        self.base = base_url.rstrip("/") + "/rest/v1"
        self.key = service_key

    def _request(self, method, path, params=None, body=None, prefer=None):
        import urllib.request, urllib.parse, urllib.error
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            sys.exit(f"ERROR: Supabase REST {method} {path} -> HTTP {e.code}\n"
                     f"       {detail}")
        except urllib.error.URLError as e:
            sys.exit(f"ERROR: could not reach Supabase REST at {self.base}\n"
                     f"       detail: {e!r}")

    def get(self, path, params):
        return self._request("GET", path, params=params)

    def insert(self, path, row):
        out = self._request("POST", path, body=row, prefer="return=representation")
        return out[0] if isinstance(out, list) and out else out


def resolve_business_rest(rc, workspace, slug):
    rows = rc.get("/content_businesses", {
        "select": "id,name,slug,brand_color",
        "workspace_id": f"eq.{workspace}", "slug": f"eq.{slug}", "limit": "1"})
    if not rows:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
    r = rows[0]
    return {"id": r["id"], "name": r["name"], "slug": r["slug"], "brand_color": r.get("brand_color")}


def title_exists_rest(rc, workspace, business_id, title):
    import urllib.parse
    rows = rc.get("/content_assets", {
        "select": "id", "workspace_id": f"eq.{workspace}",
        "business_id": f"eq.{business_id}", "title": f"eq.{title}", "limit": "1"})
    return bool(rows)


def cmd_inspect_rest(rc, workspace):
    print(f"Connected via PostgREST (HTTPS). Workspace {workspace}   mode=rest\n\nBusinesses:")
    rows = rc.get("/content_businesses", {
        "select": "name,slug,brand_color", "workspace_id": f"eq.{workspace}", "order": "name"})
    for r in rows:
        print(f"  - {r['slug']:<22} {r['name']:<24} {r.get('brand_color')}")
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")


def cmd_publish_rest(rc, workspace, man, args):
    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man["items"]

    biz = resolve_business_rest(rc, workspace, slug)
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}   mode=rest")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and title_exists_rest(rc, workspace, biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = {
            "id": str(uuid.uuid4()), "workspace_id": workspace, "business_id": biz["id"],
            "title": title, "type": it["channel"], "content": it["content"],
            "amp_content": it.get("amp_content"), "subject": it.get("subject"),
            "platform": it.get("platform"), "tags": it.get("tags") or [],
            "notes": it.get("notes"), "image_url": it.get("image_url"),
        }
        new = rc.insert("/content_assets", row)
        new_id = new["id"] if isinstance(new, dict) else row["id"]
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

    print(f"\nDone. created={created} skipped={skipped}")
    print(f"View: https://leadloftexporter.vercel.app/content-hub/{slug}")


# ============================ Direct DB / psycopg2 path ============================
def _psycopg2():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("psycopg2 not found - installing psycopg2-binary...")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                        "--break-system-packages", "psycopg2-binary"], check=False)
    import psycopg2
    return psycopg2


def connect_db(database_url):
    psycopg2 = _psycopg2()
    try:
        return psycopg2.connect(database_url, connect_timeout=15)
    except Exception as e:
        sys.exit("ERROR: could not connect to the database.\n"
                 "       Run this where port 5432 is open (laptop / VM / server), or set\n"
                 "       SUPABASE_SERVICE_KEY to use the PostgREST/HTTPS path instead.\n"
                 f"       detail: {e!r}")


def cmd_inspect_db(database_url, workspace):
    conn = connect_db(database_url)
    print(f"Connected via psycopg2. Workspace {workspace}   mode=direct\n\nBusinesses:")
    cur = conn.cursor()
    cur.execute("select name,slug,brand_color from content_businesses "
                "where workspace_id=%s order by name", (workspace,))
    for name, slug, color in cur.fetchall():
        print(f"  - {slug:<22} {name:<24} {color}")
    cur.close(); conn.close()
    print(f"\nAllowed types: {sorted(ALLOWED_TYPES)}")


def cmd_publish_db(database_url, workspace, man, args):
    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man["items"]

    conn = connect_db(database_url)
    cur = conn.cursor()
    cur.execute("select id,name,slug,brand_color from content_businesses "
                "where workspace_id=%s and slug=%s limit 1", (workspace, slug))
    r = cur.fetchone()
    if not r:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {workspace}.")
    biz = {"id": r[0], "name": r[1], "slug": r[2]}
    print(f"Business: {biz['name']} ({biz['slug']})  id={biz['id']}   mode=direct")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing:
            cur.execute("select 1 from content_assets where workspace_id=%s and business_id=%s "
                        "and title=%s limit 1", (workspace, biz["id"], title))
            if cur.fetchone():
                print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        new_id = str(uuid.uuid4())
        cur.execute(
            "insert into content_assets "
            "(id,workspace_id,business_id,title,type,content,amp_content,subject,platform,tags,notes,image_url) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) returning id",
            (new_id, workspace, biz["id"], title, it["channel"], it["content"],
             it.get("amp_content"), it.get("subject"), it.get("platform"),
             json.dumps(it.get("tags") or []), it.get("notes"), it.get("image_url")))
        conn.commit()
        print(f"  + {it['channel']:<10} {title}  -> {cur.fetchone()[0]}")
        created += 1

    cur.close(); conn.close()
    print(f"\nDone. created={created} skipped={skipped}")
    print(f"View: https://leadloftexporter.vercel.app/content-hub/{slug}")


# ----------------------------- entrypoint -----------------------------
def load_manifest(path):
    with open(path, encoding="utf-8") as f:
        man = json.load(f)
    items = man.get("items") or []
    if not items:
        sys.exit("ERROR: manifest has no 'items'.")
    for it in items:  # validate before touching the network
        ch = (it.get("channel") or "").strip()
        if ch not in ALLOWED_TYPES:
            sys.exit(f"ERROR: channel '{ch}' not in {sorted(ALLOWED_TYPES)}.")
        if not it.get("content"):
            sys.exit(f"ERROR: item ({ch}) has empty 'content'.")
    man["items"] = items
    return man


def cmd_dry_run(man, args):
    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man["items"]
    print(f"[dry] business={slug}  date={date_str}  topic={topic}  items={len(items)}")
    for it in items:
        print(f"  [dry] {it['channel']:<10} {make_title(it, topic, date_str)}")
    print(f"\n[dry] would create={len(items)} (no network touched)")


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
    service_key = os.environ.get("SUPABASE_SERVICE_KEY")
    project_url = os.environ.get("SUPABASE_URL") or project_url_from_dburl(database_url)

    use_rest = bool(service_key)
    if use_rest and not project_url:
        sys.exit("ERROR: SUPABASE_SERVICE_KEY is set but no SUPABASE_URL and none "
                 "could be derived from DATABASE_URL.")

    # --dry-run makes no network calls and needs no key.
    if args.manifest and args.dry_run:
        return cmd_dry_run(load_manifest(args.manifest), args)

    if args.inspect:
        if use_rest:
            return cmd_inspect_rest(RestClient(project_url, service_key), workspace)
        return cmd_inspect_db(database_url, workspace)

    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")

    man = load_manifest(args.manifest)
    if use_rest:
        return cmd_publish_rest(RestClient(project_url, service_key), workspace, man, args)
    return cmd_publish_db(database_url, workspace, man, args)


if __name__ == "__main__":
    main()
