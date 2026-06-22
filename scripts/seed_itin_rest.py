#!/usr/bin/env python3
"""
seed_itin_rest.py - seed ViaKashmir Itinerary content via Supabase REST API
(no psycopg2 / no direct Postgres port needed).
"""
import argparse, datetime as dt, json, os, sys, uuid
from pathlib import Path

SUPABASE_URL = "https://cmdnezltteldysoxyjzh.supabase.co"
SERVICE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5lemx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwiZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM"

SLUG  = "via-kashmir-itinerary"
NAME  = "Via Kashmir Itinerary"
LOGO  = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND = "#0e3d2f"
ACCENT = "#c8a84b"
TONE  = "warm-editorial"
HUB_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"

import requests

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}
REST = f"{SUPABASE_URL}/rest/v1"


def get(table, params):
    r = requests.get(f"{REST}/{table}", headers=HEADERS, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def post(table, data, upsert=False):
    h = dict(HEADERS)
    if upsert:
        h["Prefer"] = "resolution=merge-duplicates,return=representation"
    r = requests.post(f"{REST}/{table}", headers=h, json=data, timeout=20)
    r.raise_for_status()
    return r.json()


def patch(table, params, data):
    r = requests.patch(f"{REST}/{table}", headers=HEADERS, params=params, json=data, timeout=20)
    r.raise_for_status()
    return r.json()


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def repo_root():
    return Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    day = repo_root() / "content" / SLUG / args.date
    if not day.is_dir():
        print(json.dumps({"error": f"no content dir: {day}"}))
        return 4

    # verify workspace
    ws = get("workspaces", {"select": "id", "id": f"eq.{HUB_WORKSPACE}"})
    if not ws:
        print(json.dumps({"error": f"workspace not found: {HUB_WORKSPACE}"}))
        return 4

    # find or create business
    rows = get("content_businesses", {"select": "id", "workspace_id": f"eq.{HUB_WORKSPACE}", "slug": f"eq.{SLUG}"})
    if rows:
        biz = rows[0]["id"]
        created = False
        patch("content_businesses", {"id": f"eq.{biz}", "workspace_id": f"eq.{HUB_WORKSPACE}"},
              {"name": NAME, "brand_color": BRAND, "accent_color": ACCENT, "tone": TONE, "logo_url": LOGO})
    else:
        biz = str(uuid.uuid4())
        created = True
        post("content_businesses", {
            "id": biz, "workspace_id": HUB_WORKSPACE, "name": NAME, "slug": SLUG,
            "brand_color": BRAND, "accent_color": ACCENT, "tone": TONE, "logo_url": LOGO,
        })

    rep = {"engine": SLUG, "date": args.date, "business_id": biz,
           "created_business": created, "inserted": 0, "skipped": 0, "failures": []}

    meta_files = sorted({p.parent for p in day.rglob("meta.json")})
    for sd in meta_files:
        m_txt = read(sd / "meta.json")
        if not m_txt:
            continue
        m = json.loads(m_txt)
        code  = m.get("campaign_code", sd.name)
        name  = m.get("campaign_name", code)
        subj  = m.get("subject")
        track = m.get("track", sd.name)
        market = m.get("market", track)
        eh = read(sd / "email.html")
        ea = read(sd / "email.amp.html")
        wa = read(sd / "whatsapp.txt")
        li = read(sd / "linkedin.txt")

        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, track, market], ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track, market], None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track, market], None))

        for title, atype, content, s, plat, tags, amp in jobs:
            try:
                existing = get("content_assets", {
                    "select": "id", "business_id": f"eq.{biz}", "title": f"eq.{title}", "limit": "1"
                })
                if existing:
                    rep["skipped"] += 1
                    continue
                row = {
                    "id": str(uuid.uuid4()),
                    "workspace_id": HUB_WORKSPACE,
                    "business_id": biz,
                    "title": title,
                    "type": atype,
                    "content": content,
                    "subject": s,
                    "platform": plat,
                    "tags": tags,
                    "amp_content": amp,
                }
                post("content_assets", row)
                rep["inserted"] += 1
            except Exception as e:
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
