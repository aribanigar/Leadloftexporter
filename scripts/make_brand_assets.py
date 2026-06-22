#!/usr/bin/env python3
"""Generate shared Hudace brand assets (white-on-transparent) into public/email.
Run once; reused across all email batches. Logo wordmark, mark, and white social
icons (Instagram, LinkedIn, WhatsApp, Facebook). No external deps beyond Pillow."""
import os
from PIL import Image, ImageDraw, ImageFont

EMAIL_DIR = "public/email"
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
WHITE = (255, 255, 255, 255)
BLUE = (27, 144, 255, 255)
os.makedirs(EMAIL_DIR, exist_ok=True)


def save(img, name):
    img.save(f"{EMAIL_DIR}/{name}")
    print("  asset:", name)


def logo():
    # White HUDACE wordmark with blue underline, transparent background. 3x for retina.
    w, h = 720, 200
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT_BOLD, 96)
    text = "HUDACE"
    # letter-spacing
    x = 8
    for ch in text:
        d.text((x, 30), ch, font=f, fill=WHITE)
        x += int(d.textlength(ch, font=f)) + 14
    end = x - 14
    d.rectangle([(10, 150), (end, 160)], fill=BLUE)
    save(img, "hudace-logo.png")


def mark():
    # Blue rounded square with white H. 144px.
    s = 144
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([(0, 0), (s - 1, s - 1)], radius=28, fill=BLUE)
    f = ImageFont.truetype(FONT_BOLD, 104)
    tw = d.textlength("H", font=f)
    bbox = f.getbbox("H")
    th = bbox[3] - bbox[1]
    d.text(((s - tw) / 2, (s - th) / 2 - bbox[1]), "H", font=f, fill=WHITE)
    save(img, "hudace-mark.png")


def _circle(s=96):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    return img, d


def icon_instagram():
    s = 96
    img, d = _circle(s)
    pad = 18
    d.rounded_rectangle([(pad, pad), (s - pad, s - pad)], radius=20, outline=WHITE, width=7)
    cx = cy = s / 2
    r = 16
    d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], outline=WHITE, width=7)
    d.ellipse([(s - pad - 14, pad + 6), (s - pad - 4, pad + 16)], fill=WHITE)
    save(img, "icon-instagram.png")


def icon_linkedin():
    s = 96
    img, d = _circle(s)
    f = ImageFont.truetype(FONT_BOLD, 56)
    txt = "in"
    tw = d.textlength(txt, font=f)
    bbox = f.getbbox(txt)
    th = bbox[3] - bbox[1]
    d.text(((s - tw) / 2, (s - th) / 2 - bbox[1]), txt, font=f, fill=WHITE)
    save(img, "icon-linkedin.png")


def icon_facebook():
    s = 96
    img, d = _circle(s)
    f = ImageFont.truetype(FONT_BOLD, 72)
    txt = "f"
    tw = d.textlength(txt, font=f)
    bbox = f.getbbox(txt)
    th = bbox[3] - bbox[1]
    d.text(((s - tw) / 2, (s - th) / 2 - bbox[1]), txt, font=f, fill=WHITE)
    save(img, "icon-facebook.png")


def icon_whatsapp():
    # Speech-bubble circle with a simple handset glyph.
    s = 96
    img, d = _circle(s)
    cx = cy = s / 2
    r = 34
    d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], outline=WHITE, width=7)
    # little tail
    d.polygon([(cx - r + 4, cy + r - 6), (cx - r - 6, cy + r + 12), (cx - 6, cy + r - 2)], fill=WHITE)
    # handset (rotated rounded rect)
    handset = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    hd = ImageDraw.Draw(handset)
    hd.rounded_rectangle([(6, 6), (18, 34)], radius=6, fill=WHITE)
    hd.rounded_rectangle([(6, 6), (34, 18)], radius=6, fill=WHITE)
    handset = handset.rotate(-45, expand=True, resample=Image.BICUBIC)
    img.alpha_composite(handset, (int(cx - handset.width / 2), int(cy - handset.height / 2)))
    save(img, "icon-whatsapp.png")


if __name__ == "__main__":
    logo()
    mark()
    icon_instagram()
    icon_linkedin()
    icon_facebook()
    icon_whatsapp()
    print("Brand assets done.")
