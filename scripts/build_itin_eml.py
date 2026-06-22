#!/usr/bin/env python3
"""
build_itin_eml.py - turn each market's email.html into a self-contained .eml where
every wsrv-wrapped photo is embedded as a CID attachment. Standard-library only.

  python3 scripts/build_itin_eml.py --date 2026-06-15 --all
  python3 scripts/build_itin_eml.py --date 2026-06-15 --market india
"""
import argparse, datetime as dt, json, mimetypes, re, sys
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
MARKETS = ["india", "kashmir", "saudi", "dubai"]


def build_eml(html_path: Path, subject: str, out_path: Path) -> int:
    html = html_path.read_text(encoding="utf-8")
    cids: dict[str, tuple[str, Path]] = {}

    def repl(m):
        url = m.group(0)
        fm = re.search(r"/photos/([A-Za-z0-9_\-]+)\.jpg", url)
        if not fm:
            return url
        key = fm.group(1)
        fp = PHOTOS / f"{key}.jpg"
        if not fp.exists():
            return url
        if key not in cids:
            cids[key] = (make_msgid(domain="viakashmir.in")[1:-1], fp)
        return f'src="cid:{cids[key][0]}"'

    html = re.sub(r'src="https://wsrv\.nl/\?url=[^"]+/photos/[^"]+"', repl, html)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "ViaKashmir Itinerary <contact@viakashmir.in>"
    msg["To"] = "recipient@example.com"
    msg.set_content("This email requires an HTML-capable client.")
    msg.add_alternative(html, subtype="html")
    html_part = msg.get_payload()[1]
    for key, (cid, fp) in cids.items():
        ctype, _ = mimetypes.guess_type(str(fp))
        maintype, subtype = (ctype or "image/jpeg").split("/", 1)
        html_part.add_related(fp.read_bytes(), maintype=maintype, subtype=subtype,
                              cid=f"<{cid}>", filename=fp.name)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(msg))
    return len(cids)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--market", choices=MARKETS)
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    markets = MARKETS if a.all else ([a.market] if a.market else None)
    if not markets:
        raise SystemExit("pass --all or --market <market>")

    day = ROOT / "content" / "via-kashmir-itinerary" / a.date
    for market in markets:
        sd = day / market
        html_path = sd / "email.html"
        if not html_path.exists():
            print(f"  {market}: skipped (no email.html)")
            continue
        meta = json.loads((sd / "meta.json").read_text()) if (sd / "meta.json").exists() else {}
        subject = meta.get("subject", f"ViaKashmir Itinerary - {market}")
        out = sd / "email.eml"
        n = build_eml(html_path, subject, out)
        print(f"  {market}: {out}  (embedded {n} images)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
