#!/usr/bin/env python3
"""
fetch_photos.py - refresh the ViaKashmir Kashmir photo pool from Pixabay.

Pixabay blocks scraping (403) and its API needs a free key, so this uses the
official API and downloads JPEGs into a committed pool. Email/card code then
references these via raw.githubusercontent + wsrv (never hot-links Pixabay CDN
into email, which is unreliable). If PIXABAY_API_KEY is unset, it does nothing
and the routine falls back to whatever is already committed in the pool.

Pixabay Content License: free for commercial use, no attribution required.

Env:
  PIXABAY_API_KEY   optional. Free key from https://pixabay.com/api/docs/
Usage:
  python3 scripts/fetch_photos.py --query "kashmir dal lake shikara" --count 8 --tag dal
Writes:
  content/via-kashmir-itinerary/_assets/photos/<tag>.jpg   (idempotent on tag)
Prints one JSON object {downloaded:[...], skipped:n}.
"""
import argparse, json, os, sys, io
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
try:
    from PIL import Image
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

POOL = Path(__file__).resolve().parent.parent / "content" / "via-kashmir-itinerary" / "_assets" / "photos"

def get(url):
    return urlopen(Request(url, headers={"User-Agent": "ViaKashmir/1.0"}), timeout=60)

def save_sized(raw, path):
    """Write a single JPEG resized to 1200px wide. Falls back to raw if Pillow unavailable."""
    if not HAVE_PIL:
        path.write_bytes(raw)
        return path.name
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w = 1200
    h = int(im.height * w / im.width)
    rs = im.resize((w, h), Image.LANCZOS)
    rs.save(path, "JPEG", quality=84, optimize=True)
    return path.name

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="kashmir landscape")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--tag", default="kashmir")
    a = ap.parse_args()
    key = os.environ.get("PIXABAY_API_KEY", "56316516-fbb10ad7475940758256bc517")
    if not key:
        print(json.dumps({"pixabay": "skipped (no PIXABAY_API_KEY)", "pool": str(POOL)}))
        return 0
    POOL.mkdir(parents=True, exist_ok=True)
    dest = POOL / f"{a.tag}.jpg"
    if dest.exists():
        print(json.dumps({"downloaded": [], "skipped": 1, "existing": str(dest)}))
        return 0
    params = urlencode({"key": key, "q": a.query, "image_type": "photo",
                        "orientation": "horizontal", "safesearch": "true",
                        "per_page": max(3, min(a.count + 5, 50)), "min_width": "1280"})
    data = json.loads(get("https://pixabay.com/api/?" + params).read())
    out = {"downloaded": [], "skipped": 0}
    for hit in data.get("hits", [])[:a.count]:
        src = hit.get("largeImageURL") or hit.get("webformatURL")
        try:
            raw = get(src).read()
            name = save_sized(raw, dest)
            out["downloaded"].append(name)
            break  # one photo per tag
        except Exception as e:  # noqa: BLE001
            out.setdefault("failures", []).append([str(hit.get("id")), str(e)[:120]])
    print(json.dumps(out, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
