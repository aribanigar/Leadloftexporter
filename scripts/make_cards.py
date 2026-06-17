#!/usr/bin/env python3
"""
make_cards.py - ViaKashmir promotional card (1080x1350 JPG) rendered in the SAME
Alpine Editorial design as the emails: #f3f4f5 page -> white logo card -> a big Kashmir
photo hero (rounded top) sitting on a GREEN-GRADIENT hook card (badge, Manrope headline
with a mint accent line, body, mint pill CTA, reassurance line) -> green contact banner.
It is, in effect, the email's hero unit as a shareable poster. No price. No timeline.

Renders HTML through Chromium (Playwright) so it matches the email pixel for pixel.
One-time: pip install playwright && python3 -m playwright install chromium.

Per-track defaults are built in; pass --photo and --out (and optionally override copy).
  python3 make_cards.py --track b2b-hotels --photo photos/stay.jpg --out card.jpg
Override copy:
  --label "VIAKASHMIR  -  FOR HOTELS & STAYS"  --promo "That booking just went to"
  --accent "someone else's hotel."  --body "..."  --cta "List my hotel"  --reassure "..."
"""
import argparse, asyncio, io, json, tempfile
from html import escape
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "content/via-kashmir/_assets/photos"
LOGO = Path(__file__).resolve().parent.parent / "content/via-kashmir/_assets/logo.png"
LOGO_WSRV = "https://wsrv.nl/?url=https://viakashmir.in/logo-colour.svg%3Fv=3&w=520&output=png"
CONTACT = "contact@viakashmir.in &nbsp;&nbsp;|&nbsp;&nbsp; +919186051499"

TRACKS = {
  "b2c": dict(
    label="KASHMIR  &middot;  SPRING 2026",
    promo="The valley you keep postponing is",
    accent="wide open.",
    body="Flights are landing, the roads are clear, and the season is at its best. Planned start to finish by people who live here, so you just arrive.",
    cta="Plan my Kashmir trip",
    reassure="Open all season  &middot;  Houseboats, hotels, cabs &amp; shikaras sorted",
    photo="dal.jpg"),
  "b2b-hotels": dict(
    label="VIAKASHMIR  &mdash;  FOR HOTELS &amp; STAYS",
    promo="That booking just went to",
    accent="someone else's hotel.",
    body="Travellers are searching Kashmir stays right now. The ones who find you, book you. Get your rooms in front of them.",
    cta="List my hotel",
    reassure="No cost to list  &middot;  Direct bookings, your guests",
    photo="stay.jpg"),
  "b2b-cabs-shikaras": dict(
    label="VIAKASHMIR  &mdash;  FOR CABS &amp; SHIKARAS",
    promo="That ride just went to",
    accent="another driver.",
    body="Travellers need airport cabs, valley drives and shikara rides every day. Be the one they find and book first.",
    cta="List my service",
    reassure="No cost to list  &middot;  Riders come to you",
    photo="dal.jpg"),
  "b2b-houseboats": dict(
    label="VIAKASHMIR  &mdash;  FOR HOUSEBOATS",
    promo="That guest just booked",
    accent="another houseboat.",
    body="Travellers want the real Dal Lake stay. List your boat where they are already looking, and your rooms get seen first.",
    cta="List my houseboat",
    reassure="No cost to list  &middot;  Your guests, your relationship",
    photo="houseboat.jpg"),
}

def img_uri(p):
    if str(p).startswith("http"): return p
    q = Path(p)
    if not q.is_absolute(): q = ASSETS / q.name
    return q.resolve().as_uri()

def logo_uri():
    return LOGO.resolve().as_uri() if LOGO.exists() else LOGO_WSRV

def build_html(s):
    accent = f'<br><span style="color:#9dd3aa;">{s["accent"]}</span>' if s.get("accent") else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800;900&family=Inter:wght@400;500;600;700&display=swap');
