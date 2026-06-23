#!/usr/bin/env python3
"""Fix image placeholders, swap AMP tea-ceremony images, and publish all 4 content_assets."""
import json, sys, requests
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAY = "2026-06-22"
DAY_DIR = ROOT / "content-hub" / "date-khaas" / DAY

SUPABASE_URL = "https://cmdnezltteldysoxyjzh.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5lemx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwiZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# Row IDs inserted yesterday
ROW_IDS = {
    "01": "02487440-e637-4273-82b9-f08cf99e8282",   # standard email
    "02": "2b05a271-f41f-45d3-97ea-71463908cad5",   # AMP email
    "03": "d80ed213-4a94-4776-9850-ee2c8919e37a",   # whatsapp
    "04": "065dd4c8-27a0-4f81-a61d-63036c2fc515",   # linkedin
}

def rest(method, path, **kwargs):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    r = requests.request(method, url, headers=HEADERS, timeout=30, **kwargs)
    if not r.ok:
        print(f"  ! {method} {path} → {r.status_code}: {r.text[:400]}", file=sys.stderr)
        r.raise_for_status()
    return r.json() if r.text else {}

def load_item(prefix):
    p = next(DAY_DIR.glob(f"{prefix}-*.json"))
    return json.loads(p.read_text()), p

def save_item(data, path):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

def patch_row(row_id, payload):
    return rest("PATCH", f"/content_assets?id=eq.{row_id}", json=payload)

def tag_swap(tags):
    tags = [t for t in tags if t not in ("draft",)]
    if "published" not in tags:
        tags.insert(0, "published")
    return tags

# ── Load items ────────────────────────────────────────────────────────────────
item1, path1 = load_item("01")   # standard email — has real wedding images
item2, path2 = load_item("02")   # AMP email — has tea ceremony images (BAD)
item3, path3 = load_item("03")   # whatsapp
item4, path4 = load_item("04")   # linkedin

# Real wedding image URLs (from item 1 — confirmed wedding photos)
wedding_imgs = [img["remote_url"] for img in item1.get("images", [])]
hero_url  = wedding_imgs[0]   # OlcayErtem 8028163 — wedding/newlyweds
slide2_url = wedding_imgs[1]  # OlcayErtem 4615557 — couple
slide3_url = wedding_imgs[2]  # Pexels 1868868 — ceremony

print("Wedding image URLs confirmed:")
for u in wedding_imgs:
    print(f"  {u[:80]}…")

# ── Fix standard email: replace placeholder hero src ─────────────────────────
HERO_PLACEHOLDER = "https://datekhaas.com/images/hero-nikah.jpg"
body1 = item1["body"].replace(HERO_PLACEHOLDER, hero_url)
item1["body"] = body1

html1_path = next(DAY_DIR.glob("01-*.html"))
html1_path.write_text(body1)
save_item(item1, path1)
print(f"\n  ↳ fixed standard email hero image → {hero_url[:60]}…")

# ── Fix AMP email: swap tea-ceremony placeholders for wedding photos ──────────
PLACEHOLDERS = [
    "https://cdn.pixabay.com/photo/placeholder-nikah.jpg",
    "https://cdn.pixabay.com/photo/placeholder-wedding.jpg",
    "https://cdn.pixabay.com/photo/placeholder-couple.jpg",
]
body2 = item2["body"]
for i, ph in enumerate(PLACEHOLDERS):
    real = wedding_imgs[i % len(wedding_imgs)]
    body2 = body2.replace(ph, real)

# Also fix fallback body
fallback2 = item2.get("body_fallback", "").replace(HERO_PLACEHOLDER, hero_url)
item2["body"] = body2
item2["body_fallback"] = fallback2

html2_path = next(DAY_DIR.glob("02-*.html"))
html2_path.write_text(body2)
save_item(item2, path2)
print(f"  ↳ fixed AMP carousel: 3 tea-ceremony placeholders → wedding images")

# ── Patch all 4 rows in Supabase ─────────────────────────────────────────────
print("\nPublishing to Supabase…")

# 01 — standard email
patch_row(ROW_IDS["01"], {
    "content": body1,
    "image_url": hero_url,
    "tags": tag_swap(item1.get("metadata", {}).get("tags", ["date-khaas","muharram-1448","standard","draft","2026-06-22","email"])),
})
print(f"  ↳ published html_email/standard  id={ROW_IDS['01']}")

# 02 — AMP email
patch_row(ROW_IDS["02"], {
    "amp_content": body2,            # ⚡4email goes in amp_content
    "content": fallback2,            # plain fallback in content
    "image_url": hero_url,
    "tags": tag_swap(["date-khaas","muharram-1448","amp","draft","2026-06-22","email"]),
})
print(f"  ↳ published html_email/amp       id={ROW_IDS['02']}")

# 03 — WhatsApp
item3_imgs = [img["remote_url"] for img in item3.get("images", [])]
patch_row(ROW_IDS["03"], {
    "image_url": item3_imgs[0] if item3_imgs else None,
    "tags": tag_swap(["date-khaas","muharram-1448","text","draft","2026-06-22","whatsapp"]),
})
print(f"  ↳ published whatsapp             id={ROW_IDS['03']}")

# 04 — LinkedIn
item4_imgs = [img["remote_url"] for img in item4.get("images", [])]
patch_row(ROW_IDS["04"], {
    "image_url": item4_imgs[0] if item4_imgs else None,
    "tags": tag_swap(["date-khaas","muharram-1448","linkedin","draft","2026-06-22","linkedin"]),
})
print(f"  ↳ published other/linkedin       id={ROW_IDS['04']}")

print("\nAll 4 rows live in Supabase. Images fixed. Tags: published.")
