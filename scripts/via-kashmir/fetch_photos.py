#!/usr/bin/env python3
"""
fetch_photos.py - refresh the ViaKashmir (B2C/B2B tracks) photo pool from Pixabay.

Distinct from scripts/fetch_photos.py (which serves the via-kashmir-ITINERARY pool)
and from the gifts-gulf engine. ALLOWED PHOTO SOURCES ARE ONLY: this Pixabay fetch
(watermark-free, free for commercial use, no attribution) and whatever is already
committed under content/via-kashmir/_assets/photos. NEVER Wikimedia/Google/scraped
stock - that is where watermarked shots come from.

Email/card code references these via raw.githubusercontent + wsrv (never hot-links the
Pixabay CDN into an email). Saved cover-cropped to 1200px wide.

Env:
  PIXABAY_API_KEY   optional. Falls back to the project's free key.
Usage:
  python3 scripts/via-kashmir/fetch_photos.py --query "kashmir dal lake shikara" --tag hero_dal
Writes:
  content/via-kashmir/_assets/photos/<tag>.jpg   (idempotent: keeps an existing good file)
Prints one JSON object.
"""
import argparse, io, json, os, sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    from PIL import Image
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

POOL = Path(__file__).resolve().parent.parent.parent / "content" / "via-kashmir" / "_assets" / "photos"
KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")


def get(url):
    return urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0 ViaKashmir/1.0"}), timeout=60)


def save_cover(raw, dest, w=1200):
    if not HAVE_PIL:
        dest.write_bytes(raw)
        return
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    h = int(im.height * w / im.width)
    im.resize((w, h), Image.LANCZOS).save(dest, "JPEG", quality=84, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="kashmir landscape")
    ap.add_argument("--tag", default="kashmir")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    POOL.mkdir(parents=True, exist_ok=True)
    dest = POOL / f"{a.tag}.jpg"
    if dest.exists() and dest.stat().st_size > 15000 and not a.force:
        print(json.dumps({"tag": a.tag, "status": "kept", "kb": dest.stat().st_size // 1024}))
        return 0
    params = urlencode({"key": KEY, "q": a.query, "image_type": "photo",
                        "orientation": "horizontal", "category": "travel,nature,places",
                        "safesearch": "true", "per_page": 12, "order": "popular",
                        "min_width": "1280"})
    data = json.loads(get("https://pixabay.com/api/?" + params).read())
    hits = data.get("hits", [])
    if not hits:
        print(json.dumps({"tag": a.tag, "status": "no_results", "query": a.query}))
        return 1
    src = hits[0].get("largeImageURL") or hits[0].get("webformatURL")
    raw = get(src).read()
    save_cover(raw, dest)
    print(json.dumps({"tag": a.tag, "status": "fetched", "id": hits[0]["id"],
                      "kb": dest.stat().st_size // 1024}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
