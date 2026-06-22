#!/usr/bin/env python3
"""
make_itin_cards.py - Generate 1080×1350 poster card (img/whatsapp.jpg) for each market.

Uses PIL. Falls back to a solid-colour card if the photo is missing.

Usage:
  python3 scripts/make_itin_cards.py --date 2026-06-22 --all
  python3 scripts/make_itin_cards.py --date 2026-06-22 --market india
"""
import argparse, datetime, json, sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    sys.exit("Pillow not installed — run: pip install pillow")

ROOT = Path(__file__).parent.parent
PHOTOS_DIR = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
CONTENT_BASE = ROOT / "content" / "via-kashmir-itinerary"
MARKETS = ["india", "kashmir", "saudi", "dubai"]

GREEN  = (14, 61, 47)        # #0e3d2f
SAFFRON = (200, 168, 75)     # #c8a84b
MINT   = (76, 175, 140)      # #4caf8c
WHITE  = (255, 255, 255)
CREAM  = (240, 237, 232)     # #f0ede8
DARK_GREEN = (17, 43, 30)    # #112b1e

W, H = 1080, 1350


def find_font(size: int, bold: bool = False):
    candidates_bold = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
    ]
    candidates_reg = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
    ]
    for path in (candidates_bold if bold else candidates_reg):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def wrap_text(text: str, font, draw, max_width: int) -> list[str]:
    words = text.split()
    lines, current = [], ""
    for w in words:
        test = (current + " " + w).strip()
        bbox = draw.textbbox((0, 0), test, font=font)
        if bbox[2] - bbox[0] <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = w
    if current:
        lines.append(current)
    return lines


