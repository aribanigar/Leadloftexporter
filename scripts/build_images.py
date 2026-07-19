"""Generate all Hudace email images into public/email/.

- Brand assets: white wordmark logo, mark, social icons.
- Per service: a darkened 4:5 cinematic hero photo (from Pixabay) and a
  baked 4:5 promo card (photo background + logo + headline + deliverables + CTA).

No external image hotlinking: Pixabay is only the search source; the chosen
photo is downloaded and committed. Falls back to a brand gradient if a query
returns nothing or the network is unavailable.
"""
import os, io, json, urllib.request, urllib.parse, urllib.error
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from hudace_data import SERVICES, BRAND, CONTACT

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "email")
os.makedirs(OUT, exist_ok=True)
PIX_KEY = os.environ.get("PIXABAY_API", "")
W, H = 1080, 1350  # 4:5

def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

FONT_DIRS = [
    "/usr/share/fonts/truetype/liberation/",
    "/usr/share/fonts/truetype/dejavu/",
]
def font(bold=False, size=48):
    names = (["LiberationSans-Bold.ttf", "DejaVuSans-Bold.ttf"] if bold
             else ["LiberationSans-Regular.ttf", "DejaVuSans.ttf"])
    for d in FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def tsize(draw, text, fnt):
    b = draw.textbbox((0, 0), text, font=fnt)
    return b[2] - b[0], b[3] - b[1]

def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if tsize(draw, t, fnt)[0] <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines

# ---------------- Pixabay ----------------
def pixabay_photo(query):
    if not PIX_KEY:
        return None
    try:
        url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=vertical"
               "&safesearch=true&per_page=20&order=popular" % (PIX_KEY, urllib.parse.quote(query)))
        req = urllib.request.Request(url, headers={"User-Agent": "hudace-routine/1.0"})
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode())
        hits = data.get("hits", [])
        if not hits:
            return None
        for h in hits:
            src = h.get("largeImageURL") or h.get("webformatURL")
            if not src:
                continue
            ir = urllib.request.Request(src, headers={"User-Agent": "hudace-routine/1.0"})
            with urllib.request.urlopen(ir, timeout=60) as ri:
                img = Image.open(io.BytesIO(ri.read())).convert("RGB")
            return img
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
        print("  pixabay fail for %r: %s" % (query, e))
    return None

def cover_crop(img, w=W, h=H):
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    nw, nh = int(iw * scale + 0.5), int(ih * scale + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return img.crop((left, top, left + w, top + h))

def gradient_bg(w=W, h=H):
    top, bot = hexrgb(BRAND["bg2"]), hexrgb(BRAND["bg3"])
    base = Image.new("RGB", (w, h))
    px = base.load()
    for y in range(h):
        t = y / (h - 1)
        px_row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = px_row
    # subtle blue glow top-right
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w * 0.45, -h * 0.25, w * 1.25, h * 0.55], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    accent = Image.new("RGB", (w, h), hexrgb(BRAND["accent"]))
    return Image.composite(accent, base, glow)

def darken(img, factor=0.45, bottom_gradient=True):
    img = ImageEnhance.Brightness(img).enhance(factor)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    if bottom_gradient:
        ov = Image.new("L", img.size, 0)
        d = ImageDraw.Draw(ov)
        h = img.size[1]
        for y in range(h):
            t = max(0.0, (y - h * 0.35) / (h * 0.65))
            d.line([(0, y), (img.size[0], y)], fill=int(190 * (t ** 1.3)))
        black = Image.new("RGB", img.size, (2, 2, 10))
        img = Image.composite(black, img, ov)
    return img

def get_base_photo(svc):
    img = pixabay_photo(svc["photo_query"])
    if img is None:
        print("  -> gradient fallback for", svc["key"])
        return gradient_bg()
    return cover_crop(img)

