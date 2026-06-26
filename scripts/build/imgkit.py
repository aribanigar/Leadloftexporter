#!/usr/bin/env python3
"""Hudace image kit: Pixabay fetch -> 4:5 crop -> baked promo card. Self-hosted assets only."""
import io, json, os, sys, urllib.request, urllib.parse, hashlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT/"assets"/"fonts"
OUT = ROOT/"public"/"email"
PIX = os.environ["PIXABAY_API"]
W, H = 1080, 1350
BG=(10,9,25); INK=(255,255,255); MUT=(154,154,174); BLUE=(27,144,255)

def F(name, size): return ImageFont.truetype(str(FONTS/name), size)
def fb(s): return F("Montserrat-Bold.ttf", s)
def fsb(s): return F("Montserrat-SemiBold.ttf", s)
def fm(s): return F("Montserrat-Medium.ttf", s)
def fr(s): return F("Montserrat-Regular.ttf", s)

def _get(url, timeout=50):
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def pixabay_pick(query, want=1, skip=0, min_w=1200):
    u = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=horizontal"
         "&safesearch=true&per_page=40&order=popular" % (PIX, urllib.parse.quote(query)))
    data = json.loads(_get(u).decode())
    hits = [h for h in data.get("hits",[]) if h.get("imageWidth",0)>=min_w]
    chosen = hits[skip:skip+want]
    return [h["largeImageURL"] for h in chosen]

def fill_crop(im, w, h):
    """center-crop-cover to exactly w x h"""
    im = im.convert("RGB")
    sr, tr = im.width/im.height, w/h
    if sr > tr:
        nh = h; nw = int(h*sr)
    else:
        nw = w; nh = int(w/sr)
    im = im.resize((nw, nh), Image.LANCZOS)
    x = (nw-w)//2; y = (nh-h)//2
    return im.crop((x, y, x+w, y+h))

def fetch_photo(query, out_name, skip=0, darken=0.62):
    urls = pixabay_pick(query, want=1, skip=skip)
    if not urls:
        urls = pixabay_pick(query.split()[0], want=1, skip=skip, min_w=900)
    raw = _get(urls[0])
    im = Image.open(io.BytesIO(raw))
    im = fill_crop(im, W, H)
    im = ImageEnhance.Brightness(im).enhance(darken)
    im = ImageEnhance.Contrast(im).enhance(1.05)
    p = OUT/out_name
    im.save(p, "JPEG", quality=86, optimize=True)
    return p

# ---------- text helpers ----------
def wrap(d, text, font, maxw):
    words=text.split(); lines=[]; cur=""
    for w in words:
        t=(cur+" "+w).strip()
        if d.textlength(t, font=font)<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
    if cur: lines.append(cur)
    return lines

def tracked(d, xy, text, font, fill, ls=0):
    x,y=xy
    for ch in text:
        d.text((x,y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font)+ls
    return x

def grad_overlay(im, top=0.15, bottom=0.82):
    """darken vertically: subtle at top, strong at bottom for text legibility"""
    g = Image.new("L",(1,H))
    for yy in range(H):
        a = top + (bottom-top)*(yy/H)
        g.putpixel((0,yy), int(255*a))
    g = g.resize((W,H))
    black = Image.new("RGB",(W,H),(4,4,12))
    return Image.composite(black, im, g)

def logo_white(maxw):
    lg = Image.open(OUT/"hudace-logo.png").convert("RGBA")
    return lg.resize((maxw, int(lg.height*maxw/lg.width)), Image.LANCZOS)

def bake_card(bg_name, out_name, eyebrow, headline, items, cta="Chat on WhatsApp  .  wa.me/918218929990"):
    base = Image.open(OUT/bg_name).convert("RGB")
    base = fill_crop(base, W, H)
    base = grad_overlay(base, 0.30, 0.86)
    d = ImageDraw.Draw(base)
    M = 84
    # logo
    lg = logo_white(300); base.paste(lg,(M,76),lg)
    y = 250
    # accent rule
    d.rectangle([M, y, M+64, y+5], fill=BLUE); y += 30
    # eyebrow
    tracked(d,(M,y), eyebrow.upper(), fsb(25), BLUE, ls=3); y += 58
    # headline
    for ln in wrap(d, headline, fb(60), W-2*M-10):
        d.text((M,y), ln, font=fb(60), fill=INK); y += 74
    y += 26
    # deliverables
    for it in items:
        d.rectangle([M, y+6, M+5, y+34], fill=BLUE)
        lines = wrap(d, it, fm(31), W-2*M-34)
        for i,ln in enumerate(lines):
            d.text((M+28, y), ln, font=fm(31), fill=INK); y += 42
        y += 14
    # CTA pill near bottom
    cy = H-228
    d.rounded_rectangle([M, cy, W-M, cy+78], radius=10, fill=BLUE)
    tw = d.textlength(cta, font=fsb(30))
    d.text(((W-tw)/2, cy+23), cta, font=fsb(30), fill=INK)
    # contact
    contact = "hudace.com   .   contact@hudace.com   .   +91 82189 29990"
    cw = d.textlength(contact, font=fm(26))
    d.text(((W-cw)/2, H-104), contact, font=fm(26), fill=MUT)
    base.save(OUT/out_name, "JPEG", quality=88, optimize=True)
    return OUT/out_name

if __name__=="__main__":
    # smoke test
    p = fetch_photo("pharmaceutical laboratory research dark", "_test-bg.jpg", skip=0)
    print("photo:", p)
    bake_card("_test-bg.jpg", "_test-card.jpg",
              "Social Media . Life Sciences",
              "Managed Social That Earns Clinical Trust",
              ["6 short-form videos / month","12 feed posts / month","8 stories / month",
               "Community management","Monthly performance report"])
    print("card baked")
