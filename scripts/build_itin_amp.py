#!/usr/bin/env python3
"""
build_itin_amp.py — Generate AMP4Email email.amp.html for ViaKashmir Itinerary.
Reads email.html and meta.json produced by build_itin.py.

Usage:
    python3 scripts/build_itin_amp.py --date 2026-06-22 --all
    python3 scripts/build_itin_amp.py --date 2026-06-22 --market india
"""
import argparse, datetime as dt, json, sys
from pathlib import Path

ROOT    = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content" / "via-kashmir-itinerary"
WSRV    = "https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main"
CTA_URL = "https://viakashmiritinerary.in/signup"
LOGO_URL = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png"

MARKETS = ["india", "kashmir", "saudi", "dubai"]

GREEN   = "#0e3d2f"
GREEN2  = "#1a5c44"
SAFFRON = "#c8a84b"
MINT    = "#7dd9b0"
WHITE   = "#ffffff"
MINT_LIGHT = "#e8f5f0"
TEXT_LIGHT = "#555555"


def photo_url(name: str) -> str:
    return f"{WSRV}/content/via-kashmir-itinerary/_assets/photos/{name}.jpg&w=1200&output=jpg&q=82"


def build_amp(market: str, date_str: str):
    md = CONTENT / date_str / market
    if not md.is_dir():
        print(f"  [amp:{market}] no dir, run build_itin.py first", file=sys.stderr)
        return

    meta_path = md / "meta.json"
    if not meta_path.exists():
        print(f"  [amp:{market}] meta.json missing", file=sys.stderr)
        return
    meta = json.loads(meta_path.read_text())

    photo = meta.get("photo", "kerala")
    feat  = meta.get("feat_photo", "rajasthan")
    subj  = meta.get("subject", "")
    dest  = meta.get("destination", "")
    cname = meta.get("campaign_name", market)
    bilingual = meta.get("bilingual", False)

    hero_img = photo_url(photo)
    feat_img = photo_url(feat)

    bilingual_section = ""
    if bilingual:
        bilingual_section = f"""
    <div style="background:{GREEN2};padding:28px 32px;text-align:right;direction:rtl;font-family:Arial,sans-serif">
      <h2 style="margin:0 0 12px;color:{WHITE};font-size:20px">أنجز عرضك قبل المنافس</h2>
      <p style="margin:0 0 20px;color:#cceedf;font-size:14px;line-height:1.6">بنِ خط سير أي وجهة في دقيقتين. احترافي، مُبوَّب، جاهز للإرسال.</p>
      <a href="{CTA_URL}" style="display:inline-block;background:{WHITE};color:{GREEN};padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;text-decoration:none">ابدأ الآن ←</a>
    </div>"""

    amp_html = f"""<!doctype html>
<html ⚡4email data-css-strict>
<head>
  <meta charset="utf-8">
  <style amp4email-boilerplate>body{{-webkit-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-moz-animation:-amp-start 8s steps(1,end) 0s 1 normal both;-ms-animation:-amp-start 8s steps(1,end) 0s 1 normal both;animation:-amp-start 8s steps(1,end) 0s 1 normal both}}@-webkit-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@-moz-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@-ms-keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}@keyframes -amp-start{{from{{visibility:hidden}}to{{visibility:visible}}}}</style>
  <noscript><style amp-boilerplate>body{{-webkit-animation:none;-moz-animation:none;-ms-animation:none;animation:none}}</style></noscript>
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <style amp-custom>
    body {{ margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif }}
    .wrap {{ max-width:600px;margin:0 auto;background:#fff }}
    .logo-card {{ padding:24px 32px;text-align:center;border-bottom:1px solid #f0f0f0 }}
    .logo-tag {{ font-size:10px;letter-spacing:3px;color:#aaa;text-transform:uppercase;margin-top:6px }}
    .hero-text {{ background:linear-gradient(180deg,{GREEN} 0%,{GREEN2} 100%);padding:32px 32px 40px }}
    .hero-tag {{ color:{MINT};font-size:10px;letter-spacing:2px;text-transform:uppercase;margin:0 0 8px }}
    .hero-h1 {{ color:{WHITE};font-size:22px;font-weight:700;line-height:1.35;margin:0 0 14px }}
    .hero-sub {{ color:#cceedf;font-size:14px;line-height:1.6;margin:0 0 22px }}
    .pill {{ display:inline-block;background:{WHITE};color:{GREEN};padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;text-decoration:none }}
    .strip {{ height:4px;background:linear-gradient(90deg,{MINT},{SAFFRON}) }}
    .section {{ padding:32px }}
    .cta-card {{ background:{GREEN};padding:40px 32px;text-align:center }}
    .cta-card h2 {{ color:{WHITE};font-size:20px;margin:0 0 10px }}
    .cta-card p {{ color:#aaddcc;font-size:14px;margin:0 0 22px }}
    .cta-btn {{ display:inline-block;background:{SAFFRON};color:{GREEN};padding:14px 36px;border-radius:50px;font-size:15px;font-weight:700;text-decoration:none }}
    .urgency {{ background:{SAFFRON};padding:18px 32px;text-align:center }}
    .urgency p {{ margin:0;color:{GREEN};font-size:14px;font-weight:700 }}
    .contact {{ background:{MINT_LIGHT};padding:24px 32px;text-align:center }}
    .footer {{ background:#fafafa;padding:20px 32px;text-align:center;border-top:1px solid #eee }}
    .footer p {{ margin:0;color:#999;font-size:11px;line-height:1.7 }}
    a {{ color:{GREEN} }}
  </style>
  <title>{subj}</title>
</head>
<body>
<div class="wrap">

  <!-- Logo -->
  <div class="logo-card">
    <amp-img src="{LOGO_URL}" width="160" height="40" alt="ViaKashmir Itinerary" layout="fixed"></amp-img>
    <div class="logo-tag">Itinerary Builder</div>
  </div>

  <!-- Hero photo -->
  <amp-img src="{hero_img}" width="600" height="300" layout="responsive" alt="{dest}"></amp-img>

  <!-- Hero text -->
  <div class="hero-text">
    <p class="hero-tag">{dest} · {date_str[:7]}</p>
    <h1 class="hero-h1">Build any itinerary in about 2 minutes — not 20.</h1>
    <p class="hero-sub">Professional, branded, client-ready output. No Word. No 15-minute grind. Any destination.</p>
    <a href="{CTA_URL}" class="pill">Build your first itinerary →</a>
  </div>

  {bilingual_section}

  <!-- Accent strip -->
  <div class="strip"></div>

  <!-- Feature photo -->
  <amp-img src="{feat_img}" width="600" height="240" layout="responsive" alt="Any destination"></amp-img>

  <!-- Feature text -->
  <div class="section" style="background:{MINT_LIGHT}">
    <h3 style="margin:0 0 10px;color:{GREEN};font-size:18px">Built for every trip you sell</h3>
    <p style="margin:0;color:{TEXT_LIGHT};font-size:14px;line-height:1.7">Any destination, any route, any number of days. One builder for every client trip you handle.</p>
  </div>

  <!-- CTA card -->
  <div class="cta-card">
    <h2>Start building today</h2>
    <p>No setup. No learning curve.</p>
    <a href="{CTA_URL}" class="cta-btn">Get started →</a>
  </div>

  <!-- Urgency -->
  <div class="urgency">
    <p>The agent who sends first gets the booking. Every time.</p>
  </div>

  <!-- Contact -->
  <div class="contact">
    <p style="margin:0 0 6px;color:{GREEN};font-size:13px;font-weight:600">Questions? We're here.</p>
    <p style="margin:0;color:{TEXT_LIGHT};font-size:13px">
      <a href="mailto:contact@viakashmir.in">contact@viakashmir.in</a> ·
      <a href="https://wa.me/919186051499">WhatsApp +91 918 605 1499</a>
    </p>
  </div>

  <!-- Footer -->
  <div class="footer">
    <p>ViaKashmir Itinerary Builder · <a href="{CTA_URL}">viakashmiritinerary.in</a><br>
    Reply "unsubscribe" to stop.</p>
  </div>

</div>
</body>
</html>"""

    out = md / "email.amp.html"
    out.write_text(amp_html, encoding="utf-8")
    print(f"  [{market}] email.amp.html → {out}")


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

    print(f"build_itin_amp.py — date={args.date}  markets={markets}")
    for m in markets:
        build_amp(m, args.date)
    print("Done.")


if __name__ == "__main__":
    main()
