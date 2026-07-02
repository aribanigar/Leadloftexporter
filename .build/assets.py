#!/usr/bin/env python3
"""Generate reusable brand assets (logo, mark, white social icons) into public/email/."""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
FONTS = os.path.join(ROOT, ".build", "fonts")
os.makedirs(OUT, exist_ok=True)

BLUE = (27, 144, 255, 255)
WHITE = (255, 255, 255, 255)
MUTED = (154, 154, 174, 255)

def font(w, size):
    return ImageFont.truetype(os.path.join(FONTS, f"mont-{w}.ttf"), size)

def save(img, name):
    img.save(os.path.join(OUT, name))
    print("wrote", name, img.size)

# ---- Mark: rounded square with a blue-to-white geometric "H" motif ----
def make_mark(size=240):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.24)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(11, 9, 25, 255))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, outline=BLUE, width=max(3, size // 40))
    # stylised H: two verticals + connecting bar, blue accent
    bw = int(size * 0.14)
    x1 = int(size * 0.28)
    x2 = int(size * 0.72) - bw
    top = int(size * 0.26)
    bot = int(size * 0.74)
    d.rectangle([x1, top, x1 + bw, bot], fill=WHITE)
    d.rectangle([x2, top, x2 + bw, bot], fill=WHITE)
    midy = (top + bot) // 2
    d.rectangle([x1, midy - bw // 2, x2 + bw, midy + bw // 2], fill=BLUE)
    return img

make_mark_img = make_mark()
save(make_mark_img, "hudace-mark.png")

# ---- Logo lockup: mark + HUDACE wordmark (white) ----
def make_logo(scale=1):
    h = 120 * scale
    mark = make_mark(int(h * 0.9))
    f = font(800, int(h * 0.6))
    text = "HUDACE"
    tmp = Image.new("RGBA", (10, 10))
    td = ImageDraw.Draw(tmp)
    bbox = td.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    gap = int(h * 0.18)
    W = mark.size[0] + gap + tw + 10
    img = Image.new("RGBA", (W, h), (0, 0, 0, 0))
    img.paste(mark, (0, (h - mark.size[1]) // 2), mark)
    d = ImageDraw.Draw(img)
    ty = (h - th) // 2 - bbox[1]
    d.text((mark.size[0] + gap, ty), text, font=f, fill=WHITE)
    return img

save(make_logo(2), "hudace-logo-white.png")

# ---- White social icons (monochrome, transparent) ----
def canvas(size=96):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def icon_instagram(size=96):
    img, d = canvas(size)
    m = int(size * 0.14)
    box = [m, m, size - m, size - m]
    r = int(size * 0.26)
    d.rounded_rectangle(box, radius=r, outline=WHITE, width=max(4, size // 14))
    c = size / 2
    rr = size * 0.19
    d.ellipse([c - rr, c - rr, c + rr, c + rr], outline=WHITE, width=max(4, size // 14))
    dot = size * 0.055
    dx = size * 0.70
    dy = size * 0.30
    d.ellipse([dx - dot, dy - dot, dx + dot, dy + dot], fill=WHITE)
    return img

def icon_linkedin(size=96):
    img, d = canvas(size)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.2), outline=WHITE, width=max(4, size // 14))
    f = font(800, int(size * 0.5))
    text = "in"
    bbox = d.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    d.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]), text, font=f, fill=WHITE)
    return img

def icon_facebook(size=96):
    img, d = canvas(size)
    d.ellipse([0, 0, size - 1, size - 1], outline=WHITE, width=max(4, size // 14))
    f = font(800, int(size * 0.62))
    text = "f"
    bbox = d.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    d.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1] - size * 0.02), text, font=f, fill=WHITE)
    return img

def icon_whatsapp(size=96):
    img, d = canvas(size)
    w = max(4, size // 14)
    d.ellipse([w, w, size - 1 - w, size - 1 - w], outline=WHITE, width=w)
    # handset: simple rounded shape
    cx, cy = size * 0.5, size * 0.52
    hs = size * 0.20
    d.rounded_rectangle([cx - hs * 0.8, cy - hs, cx + hs * 0.8, cy + hs], radius=int(hs * 0.5), outline=WHITE, width=max(3, size // 18))
    d.ellipse([cx - hs * 0.35, cy - hs * 0.45, cx + hs * 0.35, cy + hs * 0.25], fill=(0, 0, 0, 0))
    return img

for name, fn in [("instagram", icon_instagram), ("linkedin", icon_linkedin),
                 ("facebook", icon_facebook), ("whatsapp", icon_whatsapp)]:
    save(fn(96), f"icon-{name}.png")

print("assets done")