def make_card(market: str, date_str: str, destinations: dict) -> Path:
    meta_path = CONTENT_BASE / date_str / market / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        hero_tag = meta.get("hero_photo", market)
        headline = meta.get("subject", "Build any itinerary in 2 minutes.")
    else:
        hero_tag = market
        headline = "Build any itinerary in 2 minutes."

    dest_data = destinations.get(market, {})
    hero_tag = dest_data.get("photo") or hero_tag

    # ── Background ──────────────────────────────────────────────────────────
    card = Image.new("RGB", (W, H), GREEN)

    # Try to load photo
    photo_path = PHOTOS_DIR / f"{hero_tag}.jpg"
    if not photo_path.exists():
        # try fallbacks
        for fb in [market, "manali", "kashmir"]:
            p = PHOTOS_DIR / f"{fb}.jpg"
            if p.exists():
                photo_path = p
                break

    if photo_path.exists():
        try:
            photo = Image.open(photo_path).convert("RGB")
            # crop to fill top 55% of card
            ph = int(H * 0.55)
            # resize maintaining aspect, then centre-crop
            pw = int(photo.width * ph / photo.height)
            if pw < W:
                pw = W
                ph = int(photo.height * W / photo.width)
            photo = photo.resize((pw, ph), Image.LANCZOS)
            left = (pw - W) // 2
            top = (ph - int(H * 0.55)) // 2
            photo = photo.crop((left, top, left + W, top + int(H * 0.55)))
            # dark gradient overlay
            overlay = Image.new("RGBA", photo.size, (14, 61, 47, 160))
            photo = photo.convert("RGBA")
            photo = Image.alpha_composite(photo, overlay).convert("RGB")
            card.paste(photo, (0, 0))
        except Exception:
            pass

    draw = ImageDraw.Draw(card)

    # ── Top bar: LOGO area ───────────────────────────────────────────────────
    draw.rectangle([0, 0, W, 80], fill=WHITE)
    font_logo = find_font(22, bold=True)
    font_tag  = find_font(13)
    draw.text((40, 22), "ViaKashmir", font=font_logo, fill=GREEN)
    draw.text((40, 50), "Itinerary Builder", font=font_tag, fill=(100, 130, 110))

    # Saffron accent line under logo bar
    draw.rectangle([0, 80, W, 84], fill=SAFFRON)

    # ── Photo zone label (destination pill) ──────────────────────────────────
    dest_label = hero_tag.replace("-", " ").title()
    font_pill = find_font(16, bold=True)
    pill_bbox = draw.textbbox((0, 0), dest_label, font=font_pill)
    pill_w = (pill_bbox[2] - pill_bbox[0]) + 32
    pill_x = (W - pill_w) // 2
    pill_y = int(H * 0.55) - 52
    draw.rounded_rectangle([pill_x, pill_y, pill_x + pill_w, pill_y + 34], radius=17, fill=MINT)
    draw.text((pill_x + 16, pill_y + 8), dest_label, font=font_pill, fill=WHITE)

    # ── Headline area (lower green section) ─────────────────────────────────
    text_y = int(H * 0.55) + 32
    font_h1 = find_font(46, bold=True)
    max_w = W - 80
    lines = wrap_text(headline, font_h1, draw, max_w)
    for line in lines[:3]:  # max 3 lines
        draw.text((40, text_y), line, font=font_h1, fill=WHITE)
        bbox = draw.textbbox((0, 0), line, font=font_h1)
        text_y += (bbox[3] - bbox[1]) + 12

    # ── Sub-text ─────────────────────────────────────────────────────────────
    text_y += 8
    font_sub = find_font(28)
    sub = "Any destination. Any client. About 2 minutes."
    sub_lines = wrap_text(sub, font_sub, draw, max_w)
    for line in sub_lines[:2]:
        draw.text((40, text_y), line, font=font_sub, fill=(168, 213, 184))
        bbox = draw.textbbox((0, 0), line, font=font_sub)
        text_y += (bbox[3] - bbox[1]) + 8

    # ── Speed stat box ───────────────────────────────────────────────────────
    stat_y = H - 280
    draw.rectangle([40, stat_y, W - 40, stat_y + 110], fill=DARK_GREEN)
    font_stat_big = find_font(36, bold=True)
    font_stat_sm  = find_font(18)
    draw.text((60, stat_y + 14), "15–20 min", font=font_stat_big, fill=(180, 130, 80))
    draw.text((60, stat_y + 56), "by hand in Word", font=font_stat_sm, fill=(140, 160, 150))
    arrow_x = W // 2
    draw.text((arrow_x - 20, stat_y + 30), "→", font=find_font(36, bold=True), fill=SAFFRON)
    draw.text((arrow_x + 20, stat_y + 14), "~2 min", font=font_stat_big, fill=MINT)
    draw.text((arrow_x + 20, stat_y + 56), "with the builder", font=font_stat_sm, fill=(140, 160, 150))

    # ── CTA bar ──────────────────────────────────────────────────────────────
    draw.rectangle([0, H - 140, W, H - 60], fill=SAFFRON)
    font_cta = find_font(26, bold=True)
    cta = "viakashmiritinerary.in/signup"
    cta_bbox = draw.textbbox((0, 0), cta, font=font_cta)
    cta_x = (W - (cta_bbox[2] - cta_bbox[0])) // 2
    draw.text((cta_x, H - 113), cta, font=font_cta, fill=DARK_GREEN)

    # ── Footer ───────────────────────────────────────────────────────────────
    draw.rectangle([0, H - 60, W, H], fill=(10, 40, 28))
    font_footer = find_font(18)
    draw.text((40, H - 42), "contact@viakashmir.in  ·  wa.me/919186051499", font=font_footer, fill=(80, 130, 100))

    # ── Save ─────────────────────────────────────────────────────────────────
    img_dir = CONTENT_BASE / date_str / market / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    out_path = img_dir / "whatsapp.jpg"
    card.save(str(out_path), "JPEG", quality=88, optimize=True)
    print(f"  [make_cards] ✓ {market}/img/whatsapp.jpg  ({W}×{H})")
    return out_path


def main():
    ap = argparse.ArgumentParser(description="Render poster cards for ViaKashmir Itinerary markets.")
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--market", choices=MARKETS)
    args = ap.parse_args()

    if not args.all and not args.market:
        ap.error("Provide --all or --market <name>")

    markets = MARKETS if args.all else [args.market]
    dest_file = CONTENT_BASE / args.date / "destinations.json"
    destinations = json.loads(dest_file.read_text()) if dest_file.exists() else {}

    print(f"[make_cards] Date={args.date}  Markets={markets}")
    for m in markets:
        make_card(m, args.date, destinations)
    print("[make_cards] Done.")


if __name__ == "__main__":
    main()
