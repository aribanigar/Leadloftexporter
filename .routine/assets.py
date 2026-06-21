# -*- coding: utf-8 -*-
"""Build all hosted images into public/email/:
 - download one dark cinematic 4:5 photo per service from Pixabay
 - generate the Hudace logo lockup, mark, and white social icons (once)
 - bake a 1080x1350 promo card JPG per service
Idempotent: existing files are reused, photos are only fetched when missing.
"""
import os, sys, json, time, urllib.request, urllib.parse, io
from PIL import Image, ImageDraw, ImageFont, ImageFilter
sys.path.insert(0, os.path.dirname(__file__))
from data import SERVICES, BRAND, CONTACT

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
FONTS = os.path.join(ROOT, "assets", "fonts")
os.makedirs(OUT, exist_ok=True)
PIXABAY = os.environ.get("PIXABAY_API", "56316516-fbb10ad7475940758256bc517")

def F(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

def hx(c):
    c = c.lstrip("#"); return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))

ACCENT = hx(BRAND["accent"]); WHITE = hx(BRAND["white"])
MUTED = hx(BRAND["muted"]); BG = hx(BRAND["bg"]); BG2 = hx(BRAND["bg2"])

def fetch(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

# ---------------------------------------------------------------- photos
def pixabay_pick(queries):
    for q in queries:
        u = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=vertical"
             "&safesearch=true&per_page=30&min_width=1000&min_height=1200&order=popular"
             % (PIXABAY, urllib.parse.quote(q)))
        try:
            data = json.loads(fetch(u, 30))
        except Exception as e:
            print("  pixabay query failed", q, e); continue
        hits = data.get("hits", [])
        hits.sort(key=lambda h: h.get("imageHeight", 0) / max(h.get("imageWidth", 1), 1), reverse=True)
        for h in hits:
            img = h.get("largeImageURL") or h.get("webformatURL")
            if img:
                return img, q
    return None, None

def crop_45(im, w=1080, h=1350):
    im = im.convert("RGB")
    tr = w / h
    sr = im.width / im.height
    if sr > tr:
        nw = int(im.height * tr); x = (im.width - nw) // 2
        im = im.crop((x, 0, x + nw, im.height))
    else:
        nh = int(im.width / tr); y = (im.height - nh) // 2
        im = im.crop((0, y, im.width, y + nh))
    return im.resize((w, h), Image.LANCZOS)

def ensure_photo(svc):
    path = os.path.join(OUT, "photo-%s.jpg" % svc["slug"])
    if os.path.exists(path):
        print("  photo cached", os.path.basename(path)); return path
    url, q = pixabay_pick(svc["queries"])
    if not url:
        print("  NO PHOTO for", svc["slug"], "- using brand fallback")
        im = Image.new("RGB", (1080, 1350), BG2)
    else:
        im = crop_45(Image.open(io.BytesIO(fetch(url))))
        print("  downloaded photo for", svc["slug"], "(", q, ")")
    im.save(path, "JPEG", quality=88)
    time.sleep(0.4)
    return path

