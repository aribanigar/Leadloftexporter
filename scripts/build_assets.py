#!/usr/bin/env python3
"""Prepare reusable brand assets (white logo mark, header lockup, social icons)
for the Hudace email batch. All output is white-on-transparent PNG so it reads
on the dark email background. Run once; assets are reused every run."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "email")
OUT = os.path.abspath(OUT)
BLUE = (27, 144, 255, 255)
WHITE = (255, 255, 255, 255)
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"


def recolor_to(src, color):
    """The cairosvg render is dark shapes on an opaque white canvas. Turn the
    dark shapes into `color` on transparent by using inverted luminance as alpha."""
    from PIL import ImageOps
    im = Image.open(src).convert("RGB")
    lum = ImageOps.grayscale(im)
    alpha = ImageOps.invert(lum)  # black shapes -> opaque, white bg -> transparent
    solid = Image.new("RGBA", im.size, color)
    solid.putalpha(alpha)
    return solid


def trim(im):
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im


# 1. White mark from the real SVG-derived PNG
mark = trim(recolor_to(os.path.join(OUT, "logo-mark.png"), WHITE))
mark.save(os.path.join(OUT, "mark-white.png"))

# 2. Header lockup: white mark + HUDACE wordmark
mh = 96
scale = mh / mark.height
mk = mark.resize((int(mark.width * scale), mh), Image.LANCZOS)
word = "HUDACE"
f = ImageFont.truetype(FONT_BOLD, 78)
tmp = Image.new("RGBA", (10, 10))
d = ImageDraw.Draw(tmp)
tw = int(d.textlength(word, font=f))
gap = 34
lock = Image.new("RGBA", (mk.width + gap + tw + 8, mh), (0, 0, 0, 0))
lock.alpha_composite(mk, (0, 0))
d = ImageDraw.Draw(lock)
# vertical-center the text against the mark
asc, desc = f.getmetrics()
ty = (mh - (asc + desc)) // 2
d.text((mk.width + gap, ty), word, font=f, fill=WHITE)
lock = trim(lock)
lock.save(os.path.join(OUT, "logo-lockup-white.png"))
print("lockup", lock.size)

# 3. Footer mark (smaller standalone white mark already saved as mark-white.png)

# 4. Social icons: clean white glyphs on transparent, 120x120, rounded style
SZ = 120


def canvas():
    im = Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def save(im, name):
    im.save(os.path.join(OUT, name))


# Instagram: rounded square, circle, dot
im, d = canvas()
d.rounded_rectangle([12, 12, 108, 108], radius=30, outline=WHITE, width=9)
d.ellipse([40, 40, 80, 80], outline=WHITE, width=9)
d.ellipse([86, 30, 98, 42], fill=WHITE)
save(im, "icon-instagram.png")

# LinkedIn: rounded square with "in"
im, d = canvas()
d.rounded_rectangle([10, 10, 110, 110], radius=24, fill=WHITE)
fin = ImageFont.truetype(FONT_BOLD, 58)
d.text((60, 62), "in", font=fin, fill=(10, 9, 25, 255), anchor="mm")
save(im, "icon-linkedin.png")

# WhatsApp: speech circle with handset
im, d = canvas()
d.ellipse([10, 10, 110, 110], fill=WHITE)
# simple handset glyph in dark
fw = ImageFont.truetype(FONT_BOLD, 60)
# draw a phone using unicode fallback may fail; draw handset shape manually
dk = (10, 9, 25, 255)
# handset: two rounded ends connected by a bar
d.rounded_rectangle([44, 40, 62, 58], radius=8, fill=dk)
d.rounded_rectangle([62, 62, 80, 80], radius=8, fill=dk)
d.line([53, 53, 71, 71], fill=dk, width=12)
save(im, "icon-whatsapp.png")

# Facebook: rounded square with f
im, d = canvas()
d.rounded_rectangle([10, 10, 110, 110], radius=24, fill=WHITE)
ff = ImageFont.truetype(FONT_BOLD, 74)
d.text((66, 60), "f", font=ff, fill=(10, 9, 25, 255), anchor="mm")
save(im, "icon-facebook.png")

print("assets built in", OUT)
for n in ["mark-white.png", "logo-lockup-white.png", "icon-instagram.png",
          "icon-linkedin.png", "icon-whatsapp.png", "icon-facebook.png"]:
    p = os.path.join(OUT, n)
    print(" ", n, Image.open(p).size)
