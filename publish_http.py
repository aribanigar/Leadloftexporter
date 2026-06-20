#!/usr/bin/env python3
"""publish_http.py - seed the Hudace content batch into the LeadLoft content hub
over Neon's SQL-over-HTTPS endpoint (port 5432 is blocked in this environment,
443 is open). Mirrors publish.py semantics against the live schema:

  folder  -> content_businesses (matched by slug/name in HUB_WORKSPACE)
  items   -> content_assets (id uuid, workspace_id, business_id, title, type,
             content, subject, image_url, tags[])

Idempotent: an item whose title already exists for the business is skipped.
Atomic: all new rows are inserted in one Neon HTTP transaction.

USAGE
  python publish_http.py --discover
  python publish_http.py --folder hudace batch.json
"""
import os, sys, json, uuid, argparse, urllib.request, re

DB = os.environ["DATABASE_URL"]
WS = os.environ["HUB_WORKSPACE"]
DATE = os.environ.get("RUN_DATE", "2026-06-20")
HOST = re.search(r"@([^/:?]+)", DB).group(1)
URL = "https://%s/sql" % HOST

TYPE_MAP = {
    "email": "html_email", "html_email": "html_email", "html": "html_email",
    "whatsapp": "whatsapp", "wa": "whatsapp",
    "linkedin": "caption", "caption": "caption", "post": "caption", "social": "caption",
    "sms": "sms", "text": "sms",
    "outreach": "other", "other": "other", "dm": "other", "cold": "other",
}
def norm_type(t): return TYPE_MAP.get(str(t).strip().lower(), "other")

def _headers():
    return {"Content-Type": "application/json", "Neon-Connection-String": DB,
            "Neon-Raw-Text-Output": "true", "Neon-Array-Mode": "true"}

def q(sql, params=None):
    body = json.dumps({"query": sql, "params": params or []}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers=_headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["rows"]

def tx(queries):
    """queries: list of (sql, params). Runs atomically via Neon HTTP transaction."""
    payload = {"queries": [{"query": s, "params": p or []} for s, p in queries]}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers=_headers())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def discover():
    print("ITEM TABLE content_assets:")
    for c in q("select column_name,data_type from information_schema.columns "
               "where table_schema='public' and table_name='content_assets' order by ordinal_position"):
        print("   ", c)
    print("FOLDER TABLE content_businesses:")
    for c in q("select column_name,data_type from information_schema.columns "
               "where table_schema='public' and table_name='content_businesses' order by ordinal_position"):
        print("   ", c)

def ensure_business(slug):
    rows = q("select id from content_businesses where workspace_id=$1 and "
             "(lower(slug)=lower($2) or lower(name)=lower($2)) limit 1", [WS, slug])
    if rows:
        return rows[0][0]
    bid = str(uuid.uuid4())
    q("insert into content_businesses (id,workspace_id,name,slug,brand_color,accent_color,tone) "
      "values ($1,$2,$3,$4,$5,$6,$7)",
      [bid, WS, slug.title(), slug, "#0A0919", "#1B90FF", "sap"])
    return bid

def publish(folder, items):
    bid = ensure_business(folder)
    existing = {r[0] for r in q("select title from content_assets where workspace_id=$1 and business_id=$2",
                                [WS, bid])}
    queries = []
    created = 0; skipped = 0
    for it in items:
        if it["title"] in existing:
            skipped += 1; continue
        t = norm_type(it.get("type", "other"))
        subject = it.get("subject") if t == "html_email" else None
        tags = json.dumps([DATE, "hudace-routine"])
        queries.append((
            "insert into content_assets "
            "(id,workspace_id,business_id,title,type,content,subject,platform,image_url,tags) "
            "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
            [str(uuid.uuid4()), WS, bid, it["title"], t,
             it.get("body") or it.get("content", ""), subject,
             it.get("platform"), it.get("image_url"), tags]))
        created += 1
    if queries:
        res = tx(queries)
        if isinstance(res, dict) and res.get("message"):
            raise SystemExit("TX FAILED: %s" % res["message"])
    print("OK folder='%s' business_id=%s created=%d skipped=%d" % (folder, bid, created, skipped))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--folder", default="hudace")
    ap.add_argument("batch", nargs="?")
    a = ap.parse_args()
    if a.discover:
        discover()
    elif a.batch:
        with open(a.batch) as f:
            publish(a.folder, json.load(f))
    else:
        ap.print_help()
