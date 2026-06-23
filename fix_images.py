#!/usr/bin/env python3
"""Upload local Pixabay images to Supabase Storage, patch HTML + DB, push to main."""
import json, re, subprocess, sys, requests
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAY = "2026-06-22"
DAY_DIR = ROOT / "content-hub" / "date-khaas" / DAY

SUPABASE_URL = "https://cmdnezltteldysoxyjzh.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5lemx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwiZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM"
BUCKET = "email"

HEADERS_JSON = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

ROW_IDS = {
    "01": "02487440-e637-4273-82b9-f08cf99e8282",
    "02": "2b05a271-f41f-45d3-97ea-71463908cad5",
    "03": "d80ed213-4a94-4776-9850-ee2c8919e37a",
    "04": "065dd4c8-27a0-4f81-a61d-63036c2fc515",
}

def public_url(storage_path):
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{storage_path}"

def upload_image(local_path: Path, storage_path: str) -> str:
    """Upload file to Supabase Storage. Returns public URL."""
    data = local_path.read_bytes()
    content_type = "image/jpeg" if local_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
    h = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": content_type,
        "x-upsert": "true",  # overwrite if already uploaded
    }
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{storage_path}"
    r = requests.post(url, headers=h, data=data, timeout=60)
    if not r.ok:
        print(f"  ! upload {local_path.name} → {r.status_code}: {r.text[:200]}", file=sys.stderr)
        r.raise_for_status()
    return public_url(storage_path)

def rest(method, path, **kwargs):
    url = f"{SUPABASE_URL}/rest/v1{path}"
    r = requests.request(method, url, headers=HEADERS_JSON, timeout=30, **kwargs)
    if not r.ok:
        print(f"  ! {method} {path} → {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()
    return r.json() if r.text else {}

def load_item(prefix):
    p = next(DAY_DIR.glob(f"{prefix}-*.json"))
    return json.loads(p.read_text()), p

def save_item(data, path):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

# ── Upload all images in the images/ dir ─────────────────────────────────────
img_dir = DAY_DIR / "images"
local_images = sorted(img_dir.glob("*.jpg")) + sorted(img_dir.glob("*.png"))
print(f"Uploading {len(local_images)} images to Supabase Storage bucket '{BUCKET}'…")

url_map = {}  # local filename → public CDN URL
for img in local_images:
    storage_path = f"date-khaas/{DAY}/{img.name}"
    pub = upload_image(img, storage_path)
    url_map[img.name] = pub
    print(f"  ↳ {img.name} → {pub}")

# ── Build per-item image URL list ─────────────────────────────────────────────
def item_urls(prefix_slug):
    """Return list of stable public URLs for an item, matching by filename prefix."""
    slug = re.sub(r"[^a-z0-9]+", "-", prefix_slug.lower()).strip("-")
    matched = [url_map[k] for k in sorted(url_map) if k.startswith(slug)]
    return matched

wedding_urls  = item_urls("muslim-wedding-ceremony")   # item 01
nikah_urls    = item_urls("nikah-ceremony")             # item 02 (now real wedding from item01 substitution below)
whatsapp_urls = item_urls("muslim-bride-groom")         # item 03
linkedin_urls = item_urls("muslim-wedding-celebration") # item 04

# AMP email should use wedding-ceremony images (item01) not the tea-ceremony nikah ones
amp_slide_urls = wedding_urls  # guaranteed wedding photos

print(f"\nWedding images for standard + AMP: {len(wedding_urls)}")
print(f"WhatsApp images: {len(whatsapp_urls)}")
print(f"LinkedIn images: {len(linkedin_urls)}")

# ── Load items ────────────────────────────────────────────────────────────────
item1, path1 = load_item("01")
item2, path2 = load_item("02")
item3, path3 = load_item("03")
item4, path4 = load_item("04")

hero = wedding_urls[0]

# ── Fix standard email ────────────────────────────────────────────────────────
# Replace ANY pixabay.com/get/... src AND the datekhaas placeholder
body1 = item1["body"]
# Replace all pixabay get-URLs with stable storage URLs (they appear as src attributes)
for i, wu in enumerate(wedding_urls):
    pass  # we'll do a regex replace below

# Replace old (now-404) src values with stable ones
PIXABAY_GET = re.compile(r'https://pixabay\.com/get/[^"\'>\s]+')
occurrences = PIXABAY_GET.findall(body1)
for j, old in enumerate(occurrences):
    body1 = body1.replace(old, wedding_urls[j % len(wedding_urls)], 1)
# Also replace datekhaas placeholder if still present
body1 = body1.replace("https://datekhaas.com/images/hero-nikah.jpg", hero)
item1["body"] = body1
next(DAY_DIR.glob("01-*.html")).write_text(body1)
save_item(item1, path1)
print(f"\n  ↳ standard email: replaced image URLs → stable storage")

# ── Fix AMP email ─────────────────────────────────────────────────────────────
body2 = item2["body"]
fallback2 = item2.get("body_fallback", "")
pixabay_get_amp = PIXABAY_GET.findall(body2)
for j, old in enumerate(pixabay_get_amp):
    body2 = body2.replace(old, amp_slide_urls[j % len(amp_slide_urls)], 1)
# Also handle any cdn.pixabay.com/photo/placeholder-*.jpg still remaining
body2 = re.sub(r'https://cdn\.pixabay\.com/photo/placeholder[^"\'>\s]+', hero, body2)
body2 = body2.replace("https://datekhaas.com/images/hero-nikah.jpg", hero)

# Fix fallback too
fallback2 = re.sub(r'https://pixabay\.com/get/[^"\'>\s]+', hero, fallback2)
fallback2 = fallback2.replace("https://datekhaas.com/images/hero-nikah.jpg", hero)

item2["body"] = body2
item2["body_fallback"] = fallback2
next(DAY_DIR.glob("02-*.html")).write_text(body2)
save_item(item2, path2)
print(f"  ↳ AMP email: replaced image URLs → stable storage")

# ── Patch all 4 Supabase rows ─────────────────────────────────────────────────
print("\nPatching Supabase rows with stable image URLs…")

rest("PATCH", f"/content_assets?id=eq.{ROW_IDS['01']}", json={
    "content": body1,
    "image_url": hero,
})
print(f"  ↳ patched html_email/standard  id={ROW_IDS['01']}")

rest("PATCH", f"/content_assets?id=eq.{ROW_IDS['02']}", json={
    "amp_content": body2,
    "content": fallback2,
    "image_url": hero,
})
print(f"  ↳ patched html_email/amp       id={ROW_IDS['02']}")

rest("PATCH", f"/content_assets?id=eq.{ROW_IDS['03']}", json={
    "image_url": whatsapp_urls[0] if whatsapp_urls else hero,
})
print(f"  ↳ patched whatsapp             id={ROW_IDS['03']}")

rest("PATCH", f"/content_assets?id=eq.{ROW_IDS['04']}", json={
    "image_url": linkedin_urls[0] if linkedin_urls else hero,
})
print(f"  ↳ patched other/linkedin       id={ROW_IDS['04']}")

print("\nAll images stable. Ready to merge to main.")