# ---------------- Brand assets ----------------
def build_logo():
    white = hexrgb(BRAND["text"]); accent = hexrgb(BRAND["accent"])
    # wordmark
    im = Image.new("RGBA", (720, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = font(True, 116)
    d.text((0, 30), "hudace", font=f, fill=white + (255,))
    w = tsize(d, "hudace", f)[0]
    d.ellipse([w + 18, 128, w + 46, 156], fill=accent + (255,))  # accent dot
    im = im.crop(im.getbbox())
    im.save(os.path.join(OUT, "hudace-logo-white.png"))
    # mark: rounded blue square with h
    m = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
    dm = ImageDraw.Draw(m)
    dm.rounded_rectangle([0, 0, 159, 159], radius=38, fill=accent + (255,))
    fm = font(True, 108)
    tw, th = tsize(dm, "h", fm)
    dm.text(((160 - tw) / 2 - 4, (160 - th) / 2 - 22), "h", font=fm, fill=white + (255,))
    m.save(os.path.join(OUT, "hudace-mark.png"))
    print("  logo + mark done")

def _icon_canvas():
    return Image.new("RGBA", (96, 96), (0, 0, 0, 0))

def build_icons():
    white = (255, 255, 255, 255)
    # Instagram: rounded square, circle, dot
    ig = _icon_canvas(); d = ImageDraw.Draw(ig)
    d.rounded_rectangle([10, 10, 86, 86], radius=24, outline=white, width=7)
    d.ellipse([32, 32, 64, 64], outline=white, width=7)
    d.ellipse([68, 22, 78, 32], fill=white)
    ig.save(os.path.join(OUT, "icon-instagram.png"))
    # LinkedIn: rounded square with "in"
    li = _icon_canvas(); d = ImageDraw.Draw(li)
    d.rounded_rectangle([8, 8, 88, 88], radius=18, outline=white, width=7)
    f = font(True, 46)
    d.text((22, 24), "in", font=f, fill=white)
    li.save(os.path.join(OUT, "icon-linkedin.png"))
    # WhatsApp: speech bubble circle with handset
    wa = _icon_canvas(); d = ImageDraw.Draw(wa)
    d.ellipse([8, 8, 88, 88], outline=white, width=7)
    d.pieslice([30, 30, 66, 66], start=110, end=380, outline=white, width=8)
    wa.save(os.path.join(OUT, "icon-whatsapp.png"))
    # Facebook: rounded square with "f"
    fb = _icon_canvas(); d = ImageDraw.Draw(fb)
    d.rounded_rectangle([8, 8, 88, 88], radius=18, outline=white, width=7)
    ff = font(True, 62)
    d.text((36, 12), "f", font=ff, fill=white)
    fb.save(os.path.join(OUT, "icon-facebook.png"))
    print("  social icons done")

# ---------------- Baked card ----------------
def build_card(svc, base_photo):
    accent = hexrgb(BRAND["accent"]); white = hexrgb(BRAND["text"]); muted = hexrgb(BRAND["muted"])
    img = darken(base_photo.copy(), factor=0.4, bottom_gradient=True)
    d = ImageDraw.Draw(img)
    M = 72  # margin

    # logo wordmark top-left
    logo = Image.open(os.path.join(OUT, "hudace-logo-white.png")).convert("RGBA")
    lh = 60
    logo = logo.resize((int(logo.width * lh / logo.height), lh), Image.LANCZOS)
    img.paste(logo, (M, 64), logo)

    # accent service label
    fl = font(True, 30)
    d.text((M, 172), svc["name"].upper(), font=fl, fill=accent)

    # headline
    fh = font(True, 78)
    y = 220
    for line in wrap(d, svc["card_headline"], fh, W - 2 * M):
        d.text((M, y), line, font=fh, fill=white)
        y += 92
    y += 24

    # deliverables (up to 6)
    fd = font(False, 38)
    items = svc["deliverables"][:6]
    for it in items:
        # accent square bullet
        d.rounded_rectangle([M, y + 12, M + 16, y + 28], radius=4, fill=accent)
        for i, line in enumerate(wrap(d, it, fd, W - 2 * M - 40)):
            d.text((M + 40, y), line, font=fd, fill=(235, 235, 245))
            y += 48
        y += 10
    if len(svc["deliverables"]) > 6:
        d.text((M + 40, y), "and more", font=font(False, 34), fill=muted)
        y += 48

    # CTA pill
    cta_y = H - 220
    ft = font(True, 40)
    label = "Chat on WhatsApp"
    tw, th = tsize(d, label, ft)
    d.rounded_rectangle([M, cta_y, M + tw + 72, cta_y + 84], radius=42, fill=accent)
    d.text((M + 36, cta_y + 20), label, font=ft, fill=white)

    # contact line
    fc = font(False, 32)
    contact = "%s   ·   %s   ·   %s" % (CONTACT["site"], CONTACT["email"], CONTACT["phone_display"])
    d.text((M, H - 96), contact, font=fc, fill=(210, 210, 225))

    path = os.path.join(OUT, "%s-card.jpg" % svc["key"])
    img.convert("RGB").save(path, "JPEG", quality=88)
    print("  card:", os.path.basename(path))

def build_hero_photo(svc, base_photo):
    img = darken(base_photo.copy(), factor=0.62, bottom_gradient=False)
    path = os.path.join(OUT, "%s-photo.jpg" % svc["key"])
    img.convert("RGB").save(path, "JPEG", quality=86)
    print("  photo:", os.path.basename(path))

def main():
    print("Building brand assets...")
    build_logo()
    build_icons()
    for svc in SERVICES:
        print("Service:", svc["key"])
        base = get_base_photo(svc)
        build_hero_photo(svc, base)
        build_card(svc, base)
    print("DONE. Files in", OUT)

if __name__ == "__main__":
    main()
