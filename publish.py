#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the Content Hub (Supabase).

Two write paths, picked automatically:

  • PostgREST over HTTPS  — used when SUPABASE_SERVICE_KEY is set. This is the
    ROUTINE path: Anthropic's cloud sandbox blocks Postgres ports (5432/6543),
    so the only write path that reaches Supabase from there is PostgREST, which
    authenticates with the service_role key. Stdlib only — nothing to pip install.

  • psycopg2 (direct DB)  — fallback when no service key is set (local runs where
    port 5432 is open). Auto-installs psycopg2-binary if missing.

The project URL is derived from DATABASE_URL (or taken from SUPABASE_URL), and the
qckserve business_id is resolved by slug — nothing else is hard-coded.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_SERVICE_KEY  service_role key  -> enables the PostgREST/HTTPS path
  SUPABASE_URL          (optional) https://<ref>.supabase.co  (else derived from DATABASE_URL)

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-06-21.json
  python publish.py --manifest <file> --dry-run          # print, no network
  python publish.py --manifest <file> --skip-existing     # skip dup titles

MANIFEST (json)
  { "date":"2026-06-21","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
"""

import argparse, json, os, sys, uuid, datetime, subprocess, re
import urllib.request, urllib.parse, urllib.error

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}


# ----------------------------- project URL -----------------------------
def project_url(database_url):
    """Derive https://<ref>.supabase.co from SUPABASE_URL or DATABASE_URL."""
    env = os.environ.get("SUPABASE_URL")
    if env:
        return env.rstrip("/")
    # postgresql://postgres.<ref>:<pass>@...
    m = re.search(r"postgres\.([a-z0-9]+):", database_url or "")
    if not m:
        sys.exit("ERROR: could not derive Supabase project ref from DATABASE_URL; "
                 "set SUPABASE_URL explicitly.")
    return f"https://{m.group(1)}.supabase.co"


# ----------------------------- PostgREST (HTTPS) -----------------------------
class Rest:
    def __init__(self, base, key, workspace):
        self.base = base.rstrip("/") + "/rest/v1"
        self.key = key
        self.workspace = workspace

    def _req(self, method, path, params=None, body=None, prefer=None):
        url = f"{self.base}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, safe="*.,()")
        data = json.dumps(body).encode() if body is not None else None
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}",
                   "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()
            except Exception:
                pass
            sys.exit(f"ERROR: PostgREST {method} {path} -> {e.code}\n       {detail}")
        except Exception as e:
            sys.exit("ERROR: could not reach Supabase PostgREST.\n"
                     f"       {e!r}")

    def resolve_business(self, slug):
        rows = self._req("GET", "content_businesses", params={
            "workspace_id": f"eq.{self.workspace}", "slug": f"eq.{slug}",
            "select": "id,name,slug,brand_color", "limit": "1"})
        if not rows:
            sys.exit(f"ERROR: no business slug '{slug}' in workspace {self.workspace}.")
        r = rows[0]
        return {"id": r["id"], "name": r["name"], "slug": r["slug"],
                "brand_color": r.get("brand_color")}

    def title_exists(self, business_id, title):
        rows = self._req("GET", "content_assets", params={
            "workspace_id": f"eq.{self.workspace}", "business_id": f"eq.{business_id}",
            "title": f"eq.{title}", "select": "id", "limit": "1"})
        return bool(rows)

    def insert_asset(self, row):
        res = self._req("POST", "content_assets", body=row, prefer="return=representation")
        return res[0]["id"] if res else "(inserted)"

    def list_businesses(self):
        return self._req("GET", "content_businesses", params={
            "workspace_id": f"eq.{self.workspace}",
            "select": "name,slug,brand_color", "order": "name"})


# ----------------------------- psycopg2 (direct DB) -----------------------------
class Direct:
    def __init__(self, database_url, workspace):
        self.workspace = workspace
        try:
            import psycopg2  # noqa: F401
        except ImportError:
            print("psycopg2 not found — installing psycopg2-binary…")
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                            "--break-system-packages", "psycopg2-binary"], check=False)
            import psycopg2  # noqa: F401
        import psycopg2
        try:
            self.conn = psycopg2.connect(database_url, connect_timeout=15)
        except Exception as e:
            sys.exit("ERROR: could not connect to the database.\n"
                     "       Run where port 5432 is open, or set SUPABASE_SERVICE_KEY "
                     "to use the PostgREST/HTTPS path (required in the cloud sandbox).\n"
                     f"       detail: {e!r}")

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
        rows = cur.fetchall(); cur.close()
        return [{"name": n, "slug": s, "brand_color": c} for n, s, c in rows]


def make_client(database_url, workspace):
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        return Rest(project_url(database_url), key, workspace), "rest"
    return Direct(database_url, workspace), "direct"


# ----------------------------- shared -----------------------------
def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def cmd_inspect(database_url, workspace):
    client, mode = make_client(database_url, workspace)
    print(f"Connected (mode={mode}). Workspace {workspace}\n\nBusinesses:")
    for b in client.list_businesses():
        print(f"  - {b['slug']:<22} {b['name']:<24} {b.get('brand_color')}")
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

    for it in items:  # validate before any network
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

    client, mode = make_client(database_url, workspace)
    biz = client.resolve_business(slug)
    print(f"Mode: {mode}   Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and client.title_exists(biz["id"], title):
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

    database_url = os.environ.get("DATABASE_URL", "")
    workspace = os.environ.get("HUB_WORKSPACE", "")
    if not workspace:
        sys.exit("ERROR: HUB_WORKSPACE is required.")

    if args.inspect:
        return cmd_inspect(database_url, workspace)
    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")
    return cmd_publish(database_url, workspace, args)


if __name__ == "__main__":
    main()
