#!/usr/bin/env python3
"""Build all self-hosted images for the Hudace batch into public/email/.

- White logo lockup + mark (from icons/logo-white.svg)
- White social icons (instagram, linkedin, whatsapp, facebook)
- Per service: photo-<key>.jpg (4:5 cinematic hero) and card-<key>.jpg (4:5 promo)

All output is 1080x1350 (4:5). Photos are downloaded from Pixabay via the API
and baked in; no hotlinking. Fonts and icons are committed under scripts/.
"""
import io, os, sys, json, urllib.parse, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps, ImageEnhance
sys.path.insert(0, os.path.dirname(__file__))
from content_model import (SERVICES, ACCENT, MUTED, PHONE_DISPLAY, EMAIL, SITE)

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "icons")
FONTS = os.path.join(HERE, "fonts")
OUT = os.path.abspath(os.path.join(HERE, "..", "public", "email"))
os.makedirs(OUT, exist_ok=True)
PIXABAY = "56316516-fbb10ad7475940758256bc517"
W, H = 1080, 1350

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

ACC = hexrgb(ACCENT)
MUT = hexrgb(MUTED)

# ---------- SVG -> white PNG ----------
import cairosvg
def svg_white_png(svg_path, out_w):
    png = cairosvg.svg2png(url=svg_path, output_width=out_w, output_height=out_w)
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    # Recolor any opaque shape to white, keep alpha
    r, g, b, a = im.split()
    white = Image.new("RGBA", im.size, (255, 255, 255, 0))
    white.putalpha(a)
    return white

def trim(im):
    bbox = im.split()[-1].getbbox()
    return im.crop(bbox) if bbox else im

