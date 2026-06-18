#!/usr/bin/env python3
"""
publish_to_hub.py — push a day's Gifts Gulf content into the Content Hub DB.

Talks to Neon over its HTTPS SQL endpoint (port 443), NOT the Postgres wire
protocol (5432), because routine runners and sandboxes usually allow only
HTTPS egress. No psycopg, no pip install: standard library only.

Reads files the routine wrote under:
  content/gifts-gulf/<date>/<CUR>/set-<n>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
and inserts rows into `content_businesses` + `content_assets`.

Env:
  DATABASE_URL   required. Neon URL (postgresql+psycopg://... accepted; +driver stripped).
  HUB_WORKSPACE  required. Workspace UUID the business folder lives under.
  HUB_BUSINESS_SLUG  optional, default "gifts-gulf".
  HUB_BUSINESS_NAME  optional, default "Gifts Gulf".

Usage:
  python3 scripts/publish_to_hub.py --date 2026-06-13   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BRAND, ACCENT = "#00a544", "#008138"
LOGO = "https://www.giftsgulf.com/gglogo.svg"
TONE = "minimal"


def normalize(url: str) -> str:
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


class Neon:
    def __init__(self, dsn: str):
        self.conn = normalize(dsn)
        host = urlparse(self.conn).hostname
        if not host:
            raise SystemExit("DATABASE_URL has no host")
        self.url = "https://%s/sql" % host

    def q(self, sql: str, params=None):
        body = json.dumps({"query": sql, "params": params or []}).encode()
        req = Request(self.url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Neon-Connection-String": self.conn,
            "Neon-Raw-Text-Output": "true",
        })
        try:
            with urlopen(req, timeout=45) as r:
                return json.loads(r.read())["rows"]
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    db = os.environ.get("DATABASE_URL")
    ws = os.environ.get("HUB_WORKSPACE")
    slug = os.environ.get("HUB_BUSINESS_SLUG", "gifts-gulf")
    biz_name = os.environ.get("HUB_BUSINESS_NAME", "Gifts Gulf")
    if not db or not ws:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no_secrets)"}))
        return 0

    day = repo_root() / "content" / "gifts-gulf" / args.date
    if not day.is_dir():
        print(json.dumps({"date": args.date, "error": "no content dir: %s" % day}))
        return 4

    n = Neon(db)
    if not n.q("select id from workspaces where id=$1", [ws]):
        print(json.dumps({"date": args.date, "error": "workspace not found: %s" % ws}))
        return 4

    rows = n.q("select id from content_businesses where workspace_id=$1 and slug=$2", [ws, slug])
    if rows:
        biz, created = rows[0]["id"], False
    else:
        biz, created = str(uuid.uuid4()), True
        n.q("""insert into content_businesses
                 (id,workspace_id,name,slug,brand_color,accent_color,tone,logo_url)
               values ($1,$2,$3,$4,$5,$6,$7,$8)""",
            [biz, ws, biz_name, slug, BRAND, ACCENT, TONE, LOGO])

    rep = {"date": args.date, "business_id": biz, "created_business": created,
           "inserted": 0, "skipped": 0, "failures": []}

    for sd in sorted({p.parent for p in day.rglob("meta.json")}):
        m = json.loads(read(sd / "meta.json"))
        code = m.get("campaign_code", sd.name)
        name = m.get("campaign_name", code)
        subj = m.get("subject")
        cur = m.get("currency")  # optional; geography removed
        seas = m.get("season", "")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code] + ([cur] if cur else []) + ([seas] if seas else []), ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code] + ([cur] if cur else []), None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code] + ([cur] if cur else []), None))
        for title, atype, content, s, plat, tags, amp in jobs:
            try:
                if n.q("select 1 from content_assets where business_id=$1 and title=$2 limit 1", [biz, title]):
                    rep["skipped"] += 1
                    continue
                n.q("""insert into content_assets
                         (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)""",
                    [str(uuid.uuid4()), ws, biz, title, atype, content, s, plat, json.dumps(tags), amp])
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
