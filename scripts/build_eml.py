#!/usr/bin/env python3
"""
build_eml.py - turn a track's email.html into a self-contained .eml where every photo
is EMBEDDED inside the message as a CID (Content-ID) part. No external hosting, no
Gmail image proxy, no AMP runtime - the images travel inside the email and therefore
render in Gmail, Apple Mail, Outlook, everywhere.

Use this when you want images guaranteed to show (e.g. testing, or sending via a tool
that supports an inline/related draft). For a normal hosted send, email.html with clean
jsDelivr URLs is fine; this is the bulletproof embedded alternative.

  python3 build_eml.py --html <email.html> --photos <dir> --subject "<subj>" \
      --from "ViaKashmir <contact@viakashmir.in>" --to "you@example.com" --out <email.eml>

It finds <img src="https://images.unsplash.com/<id>?..."> (and any local-named photo),
maps each to a file in --photos by matching the Unsplash id to a known filename, embeds
it, and rewrites the src to cid:<id>. Mapping can be extended in PHOTO_MAP.
"""
import argparse, re, mimetypes
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

# Unsplash id  ->  local filename in the photos pool
PHOTO_MAP = {
    "photo-1600845747913-e33543f94892": "hero_dal.jpg",
    "photo-1715457573748-8e8a70b2c1be": "boats.jpg",
    "photo-1651509094074-e8acaeb84d8f": "gulmarg.jpg",
    "photo-1564329494258-3f72215ba175": "shikara.jpg",
    "photo-1598091383021-15ddea10925d": "valley.jpg",
    "photo-1568889753852-196c487a536e": "cablecar.jpg",
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True)
    ap.add_argument("--photos", required=True)
    ap.add_argument("--subject", default="ViaKashmir")
    ap.add_argument("--from", dest="frm", default="ViaKashmir <contact@viakashmir.in>")
    ap.add_argument("--to", default="recipient@example.com")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    html = Path(a.html).read_text()
    photos = Path(a.photos)
    cids = {}  # id -> (cid, filepath)

    def repl(m):
        url = m.group(0)
        idm = re.search(r"(photo-\d+-[0-9a-f]+)", url)
        if not idm:
            return url
        pid = idm.group(1)
        fname = PHOTO_MAP.get(pid)
        if not fname or not (photos / fname).exists():
            return url  # leave hosted URL if we can't embed
        if pid not in cids:
            cids[pid] = (make_msgid(domain="viakashmir.in")[1:-1], photos / fname)
        cid = cids[pid][0]
        return f'src="cid:{cid}"'

    html = re.sub(r'src="https://(?:wsrv\.nl/\?url=images\.unsplash\.com|images\.unsplash\.com)/[^"]+"', repl, html)

    msg = EmailMessage()
    msg["Subject"] = a.subject
    msg["From"] = a.frm
    msg["To"] = a.to
    msg.set_content("This email requires an HTML-capable client.")
    msg.add_alternative(html, subtype="html")
    # attach images as related parts on the html alternative
    html_part = msg.get_payload()[1]
    for pid, (cid, fp) in cids.items():
        ctype, _ = mimetypes.guess_type(str(fp))
        maintype, subtype = (ctype or "image/jpeg").split("/", 1)
        html_part.add_related(fp.read_bytes(), maintype=maintype, subtype=subtype,
                              cid=f"<{cid}>", filename=fp.name)

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_bytes(bytes(msg))
    print(f"{a.out}  embedded={len(cids)} images: {', '.join(p.name for _,p in cids.values())}")

if __name__ == "__main__":
    main()
