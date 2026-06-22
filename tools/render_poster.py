#!/usr/bin/env python3
"""Render the QckServe daily poster as a PNG (dependency: Pillow).

PNG (not SVG) so it renders in both the Content Hub and email clients — most
inboxes (Gmail/Outlook/Apple Mail) refuse to display SVG. On-brand editorial
layout: flat colour blocking, oversized headline, giant rupee-zero device, with
the top-left ~140px square left blank for the logo (placed manually).

Usage: python tools/render_poster.py <YYYY-MM-DD> <out.png>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1350
DARK = (26, 26, 26)        # #1A1A1A
ORANGE = (239, 103, 35)    # #ef6723
LIGHT = (252, 249, 248)    # #FCF9F8
GREY = (154, 154, 154)
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SERIF_IT = "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf"


def fit(draw, text, font_path, target_w, start=200):
    """Largest font size whose text width <= target_w."""
    size = start
    while size > 10:
        f = ImageFont.truetype(font_path, size)
        if draw.textlength(text, font=f) <= target_w:
            return f, size
        size -= 2
    return ImageFont.truetype(font_path, 10), 10


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else "0000-00-00"
    out = sys.argv[2] if len(sys.argv) > 2 else f"qckserve-{date}.png"

    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)

    # bottom flat orange band (no gradients)
    d.rectangle([0, 1086, W, H], fill=ORANGE)

    margin = 76
    maxw = W - margin - 40

    # italic-serif kicker
    d.text((80, 188), "Peak house-hunting season is here.",
           font=ImageFont.truetype(SERIF_IT, 42), fill=LIGHT)

    # oversized condensed headline (auto-fit longest line)
    hf, hsize = fit(d, "BROKERAGE.", F, maxw, start=180)
    lh = int(hsize * 1.02)
    y = 270
    for line, col in [("LIST FREE.", LIGHT), ("KEEP THE", LIGHT), ("BROKERAGE.", ORANGE)]:
        d.text((margin, y), line, font=hf, fill=col)
        y += lh

    # big-number device: struck "1 month's rent" over giant "you pay ₹0"
    sf = ImageFont.truetype(F, 40)
    strike = "1 month's rent to a broker"
    d.text((80, y + 24), strike, font=sf, fill=GREY)
    sw = d.textlength(strike, font=sf)
    sy = y + 24 + 40 // 2 + 4
    d.line([(80, sy), (80 + sw, sy)], fill=GREY, width=4)

    bigf, bsize = fit(d, "you pay ₹0", F, maxw, start=150)
    by = y + 24 + 64
    pre = "you pay "
    d.text((76, by), pre, font=bigf, fill=LIGHT)
    d.text((76 + d.textlength(pre, font=bigf), by), "₹0", font=bigf, fill=ORANGE)

    # footer on orange band
    d.text((80, 1132), "qckserve.in", font=ImageFont.truetype(F, 56), fill=DARK)
    d.text((80, 1208), "Owner to owner. Free listings, nationwide.",
           font=ImageFont.truetype(F, 30), fill=DARK)

    img.save(out, "PNG", optimize=True)
    print("wrote", out)


if __name__ == "__main__":
    main()
