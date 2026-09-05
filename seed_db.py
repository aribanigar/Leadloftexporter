#!/usr/bin/env python3
"""Seed content_assets into Supabase via REST API (HTTPS, no direct Postgres needed)."""
import json, os, sys, uuid
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent
DAY = "2026-06-22"
DAY_DIR = ROOT / "content-hub" / "date-khaas" / DAY

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://cmdnezltteldysoxyjzh.supabase.co")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not SERVICE_KEY:
    sys.exit("SUPABASE_SERVICE_KEY env var not set (never hardcode this — it's a full-admin secret).")
WORKSPACE_ID = "1a716353-9472-4c1d-ae89-f95052e8f015"
BUSINESS_SLUG = "date-khaas"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

def rest(method, path, **kwargs):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    r = requests.request(method, url, headers=HEADERS, timeout=30, **kwargs)
    if not r.ok:
        print(f"  ! {method} {path} → {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()
    return r.json()

def find_or_create_business():
    rows = rest("GET", f"/content_businesses?slug=eq.{BUSINESS_SLUG}&workspace_id=eq.{WORKSPACE_ID}&select=id,name,slug")
    if rows:
        bid = rows[0]["id"]
        print(f"  ↳ found business: {rows[0]['name']} ({bid})")
        return bid
    # create
    payload = {
        "id": str(uuid.uuid4()),
        "workspace_id": WORKSPACE_ID,
        "name": "Date Khaas",
        "slug": BUSINESS_SLUG,
        "description": "Muslim matrimony app with an editorial/gallery identity.",
        "brand_color": "#003527",
        "accent_color": "#e9c176",
        "tone": "warm, literary, faith-aware",
    }
    rows = rest("POST", "/content_businesses", json=payload)
    if isinstance(rows, list):
        rows = rows[0]
    bid = rows["id"]
    print(f"  ↳ created business: Date Khaas ({bid})")
    return bid

def load_items():
    items = []
    for p in sorted(DAY_DIR.glob("*.json")):
        it = json.loads(p.read_text())
        items.append(it)
    return items

def first_image_url(item):
    imgs = item.get("images") or item.get("metadata", {}).get("images") or []
    for img in imgs:
        if img.get("remote_url"):
            return img["remote_url"]
    return None

def main():
    print(f"Seeding content_assets for {DAY} via Supabase REST API...")
    business_id = find_or_create_business()

    items = load_items()
    print(f"  ↳ loaded {len(items)} items from {DAY_DIR.relative_to(ROOT)}")

    inserted = []
    for it in items:
        # Map content.json fields → content_assets columns
        item_type = it.get("type", "other")
        # Normalise type to the values the app uses
        type_map = {
            "html_email": "email",
            "whatsapp": "whatsapp",
            "other": "other",
            "caption": "caption",
            "sms": "sms",
        }
        content_type = type_map.get(item_type, item_type)

        # For AMP email, store AMP body in amp_content and plain fallback in content
        body = it.get("body") or it.get("content") or ""
        amp_body = it.get("body_fallback")  # for AMP emails: plain fallback goes in content, AMP goes in amp_content
        if it.get("format") == "amp":
            amp_content = body         # the ⚡4email body
            content = amp_body or body  # plain fallback
        else:
            content = body
            amp_content = None

        tags = [
            "date-khaas",
            f"muharram-1448",
            it.get("format", item_type),
            "draft",
            DAY,
        ]
        if it.get("channel"):
            tags.append(it["channel"])

        notes_obj = {
            "angle": "Begin with intention — your match is already written",
            "preheader": it.get("preheader"),
            "cta_url": it.get("cta_url"),
            "format": it.get("format"),
            "image_query": it.get("image_query"),
            "images": it.get("images"),
            "research_sources": (it.get("metadata") or {}).get("research_sources"),
            "generated_by": "datekhaas-daily-routine",
            "date": DAY,
        }

        row = {
            "id": str(uuid.uuid4()),
            "workspace_id": WORKSPACE_ID,
            "business_id": business_id,
            "title": (it.get("title") or "Untitled")[:200],
            "type": content_type,
            "content": content,
            "tags": tags,
        }
        if amp_content:
            row["amp_content"] = amp_content
        subject = it.get("subject")
        if subject:
            row["subject"] = subject[:300]
        platform = it.get("channel")
        if platform:
            row["platform"] = platform[:40]
        image_url = first_image_url(it)
        if image_url:
            row["image_url"] = image_url
        row["notes"] = json.dumps(notes_obj, ensure_ascii=False)

        result = rest("POST", "/content_assets", json=row)
        if isinstance(result, list):
            result = result[0]
        rid = result.get("id", row["id"])
        inserted.append(rid)
        print(f"  ↳ inserted {it.get('type','?'):<11} platform={it.get('channel','?'):<10} id={rid}")

    print(f"\nDone. Seeded {len(inserted)} rows.")
    print("IDs:", inserted)
    return inserted

if __name__ == "__main__":
    main()
