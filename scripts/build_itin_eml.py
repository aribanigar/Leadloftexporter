#!/usr/bin/env python3
"""
build_itin_eml.py - Generate CID-embedded .eml for each market.

Reads email.html and img/whatsapp.jpg, embeds the image as a CID attachment,
and writes email.eml. The hero <img> src is NOT rewritten to CID because we
use wsrv URLs that email clients can load; the CID attachment is the poster card.

Usage:
  python3 scripts/build_itin_eml.py --date 2026-06-22 --all
"""
import argparse, base64, datetime, email.mime.image, email.mime.multipart, email.mime.text, json, sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONTENT_BASE = ROOT / "content" / "via-kashmir-itinerary"
MARKETS = ["india", "kashmir", "saudi", "dubai"]

FROM_ADDR = "ViaKashmir Itinerary Builder <contact@viakashmir.in>"
REPLY_TO  = "contact@viakashmir.in"


def build_eml(date_str: str, market: str) -> Path:
    mkt_dir = CONTENT_BASE / date_str / market
    meta_path = mkt_dir / "meta.json"
    html_path = mkt_dir / "email.html"
    card_path = mkt_dir / "img" / "whatsapp.jpg"

    if not meta_path.exists() or not html_path.exists():
        print(f"  [build_eml] SKIP {market}: missing meta.json or email.html")
        return None

    meta = json.loads(meta_path.read_text())
    subject = meta.get("subject", "ViaKashmir Itinerary Builder")
    html_content = html_path.read_text(encoding="utf-8")

    # Build MIME message
    msg = email.mime.multipart.MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = FROM_ADDR
    msg["Reply-To"] = REPLY_TO
    msg["X-Mailer"] = "ViaKashmir-Itinerary-Engine/1.0"
    msg["List-Unsubscribe"] = "<mailto:contact@viakashmir.in?subject=Unsubscribe>"

    # HTML part
    html_part = email.mime.text.MIMEText(html_content, "html", "utf-8")
    alt = email.mime.multipart.MIMEMultipart("alternative")
    alt.attach(html_part)
    msg.attach(alt)

    # Attach poster card as inline image if it exists
    if card_path.exists():
        with open(card_path, "rb") as f:
            img_data = f.read()
        img_part = email.mime.image.MIMEImage(img_data, "jpeg")
        img_part.add_header("Content-ID", "<poster-card>")
        img_part.add_header("Content-Disposition", "inline", filename="itinerary-builder.jpg")
        msg.attach(img_part)

    out_path = mkt_dir / "email.eml"
    out_path.write_bytes(msg.as_bytes())
    print(f"  [build_eml] ✓ {market}/email.eml")
    return out_path


def main():
    ap = argparse.ArgumentParser(description="Build CID-embedded .eml for ViaKashmir Itinerary markets.")
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--market", choices=MARKETS)
    args = ap.parse_args()

    if not args.all and not args.market:
        ap.error("Provide --all or --market")

    markets = MARKETS if args.all else [args.market]
    print(f"[build_eml] Date={args.date}  Markets={markets}")
    for m in markets:
        build_eml(args.date, m)
    print("[build_eml] Done.")


if __name__ == "__main__":
    main()