*{{margin:0;padding:0;box-sizing:border-box;}}
html,body{{width:1080px;height:1350px;}}
body{{font-family:'Inter',Arial,sans-serif;background:#f3f4f5;padding:44px;display:flex;flex-direction:column;}}
.logo{{background:#fff;border-radius:20px;padding:24px 0;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,0.05);}}
.logo img{{height:46px;width:auto;display:inline-block;}}
.unit{{flex:1;display:flex;flex-direction:column;margin:26px 0;border-radius:26px;overflow:hidden;box-shadow:0 22px 60px rgba(0,0,0,0.14);}}
.hero{{flex:1;min-height:330px;background-size:cover;background-position:center;}}
.hook{{background:linear-gradient(160deg,#00361a 0%,#1a4d2e 60%,#004e5f 100%);padding:46px 54px 50px;}}
.badge{{display:inline-block;background:rgba(161,231,255,0.14);border-radius:99px;padding:11px 24px;
  font-size:19px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#b2ebff;margin-bottom:26px;}}
.head{{font-family:'Manrope',Arial,sans-serif;font-size:62px;line-height:1.05;font-weight:900;
  letter-spacing:-0.03em;color:#fff;margin:0 0 22px;}}
.body{{font-family:'Inter',Arial,sans-serif;font-size:26px;line-height:1.55;color:rgba(255,255,255,0.72);
  max-width:760px;margin:0 0 32px;}}
.cta{{display:inline-block;background:linear-gradient(135deg,#b8f0c5,#9dd3aa);border-radius:99px;
  font-family:'Manrope',Arial,sans-serif;font-size:26px;font-weight:800;color:#00210e;padding:22px 50px;}}
.reassure{{font-family:'Inter',Arial,sans-serif;font-size:20px;color:rgba(255,255,255,0.45);
  letter-spacing:0.02em;margin-top:24px;}}
.contact{{background:#0e3d2f;border-radius:18px;padding:30px;text-align:center;}}
.contact span{{font-family:'Manrope',Arial,sans-serif;font-weight:800;font-size:30px;color:#fff;}}
</style></head>
<body>
  <div class="logo"><img src="{logo_uri()}" alt="ViaKashmir"></div>
  <div class="unit">
    <div class="hero" style="background-image:url('{img_uri(s['photo'])}');"></div>
    <div class="hook">
      <span class="badge">{s['label']}</span>
      <div class="head">{s['promo']}{accent}</div>
      <div class="body">{s['body']}</div>
      <span class="cta">{s['cta']} &nbsp;&rarr;</span>
      <div class="reassure">{s['reassure']}</div>
    </div>
  </div>
  <div class="contact"><span>{CONTACT}</span></div>
</body></html>"""

async def render(html, out):
    from playwright.async_api import async_playwright
    from PIL import Image
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html); src = f.name
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1080, "height": 1350}, device_scale_factor=2)
        await pg.goto(Path(src).as_uri(), wait_until="networkidle", timeout=60000)
        await pg.wait_for_timeout(900)
        png = await pg.screenshot(clip={"x": 0, "y": 0, "width": 1080, "height": 1350})
        await b.close()
    im = Image.open(io.BytesIO(png)).convert("RGB").resize((1080, 1350), Image.LANCZOS)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "JPEG", quality=90)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec")
    ap.add_argument("--track", choices=list(TRACKS))
    ap.add_argument("--photo"); ap.add_argument("--out", required=False)
    ap.add_argument("--label"); ap.add_argument("--promo"); ap.add_argument("--accent")
    ap.add_argument("--body"); ap.add_argument("--cta"); ap.add_argument("--reassure")
    a = ap.parse_args()
    if a.spec:
        s = json.load(open(a.spec)); out = s["out"]
    else:
        s = dict(TRACKS.get(a.track, TRACKS["b2c"]))
        for k in ("label", "promo", "accent", "body", "cta", "reassure", "photo"):
            if getattr(a, k): s[k] = getattr(a, k)
        out = a.out
    asyncio.run(render(build_html(s), out)); print(out)

if __name__ == "__main__":
    main()
