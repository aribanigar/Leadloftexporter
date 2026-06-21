#!/usr/bin/env python3
"""
seed_via_kashmir_itinerary.py - seed ONE day of ViaKashmir Itinerary
(viakashmiritinerary.in) content into the Content Hub DB. Independent of the main
ViaKashmir engine: it only ever touches the 'via-kashmir-itinerary' business and
the content/via-kashmir-itinerary/ tree.

Uses the Supabase PostgREST REST API (port 443) — works from routine runners /
sandboxes that allow only HTTPS egress. Standard library only - no psycopg.

Reads what build_itin.py wrote under:
  content/via-kashmir-itinerary/<date>/<market>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
Markets (one folder each): india | kashmir | saudi | dubai

Usage:
  python3 scripts/seed_via_kashmir_itinerary.py --date 2026-06-15   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, sys, uuid
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# --- this engine's fixed identity ---------------------------------------------
SLUG   = "via-kashmir-itinerary"
NAME   = "Via Kashmir Itinerary"
LOGO   = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND  = "#0e3d2f"
ACCENT = "#c8a84b"
TONE   = "warm-editorial"

# --- Supabase credentials (env vars override) ---------------------------------
SUPABASE_URL = os.environ.get(
    "SUPABASE_URL",
    "https://cmdnezltteldysoxyjzh.supabase.co",
).rstrip("/")

SUPABASE_JWT = os.environ.get(
    "SUPABASE_SERVICE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5lemx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwiZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM",
)

HUB_WORKSPACE = os.environ.get("HUB_WORKSPACE", "1a716353-9472-4c1d-ae89-f95052e8f015")

BASE = SUPABASE_URL + "/rest/v1"


def _headers(extra=None):
    h = {
        "apikey": SUPABASE_JWT,
        "Authorization": "Bearer " + SUPABASE_JWT,
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def _get(table: str, params: dict) -> list:
    qs = urlencode(params)
    url = "%s/%s?%s" % (BASE, table, qs)
    req = Request(url, headers=_headers())
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError("GET %s %s: %s" % (table, params, e.read().decode()[:300]))
    except URLError as e:
        raise RuntimeError("GET %s unreachable: %s" % (table, e))


def _post(table: str, body: dict) -> None:
    data = json.dumps(body).encode()
    req = Request("%s/%s" % (BASE, table), data=data, method="POST",
                  headers=_headers({"Prefer": "return=minimal"}))
    try:
        with urlopen(req, timeout=30):
            pass
    except HTTPError as e:
        raise RuntimeError("POST %s: %s" % (table, e.read().decode()[:300]))
    except URLError as e:
        raise RuntimeError("POST %s unreachable: %s" % (table, e))


def _patch(table: str, params: dict, body: dict) -> None:
    qs = urlencode(params)
    data = json.dumps(body).encode()
    req = Request("%s/%s?%s" % (BASE, table, qs), data=data, method="PATCH",
                  headers=_headers({"Prefer": "return=minimal"}))
    try:
        with urlopen(req, timeout=30):
            pass
    except HTTPError as e:
        raise RuntimeError("PATCH %s %s: %s" % (table, params, e.read().decode()[:300]))
    except URLError as e:
        raise RuntimeError("PATCH %s unreachable: %s" % (table, e))


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

    # verify workspace exists
    rows = _get("workspaces", {"id": "eq.%s" % HUB_WORKSPACE, "select": "id"})
    if not rows:
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "workspace not found: %s" % HUB_WORKSPACE}))
        return 4

    # upsert business
    rows = _get("content_businesses",
                {"workspace_id": "eq.%s" % HUB_WORKSPACE,
                 "slug": "eq.%s" % SLUG,
                 "select": "id"})
    if rows:
        biz, created = rows[0]["id"], False
        _patch("content_businesses",
               {"id": "eq.%s" % biz, "workspace_id": "eq.%s" % HUB_WORKSPACE},
               {"name": NAME, "brand_color": BRAND, "accent_color": ACCENT,
                "tone": TONE, "logo_url": LOGO})
    else:
        biz, created = str(uuid.uuid4()), True
        _post("content_businesses",
              {"id": biz, "workspace_id": HUB_WORKSPACE, "name": NAME,
               "slug": SLUG, "brand_color": BRAND, "accent_color": ACCENT,
               "tone": TONE, "logo_url": LOGO})

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
                exists = _get("content_assets",
                              {"business_id": "eq.%s" % biz,
                               "title": "eq.%s" % title,
                               "select": "id",
                               "limit": "1"})
                if exists:
                    rep["skipped"] += 1
                    continue
                row = {"id": str(uuid.uuid4()), "workspace_id": HUB_WORKSPACE,
                       "business_id": biz, "title": title, "type": atype,
                       "content": content, "tags": tags}
                if s:
                    row["subject"] = s
                if plat:
                    row["platform"] = plat
                if amp:
                    row["amp_content"] = amp
                _post("content_assets", row)
                rep["inserted"] += 1
            except Exception as e:
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
