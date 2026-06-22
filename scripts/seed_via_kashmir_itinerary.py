#!/usr/bin/env python3
"""
seed_via_kashmir_itinerary.py - seed ONE day of ViaKashmir Itinerary
(viakashmiritinerary.in) content into the Content Hub DB. Independent of the main
ViaKashmir engine: it only ever touches the 'via-kashmir-itinerary' business and
the content/via-kashmir-itinerary/ tree.

Connects to the Supabase Postgres database with psycopg2 using DATABASE_URL. Run it from
an environment that can reach Supabase on port 5432 (or swap in the 6543 transaction
pooler). Needs psycopg2-binary (see scripts/requirements.txt).

Reads what build_itin.py wrote under:
  content/via-kashmir-itinerary/<date>/<market>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
Markets (one folder each): india | kashmir | saudi | dubai

Usage:
  python3 scripts/seed_via_kashmir_itinerary.py --date 2026-06-15   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path

# --- this engine's fixed identity ---------------------------------------------
SLUG  = "via-kashmir-itinerary"
NAME  = "Via Kashmir Itinerary"
LOGO  = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND = "#0e3d2f"
ACCENT = "#c8a84b"
TONE  = "warm-editorial"

# --- credentials (real values baked in; env vars override if set) -------------
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres.cmdnezltteldysoxyjzh:vTqdrCo4vaa4MJzz@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres",
)
HUB_WORKSPACE = os.environ.get("HUB_WORKSPACE", "1a716353-9472-4c1d-ae89-f95052e8f015")

_PARAM = re.compile(r"\$(\d+)")


class DB:
    def __init__(self, dsn: str):
        try:
            import psycopg2
            from psycopg2.extras import RealDictCursor
        except ImportError:
            raise SystemExit("psycopg2 missing - run: pip install psycopg2-binary")
        self._rd = RealDictCursor
        self.c = psycopg2.connect(dsn, connect_timeout=20)
        self.c.autocommit = True

    def q(self, sql: str, params=None):
        params = params or []
        seq = []
        sql2 = _PARAM.sub(lambda m: (seq.append(params[int(m.group(1)) - 1]), "%s")[1], sql)
        with self.c.cursor(cursor_factory=self._rd) as cur:
            cur.execute(sql2, seq)
            return [dict(r) for r in cur.fetchall()] if cur.description else []


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed ViaKashmir Itinerary content into the Content Hub.")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    day = repo_root() / "content" / SLUG / args.date
    if not day.is_dir():
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "no content dir: %s" % day}))
        return 4

    n = DB(DATABASE_URL)
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
        code  = m.get("campaign_code", sd.name)
        name  = m.get("campaign_name", code)
        subj  = m.get("subject")
        track = m.get("track", sd.name)
        market = m.get("market", track)
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, track, market], ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track, market], None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track, market], None))
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
            except Exception as e:
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
