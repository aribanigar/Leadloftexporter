#!/usr/bin/env python3
"""
seed_via_kashmir.py - seed ONE day of ViaKashmir (viakashmir.in) content into the
Content Hub DB. Independent of the itinerary engine: it only ever touches the
'via-kashmir' business and the content/via-kashmir/ tree.

Talks to Neon over its HTTPS SQL endpoint (port 443), not the Postgres wire
protocol (5432), so it works from routine runners / sandboxes that allow only
HTTPS egress. Standard library only - no psycopg.

Reads what the routine wrote under:
  content/via-kashmir/<date>/<track>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
Tracks (one folder each): b2c | b2b-hotels | b2b-cabs-shikaras | b2b-houseboats

Usage:
  python3 scripts/seed_via_kashmir.py --date 2026-06-15     # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# --- this engine's fixed identity ---------------------------------------------
SLUG  = "via-kashmir"
NAME  = "Via Kashmir"
LOGO  = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND = "#0e3d2f"      # deep forest green
ACCENT = "#c8a84b"     # saffron gold
TONE  = "warm-editorial"

# --- credentials (real values baked in; env vars override if set) -------------
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://neondb_owner:npg_Dfar3YXQ9AFK@ep-sparkling-grass-ah1zobz0-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
)
HUB_WORKSPACE = os.environ.get("HUB_WORKSPACE", "b2236a00-faa2-41d5-8ee7-b6e24d0c4904")


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
    return Path(__file__).resolve().parent.parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed ViaKashmir content into the Content Hub.")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    day = repo_root() / "content" / SLUG / args.date
    if not day.is_dir():
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "no content dir: %s" % day}))
        return 4

    n = Neon(DATABASE_URL)
    if not n.q("select id from workspaces where id=$1", [HUB_WORKSPACE]):
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "workspace not found: %s" % HUB_WORKSPACE}))
        return 4

    rows = n.q("select id from content_businesses where workspace_id=$1 and slug=$2",
               [HUB_WORKSPACE, SLUG])
    if rows:
        biz, created = rows[0]["id"], False
        n.q("""update content_businesses
                 set name=$3, brand_color=$4, accent_color=$5, tone=$6, logo_url=$7
               where id=$1 and workspace_id=$2""",
            [biz, HUB_WORKSPACE, NAME, BRAND, ACCENT, TONE, LOGO])
    else:
        biz, created = str(uuid.uuid4()), True
        n.q("""insert into content_businesses
                 (id,workspace_id,name,slug,brand_color,accent_color,tone,logo_url)
               values ($1,$2,$3,$4,$5,$6,$7,$8)""",
            [biz, HUB_WORKSPACE, NAME, SLUG, BRAND, ACCENT, TONE, LOGO])

    rep = {"engine": SLUG, "date": args.date, "business_id": biz,
           "created_business": created, "inserted": 0, "skipped": 0, "failures": []}

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
            jobs.append((name, "html_email", eh, subj, None,
                         [code, track] + ([seas] if seas else []), ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track], None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track], None))
        for title, atype, content, s, plat, tags, amp in jobs:
            try:
                if n.q("select 1 from content_assets where business_id=$1 and title=$2 limit 1",
                       [biz, title]):
                    rep["skipped"] += 1
                    continue
                n.q("""insert into content_assets
                         (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)""",
                    [str(uuid.uuid4()), HUB_WORKSPACE, biz, title, atype, content, s, plat,
                     json.dumps(tags), amp])
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
