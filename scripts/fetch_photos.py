#!/usr/bin/env python3
"""
fetch_photos.py - Fetch watermark-free photos from Pixabay only.

Usage:
  python3 scripts/fetch_photos.py --query "manali mountains himachal" --tag manali
  python3 scripts/fetch_photos.py --query "cappadocia turkey balloons" --tag cappadocia
"""
import argparse, json, os, sys, urllib.parse, urllib.request
from pathlib import Path

PIXABAY_KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")
PHOTOS_DIR = Path(__file__).parent.parent / "content" / "via-kashmir-itinerary" / "_assets" / "photos"


def fetch(query: str, tag: str, force: bool = False) -> str:
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    out = PHOTOS_DIR / f"{tag}.jpg"
    if out.exists() and not force:
        print(f"[fetch_photos] {tag}.jpg already cached — skipping fetch")
        return str(out)

    base = "https://pixabay.com/api/"
    params = {
        "key": PIXABAY_KEY,
        "q": query,
        "image_type": "photo",
        "orientation": "horizontal",
        "per_page": 10,
        "safesearch": "true",
        "min_width": 1200,
    }
    url = base + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"[fetch_photos] API error: {e}", file=sys.stderr)
        return ""

    hits = data.get("hits", [])
    if not hits:
        # retry without min_width
        params.pop("min_width")
        url2 = base + "?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(url2, timeout=20) as r:
                data = json.loads(r.read())
            hits = data.get("hits", [])
        except Exception:
            pass

    if not hits:
        print(f"[fetch_photos] No Pixabay results for '{query}'", file=sys.stderr)
        return ""

    hit = hits[0]
    # webformatURL (640px) is always downloadable; largeImageURL requires auth on some plans
    img_url = hit.get("webformatURL") or hit.get("largeImageURL")
    if not img_url:
        print(f"[fetch_photos] No image URL in result", file=sys.stderr)
        return ""

    try:
        req = urllib.request.Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            out.write_bytes(r.read())
    except Exception as e:
        print(f"[fetch_photos] Download error: {e}", file=sys.stderr)
        return ""

    w, h = hit.get("imageWidth", "?"), hit.get("imageHeight", "?")
    print(f"[fetch_photos] ✓ {tag}.jpg  ({w}×{h})  Pixabay id={hit['id']}")
    return str(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Fetch a photo from Pixabay and save to the asset pool.")
    ap.add_argument("--query", required=True, help="Search query")
    ap.add_argument("--tag", required=True, help="Output filename (without .jpg)")
    ap.add_argument("--force", action="store_true", help="Re-fetch even if file exists")
    args = ap.parse_args()
    result = fetch(args.query, args.tag, args.force)
    sys.exit(0 if result else 1)
