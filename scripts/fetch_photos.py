#!/usr/bin/env python3
"""
fetch_photos.py - fetch watermark-free photos from Pixabay into the photo pool.
Usage:
  python3 scripts/fetch_photos.py --query "rajasthan india" --tag rajasthan
  python3 scripts/fetch_photos.py --all   # fetch the full default pool
"""
import argparse, os, sys, time
from pathlib import Path
import requests

API_KEY = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")
POOL = Path(__file__).resolve().parent.parent / "content" / "via-kashmir-itinerary" / "_assets" / "photos"

DEFAULT_TAGS = {
    "kashmir":    "kashmir valley mountains",
    "kerala":     "kerala india backwaters",
    "rajasthan":  "rajasthan india palace",
    "goa":        "goa india beach",
    "himalaya":   "himalayas mountains india",
    "varanasi":   "varanasi india ganges",
    "tajmahal":   "taj mahal india agra",
    "cappadocia": "cappadocia turkey balloons",
    "maldives":   "maldives island ocean",
    "alps":       "swiss alps mountains",
    "baku":       "baku azerbaijan city",
    "georgia":    "georgia caucasus landscape",
    "bali":       "bali indonesia temple",
    "thailand":   "thailand temple beautiful",
}

def fetch(query, tag, dry_run=False):
    POOL.mkdir(parents=True, exist_ok=True)
    dest = POOL / f"{tag}.jpg"
    if dest.exists():
        print(f"  {tag}: already in pool ({dest.stat().st_size//1024}KB)")
        return dest

    r = requests.get("https://pixabay.com/api/", params={
        "key": API_KEY, "q": query, "image_type": "photo",
        "orientation": "horizontal", "min_width": 1200, "min_height": 700,
        "safesearch": "true", "per_page": 5, "order": "popular",
    }, timeout=20)
    data = r.json()
    hits = data.get("hits", [])
    if not hits:
        print(f"  {tag}: no results for '{query}'")
        return None

    # pick the largest image available
    hit = hits[0]
    url = hit.get("largeImageURL") or hit.get("webformatURL")
    if dry_run:
        print(f"  {tag}: would download {url}")
        return None

    img = requests.get(url, timeout=30)
    img.raise_for_status()
    dest.write_bytes(img.content)
    print(f"  {tag}: saved {dest.stat().st_size//1024}KB from Pixabay (id={hit['id']})")
    return dest

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query")
    ap.add_argument("--tag")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if a.all:
        for tag, query in DEFAULT_TAGS.items():
            fetch(query, tag, a.dry_run)
            time.sleep(0.3)
    elif a.query and a.tag:
        fetch(a.query, a.tag, a.dry_run)
    else:
        ap.print_help(); sys.exit(1)

if __name__ == "__main__":
    main()
