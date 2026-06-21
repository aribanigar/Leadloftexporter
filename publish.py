#!/usr/bin/env python3
"""
publish.py — seed daily QckServe content into the LeadLoft Content Hub (Supabase Postgres).

WHY THIS WORKS THE WAY IT DOES
  The Content Hub now lives on Supabase. Inside Claude Code / sandbox / routine
  containers, Postgres ports 5432 and 6543 are blocked, so a direct DB connection
  cannot be made there. Supabase's only HTTPS (port 443) write path is PostgREST,
  which needs a Supabase API key. So:
    - PRIMARY (works in routines): PostgREST over HTTPS  -> needs SUPABASE_SERVICE_KEY
    - FALLBACK (works locally):    psycopg2 over 5432/6543 -> used only if no key set
  Stdlib only for the PostgREST path (no pip). psycopg2 is imported lazily.

ENV
  DATABASE_URL          postgresql://postgres.<ref>:<pass>@...pooler.supabase.com:5432/postgres
  HUB_WORKSPACE         workspace uuid
  SUPABASE_SERVICE_KEY  Supabase service_role key   (REQUIRED for the routine/HTTPS path)
                        Dashboard -> Project Settings -> API -> service_role (secret)
  SUPABASE_URL          optional override, e.g. https://<ref>.supabase.co
                        (auto-derived from DATABASE_URL username "postgres.<ref>")

USAGE
  python publish.py --inspect
  python publish.py --manifest content/qckserve/qckserve-2026-06-21.json --dry-run
  python publish.py --manifest <file> --skip-existing

MANIFEST (json)
  { "date":"2026-06-21","business":"qckserve","topic":"...",
    "items":[ {channel, subject?, platform?, content, amp_content?, image_url?,
               tags[], notes?, title?}, ... ] }
  channel == content_hub type in {html_email, whatsapp, caption, sms, other}
  title auto-fills to "[date] topic (Channel)" when omitted.
"""

import argparse, json, os, sys, uuid, datetime
import urllib.request, urllib.error, urllib.parse

ALLOWED_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
CHANNEL_LABEL = {"html_email": "Email", "whatsapp": "WhatsApp", "caption": "Caption",
                 "sms": "SMS", "other": "Other"}
ASSET_COLS = ["id", "workspace_id", "business_id", "title", "type", "content",
              "amp_content", "subject", "platform", "tags", "notes", "image_url"]


# ============================ config / context ============================
def derive_ref(database_url: str):
    user = urllib.parse.urlparse(database_url).username or ""
    return user.split(".", 1)[1] if user.startswith("postgres.") and "." in user else None


def build_ctx():
    database_url = os.environ.get("DATABASE_URL")
    workspace = os.environ.get("HUB_WORKSPACE")
    if not database_url or not workspace:
        sys.exit("ERROR: set DATABASE_URL and HUB_WORKSPACE.")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
    sb_url = os.environ.get("SUPABASE_URL")
    if not sb_url:
        ref = derive_ref(database_url)
        sb_url = f"https://{ref}.supabase.co" if ref else None
    mode = "rest" if key else "pg"
    return {"database_url": database_url, "workspace": workspace,
            "key": key, "sb_url": sb_url, "mode": mode}


# ============================ PostgREST (HTTPS) ============================
def _rest_req(ctx, method, path, *, params=None, body=None, prefer=None):
    if not ctx["key"]:
        sys.exit("ERROR: SUPABASE_SERVICE_KEY (service_role) is required for the HTTPS path.\n"
                 "       Get it: Supabase Dashboard -> Project Settings -> API -> service_role.")
    if not ctx["sb_url"]:
        sys.exit("ERROR: could not derive SUPABASE_URL; set it explicitly (https://<ref>.supabase.co).")
    url = ctx["sb_url"].rstrip("/") + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params, safe="*.()")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", ctx["key"])
    req.add_header("Authorization", "Bearer " + ctx["key"])
    req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: PostgREST {e.code} on {method} {path}: {e.read().decode()[:500]}")
    except Exception as e:
        sys.exit(f"ERROR: PostgREST request failed: {e!r}")