# ---------------------------------------------------------------- logo + icons
def rounded(draw, box, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def make_logo():
    # wordmark lockup: accent mark + "hudace"
    path = os.path.join(OUT, "logo.png")
    markp = os.path.join(OUT, "mark.png")
    # mark
    m = Image.new("RGBA", (240, 240), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    rounded(d, (10, 10, 230, 230), 56, fill=ACCENT)
    fh = F("Montserrat-ExtraBold.ttf", 150)
    tb = d.textbbox((0, 0), "h", font=fh)
    d.text((120 - (tb[2]-tb[0])/2 - tb[0], 120 - (tb[3]-tb[1])/2 - tb[1]), "h", font=fh, fill=WHITE)
    m.save(markp)
    # lockup (transparent, white wordmark) for dark backgrounds
    W, H = 900, 240
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    sm = m.resize((150, 150))
    im.alpha_composite(sm, (8, 45))
    fw = F("Montserrat-Bold.ttf", 120)
    d.text((180, 58), "hudace", font=fw, fill=WHITE)
    im.save(path)
    print("  logo + mark built")

def _circle_badge(size=80, stroke=6):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((stroke//2, stroke//2, size-stroke//2, size-stroke//2), outline=WHITE, width=stroke)
    return im, d

def make_icons():
    s = 80
    # instagram: rounded square + circle + dot
    ig, d = Image.new("RGBA", (s, s), (0, 0, 0, 0)), None
    d = ImageDraw.Draw(ig)
    rounded(d, (12, 12, s-12, s-12), 18, outline=WHITE, width=6)
    d.ellipse((26, 26, s-26, s-26), outline=WHITE, width=6)
    d.ellipse((56, 22, 64, 30), fill=WHITE)
    ig.save(os.path.join(OUT, "icon-instagram.png"))
    # linkedin: rounded square filled white, "in" in bg color
    li = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(li)
    rounded(d, (8, 8, s-8, s-8), 16, fill=WHITE)
    fin = F("Montserrat-Bold.ttf", 38)
    tb = d.textbbox((0, 0), "in", font=fin)
    d.text((s/2-(tb[2]-tb[0])/2-tb[0], s/2-(tb[3]-tb[1])/2-tb[1]), "in", font=fin, fill=BG2)
    li.save(os.path.join(OUT, "icon-linkedin.png"))
    # facebook: rounded square filled white, "f"
    fb = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(fb)
    rounded(d, (8, 8, s-8, s-8), 16, fill=WHITE)
    ff = F("Montserrat-ExtraBold.ttf", 50)
    tb = d.textbbox((0, 0), "f", font=ff)
    d.text((s/2-(tb[2]-tb[0])/2-tb[0], s/2-(tb[3]-tb[1])/2-tb[1]), "f", font=ff, fill=BG2)
    fb.save(os.path.join(OUT, "icon-facebook.png"))
    # whatsapp: white circle + handset glyph
    wa, d = _circle_badge(s, 6)
    # simple handset: rotated rounded bar
    h = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    hd = ImageDraw.Draw(h)
    rounded(hd, (30, 24, 50, 56), 9, fill=WHITE)
    hd.ellipse((26, 20, 54, 60), outline=WHITE, width=0)
    h = h.rotate(-35, resample=Image.BICUBIC, center=(40, 40))
    wa.alpha_composite(h)
    wa.save(os.path.join(OUT, "icon-whatsapp.png"))
    print("  social icons built")

# ---------------------------------------------------------------- promo card
def wrap(draw, text, font, maxw):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def bake_card(svc, photo_path):
    W, H = 1080, 1350
    base = Image.open(photo_path).convert("RGB").resize((W, H))
    # darken: multiply + bottom-up gradient for legibility
    ov = Image.new("L", (1, H))
    for y in range(H):
        # darker at top and bottom, readable
        t = y / H
        val = int(150 + 90 * t)            # base darkening
        ov.putpixel((0, y), 255 - val)
    grad = ov.resize((W, H))
    dark = Image.new("RGB", (W, H), (3, 3, 12))
    base = Image.composite(base, dark, grad.point(lambda v: min(255, v)))
    base = Image.blend(base, Image.new("RGB", (W, H), (5, 5, 14)), 0.30)
    d = ImageDraw.Draw(base)

    M = 80
    # logo lockup top
    logo = Image.open(os.path.join(OUT, "logo.png")).convert("RGBA").resize((360, 96))
    base.paste(logo, (M, 70), logo)
    # accent label
    fl = F("Montserrat-SemiBold.ttf", 30)
    d.text((M, 210), svc["name"].upper(), font=fl, fill=ACCENT)
    # headline
    fh = F("Montserrat-ExtraBold.ttf", 150)
    d.text((M-4, 250), svc["headline"], font=fh, fill=WHITE)
    # subhead
    fs = F("Montserrat-Medium.ttf", 36)
    yy = 440
    for ln in wrap(d, svc["subhead"], fs, W - 2*M):
        d.text((M, yy), ln, font=fs, fill=(225, 225, 235)); yy += 48

    # deliverables label
    yy += 26
    d.text((M, yy), "DELIVERABLES", font=F("Montserrat-SemiBold.ttf", 30), fill=ACCENT)
    yy += 56
    fd = F("Montserrat-Medium.ttf", 33)
    items = svc["deliverables"]
    shown = items[:7]
    extra = len(items) - len(shown)
    for it in shown:
        # bullet
        d.ellipse((M, yy+14, M+12, yy+26), fill=ACCENT)
        line = wrap(d, it, fd, W - 2*M - 40)
        d.text((M+34, yy), line[0], font=fd, fill=(235, 235, 242))
        yy += 46
    if extra > 0:
        d.ellipse((M, yy+14, M+12, yy+26), fill=ACCENT)
        d.text((M+34, yy), "and %d more modules" % extra, font=fd, fill=(235, 235, 242))
        yy += 46

    # CTA pill
    cy = H - 230
    pill = (M, cy, M+560, cy+86)
    rounded(d, pill, 43, fill=ACCENT)
    fc = F("Montserrat-Bold.ttf", 36)
    d.text((M+44, cy+22), "Chat on WhatsApp", font=fc, fill=WHITE)
    d.text((M, cy+110), CONTACT["wa"].replace("https://", ""), font=F("Montserrat-Medium.ttf", 30), fill=(210, 210, 222))

    # contact footer
    foot = "%s   |   %s   |   %s" % (CONTACT["phone_display"], CONTACT["email"], CONTACT["site"])
    d.text((M, H - 70), foot, font=F("Montserrat-Medium.ttf", 28), fill=MUTED)

    path = os.path.join(OUT, "card-%s.jpg" % svc["slug"])
    base.save(path, "JPEG", quality=90)
    print("  baked", os.path.basename(path))
    return path

def main():
    make_logo()
    make_icons()
    for svc in SERVICES:
        print("service:", svc["slug"])
        p = ensure_photo(svc)
        bake_card(svc, p)
    print("DONE assets")

if __name__ == "__main__":
    main()
