#!/usr/bin/env python3
"""
make_itin_cards.py — Generate 1080x1350 WhatsApp poster cards for ViaKashmir Itinerary.
Requires Pillow. Reads destinations.json and meta.json; writes img/whatsapp.jpg.

Usage:
    python3 scripts/make_itin_cards.py --date 2026-06-22 --all
    python3 scripts/make_itin_cards.py --date 2026-06-22 --market india
"""
import argparse, datetime as dt, json, sys, urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    raise SystemExit("Pillow missing — run: pip install pillow")

ROOT      = Path(__file__).resolve().parent.parent
CONTENT   = ROOT / "content" / "via-kashmir-itinerary"
PHOTO_DIR = CONTENT / "_assets" / "photos"

GREEN    = (14, 61, 47)       # #0e3d2f
GREEN2   = (26, 92, 68)       # #1a5c44
SAFFRON  = (200, 168, 75)     # #c8a84b
MINT     = (125, 217, 176)    # #7dd9b0
WHITE    = (255, 255, 255)
CARD_W, CARD_H = 1080, 1350

MARKETS = ["india", "kashmir", "saudi", "dubai"]

MARKET_COPY = {
    "india":   {"template": "{name} quote\nin 2 minutes", "sub": "Build any Indian itinerary — fast, professional, branded."},
    "kashmir": {"headline": "Kashmir circuit\nin 2 minutes", "sub": "Dal Lake · Gulmarg · Pahalgam — client-ready instantly."},
    "saudi":   {"template": "{name} quote\nin 2 minutes", "sub": "Any global itinerary — fast, professional, branded."},
    "dubai":   {"template": "{name} itinerary\nin 2 minutes", "sub": "Any destination worldwide — quoted in minutes, not hours."},
}
DEFAULT_PLACE = {"india": "Kerala", "kashmir": "Kashmir", "saudi": "Cappadocia", "dubai": "Bali"}


def gradient_image(w: int, h: int, top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        r = int(top[0] + (bottom[0] - top[0]) * y / h)
        g = int(top[1] + (bottom[1] - top[1]) * y / h)
        b = int(top[2] + (bottom[2] - top[2]) * y / h)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    return img


def load_photo(name: str, size: tuple) -> Image.Image | None:
    path = PHOTO_DIR / f"{name}.jpg"
    if not path.exists():
        return None
    try:
        img = Image.open(path).convert("RGB")
        img_ratio = img.width / img.height
        target_ratio = size[0] / size[1]
        if img_ratio > target_ratio:
            new_h = size[1]
            new_w = int(new_h * img_ratio)
        else:
            new_w = size[0]
            new_h = int(new_w / img_ratio)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - size[0]) // 2
        top  = (new_h - size[1]) // 2
        return img.crop((left, top, left + size[0], top + size[1]))
    except Exception as e:
        print(f"  [card] photo load error: {e}")
        return None