def rest_resolve_business(ctx, slug):
    rows = _rest_req(ctx, "GET", "content_businesses", params={
        "workspace_id": "eq." + ctx["workspace"], "slug": "eq." + slug,
        "select": "id,name,slug,brand_color", "limit": "1"})
    if not rows:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {ctx['workspace']}.")
    return rows[0]


def rest_title_exists(ctx, business_id, title):
    rows = _rest_req(ctx, "GET", "content_assets", params={
        "workspace_id": "eq." + ctx["workspace"], "business_id": "eq." + business_id,
        "title": "eq." + title, "select": "id", "limit": "1"})
    return bool(rows)


def rest_insert(ctx, row):
    out = _rest_req(ctx, "POST", "content_assets", body=row, prefer="return=representation")
    return out[0]["id"] if out else row["id"]


def rest_list_businesses(ctx):
    return _rest_req(ctx, "GET", "content_businesses", params={
        "workspace_id": "eq." + ctx["workspace"], "select": "name,slug,brand_color", "order": "name"})


# ============================ psycopg2 (local fallback) ============================
def _pg_conn(ctx):
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        sys.exit("ERROR: no SUPABASE_SERVICE_KEY set and psycopg2 not installed.\n"
                 "       In a routine use the service key (HTTPS). Locally: pip install psycopg2-binary.")
    import psycopg2
    try:
        return psycopg2.connect(ctx["database_url"], connect_timeout=10)
    except Exception as e:
        sys.exit(f"ERROR: direct DB connect failed (ports 5432/6543 are blocked in sandboxes; "
                 f"set SUPABASE_SERVICE_KEY to use HTTPS instead): {e!r}")


def pg_resolve_business(ctx, slug):
    conn = _pg_conn(ctx); cur = conn.cursor()
    cur.execute("select id,name,slug,brand_color from content_businesses "
                "where workspace_id=%s and slug=%s limit 1", (ctx["workspace"], slug))
    r = cur.fetchone(); conn.close()
    if not r:
        sys.exit(f"ERROR: no business slug '{slug}' in workspace {ctx['workspace']}.")
    return {"id": r[0], "name": r[1], "slug": r[2], "brand_color": r[3]}


def pg_title_exists(ctx, business_id, title):
    conn = _pg_conn(ctx); cur = conn.cursor()
    cur.execute("select 1 from content_assets where workspace_id=%s and business_id=%s and title=%s limit 1",
                (ctx["workspace"], business_id, title))
    r = cur.fetchone(); conn.close(); return bool(r)


def pg_insert(ctx, row):
    conn = _pg_conn(ctx); cur = conn.cursor()
    cur.execute(
        "insert into content_assets "
        "(id,workspace_id,business_id,title,type,content,amp_content,subject,platform,tags,notes,image_url) "
        "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) returning id",
        (row["id"], row["workspace_id"], row["business_id"], row["title"], row["type"],
         row["content"], row.get("amp_content"), row.get("subject"), row.get("platform"),
         json.dumps(row.get("tags") or []), row.get("notes"), row.get("image_url")))
    new_id = cur.fetchone()[0]; conn.commit(); conn.close(); return new_id


def pg_list_businesses(ctx):
    conn = _pg_conn(ctx); cur = conn.cursor()
    cur.execute("select name,slug,brand_color from content_businesses where workspace_id=%s order by name",
                (ctx["workspace"],))
    rows = [{"name": a, "slug": b, "brand_color": c} for a, b, c in cur.fetchall()]
    conn.close(); return rows


# ============================ shared ============================
def D(ctx):
    if ctx["mode"] == "rest":
        return (rest_resolve_business, rest_title_exists, rest_insert, rest_list_businesses)
    return (pg_resolve_business, pg_title_exists, pg_insert, pg_list_businesses)


def make_title(item, topic, date_str):
    if item.get("title"):
        return item["title"]
    label = CHANNEL_LABEL.get(item["channel"], "Other")
    if item["channel"] == "caption" and item.get("platform"):
        label = item["platform"].capitalize()
    return f"[{date_str}] {topic} ({label})"


