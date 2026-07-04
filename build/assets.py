#!/usr/bin/env python3
"""Generate reusable brand assets (logo wordmark, mark, white social icons) into public/email/.
Run once; assets are committed and reused across runs. Idempotent (skips if present)."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "email")
os.makedirs(OUT, exist_ok=True)

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG  = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BLUE = (27, 144, 255, 255)
WHITE = (255, 255, 255, 255)


def rounded_tile(size, radius, fill):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)
    return img


def punch(img, drawer):
    """drawer(d) draws shapes with fill=(0,0,0,0) to punch transparent holes."""
    d = ImageDraw.Draw(img)
    drawer(d)
    return img


def wordmark():
    p = os.path.join(OUT, "logo-wordmark.png")
    W, H = 520, 130
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(BOLD, 86)
    d.text((6, 18), "hudace", font=f, fill=WHITE)
    # blue accent dot after the wordmark
    bb = d.textbbox((6, 18), "hudace", font=f)
    d.ellipse([bb[2] + 14, bb[3] - 26, bb[2] + 34, bb[3] - 6], fill=BLUE)
    img.save(p)
    return p


def mark():
    p = os.path.join(OUT, "logo-mark.png")
    S = 160
    img = rounded_tile(S, 38, BLUE)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(BOLD, 104)
    tb = d.textbbox((0, 0), "h", font=f)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text(((S - tw) / 2 - tb[0], (S - th) / 2 - tb[1] - 4), "h", font=f, fill=WHITE)
    img.save(p)
    return p


def icon_instagram():
    S = 96
    img = rounded_tile(S, 26, WHITE)

    def draw(d):
        d.rounded_rectangle([24, 24, 72, 72], radius=16, fill=(0, 0, 0, 0), width=0)
        # re-fill inner white then punch lens + dot to give camera look
    img = rounded_tile(S, 26, WHITE)
    d = ImageDraw.Draw(img)
    # lens
    d.ellipse([32, 32, 64, 64], outline=(0, 0, 0, 0), width=8)
    # dot
    d.ellipse([66, 30, 74, 38], fill=(0, 0, 0, 0))
    img.save(os.path.join(OUT, "ig.png"))


def icon_linkedin():
    S = 96
    img = rounded_tile(S, 26, WHITE)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(BOLD, 54)
    tb = d.textbbox((0, 0), "in", font=f)
    tw = tb[2] - tb[0]
    d.text(((S - tw) / 2 - tb[0], 20), "in", font=f, fill=(0, 0, 0, 0))
    img.save(os.path.join(OUT, "li.png"))


def icon_whatsapp():
    S = 96
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, S - 3, S - 3], fill=WHITE)
    hole = (0, 0, 0, 0)
    # diagonal telephone handset silhouette
    d.line([(36, 36), (60, 60)], fill=hole, width=13)
    d.ellipse([28, 28, 46, 46], fill=hole)   # ear piece
    d.ellipse([50, 50, 68, 68], fill=hole)   # mouth piece
    img.save(os.path.join(OUT, "wa.png"))


if __name__ == "__main__":
    wordmark(); mark(); icon_instagram(); icon_linkedin(); icon_whatsapp()
    print("assets ->", sorted(os.listdir(OUT)))
