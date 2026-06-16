#!/usr/bin/env python3
"""
publish.py - push a day's ViaKashmir content into the Content Hub DB.

Adapted from the Gifts Gulf publisher. Talks to Neon over its HTTPS SQL endpoint
(port 443), NOT the Postgres wire protocol (5432), because routine runners and
sandboxes usually allow only HTTPS egress. Standard library only, no psycopg.

Reads files the routine wrote under:
  content/via-kashmir/<date>/<track>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
and inserts rows into content_businesses + content_assets.

Tracks (one folder each): b2c | b2b-hotels | b2b-cabs-shikaras | b2b-houseboats

Env:
  DATABASE_URL   postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require&channel_binding=require
  HUB_WORKSPACE  optional, default 2faa195e-5817-4d32-8e6c-350b70ce32c3 (acemedia).
  HUB_BUSINESS_SLUG  optional, default "via-kashmir".
  HUB_BUSINESS_NAME  optional, default "Via Kashmir".

Usage:
  python3 scripts/publish.py --date 2026-06-15   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ViaKashmir brand (System 1 palette) - written onto the hub business so the
# Content Hub renders ViaKashmir colours and logo.
BRAND  = "#0e3d2f"      # deep forest green
ACCENT = "#c8a84b"      # saffron gold
TONE   = "warm-editorial"
LOGO   = "https://viakashmir.in/logo-colour.svg?v=3"
DEFAULT_WS = "2faa195e-5817-4d32-8e6c-350b70ce32c3"


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
    ws = os.environ.get("HUB_WORKSPACE", DEFAULT_WS)
    slug = os.environ.get("HUB_BUSINESS_SLUG", "via-kashmir")
    biz_name = os.environ.get("HUB_BUSINESS_NAME", "Via Kashmir")
    if not db:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no DATABASE_URL)"}))
        return 0

    day = repo_root() / "content" / "via-kashmir" / args.date
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
        # keep brand + logo current on every run
        n.q("""update content_businesses
                 set name=$3, brand_color=$4, accent_color=$5, tone=$6, logo_url=$7
               where id=$1 and workspace_id=$2""",
            [biz, ws, biz_name, BRAND, ACCENT, TONE, LOGO])
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
        track = m.get("track", sd.name)
        seas = m.get("season", "")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, track] + ([seas] if seas else []), ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track], None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track], None))
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
