#!/usr/bin/env python3
"""Render an on-brand 4:5 promo card per service into public/email/<slug>-card.jpg."""
import os, json
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
FONTS = os.path.join(ROOT, ".build", "fonts")
W, H = 1080, 1350
BLUE = (27, 144, 255)
WHITE = (255, 255, 255)
MUTED = (176, 176, 196)
PAD = 84

def f(w, s): return ImageFont.truetype(os.path.join(FONTS, f"mont-{w}.ttf"), s)

def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = wd
    if cur: lines.append(cur)
    return lines

def darken(img):
    img = img.convert("RGB")
    img = ImageEnhance.Brightness(img).enhance(0.6)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    # 1) flat scrim across the whole image so text reads on any photo (even bright ones)
    flat = Image.new("L", (1, H), 0)
    for y in range(H):
        base = 150                                  # ~59% flat dark everywhere
        top = max(0, 90 - int(y * 0.9))             # extra at top for the logo
        bottom = max(0, int((y - H * 0.5) / (H * 0.5) * 105)) if y > H * 0.5 else 0
        flat.putpixel((0, y), min(250, base + top + bottom))
    flat = flat.resize((W, H))
    overlay = Image.new("RGB", (W, H), (5, 5, 13))
    return Image.composite(overlay, img, flat)

def rounded_button(draw, box, fill=None, outline=None, radius=16, width=3):
    if fill: draw.rounded_rectangle(box, radius=radius, fill=fill)
    if outline: draw.rounded_rectangle(box, radius=radius, outline=outline, width=width)

def build(svc, contact):
    slug = svc["slug"]
    photo = Image.open(os.path.join(OUT, f"{slug}-photo.jpg")).resize((W, H), Image.LANCZOS)
    img = darken(photo)
    d = ImageDraw.Draw(img)

    # logo top-left
    logo = Image.open(os.path.join(OUT, "hudace-logo-white.png")).convert("RGBA")
    lh = 58
    logo = logo.resize((int(logo.width * lh / logo.height), lh))
    img.paste(logo, (PAD, 64), logo)

    y = 300
    # category label
    label = svc["name"].upper()
    d.text((PAD, y), label, font=f(700, 30), fill=BLUE)
    y += 52
    # headline
    for ln in wrap(d, svc["headline"], f(800, 108), W - 2 * PAD):
        d.text((PAD, y), ln, font=f(800, 108), fill=WHITE)
        y += 112
    y += 8
    # sub
    for ln in wrap(d, svc["hero_sub"], f(500, 36), W - 2 * PAD):
        d.text((PAD, y), ln, font=f(500, 36), fill=MUTED)
        y += 46

    # deliverables block header
    y += 26
    d.text((PAD, y), "WHAT YOU GET", font=f(700, 26), fill=BLUE)
    y += 46
    items = svc["deliverables"][:6]
    for it in items:
        # blue square bullet
        d.rounded_rectangle([PAD, y + 8, PAD + 14, y + 22], radius=3, fill=BLUE)
        lines = wrap(d, it, f(600, 33), W - 2 * PAD - 40)
        for i, ln in enumerate(lines):
            d.text((PAD + 40, y), ln, font=f(600, 33), fill=WHITE)
            y += 42
        y += 8
    if len(svc["deliverables"]) > 6:
        d.text((PAD + 40, y), f"and {len(svc['deliverables']) - 6} more", font=f(500, 30), fill=MUTED)
        y += 46

    # CTA buttons near bottom
    by = H - 250
    bw = (W - 2 * PAD - 28) // 2
    bh = 88
    # WhatsApp filled
    rounded_button(d, [PAD, by, PAD + bw, by + bh], fill=BLUE, radius=18)
    t = "Chat on WhatsApp"; tw = d.textlength(t, font=f(700, 33))
    d.text((PAD + (bw - tw) / 2, by + 26), t, font=f(700, 33), fill=WHITE)
    # Website outline
    x2 = PAD + bw + 28
    rounded_button(d, [x2, by, x2 + bw, by + bh], outline=WHITE, radius=18, width=3)
    t2 = "Visit hudace.com"; tw2 = d.textlength(t2, font=f(700, 33))
    d.text((x2 + (bw - tw2) / 2, by + 26), t2, font=f(700, 33), fill=WHITE)

    # contact line
    cl = f"{contact['site']}   .   {contact['email']}   .   {contact['phone_display']}"
    tw = d.textlength(cl, font=f(500, 28))
    d.text(((W - tw) / 2, H - 96), cl, font=f(500, 28), fill=MUTED)

    path = os.path.join(OUT, f"{slug}-card.jpg")
    img.convert("RGB").save(path, "JPEG", quality=90, optimize=True)
    print("card", slug, "->", path)

if __name__ == "__main__":
    data = json.load(open(os.path.join(ROOT, ".build", "content.json")))
    for svc in data["services"]:
        build(svc, data["contact"])
    print("cards done")