def build_row(ctx, item, business_id, topic, date_str):
    return {
        "id": str(uuid.uuid4()),
        "workspace_id": ctx["workspace"],
        "business_id": business_id,
        "title": make_title(item, topic, date_str),
        "type": item["channel"],
        "content": item["content"],
        "amp_content": item.get("amp_content"),
        "subject": item.get("subject"),
        "platform": item.get("platform"),
        "tags": item.get("tags") or [],
        "notes": item.get("notes"),
        "image_url": item.get("image_url"),
    }


# ============================ commands ============================
def cmd_inspect(ctx):
    where = ("PostgREST HTTPS — " + (ctx["sb_url"] or "?")) if ctx["mode"] == "rest" else "direct psycopg2"
    print(f"Mode: {ctx['mode']}  ({where})")
    _, _, _, list_biz = D(ctx)
    print("\nBusinesses in workspace:")
    for b in list_biz(ctx):
        print(f"  - {b['slug']:<22} {b['name']:<24} {b['brand_color']}")
    print(f"\ncontent_assets columns: {', '.join(ASSET_COLS)}")
    print(f"Allowed types: {sorted(ALLOWED_TYPES)}")


def cmd_publish(ctx, args):
    with open(args.manifest, encoding="utf-8") as f:
        man = json.load(f)
    date_str = man.get("date") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
    slug = args.business or man.get("business") or "qckserve"
    topic = man.get("topic") or "QckServe"
    items = man.get("items") or []
    if not items:
        sys.exit("ERROR: manifest has no 'items'.")

    for it in items:  # validate before any network/writes
        ch = (it.get("channel") or "").strip()
        if ch not in ALLOWED_TYPES:
            sys.exit(f"ERROR: channel '{ch}' not in {sorted(ALLOWED_TYPES)}.")
        if not it.get("content"):
            sys.exit(f"ERROR: item ({ch}) has empty 'content'.")

    if args.dry_run:
        print(f"[dry] business={slug}  date={date_str}  topic={topic}  items={len(items)}")
        for it in items:
            title = make_title(it, topic, date_str)
            preview = it["content"][:60].replace("\n", " ")
            print(f"  [dry] {it['channel']:<10} {title}")
            print(f"        subject={it.get('subject')} platform={it.get('platform')} "
                  f"image={it.get('image_url')} tags={it.get('tags') or []}")
            print(f"        content: {preview}…")
        print(f"\n[dry] would create={len(items)} (no network calls made)")
        return

    resolve, exists, insert, _ = D(ctx)
    biz = resolve(ctx, slug)
    print(f"Mode: {ctx['mode']}   Business: {biz['name']} ({biz['slug']})  id={biz['id']}")
    print(f"Date: {date_str}   Topic: {topic}   Items: {len(items)}\n")

    created = skipped = 0
    for it in items:
        title = make_title(it, topic, date_str)
        if args.skip_existing and exists(ctx, biz["id"], title):
            print(f"  ~ skip (exists): {title}"); skipped += 1; continue
        row = build_row(ctx, it, biz["id"], topic, date_str)
        new_id = insert(ctx, row)
        print(f"  + {it['channel']:<10} {title}  -> {new_id}")
        created += 1

    print(f"\nDone. created={created} skipped={skipped}")
    print(f"View: https://leadloftexporter.vercel.app/content-hub/{slug}")


def main():
    ap = argparse.ArgumentParser(description="Seed QckServe content into the Content Hub (Supabase).")
    ap.add_argument("--manifest", help="path to manifest .json")
    ap.add_argument("--business", help="business slug (default from manifest or 'qckserve')")
    ap.add_argument("--dry-run", action="store_true", help="print, no network, no writes")
    ap.add_argument("--skip-existing", action="store_true", help="skip rows whose title already exists")
    ap.add_argument("--inspect", action="store_true", help="list businesses + schema, then exit")
    args = ap.parse_args()

    ctx = build_ctx()
    if args.inspect:
        return cmd_inspect(ctx)
    if not args.manifest:
        sys.exit("ERROR: --manifest is required (or use --inspect).")
    return cmd_publish(ctx, args)


if __name__ == "__main__":
    main()
