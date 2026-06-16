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
  content/via-kashmir/_assets/photos/<tag>-<id>.jpg   (idempotent on id)
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

POOL = Path(__file__).resolve().parent.parent / "content" / "via-kashmir" / "_assets" / "photos"

def get(url):
    return urlopen(Request(url, headers={"User-Agent": "ViaKashmir/1.0"}), timeout=60)

def save_sized(raw, base):
    """Write <base>-1200.jpg and <base>-600.jpg (cover-cropped widths). Falls back to
    a single <base>.jpg if Pillow is unavailable."""
    if not HAVE_PIL:
        (base.parent / (base.name + ".jpg")).write_bytes(raw)
        return [base.name + ".jpg"]
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    out = []
    for w in (1200, 600):
        h = int(im.height * w / im.width)
        rs = im.resize((w, h), Image.LANCZOS)
        p = base.parent / f"{base.name}-{w}.jpg"
        rs.save(p, "JPEG", quality=84, optimize=True)
        out.append(p.name)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="kashmir landscape")
    ap.add_argument("--count", type=int, default=8)
    ap.add_argument("--tag", default="kashmir")
    a = ap.parse_args()
    key = os.environ.get("PIXABAY_API_KEY")
    if not key:
        print(json.dumps({"pixabay": "skipped (no PIXABAY_API_KEY)", "pool": str(POOL)}))
        return 0
    POOL.mkdir(parents=True, exist_ok=True)
    params = urlencode({"key": key, "q": a.query, "image_type": "photo",
                        "orientation": "horizontal", "safesearch": "true",
                        "per_page": max(3, min(a.count, 50)), "min_width": "1280"})
    data = json.loads(get("https://pixabay.com/api/?" + params).read())
    out = {"downloaded": [], "skipped": 0}
    for hit in data.get("hits", [])[:a.count]:
        pid = hit["id"]
        base = POOL / f"{a.tag}-{pid}"
        if (POOL / f"{a.tag}-{pid}-1200.jpg").exists():
            out["skipped"] += 1
            continue
        src = hit.get("largeImageURL") or hit.get("webformatURL")
        try:
            raw = get(src).read()
            out["downloaded"].extend(save_sized(raw, base))
        except Exception as e:  # noqa: BLE001
            out.setdefault("failures", []).append([str(pid), str(e)[:120]])
    print(json.dumps(out, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
