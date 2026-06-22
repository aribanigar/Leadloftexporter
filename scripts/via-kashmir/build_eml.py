#!/usr/bin/env python3
"""
build_eml.py - turn a via-kashmir track's email.html into a self-contained .eml where
every photo is EMBEDDED as a CID part. No external hosting, no Gmail image proxy, no AMP
runtime - the bytes travel inside the message, so it renders in Gmail, Apple Mail and
Outlook with no external fetch. Use it when you want images guaranteed to show (testing,
or a tool that sends an inline/related draft). Hosted clean wsrv URLs stay the default
for bulk sends; this is the bulletproof fallback.

It maps each wsrv-wrapped pool image (.../_assets/photos/<file>.jpg) and the wsrv logo to
a local file and rewrites the src to cid:<id>.

  python3 scripts/via-kashmir/build_eml.py --html <set>/email.html \
      --photos content/via-kashmir/_assets/photos \
      --subject "<subj>" --from "ViaKashmir <contact@viakashmir.in>" --to "you@x.com" \
      --out <set>/email.eml
"""
import argparse, re, mimetypes
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path


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
    cids = {}  # key -> (cid, filepath)

    def repl(m):
        url = m.group(0)
        fm = re.search(r"/photos/([A-Za-z0-9_\-]+)\.jpg", url)
        if not fm:
            return url
        key = fm.group(1)
        fp = photos / f"{key}.jpg"
        if not fp.exists():
            return url
        if key not in cids:
            cids[key] = (make_msgid(domain="viakashmir.in")[1:-1], fp)
        return f'src="cid:{cids[key][0]}"'

    html = re.sub(r'src="https://wsrv\.nl/\?url=[^"]+/photos/[^"]+"', repl, html)

    msg = EmailMessage()
    msg["Subject"] = a.subject
    msg["From"] = a.frm
    msg["To"] = a.to
    msg.set_content("This email requires an HTML-capable client.")
    msg.add_alternative(html, subtype="html")
    html_part = msg.get_payload()[1]
    for key, (cid, fp) in cids.items():
        ctype, _ = mimetypes.guess_type(str(fp))
        maintype, subtype = (ctype or "image/jpeg").split("/", 1)
        html_part.add_related(fp.read_bytes(), maintype=maintype, subtype=subtype,
                              cid=f"<{cid}>", filename=fp.name)

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_bytes(bytes(msg))
    print(f"{a.out}  embedded={len(cids)} images: {', '.join(p.name for _, p in cids.values())}")


if __name__ == "__main__":
    main()
