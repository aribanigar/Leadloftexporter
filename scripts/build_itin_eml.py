#!/usr/bin/env python3
"""
build_itin_eml.py — Generate CID-embedded email.eml for ViaKashmir Itinerary.
Embeds the hero photo as a CID attachment; wraps email.html in proper MIME structure.

Usage:
    python3 scripts/build_itin_eml.py --date 2026-06-22 --all
    python3 scripts/build_itin_eml.py --date 2026-06-22 --market india
"""
import argparse, base64, datetime as dt, json, re, sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.header import Header
from pathlib import Path

ROOT    = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content" / "via-kashmir-itinerary"
PHOTO_DIR = CONTENT / "_assets" / "photos"

MARKETS = ["india", "kashmir", "saudi", "dubai"]

FROM_ADDR = "ViaKashmir Itinerary <contact@viakashmir.in>"
REPLY_TO  = "contact@viakashmir.in"


def build_eml(market: str, date_str: str):
    md = CONTENT / date_str / market
    if not md.is_dir():
        print(f"  [eml:{market}] no dir — run build_itin.py first", file=sys.stderr)
        return

    html_path = md / "email.html"
    meta_path = md / "meta.json"
    if not html_path.exists() or not meta_path.exists():
        print(f"  [eml:{market}] email.html or meta.json missing", file=sys.stderr)
        return

    meta    = json.loads(meta_path.read_text())
    subject = meta.get("subject", "ViaKashmir Itinerary")
    photo   = meta.get("photo", "")
    html_src = html_path.read_text(encoding="utf-8")

    msg = MIMEMultipart("related")
    msg["Subject"] = str(Header(subject, "utf-8"))
    msg["From"]    = FROM_ADDR
    msg["Reply-To"] = REPLY_TO
    msg["Date"]    = dt.datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0000")
    msg["X-Mailer"] = "ViaKashmir-Itinerary-Builder/1.0"

    # Embed hero photo as CID if available
    cid_map = {}
    if photo:
        photo_file = PHOTO_DIR / f"{photo}.jpg"
        if photo_file.exists():
            cid = f"hero_{photo}@viakashmir.in"
            cid_map[photo] = cid
            with open(photo_file, "rb") as f:
                img_data = f.read()
            mime_img = MIMEImage(img_data, "jpeg")
            mime_img.add_header("Content-ID", f"<{cid}>")
            mime_img.add_header("Content-Disposition", "inline", filename=f"{photo}.jpg")

    # Replace wsrv URL for hero photo with cid: reference
    html_final = html_src
    if photo and photo in cid_map:
        wsrv_pattern = re.compile(
            r'https://wsrv\.nl/\?url=raw\.githubusercontent[^"\']+' + re.escape(f"{photo}.jpg") + r'[^"\']*'
        )
        html_final = wsrv_pattern.sub(f"cid:{cid_map[photo]}", html_final, count=1)

    alt = MIMEMultipart("alternative")
    plain = f"ViaKashmir Itinerary Builder — {subject}\n\nBuild any client itinerary in about 2 minutes.\n\n{meta.get('cta_url','https://viakashmiritinerary.in/signup')}\n"
    alt.attach(MIMEText(plain, "plain", "utf-8"))
    alt.attach(MIMEText(html_final, "html", "utf-8"))
    msg.attach(alt)

    if photo and photo in cid_map:
        msg.attach(mime_img)

    out = md / "email.eml"
    out.write_bytes(msg.as_bytes())
    print(f"  [{market}] email.eml → {out} ({out.stat().st_size // 1024} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--market", choices=MARKETS)
    args = ap.parse_args()

    markets = MARKETS if args.all else [args.market]
    if not markets or markets == [None]:
        print("Specify --all or --market <name>", file=sys.stderr)
        sys.exit(1)

    print(f"build_itin_eml.py — date={args.date}  markets={markets}")
    for m in markets:
        build_eml(m, args.date)
    print("Done.")


if __name__ == "__main__":
    main()