def try_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.otf" if bold else "/usr/share/fonts/truetype/freefont/FreeSans.otf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_card(market: str, photo_name: str, place_name: str = None) -> Image.Image:
    copy = MARKET_COPY.get(market, MARKET_COPY["india"])
    place_name = place_name or DEFAULT_PLACE.get(market, "")

    # Base gradient
    card = gradient_image(CARD_W, CARD_H, GREEN, GREEN2)

    # Photo zone (top 55% of card)
    photo_h = int(CARD_H * 0.55)
    photo = load_photo(photo_name, (CARD_W, photo_h))
    if photo:
        # Darken for text readability
        overlay = Image.new("RGB", (CARD_W, photo_h), GREEN)
        blended = Image.blend(photo, overlay, alpha=0.45)
        card.paste(blended, (0, 0))
    else:
        # Gradient fallback for photo zone
        zone = gradient_image(CARD_W, photo_h, GREEN2, GREEN)
        card.paste(zone, (0, 0))

    draw = ImageDraw.Draw(card)

    # Mint accent bar at top
    draw.rectangle([(0, 0), (CARD_W, 8)], fill=MINT)

    # Logo text area
    logo_font = try_font(32, bold=True)
    draw.text((60, 40), "ViaKashmir", font=logo_font, fill=WHITE)
    sub_font = try_font(22)
    draw.text((60, 82), "Itinerary Builder", font=sub_font, fill=MINT)

    # Destination badge (top right)
    badge_font = try_font(22)
    badge_text = f"✦ {place_name}"
    badge_bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
    bw = badge_bbox[2] - badge_bbox[0] + 28
    bx = CARD_W - bw - 40
    draw.rounded_rectangle([(bx - 14, 38), (bx + bw, 70)], radius=20, fill=SAFFRON)
    draw.text((bx, 45), badge_text, font=badge_font, fill=GREEN)

    # Main headline (lower part of photo zone)
    headline_font = try_font(80, bold=True)
    hy = photo_h - 240
    headline = copy["template"].format(name=place_name) if "template" in copy else copy["headline"]
    lines = headline.split("\n")
    for i, line in enumerate(lines):
        draw.text((60, hy + i * 94), line, font=headline_font, fill=WHITE)

    # Saffron accent line
    line_y = photo_h + 2
    draw.rectangle([(0, line_y), (CARD_W, line_y + 6)], fill=SAFFRON)

    # Sub text zone
    sub_font2 = try_font(36)
    draw.text((60, photo_h + 40), copy["sub"], font=sub_font2, fill=(200, 235, 218))

    # Divider
    div_y = photo_h + 110
    draw.rectangle([(60, div_y), (CARD_W - 60, div_y + 2)], fill=(60, 120, 90))

    # 3 quick proof lines
    proofs = [
        ("⏱", "~2 minutes from blank to client-ready"),
        ("✦", "Branded PDF — looks professional"),
        ("→", "Any destination, any route"),
    ]
    pf = try_font(30)
    py = div_y + 24
    for icon, text in proofs:
        draw.text((60, py), icon, font=pf, fill=SAFFRON)
        draw.text((110, py), text, font=pf, fill=WHITE)
        py += 52

    # CTA button area
    btn_y = CARD_H - 180
    draw.rounded_rectangle([(60, btn_y), (CARD_W - 60, btn_y + 80)], radius=40, fill=SAFFRON)
    cta_font = try_font(36, bold=True)
    cta_text = "viakashmiritinerary.in/signup"
    cta_bbox = draw.textbbox((0, 0), cta_text, font=cta_font)
    cw = cta_bbox[2] - cta_bbox[0]
    cx = (CARD_W - cw) // 2
    draw.text((cx, btn_y + 20), cta_text, font=cta_font, fill=GREEN)

    # Footer
    ft = try_font(24)
    draw.text((60, CARD_H - 60), "Build any itinerary. Any destination. In minutes.", font=ft, fill=MINT)

    return card


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--market", choices=MARKETS)
    args = ap.parse_args()

    dest_file = CONTENT / args.date / "destinations.json"
    dest_data = json.loads(dest_file.read_text()) if dest_file.exists() else {}

    markets = MARKETS if args.all else [args.market]
    if not markets or markets == [None]:
        print("Specify --all or --market <name>", file=sys.stderr)
        sys.exit(1)

    print(f"make_itin_cards.py — date={args.date}  markets={markets}")
    for m in markets:
        dest = dest_data.get(m, {})
        photo_name = dest.get("photo", m)
        place_name = dest.get("place", "").split(",")[0].strip() or photo_name.replace("_", " ").title()
        out_dir = CONTENT / args.date / m / "img"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "whatsapp.jpg"
        card = draw_card(m, photo_name, place_name)
        card.save(str(out_path), "JPEG", quality=88, optimize=True)
        print(f"  [{m}] {out_path} ({out_path.stat().st_size // 1024} KB)")
    print("Done.")


if __name__ == "__main__":
    main()
