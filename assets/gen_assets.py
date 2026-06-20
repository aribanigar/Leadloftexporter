#!/usr/bin/env python3
"""Generate brand logo wordmark, mark, and social icon PNGs into public/email/."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = "public/email"
os.makedirs(OUT, exist_ok=True)
FONT = "assets/Montserrat.ttf"
BLUE = (27, 144, 255)
WHITE = (255, 255, 255)

def font(sz, wght=700):
    f = ImageFont.truetype(FONT, sz)
    try: f.set_variation_by_axes([wght])
    except Exception: pass
    return f

# --- white logo lockup (wordmark) on transparent ---
def wordmark():
    txt = "HUDACE"
    f = font(120, 800)
    tmp = Image.new("RGBA", (10, 10))
    d = ImageDraw.Draw(tmp)
    bb = d.textbbox((0, 0), txt, font=f)
    w = bb[2] - bb[0]; h = bb[3] - bb[1]
    pad = 24
    img = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # blue square mark before text
    d.text((pad - bb[0], pad - bb[1]), txt, font=f, fill=WHITE)
    img.save(f"{OUT}/hudace-logo-white.png")
    return img

# --- mark: rounded blue square with white H ---
def mark():
    s = 240
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=52, fill=BLUE)
    f = font(150, 800)
    bb = d.textbbox((0, 0), "H", font=f)
    w = bb[2] - bb[0]; h = bb[3] - bb[1]
    d.text(((s - w) / 2 - bb[0], (s - h) / 2 - bb[1]), "H", font=f, fill=WHITE)
    img.save(f"{OUT}/hudace-mark.png")

# --- social icon badges: white circle ring with glyph ---
def circle_icon(name, glyph_fn):
    s = 96
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, s - 3, s - 3], outline=WHITE, width=5)
    glyph_fn(d, s)
    img.save(f"{OUT}/icon-{name}.png")

def g_linkedin(d, s):
    f = font(46, 800)
    bb = d.textbbox((0, 0), "in", font=f)
    w = bb[2] - bb[0]; h = bb[3] - bb[1]
    d.text(((s - w) / 2 - bb[0], (s - h) / 2 - bb[1]), "in", font=f, fill=WHITE)

def g_instagram(d, s):
    m = 26
    d.rounded_rectangle([m, m, s - m, s - m], radius=14, outline=WHITE, width=5)
    cx = s / 2
    d.ellipse([cx - 11, cx - 11, cx + 11, cx + 11], outline=WHITE, width=5)
    d.ellipse([s - m - 12, m + 6, s - m - 6, m + 12], fill=WHITE)

def g_whatsapp(d, s):
    cx = s / 2
    d.ellipse([cx - 20, cx - 20, cx + 20, cx + 20], outline=WHITE, width=5)
    # handset
    d.line([cx - 8, cx - 6, cx + 6, cx + 8], fill=WHITE, width=7)

def g_facebook(d, s):
    f = font(54, 800)
    bb = d.textbbox((0, 0), "f", font=f)
    w = bb[2] - bb[0]; h = bb[3] - bb[1]
    d.text(((s - w) / 2 - bb[0], (s - h) / 2 - bb[1]), "f", font=f, fill=WHITE)

if __name__ == "__main__":
    wordmark()
    mark()
    circle_icon("linkedin", g_linkedin)
    circle_icon("instagram", g_instagram)
    circle_icon("whatsapp", g_whatsapp)
    circle_icon("facebook", g_facebook)
    print("assets generated:", os.listdir(OUT))
