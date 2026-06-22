#!/usr/bin/env python3
"""
fetch_photos.py  — Pixabay-only photo fetcher for ViaKashmir Itinerary content engine.
Saves watermark-free images to content/via-kashmir-itinerary/_assets/photos/<tag>.jpg.

Usage:
    python3 scripts/fetch_photos.py --query "kerala backwaters" --tag kerala
    python3 scripts/fetch_photos.py --query "cappadocia balloons" --tag cappadocia
"""
import argparse, os, sys, urllib.request, urllib.parse
from pathlib import Path

PIXABAY_KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")
OUT_DIR = Path(__file__).resolve().parent.parent / "content" / "via-kashmir-itinerary" / "_assets" / "photos"


def fetch(query: str, tag: str, orientation: str = "horizontal") -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUT_DIR / f"{tag}.jpg"

    params = urllib.parse.urlencode({
        "key": PIXABAY_KEY,
        "q": query,
        "image_type": "photo",
        "orientation": orientation,
        "category": "travel",
        "min_width": 1200,
        "safesearch": "true",
        "per_page": 5,
        "order": "popular",
    })
    url = f"https://pixabay.com/api/?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "ViaKashmir/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        import json
        data = json.load(resp)

    hits = data.get("hits", [])
    if not hits:
        print(f"[fetch_photos] No results for '{query}'", file=sys.stderr)
        return None

    img_url = hits[0]["largeImageURL"]
    print(f"[fetch_photos] Downloading {img_url} -> {dest}")
    req2 = urllib.request.Request(img_url, headers={"User-Agent": "ViaKashmir/1.0"})
    with urllib.request.urlopen(req2, timeout=30) as resp2:
        dest.write_bytes(resp2.read())

    print(f"[fetch_photos] Saved {dest} ({dest.stat().st_size // 1024} KB)")
    return dest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--orientation", default="horizontal", choices=["horizontal", "vertical", "all"])
    args = ap.parse_args()
    result = fetch(args.query, args.tag, args.orientation)
    sys.exit(0 if result else 1)
