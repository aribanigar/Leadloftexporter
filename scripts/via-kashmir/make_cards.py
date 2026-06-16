#!/usr/bin/env python3
"""
make_cards.py - ViaKashmir promotional card (1080x1350 JPG): the email's hero unit
rebuilt as a shareable poster in the Alpine Editorial design - #f3f4f5 page -> white
logo card -> a big Kashmir photo hero (rounded top) -> a green-gradient hook card
(mint badge, bold headline with a mint accent line, body, dark-green pill CTA with white
text, reassurance line) -> green contact banner. No price, no timeline, no commission.

Renders with Pillow only (no headless browser), so it is robust in any routine runner.
Distinct from scripts/make_cards.py (the gifts-gulf PIL card) - lives under
scripts/via-kashmir/ so neither engine clobbers the other.

  python3 scripts/via-kashmir/make_cards.py --track b2c \
      --photo content/via-kashmir/_assets/photos/valley.jpg \
      --out content/via-kashmir/2026-06-15/b2c/img/whatsapp.jpg
Override copy per day with --label/--promo/--accent/--body/--cta/--reassure.
"""
import argparse, io, os
from pathlib import Path
from urllib.request import Request, urlopen
from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent.parent.parent / "content/via-kashmir/_assets/photos"
LOGO_WSRV = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=520&output=png"
CONTACT = "contact@viakashmir.in   |   +919186051499"

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

W, H, M = 1080, 1350, 44
PAGE = (243, 244, 245)
MINT = (157, 211, 170)
BADGE_TXT = (178, 235, 255)
WHITE = (255, 255, 255)
CONTACT_BG = (14, 61, 47)
# hook gradient endpoints (top -> bottom): #00361a -> #004e5f
G_TOP, G_BOT = (0, 54, 26), (0, 78, 95)

TRACKS = {
  "b2c": dict(label="KASHMIR  ·  EARLY SUMMER 2026",
              promo="The valley is green and the lake is glass.",
              accent="It is open.",
              body="Flights are landing, the roads are clear, the meadows are out. Planned by people who live here, so you just arrive.",
              cta="Plan my Kashmir trip",
              reassure="Open all season  ·  Houseboats, hotels, cabs & shikaras sorted",
              photo="valley.jpg"),
  "b2b-hotels": dict(label="VIAKASHMIR  —  FOR HOTELS & STAYS",
              promo="That booking just went to",
              accent="someone else's hotel.",
              body="Travellers are searching Kashmir stays right now. The ones who find you, book you. Get your rooms in front of them.",
              cta="List my hotel",
              reassure="No cost to list  ·  Direct bookings, your guests",
              photo="stay.jpg"),
  "b2b-cabs-shikaras": dict(label="VIAKASHMIR  —  FOR CABS & SHIKARAS",
              promo="That ride just went to",
              accent="another driver.",
              body="Airport runs, valley drives, a shikara at golden hour. Travellers book all of it. Be the one they find first.",
              cta="List my service",
              reassure="No cost to list  ·  Riders come to you",
              photo="shikara.jpg"),
  "b2b-houseboats": dict(label="VIAKASHMIR  —  FOR HOUSEBOATS",
              promo="That guest just booked",
              accent="another houseboat.",
              body="Travellers want the real Dal Lake stay. List your boat where they are already looking, and your rooms get seen first.",
              cta="List my houseboat",
              reassure="No cost to list  ·  Your guests, your relationship",
              photo="houseboat.jpg"),
}


def font(bold, size):
    return ImageFont.truetype(FB if bold else FR, size)


def rounded_mask(size, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0], size[1]], radius=r, fill=255)
    return m


def round_corners(im, r, corners=(True, True, True, True)):
    """Apply rounded corners selectively (tl, tr, br, bl)."""
    w, h = im.size
    mask = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(mask)
    # carve square corners back to transparent, then round requested ones
    full = Image.new("L", (w, h), 0)
    ImageDraw.Draw(full).rounded_rectangle([0, 0, w, h], radius=r, fill=255)
    tl, tr, br, bl = corners
    box = Image.new("L", (w, h), 0)
    db = ImageDraw.Draw(box)
    db.rectangle([0, 0, w, h], fill=255)
    # start from rounded; square off corners we want sharp
    res = full.copy()
    dr = ImageDraw.Draw(res)
    if not tl: dr.rectangle([0, 0, r, r], fill=255)
    if not tr: dr.rectangle([w - r, 0, w, r], fill=255)
    if not br: dr.rectangle([w - r, h - r, w, h], fill=255)
    if not bl: dr.rectangle([0, h - r, r, h], fill=255)
    out = im.convert("RGBA")
    out.putalpha(res)
    return out


