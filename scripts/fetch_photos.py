#!/usr/bin/env python3
"""
fetch_photos.py - fetch a watermark-free photo from Pixabay and save to the photo pool.

Usage:
  python3 scripts/fetch_photos.py --query "Kerala backwaters" --tag kerala
  python3 scripts/fetch_photos.py --query "Cappadocia Turkey" --tag cappadocia

Saves to: content/via-kashmir-itinerary/_assets/photos/<tag>.jpg
Requires: PIXABAY_API_KEY env var (falls back to hardcoded dev key).
"""
import argparse, os, sys, urllib.request, urllib.parse, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
API_KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")

def fetch(query, tag):
    POOL.mkdir(parents=True, exist_ok=True)
    dest = POOL / f"{tag}.jpg"
    params = urllib.parse.urlencode({
        "key": API_KEY, "q": query, "image_type": "photo",
        "orientation": "horizontal", "safesearch": "true",
        "per_page": 5, "min_width": 1200,
    })
    url = f"https://pixabay.com/api/?{params}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            data = json.load(r)
    except Exception as e:
        print(f"  Pixabay API error: {e}", file=sys.stderr)
        return None
    hits = data.get("hits", [])
    if not hits:
        print(f"  No results for '{query}'", file=sys.stderr)
        return None
    photo_url = hits[0].get("webformatURL") or hits[0].get("largeImageURL")
    try:
        req = urllib.request.Request(photo_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            dest.write_bytes(resp.read())
        print(f"  saved {dest} ({dest.stat().st_size // 1024}KB)")
        return str(dest)
    except Exception as e:
        print(f"  download error: {e}", file=sys.stderr)
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--tag", required=True)
    a = ap.parse_args()
    result = fetch(a.query, a.tag)
    if not result:
        sys.exit(1)

if __name__ == "__main__":
    main()
