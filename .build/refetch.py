#!/usr/bin/env python3
"""Refetch specific slugs with better queries; among top hits pick the darkest suitable one."""
import os, json, urllib.request, urllib.parse, io
from PIL import Image, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
KEY = os.environ["PIXABAY_API"]
TARGET = (1080, 1350)

REDO = {
    "website-design": ["dark computer monitor code", "web developer dark desk night", "programming dark screen blue"],
    "erp-building": ["dark data center servers", "database technology dark blue", "cloud computing dark server room"],
    "ai-work-studio": ["film set cinematic lighting dark", "cinema studio dark dramatic", "movie production dark"],
    "social-media": ["content creator filming dark", "video production dark neon", "smartphone recording dark"],
}

def api_search(q):
    url = "https://pixabay.com/api/?" + urllib.parse.urlencode({
        "key": KEY, "q": q, "image_type": "photo", "orientation": "all",
        "safesearch": "true", "order": "popular", "per_page": 20})
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode())

def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()

def crop_45(img):
    img = img.convert("RGB")
    w, h = img.size
    tr = TARGET[0] / TARGET[1]
    if w / h > tr:
        nw = int(h * tr); left = (w - nw) // 2; img = img.crop((left, 0, left + nw, h))
    else:
        nh = int(w / tr); top = int((h - nh) * 0.35); img = img.crop((0, top, w, top + nh))
    return img.resize(TARGET, Image.LANCZOS)

def brightness(img):
    return ImageStat.Stat(img.convert("L")).mean[0]

def redo(slug, queries):
    candidates = []  # (brightness, cropped, meta)
    for q in queries:
        try:
            hits = api_search(q).get("hits", [])
        except Exception as e:
            print(f"  [{slug}] api err '{q}': {e}"); continue
        hits = sorted(hits, key=lambda h: h.get("imageWidth", 0) * h.get("imageHeight", 0), reverse=True)[:6]
        for h in hits:
            try:
                img = Image.open(io.BytesIO(download(h.get("largeImageURL") or h["webformatURL"])))
                c = crop_45(img)
                b = brightness(c)
                candidates.append((b, c, {"q": q, "id": h.get("id"), "b": round(b, 1), "page": h.get("pageURL")}))
            except Exception as e:
                print(f"  [{slug}] skip id={h.get('id')}: {e}")
        if len(candidates) >= 8:
            break
    if not candidates:
        print(f"  [{slug}] FAILED"); return None
    # prefer dark but not near-black: 25..115 window, else darkest available
    inwin = [c for c in candidates if 25 <= c[0] <= 115]
    pick = min(inwin, key=lambda c: c[0]) if inwin else min(candidates, key=lambda c: c[0])
    pick[1].save(os.path.join(OUT, f"{slug}-photo.jpg"), "JPEG", quality=88, optimize=True)
    print(f"  [{slug}] picked {pick[2]}  (from {len(candidates)} candidates)")
    return pick[2]

if __name__ == "__main__":
    pj = os.path.join(ROOT, ".build", "photos.json")
    man = json.load(open(pj)) if os.path.exists(pj) else {}
    for slug, qs in REDO.items():
        print(f"[refetch] {slug}")
        m = redo(slug, qs)
        if m:
            man[slug] = {"slug": slug, "query": m["q"], "pixabay_id": m["id"], "page": m["page"]}
    json.dump(man, open(pj, "w"), indent=2)
    print("refetch done")
