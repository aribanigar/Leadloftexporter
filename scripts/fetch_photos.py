#!/usr/bin/env python3
"""
fetch_photos.py - fetch a watermark-free photo from Pixabay and save it to the
via-kashmir-itinerary photo pool.

Usage:
  python3 scripts/fetch_photos.py --query "kerala india" --tag kerala
  python3 scripts/fetch_photos.py --query "cappadocia turkey" --tag cappadocia

API key read from PIXABAY_API_KEY env var (optional in code below).
Saved to: content/via-kashmir-itinerary/_assets/photos/<tag>.jpg
"""
import argparse, os, sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urlencode
import json

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
PIXABAY_API_KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")


def fetch(query: str, tag: str) -> Path:
    POOL.mkdir(parents=True, exist_ok=True)
    dest = POOL / f"{tag}.jpg"
    if dest.exists() and dest.stat().st_size > 10_000:
        print(f"  {tag}.jpg already in pool ({dest.stat().st_size // 1024}KB), skipping fetch")
        return dest

    params = urlencode({
        "key": PIXABAY_API_KEY,
        "q": query,
        "image_type": "photo",
        "orientation": "horizontal",
        "category": "travel,nature,places",
        "min_width": 1200,
        "min_height": 800,
        "safesearch": "true",
        "per_page": 10,
        "order": "popular",
    })
    url = f"https://pixabay.com/api/?{params}"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as r:
        data = json.loads(r.read())

    hits = data.get("hits", [])
    if not hits:
        raise SystemExit(f"No Pixabay results for: {query}")

    img_url = hits[0]["largeImageURL"]
    print(f"  Fetching {tag}.jpg from: {img_url[:80]}...")
    img_req = Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(img_req, timeout=60) as r:
        content = r.read()

    dest.write_bytes(content)
    print(f"  Saved {tag}.jpg ({len(content) // 1024}KB)")
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--tag", required=True)
    a = ap.parse_args()
    fetch(a.query, a.tag)


if __name__ == "__main__":
    main()