def build_linkedin_icon():
    # cairosvg hangs on the LinkedIn glyph path, so draw it: white rounded
    # square with a transparent "in" cut out (bg-independent, matches the
    # other white glyph icons).
    S = 240
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    m = 12
    d.rounded_rectangle([m, m, S-m, S-m], radius=40, fill=(255, 255, 255, 255))
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    f = font("Montserrat-Bold.ttf", 120)
    tb = md.textbbox((0, 0), "in", font=f)
    tw, th = tb[2]-tb[0], tb[3]-tb[1]
    md.text(((S-tw)//2 - tb[0], (S-th)//2 - tb[1] - 4), "in", font=f, fill=255)
    a = base.split()[3]
    a = Image.composite(Image.new("L", (S, S), 0), a, mask)  # punch letters to transparent
    base.putalpha(a)
    base.save(os.path.join(OUT, "ic_linkedin.png"))

def _brand_mark(size):
    """Minimal deterministic brand mark: blue rounded square with a white 'h'.
    The site logo SVG uses a filter that rasterizes as a solid block, so we use
    a clean geometric lockup instead."""
    m = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size-1, size-1], radius=int(size*0.24), fill=ACC + (255,))
    hf = font("Montserrat-Bold.ttf", int(size*0.72))
    tb = d.textbbox((0, 0), "h", font=hf)
    tw, th = tb[2]-tb[0], tb[3]-tb[1]
    d.text(((size-tw)//2 - tb[0], (size-th)//2 - tb[1]), "h", font=hf, fill=(255, 255, 255, 255))
    return m

def build_logo_and_icons():
    # footer mark: small brand mark
    _brand_mark(90).save(os.path.join(OUT, "mark-white.png"))
    # header lockup: brand mark + wordmark "hudace"
    LH = 132
    mk = _brand_mark(LH)
    wf = font("Montserrat-Bold.ttf", int(LH*0.74))
    word = "hudace"
    tmp = Image.new("RGBA", (2000, 400), (0,0,0,0)); d = ImageDraw.Draw(tmp)
    tb = d.textbbox((0,0), word, font=wf)
    tw, th = tb[2]-tb[0], tb[3]-tb[1]
    gap = 34
    lock = Image.new("RGBA", (mk.width + gap + tw, LH), (0,0,0,0))
    lock.alpha_composite(mk, (0, (LH-mk.height)//2))
    ld = ImageDraw.Draw(lock)
    ld.text((mk.width+gap - tb[0], (LH-th)//2 - tb[1]), word, font=wf, fill=(255,255,255,255))
    lock = trim(lock)
    lock.save(os.path.join(OUT, "logo-white.png"))
    for name in ["instagram", "whatsapp", "facebook"]:
        ic = trim(svg_white_png(os.path.join(ICONS, f"{name}.svg"), 240))
        canvas = Image.new("RGBA", (240, 240), (0,0,0,0))
        ic.thumbnail((150,150), Image.LANCZOS)
        canvas.alpha_composite(ic, ((240-ic.width)//2, (240-ic.height)//2))
        canvas.save(os.path.join(OUT, f"ic_{name}.png"))
    build_linkedin_icon()
    print("logo + icons built")
    return lock

# ---------- Pixabay ----------
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

def _open(url, timeout):
    # Pixabay blocks the default Python-urllib User-Agent; send a browser UA.
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://pixabay.com/"})
    return urllib.request.urlopen(req, timeout=timeout)

CACHE = os.path.join(HERE, ".pxcache")
os.makedirs(CACHE, exist_ok=True)

def fetch_photo(query, key=None):
    if key:
        cp = os.path.join(CACHE, key + ".jpg")
        if os.path.exists(cp):
            return Image.open(cp).convert("RGB")
    url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=vertical"
           "&per_page=30&safesearch=true&min_width=1080&min_height=1350" %
           (PIXABAY, urllib.parse.quote(query)))
    with _open(url, 60) as r:
        data = json.loads(r.read().decode())
    hits = data.get("hits", [])
    if not hits:
        raise RuntimeError("no pixabay hits for: " + query)
    # prefer the tallest / most vertical hit for a clean 4:5 crop
    hits.sort(key=lambda h: h["imageHeight"]/max(1, h["imageWidth"]), reverse=True)
    last = None
    for hit in hits[:6]:
        try:
            with _open(hit["largeImageURL"], 90) as r:
                raw = r.read()
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            if key:
                im.save(os.path.join(CACHE, key + ".jpg"), quality=92)
            return im
        except Exception as ex:
            last = ex
    raise RuntimeError("download failed: %s" % last)

def cover(im, w, h):
    return ImageOps.fit(im, (w, h), Image.LANCZOS, centering=(0.5, 0.4))

def darken(im, factor, vignette_bottom=True):
    im = ImageEnhance.Brightness(im).enhance(factor)
    im = ImageEnhance.Color(im).enhance(0.85)
    if vignette_bottom:
        grad = Image.new("L", (1, H), 0)
        for y in range(H):
            t = y / H
            grad.putpixel((0, y), int(150 * (t ** 1.6)))
        grad = grad.resize((W, H))
        black = Image.new("RGB", (W, H), (5, 5, 13))
        im = Image.composite(black, im, grad)
    return im

# ---------- text helpers ----------
def draw_tracked(d, xy, text, fnt, fill, tracking):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += d.textlength(ch, font=fnt) + tracking
    return x

def wrap(d, text, fnt, max_w):
    words = text.split()
    lines, cur = [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if d.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines

# ---------- card ----------
def build_card(svc, photo):
    bg = darken(cover(photo, W, H), 0.42)
    card = bg.convert("RGBA")
    d = ImageDraw.Draw(card)
    PAD = 84
    x = PAD
    y = 78
    # logo lockup
    lock = Image.open(os.path.join(OUT, "logo-white.png")).convert("RGBA")
    lh = 74
    lk = lock.copy(); lk.thumbnail((lh*8, lh), Image.LANCZOS)
    card.alpha_composite(lk, (x, y))
    y += lh + 66
    # blue label
    lab = font("Montserrat-Bold.ttf", 30)
    draw_tracked(d, (x, y), svc["label"], lab, ACC, 3)
    y += 58
    # headline
    hf = font("Montserrat-ExtraBold.ttf", 74)
    for ln in wrap(d, svc["headline"], hf, W - 2*PAD):
        d.text((x, y), ln, font=hf, fill=(255,255,255,255))
        y += 84
    y += 14
    # subhead
    sf = font("Montserrat-Regular.ttf", 31)
    for ln in wrap(d, svc["subhead"], sf, W - 2*PAD):
        d.text((x, y), ln, font=sf, fill=(214,214,224,255))
        y += 42
    y += 40
    # deliverables label
    dl = font("Montserrat-Bold.ttf", 26)
    draw_tracked(d, (x, y), "DELIVERABLES", dl, ACC, 3)
    y += 52
    # bullets (max 6)
    bf = font("Montserrat-SemiBold.ttf", 31)
    items = svc["deliverables"][:6]
    extra = len(svc["deliverables"]) - len(items)
    for it in items:
        d.rounded_rectangle([x, y+9, x+16, y+25], radius=3, fill=ACC)
        lines = wrap(d, it, bf, W - 2*PAD - 40)
        for i, ln in enumerate(lines):
            d.text((x+40, y), ln, font=bf, fill=(236,236,244,255))
            y += 44
        y += 6
    if extra > 0:
        d.text((x+40, y), "and %d more" % extra, font=font("Montserrat-SemiBold.ttf", 29), fill=MUT)
        y += 46
    # CTA pill + contact pinned to bottom
    cy = H - 210
    pf = font("Montserrat-Bold.ttf", 34)
    label = "Chat on WhatsApp"
    tw = d.textlength(label, font=pf)
    pill_w, pill_h = int(tw + 76), 84
    d.rounded_rectangle([x, cy, x+pill_w, cy+pill_h], radius=42, fill=ACC)
    d.text((x+38, cy+ (pill_h-46)//2 -2), label, font=pf, fill=(255,255,255,255))
    # contact
    cf = font("Montserrat-SemiBold.ttf", 28)
    contact = "%s   %s   %s" % (SITE, EMAIL, PHONE_DISPLAY)
    d.text((x, cy+pill_h+34), contact, font=cf, fill=(200,200,214,255))
    card.convert("RGB").save(os.path.join(OUT, "card-%s.jpg" % svc["key"]), quality=88)
    print("card:", svc["key"])

def build_photo(svc, photo):
    im = darken(cover(photo, W, H), 0.62, vignette_bottom=True)
    im.save(os.path.join(OUT, "photo-%s.jpg" % svc["key"]), quality=88)
    print("photo:", svc["key"])

def main():
    build_logo_and_icons()
    failures = []
    for svc in SERVICES:
        try:
            photo = fetch_photo(svc["pixabay"], key=svc["key"])
            build_photo(svc, photo)
            build_card(svc, photo)
        except Exception as e:
            failures.append("%s: %s" % (svc["key"], e))
            print("FAIL", svc["key"], e)
    print("DONE. failures:", failures)
    return 0 if not failures else 1

if __name__ == "__main__":
    sys.exit(main())
