#!/usr/bin/env python3
"""
seed_via_kashmir_itinerary_rest.py - Supabase REST API seeder for ViaKashmir Itinerary.

Fallback for environments where port 5432/6543 is blocked (uses HTTPS only).

Usage:
  python3 scripts/seed_via_kashmir_itinerary_rest.py --date 2026-06-22
"""
import argparse, datetime as dt, json, os, sys, uuid
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import HTTPError

SLUG   = "via-kashmir-itinerary"
NAME   = "Via Kashmir Itinerary"
LOGO   = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND  = "#0e3d2f"
ACCENT = "#c8a84b"
TONE   = "warm-editorial"

SUPABASE_URL   = os.environ.get("SUPABASE_URL", "https://cmdnezltteldysoxyjzh.supabase.co")
HUB_WORKSPACE  = os.environ.get("HUB_WORKSPACE", "1a716353-9472-4c1d-ae89-f95052e8f015")
SUPABASE_KEY   = os.environ.get(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5lemx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwiZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM",
)


def headers(prefer: str = "") -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def api_get(path: str, params: dict = None) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urlencode(params)
    req = Request(url, headers=headers())
    try:
        with urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError(f"GET {path} → {e.code}: {e.read().decode()}")


def api_post(path: str, data: dict, upsert: bool = False) -> dict:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    prefer = "return=representation,resolution=merge-duplicates" if upsert else "return=representation"
    body = json.dumps(data).encode()
    req = Request(url, data=body, headers=headers(prefer), method="POST")
    try:
        with urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError(f"POST {path} → {e.code}: {e.read().decode()}")


def api_patch(path: str, params: dict, data: dict) -> None:
    url = f"{SUPABASE_URL}/rest/v1/{path}?" + urlencode(params)
    body = json.dumps(data).encode()
    req = Request(url, data=body, headers=headers("return=minimal"), method="PATCH")
    try:
        with urlopen(req, timeout=20) as r:
            r.read()
    except HTTPError as e:
        raise RuntimeError(f"PATCH {path} → {e.code}: {e.read().decode()}")


def read_file(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed ViaKashmir Itinerary via Supabase REST API.")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    day = repo_root / "content" / SLUG / args.date
    if not day.is_dir():
        print(json.dumps({"engine": SLUG, "date": args.date, "error": f"no dir: {day}"}))
        return 4

    # Verify workspace
    ws = api_get("workspaces", {"id": f"eq.{HUB_WORKSPACE}", "select": "id"})
    if not ws:
        print(json.dumps({"engine": SLUG, "date": args.date, "error": f"workspace not found: {HUB_WORKSPACE}"}))
        return 4

    # Upsert business
    biz_rows = api_get("content_businesses", {
        "workspace_id": f"eq.{HUB_WORKSPACE}", "slug": f"eq.{SLUG}", "select": "id"
    })
    if biz_rows:
        biz = biz_rows[0]["id"]
        created = False
        api_patch("content_businesses", {"id": f"eq.{biz}", "workspace_id": f"eq.{HUB_WORKSPACE}"}, {
            "name": NAME, "brand_color": BRAND, "accent_color": ACCENT, "tone": TONE, "logo_url": LOGO
        })
    else:
        biz = str(uuid.uuid4())
        created = True
        api_post("content_businesses", {
            "id": biz, "workspace_id": HUB_WORKSPACE, "name": NAME, "slug": SLUG,
            "brand_color": BRAND, "accent_color": ACCENT, "tone": TONE, "logo_url": LOGO
        })

    rep = {
        "engine": SLUG, "date": args.date, "business_id": biz,
        "created_business": created, "inserted": 0, "skipped": 0, "failures": []
    }

    meta_files = sorted({p.parent for p in day.rglob("meta.json")})
    for sd in meta_files:
        raw = read_file(sd / "meta.json")
        if not raw:
            continue
        m = json.loads(raw)
        code   = m.get("campaign_code", sd.name)
        name   = m.get("campaign_name", code)
        subj   = m.get("subject")
        track  = m.get("track", sd.name)
        market = m.get("market", track)
        photo  = m.get("photo") or m.get("hero_photo", "")
        date_s = args.date

        # Image URLs for hub cards
        wsrv_base = "https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main"
        photo_url = (
            f"{wsrv_base}/content/via-kashmir-itinerary/_assets/photos/{photo}.jpg&w=600&output=jpg&q=80"
            if photo else None
        )
        card_url = (
            f"https://raw.githubusercontent.com/aribanigar/Leadloftexporter/main"
            f"/content/via-kashmir-itinerary/{date_s}/{market}/img/whatsapp.jpg"
        )

        eh  = read_file(sd / "email.html")
        ea  = read_file(sd / "email.amp.html")
        wa  = read_file(sd / "whatsapp.txt")
        li  = read_file(sd / "linkedin.txt")

        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, track, market], ea, photo_url))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track, market], None, card_url))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track, market], None, None))

        for title, atype, content, s, plat, tags, amp, img_url in jobs:
            try:
                existing = api_get("content_assets", {
                    "business_id": f"eq.{biz}", "title": f"eq.{title}", "select": "id", "limit": "1"
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
                    "image_url": img_url,
                }
                api_post("content_assets", row)
                rep["inserted"] += 1
            except Exception as e:
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
