#!/usr/bin/env python3
"""Fetch dark cinematic photos from Pixabay, crop to 4:5 (1080x1350), host in public/email/."""
import os, json, urllib.request, urllib.parse, io
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
KEY = os.environ["PIXABAY_API"]
os.makedirs(OUT, exist_ok=True)

TARGET = (1080, 1350)  # 4:5

# service slug -> ordered list of search queries (dark, cinematic, relevant)
QUERIES = {
    "social-media": ["dark cinematic smartphone content", "video creator dark studio", "social media dark neon"],
    "seo": ["dark data analytics dashboard", "search technology dark", "network data dark blue"],
    "website-design": ["dark laptop web design", "developer dark workspace", "code screen dark blue"],
    "erp-building": ["dark server data center blue", "business software dashboard dark", "abstract technology dark blue"],
    "ai-work-studio": ["cinematic film camera dark", "cinema studio lighting dark", "movie set dark cinematic"],
    "schoolos": ["dark modern library books", "university campus evening", "classroom dark cinematic"],
}

def api_search(q):
    url = "https://pixabay.com/api/?" + urllib.parse.urlencode({
        "key": KEY, "q": q, "image_type": "photo", "orientation": "all",
        "safesearch": "true", "order": "popular", "per_page": 20,
    })
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode())

def best_hit(hits):
    # prefer higher resolution, mild preference for portrait/tall
    def score(h):
        w, ht = h.get("imageWidth", 0), h.get("imageHeight", 0)
        tall = 1.15 if ht >= w else 1.0
        return (w * ht) * tall
    return sorted(hits, key=score, reverse=True)

def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()

def crop_45(img):
    img = img.convert("RGB")
    w, h = img.size
    tw, th = TARGET
    target_ratio = tw / th  # 0.8
    ratio = w / h
    if ratio > target_ratio:
        # too wide -> crop width
        new_w = int(h * target_ratio)
        left = (w - new_w) // 2
        img = img.crop((left, 0, left + new_w, h))
    else:
        # too tall -> crop height
        new_h = int(w / target_ratio)
        top = int((h - new_h) * 0.35)  # bias slightly toward upper third
        img = img.crop((0, top, w, top + new_h))
    return img.resize(TARGET, Image.LANCZOS)

def fetch_one(slug, queries):
    for q in queries:
        try:
            data = api_search(q)
        except Exception as e:
            print(f"  [{slug}] query '{q}' api error: {e}")
            continue
        hits = data.get("hits", [])
        if not hits:
            print(f"  [{slug}] no hits for '{q}'")
            continue
        for h in best_hit(hits):
            url = h.get("largeImageURL") or h.get("webformatURL")
            try:
                raw = download(url)
                img = Image.open(io.BytesIO(raw))
                cropped = crop_45(img)
                path = os.path.join(OUT, f"{slug}-photo.jpg")
                cropped.save(path, "JPEG", quality=88, optimize=True)
                print(f"  [{slug}] '{q}' id={h.get('id')} {img.size} -> {cropped.size} saved")
                return {"slug": slug, "query": q, "pixabay_id": h.get("id"),
                        "src_size": list(img.size), "page": h.get("pageURL")}
            except Exception as e:
                print(f"  [{slug}] download/crop failed id={h.get('id')}: {e}")
                continue
    print(f"  [{slug}] FAILED all queries")
    return {"slug": slug, "error": "no photo"}

if __name__ == "__main__":
    manifest = {}
    for slug, queries in QUERIES.items():
        print(f"[fetch] {slug}")
        manifest[slug] = fetch_one(slug, queries)
    with open(os.path.join(ROOT, ".build", "photos.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("photos done")
