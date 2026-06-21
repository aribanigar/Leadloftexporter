#!/usr/bin/env python3
"""
publish_rest.py - seed Hudace content into the LeadLoft content hub over HTTPS.

The scheduled web environment only allows outbound HTTPS (443); the Supabase
Postgres ports (5432/6543) are firewalled, so the psycopg2 path in publish.py
cannot connect. This script uses the Supabase REST (PostgREST) API instead,
which is reachable on 443.

Schema (discovered via the REST OpenAPI spec):
  content_assets      -> the content item table
     id, workspace_id, business_id, title, type, content (body), subject,
     platform, image_url, created_at, updated_at
  content_businesses  -> the "folder" table (one row per brand, e.g. 'hudace')

ENV (required)
  SUPABASE_URL         e.g. https://cmdnezltteldysoxyjzh.supabase.co
  SUPABASE_SECRET_KEY  a Supabase secret key (sb_secret_... / service_role) -
                       privileged, bypasses RLS. Falls back to SB_SECRET.
  HUB_WORKSPACE        workspace UUID

USAGE
  python publish_rest.py --folder hudace batch.json
Idempotent: an item whose title already exists in the folder is skipped.
"""
import os, sys, json, uuid, argparse, datetime, urllib.request, urllib.parse, urllib.error

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ.get("SUPABASE_SECRET_KEY") or os.environ["SB_SECRET"]
WS  = os.environ["HUB_WORKSPACE"]

TYPE_MAP = {
    "email":"html_email","html_email":"html_email","html":"html_email",
    "whatsapp":"whatsapp","wa":"whatsapp",
    "linkedin":"caption","caption":"caption","post":"caption","social":"caption",
    "sms":"sms","text":"sms",
    "outreach":"other","other":"other","dm":"other","cold":"other",
}
PLATFORM_MAP = {"html_email":"email","whatsapp":"whatsapp","caption":"linkedin","sms":"sms","other":"outreach"}

def _type(t): return TYPE_MAP.get(str(t).strip().lower(), "other")

def _req(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        raw = r.read().decode()
        return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get(path):
    _, j = _req("GET", path)
    return j

def folder_id(name):
    rows = get(f"content_businesses?workspace_id=eq.{WS}&slug=eq.{urllib.parse.quote(name)}&select=id")
    if rows:
        return rows[0]["id"]
    rows = get(f"content_businesses?workspace_id=eq.{WS}&name=eq.{urllib.parse.quote(name.title())}&select=id")
    if rows:
        return rows[0]["id"]
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    bid = str(uuid.uuid4())
    st, resp = _req("POST", "content_businesses",
                    {"id": bid, "workspace_id": WS, "name": name.title(), "slug": name,
                     "created_at": now, "updated_at": now}, prefer="return=minimal")
    if st not in (200, 201, 204):
        raise SystemExit(f"create folder failed {st}: {resp}")
    return bid

def title_exists(bid, title):
    q = urllib.parse.quote(title)
    rows = get(f"content_assets?workspace_id=eq.{WS}&business_id=eq.{bid}&title=eq.{q}&select=id")
    return bool(rows)

def publish(folder_name, items):
    bid = folder_id(folder_name)
    created = skipped = failed = 0
    errs = []
    for it in items:
        title = it["title"]
        if title_exists(bid, title):
            skipped += 1; continue
        t = _type(it.get("type", "other"))
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        row = {
            "id": str(uuid.uuid4()), "workspace_id": WS, "business_id": bid,
            "title": title, "type": t, "platform": PLATFORM_MAP.get(t, "email"),
            "content": it.get("body") or it.get("body_html", ""),
            "tags": it.get("tags") or ["hudace"],
            "image_url": it.get("image_url"),
            "created_at": now, "updated_at": now,
        }
        if t == "html_email":
            row["subject"] = title.split("] ", 1)[-1]
        st, resp = _req("POST", "content_assets", row, prefer="return=minimal")
        if st in (200, 201, 204):
            created += 1
        else:
            failed += 1; errs.append(f"{title} -> {st}: {resp}")
    print(f"OK folder='{folder_name}' business_id={bid} created={created} skipped={skipped} failed={failed}")
    for e in errs:
        print("  FAIL", e)
    return failed == 0

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default="hudace")
    ap.add_argument("batch")
    a = ap.parse_args()
    with open(a.batch) as f:
        items = json.load(f)
    ok = publish(a.folder, items)
    sys.exit(0 if ok else 1)
