#!/usr/bin/env python3
"""
publish_to_hub.py — push a day's per-business content into the Content Hub DB.

Talks to Neon over its HTTPS SQL endpoint (port 443), NOT the Postgres wire
protocol (5432), because routine runners and sandboxes usually allow only
HTTPS egress. No psycopg, no pip install: standard library only.

Business-agnostic: nothing is hardcoded. The routine that owns each business
supplies the slug, name, and branding via environment variables. The script
reads files under `content/<slug>/<date>/<CUR>/set-<n>/` and inserts rows
into `content_businesses` + `content_assets`.

Env:
  DATABASE_URL       required. Neon URL (postgresql+psycopg://... accepted; +driver stripped).
  HUB_WORKSPACE      required. Workspace UUID the business folder lives under.
  HUB_BUSINESS_SLUG  required. Folder name under content/ (e.g. "acme-co").
  HUB_BUSINESS_NAME  optional. Display name (default: slug → title case).
  HUB_BRAND_COLOR    optional. Hex (default "#0e6b53").
  HUB_ACCENT_COLOR   optional. Hex (default "#008138").
  HUB_LOGO_URL       optional. Public logo URL.
  HUB_TONE           optional. AI-writer tone (default "vibrant").

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
    slug = os.environ.get("HUB_BUSINESS_SLUG")
    if not slug:
        print(json.dumps({"date": args.date, "error": "HUB_BUSINESS_SLUG not set"}))
        return 2
    biz_name = os.environ.get("HUB_BUSINESS_NAME", slug.replace("-", " ").title())
    brand = os.environ.get("HUB_BRAND_COLOR", "#0e6b53")
    accent = os.environ.get("HUB_ACCENT_COLOR", "#008138")
    logo = os.environ.get("HUB_LOGO_URL", "")
    tone = os.environ.get("HUB_TONE", "vibrant")
    if not db or not ws:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no_secrets)"}))
        return 0

    day = repo_root() / "content" / slug / args.date
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
            [biz, ws, biz_name, slug, brand, accent, tone, logo])

    rep = {"date": args.date, "business_id": biz, "created_business": created,
           "inserted": 0, "skipped": 0, "failures": []}

    for sd in sorted({p.parent for p in day.rglob("meta.json")}):
        m = json.loads(read(sd / "meta.json"))
        cur = m.get("currency", sd.parent.name)
        theme = m.get("theme", sd.name)
        date_s = m.get("date", args.date)
        seas = m.get("season", "")
        image = m.get("image") or None  # hero photo → rides on the WhatsApp asset
        # Stable, unique title per (date, currency, theme) so reruns are no-ops.
        name = m.get("campaign_name") or f"{date_s} · {cur} · {theme}"
        code = m.get("campaign_code", f"{date_s}-{cur}-{theme}")
        subj = m.get("subject")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        # (title, type, content, subject, platform, tags, amp, image_url)
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, cur] + ([seas] if seas else []), ea, None))
        if wa:
            jobs.append((name + " — WhatsApp", "whatsapp", wa, None, None, [code, cur], None, image))
        if li:
            jobs.append((name + " — LinkedIn", "caption", li, None, "linkedin", [code, cur], None, None))
        for title, atype, content, s, plat, tags, amp, image_url in jobs:
            try:
                if n.q("select 1 from content_assets where business_id=$1 and title=$2 limit 1", [biz, title]):
                    rep["skipped"] += 1
                    continue
                n.q("""insert into content_assets
                         (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content,image_url)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)""",
                    [str(uuid.uuid4()), ws, biz, title, atype, content, s, plat, json.dumps(tags), amp, image_url])
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