def cover(im, w, h):
    sw, sh = im.size
    s = max(w / sw, h / sh)
    im = im.resize((int(sw * s), int(sh * s)), Image.LANCZOS)
    x = (im.width - w) // 2
    y = (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def vgrad(w, h, top, bot):
    g = Image.new("RGB", (w, h))
    px = g.load()
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return g


def wrap(draw, text, fnt, maxw):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if draw.textlength(t, font=fnt) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines


def logo_img(h=58):
    try:
        raw = urlopen(Request(LOGO_WSRV, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read()
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        w = int(im.width * h / im.height)
        return im.resize((w, h), Image.LANCZOS)
    except Exception:
        return None


def build(s, photo, out):
    canvas = Image.new("RGB", (W, H), PAGE)
    d = ImageDraw.Draw(canvas)
    cw = W - 2 * M  # content width

    # --- logo card (white) ---
    ly, lh = M, 132
    card = Image.new("RGB", (cw, lh), WHITE)
    canvas.paste(round_corners(card, 22), (M, ly), round_corners(card, 22))
    lg = logo_img(58)
    if lg:
        canvas.paste(lg, (M + (cw - lg.width) // 2, ly + (lh - lg.height) // 2), lg)
    else:
        f = font(True, 46)
        tw = d.textlength("ViaKashmir", font=f)
        d.text((M + (cw - tw) // 2, ly + (lh - 50) // 2), "ViaKashmir", font=f, fill=G_TOP)

    # --- unit: hero photo (rounded top) + green hook (rounded bottom) ---
    uy = ly + lh + 26
    contact_h = 96
    uy_end = H - M - contact_h - 26
    unit_h = uy_end - uy
    hero_h = int(unit_h * 0.46)
    hook_h = unit_h - hero_h

    hero = cover(Image.open(photo).convert("RGB"), cw, hero_h)
    hero = round_corners(hero, 26, corners=(True, True, False, False))
    canvas.paste(hero, (M, uy), hero)

    hook = vgrad(cw, hook_h, G_TOP, G_BOT)
    hook = round_corners(hook, 26, corners=(False, False, True, True))
    canvas.paste(hook, (M, uy + hero_h), hook)

    # text inside hook
    pad = 52
    tx = M + pad
    maxw = cw - 2 * pad
    y = uy + hero_h + 44
    hd = ImageDraw.Draw(canvas)

    # badge pill
    bf = font(True, 21)
    bw = hd.textlength(s["label"], font=bf)
    bpad = 22
    bh = 46
    badge = Image.new("RGBA", (int(bw + 2 * bpad), bh), (0, 0, 0, 0))
    ImageDraw.Draw(badge).rounded_rectangle([0, 0, badge.width, bh], radius=bh // 2,
                                            fill=(161, 231, 255, 36))
    ImageDraw.Draw(badge).text((bpad, (bh - 26) // 2), s["label"], font=bf, fill=BADGE_TXT)
    canvas.paste(badge, (tx, y), badge)
    y += bh + 30

    # headline (promo white, accent mint)
    hf = font(True, 62)
    for ln in wrap(hd, s["promo"], hf, maxw):
        hd.text((tx, y), ln, font=hf, fill=WHITE)
        y += 70
    if s.get("accent"):
        for ln in wrap(hd, s["accent"], hf, maxw):
            hd.text((tx, y), ln, font=hf, fill=MINT)
            y += 70
    y += 16

    # body
    yf = font(False, 27)
    for ln in wrap(hd, s["body"], yf, maxw):
        hd.text((tx, y), ln, font=yf, fill=(214, 224, 218))
        y += 38
    y += 30

    # CTA pill (dark green, white text)
    cf = font(True, 28)
    ctext = s["cta"] + "  →"
    ctw = hd.textlength(ctext, font=cf)
    cpw, cph = int(ctw + 100), 78
    pill = Image.new("RGBA", (cpw, cph), (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle([0, 0, cpw, cph], radius=cph // 2, fill=(14, 61, 47, 255))
    ImageDraw.Draw(pill).text(((cpw - ctw) // 2, (cph - 32) // 2), ctext, font=cf, fill=WHITE)
    canvas.paste(pill, (tx, y), pill)
    y += cph + 26

    # reassurance
    rf = font(False, 21)
    hd.text((tx, y), s["reassure"], font=rf, fill=(178, 200, 188))

    # --- contact banner ---
    cby = H - M - contact_h
    banner = Image.new("RGB", (cw, contact_h), CONTACT_BG)
    banner = round_corners(banner, 20)
    canvas.paste(banner, (M, cby), banner)
    cf2 = font(True, 31)
    ctw2 = hd.textlength(CONTACT, font=cf2)
    hd.text((M + (cw - ctw2) // 2, cby + (contact_h - 34) // 2), CONTACT, font=cf2, fill=WHITE)

    Path(out).parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=90)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", required=True, choices=list(TRACKS))
    ap.add_argument("--photo")
    ap.add_argument("--out", required=True)
    for k in ("label", "promo", "accent", "body", "cta", "reassure"):
        ap.add_argument("--" + k)
    a = ap.parse_args()
    s = dict(TRACKS[a.track])
    for k in ("label", "promo", "accent", "body", "cta", "reassure"):
        if getattr(a, k):
            s[k] = getattr(a, k)
    photo = a.photo or str(ASSETS / s["photo"])
    print(build(s, photo, a.out))


if __name__ == "__main__":
    main()
