#!/usr/bin/env python3
"""Build all Hudace email images: 4:5 cinematic photos, baked promo cards, brand assets."""
import os, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
OUT = os.path.abspath(os.path.join(HERE, "..", "public", "email"))
os.makedirs(OUT, exist_ok=True)

BG = (10, 9, 25)          # #0A0919
BLUE = (27, 144, 255)     # #1B90FF
WHITE = (255, 255, 255)
MUTED = (154, 154, 174)   # #9A9AAE
W, H = 1080, 1350         # 4:5

def font(weight, size):
    return ImageFont.truetype(os.path.join(ASSETS, f"Montserrat-{weight}.ttf"), size)

# ---------- brand assets ----------
def export_assets():
    # header lockup (white), from footer horizontal logo
    cairosvg.svg2png(url=os.path.join(ASSETS, "logo-footer.svg"),
                     write_to=os.path.join(OUT, "logo-hudace.png"), output_width=720)
    # square mark
    cairosvg.svg2png(url=os.path.join(ASSETS, "logo-white.svg"),
                     write_to=os.path.join(OUT, "mark-hudace.png"), output_width=240)
    for n in ["instagram", "linkedin", "whatsapp", "facebook"]:
        cairosvg.svg2png(url=os.path.join(ASSETS, f"si-{n}.svg"),
                         write_to=os.path.join(OUT, f"icon-{n}.png"),
                         output_width=64, output_height=64)
    print("assets exported")

# ---------- 4:5 cinematic photo ----------
def make_photo(key):
    im = Image.open(os.path.join(ASSETS, f"raw-{key}.jpg")).convert("RGB")
    iw, ih = im.size
    target = W / H
    if iw / ih > target:            # too wide -> crop sides
        nw = int(ih * target); im = im.crop(((iw - nw) // 2, 0, (iw - nw) // 2 + nw, ih))
    else:                            # too tall -> crop top/bottom
        nh = int(iw / target); im = im.crop((0, (ih - nh) // 2, iw, (ih - nh) // 2 + nh))
    im = im.resize((W, H), Image.LANCZOS)
    # cinematic darken: multiply toward brand bg
    ov = Image.new("RGB", (W, H), (6, 6, 16))
    im = Image.blend(im, ov, 0.32)
    im.save(os.path.join(OUT, f"photo-{key}.jpg"), "JPEG", quality=86, optimize=True)
    return im

# ---------- helpers ----------
def wrap(draw, text, fnt, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= maxw:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def paste_center(base, img, cx, y):
    base.paste(img, (int(cx - img.width / 2), int(y)), img)

# ---------- baked promo card ----------
def make_card(key, headline, sub, deliverables):
    base = make_photo(key).copy()
    # bottom-weighted dark gradient for legibility
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        t = y / H
        grad.putpixel((0, y), int(255 * min(1.0, 0.35 + t * 0.72)))
    grad = grad.resize((W, H))
    dark = Image.new("RGB", (W, H), (5, 5, 13))
    base = Image.composite(dark, base, grad)
    d = ImageDraw.Draw(base)

    margin = 84
    # logo top-left
    logo = Image.open(os.path.join(OUT, "logo-hudace.png")).convert("RGBA")
    lw = 300; logo = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
    base.paste(logo, (margin, 74), logo)

    # accent kicker
    y = 250
    d.text((margin, y), "HUDACE", font=font("Bold", 30), fill=BLUE)
    y += 52

    # headline (may wrap)
    hf = font("Black", 92 if len(headline) <= 12 else 74)
    for line in wrap(d, headline, hf, W - 2 * margin):
        d.text((margin, y), line, font=hf, fill=WHITE)
        y += int(hf.size * 1.06)
    y += 8
    # sub
    sf = font("Medium", 34)
    for line in wrap(d, sub, sf, W - 2 * margin):
        d.text((margin, y), line, font=sf, fill=MUTED)
        y += int(sf.size * 1.28)

    # deliverables block
    y += 34
    d.text((margin, y), "WHAT YOU GET", font=font("Bold", 26), fill=BLUE)
    y += 50
    itf = font("SemiBold", 33)
    for it in deliverables:
        d.ellipse([margin, y + 12, margin + 12, y + 24], fill=BLUE)
        for i, line in enumerate(wrap(d, it, itf, W - 2 * margin - 40)):
            d.text((margin + 34, y), line, font=itf, fill=WHITE)
            y += int(itf.size * 1.18)
        y += 14

    # CTA button
    y = max(y + 20, H - 250)
    bh, bw = 88, W - 2 * margin
    d.rounded_rectangle([margin, y, margin + bw, y + bh], radius=14, fill=BLUE)
    ct = "Chat on WhatsApp  .  wa.me/918218929990"
    cf = font("Bold", 34)
    d.text((W / 2 - d.textlength(ct, font=cf) / 2, y + bh / 2 - 22), ct, font=cf, fill=WHITE)
    y += bh + 30

    # contact footer
    contact = "hudace.com   .   contact@hudace.com   .   +91 82189 29990"
    ff = font("Medium", 27)
    d.text((W / 2 - d.textlength(contact, font=ff) / 2, y), contact, font=ff, fill=MUTED)

    base.save(os.path.join(OUT, f"card-{key}.jpg"), "JPEG", quality=88, optimize=True)
    print(f"card-{key}.jpg built")

if __name__ == "__main__":
    export_assets()
    spec = json.load(open(os.path.join(HERE, "content.json")))
    for key, e in spec.items():
        make_card(key, e["headline"], e["sub"], e["card_deliverables"])
    print("ALL IMAGES DONE ->", OUT)
