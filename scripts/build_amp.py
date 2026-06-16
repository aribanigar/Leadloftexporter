#!/usr/bin/env python3
"""
build_amp.py - ViaKashmir AMP email (amp4email) in the Alpine Editorial design:
white logo card -> photo hero on a green-gradient hook (badge, Manrope headline w/ mint
accent, body, mint pill CTA, reassurance) -> accent strip -> feature photo + caption ->
green CTA card -> contact banner -> footer. Every photo is an <amp-img> with explicit
width/height. Valid amp4email: boilerplate + v0.js + all CSS in <style amp-custom>
(no !important), https images only, < 200 KB.

  python3 build_amp.py --track b2c        --out .../email.amp.html
  python3 build_amp.py --track b2b-hotels --out .../email.amp.html
  add --preview to emit a plain-HTML screenshot proxy (amp-img -> img, no boilerplate).
"""
import argparse
from pathlib import Path

U = lambda i, w: f"https://wsrv.nl/?url=images.unsplash.com/{i}&amp;w={w}&amp;output=jpg&amp;q=82"
LOGO = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&amp;w=400&amp;output=png"

TRACKS = {
 "b2c": dict(
   label="KASHMIR  &middot;  SPRING 2026",
   hhead="The valley you keep<br>postponing is ", haccent="wide open.",
   hbody="Flights are landing, the roads are clear, and the season is at its best. Planned start to finish by people who live here, so you just arrive.",
   cta="Plan my Kashmir trip", cta_url="https://viakashmir.in/",
   reassure="Open all season  &middot;  Houseboats, hotels, cabs &amp; shikaras sorted",
   strip="This is the window. Clear roads, blooming gardens, the lake like glass at dawn.",
   feat_img=U("photo-1651509094074-e8acaeb84d8f",1200), feat_title="Ride the Gulmarg gondola",
   feat_line="One of the highest cable cars on earth, lifting you into the snowline and the widest views in the valley.",
   hero=U("photo-1600845747913-e33543f94892",1200),
   ceyebrow="YOUR DATES, OUR VALLEY", chead="Your Kashmir week is<br>", caccent="one message away.",
   cbody="Tell us when you want to come. We shape the whole trip around your dates and send it back ready.",
   foot="Houseboats, hotels, cabs and shikaras, planned by people who live here."),
 "b2b-hotels": dict(
   label="VIAKASHMIR  &mdash;  FOR HOTELS &amp; STAYS",
   hhead="That booking just went<br>to ", haccent="someone else's hotel.",
   hbody="Travellers are searching Kashmir stays right now. The ones who find you, book you. The ones who don't, book the hotel listed next to yours.",
   cta="List my hotel", cta_url="https://viakashmir.in/sign-up?role=vendor",
   reassure="No cost to list  &middot;  Direct bookings, your guests",
   strip="Every day you're not listed, the search still happens. Someone gets the guest. It just isn't you.",
   feat_img=U("photo-1564329494258-3f72215ba175",1200), feat_title="This is what they're searching for",
   feat_line="Lakeside rooms, houseboats, mountain stays. Travellers planning Kashmir want exactly what you already have. Put it where they're looking.",
   hero=U("photo-1715457573748-8e8a70b2c1be",1200),
   ceyebrow="NO COST. NO CONTRACTS.", chead="Get your hotel in front of<br>", caccent="every Kashmir traveller.",
   cbody="List your rooms in minutes. Travellers find you, see your photos, and book directly. You keep the guest relationship.",
   foot="List your hotel, houseboat, cab or shikara, and reach every traveller planning Kashmir."),
}

CSS = """
body{margin:0;padding:0;background:#f3f4f5;font-family:'Inter',Arial,sans-serif;}
.wrap{max-width:600px;margin:0 auto;padding:30px 16px 48px;}
.card{background:#ffffff;border-radius:16px;}
.logo{padding:20px 0;text-align:center;}
.sp{height:18px;}.sp24{height:24px;}.sp30{height:30px;}
.heroimg amp-img,.featimg amp-img{border-radius:20px 20px 0 0;display:block;}
.hook{background:#00361a;background:linear-gradient(160deg,#00361a 0%,#1a4d2e 60%,#004e5f 100%);border-radius:0 0 20px 20px;padding:38px 40px 42px;}
.badge{display:inline-block;background:rgba(161,231,255,0.14);border-radius:99px;padding:8px 18px;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#b2ebff;margin-bottom:20px;}
.h1{font-family:'Manrope',Arial,sans-serif;font-size:34px;line-height:1.08;font-weight:800;letter-spacing:-0.02em;color:#ffffff;margin:0 0 18px;}
.acc{color:#9dd3aa;}
.bd{font-size:15px;line-height:1.7;color:rgba(255,255,255,0.72);margin:0 0 26px;}
.btn{display:inline-block;background:#0e3d2f;background:linear-gradient(135deg,#1a4d2e,#0e3d2f);border-radius:99px;font-family:'Manrope',Arial,sans-serif;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;padding:15px 36px;}
.re{font-size:11px;color:rgba(255,255,255,0.45);margin:16px 0 0;letter-spacing:0.02em;}
.strip{background:#1a4d2e;border-radius:14px;padding:20px 28px;color:#ffffff;font-family:'Manrope',Arial,sans-serif;font-weight:700;font-size:15px;line-height:1.6;border-left:4px solid #9dd3aa;}
.featcap{background:#ffffff;border-radius:0 0 18px 18px;padding:22px 28px 24px;}
.ft{font-family:'Manrope',Arial,sans-serif;font-size:20px;font-weight:800;color:#191c1d;margin:0 0 6px;letter-spacing:-0.02em;}
.fl{font-size:14px;color:#717971;line-height:1.65;margin:0;}
.cta2{background:#00361a;background:linear-gradient(135deg,#00361a,#1a4d2e);border-radius:18px;padding:38px 36px;text-align:center;}
.ce{font-size:10px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0 0 12px;}
.ch{font-family:'Manrope',Arial,sans-serif;font-size:25px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;margin:0 0 12px;line-height:1.2;}
.cb{font-size:13px;color:rgba(255,255,255,0.62);line-height:1.65;margin:0 0 24px;}
.contact{background:#0e3d2f;border-radius:16px;padding:18px 20px;text-align:center;}
.contact span{font-family:'Manrope',Arial,sans-serif;font-size:14px;color:#ffffff;font-weight:700;}
.foot{padding:24px 28px;text-align:center;}
.fh{font-family:'Manrope',Arial,sans-serif;font-size:17px;font-weight:800;color:#00361a;margin:0;}
.fp{font-size:11px;color:#717971;margin:5px 0 0;}
"""

def amp_img(src, w, h, cls):
    return f'<div class="{cls}"><amp-img src="{src}" width="{w}" height="{h}" layout="responsive" alt=""></amp-img></div>'

def img(src, cls):  # preview plain img
    return f'<div class="{cls}"><img src="{src}" style="width:100%;display:block;border-radius:20px 20px 0 0;"></div>'

def build(track, preview=False):
    s = TRACKS[track]
    IM = (lambda src, w, h, cls: img(src, cls)) if preview else amp_img
    logo_tag = (f'<img src="{LOGO}" width="172" style="height:auto">' if preview
                else f'<amp-img src="{LOGO}" width="172" height="40" layout="fixed" alt="ViaKashmir"></amp-img>')
    head = ("" if preview else
      '<style amp4email-boilerplate>body{visibility:hidden}</style>'
      '<script async src="https://cdn.ampproject.org/v0.js"></script>')
    htmltag = "<html>" if preview else '<html ⚡4email data-css-strict>'
    return f"""<!doctype html>{htmltag}<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
{head}
<style amp-custom>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&family=Inter:wght@400;500;600;700&display=swap');
{CSS}</style></head>
<body>
<div class="wrap">
  <div class="card logo">{logo_tag}</div>
  <div class="sp"></div>
  {IM(s['hero'],600,300,'heroimg')}
  <div class="hook">
    <span class="badge">{s['label']}</span>
    <div class="h1">{s['hhead']}<span class="acc">{s['haccent']}</span></div>
    <div class="bd">{s['hbody']}</div>
    <a class="btn" href="{s['cta_url']}">{s['cta']} &rarr;</a>
    <div class="re">{s['reassure']}</div>
  </div>
  <div class="sp24"></div>
  <div class="strip">{s['strip']}</div>
  <div class="sp30"></div>
  {IM(s['feat_img'],600,300,'featimg')}
  <div class="featcap"><p class="ft">{s['feat_title']}</p><p class="fl">{s['feat_line']}</p></div>
  <div class="sp30"></div>
  <div class="cta2">
    <p class="ce">{s['ceyebrow']}</p>
    <p class="ch">{s['chead']}<span class="acc">{s['caccent']}</span></p>
    <p class="cb">{s['cbody']}</p>
    <a class="btn" href="{s['cta_url']}">{s['cta']} &rarr;</a>
  </div>
  <div class="sp30"></div>
  <div class="contact"><span>contact@viakashmir.in &nbsp;&nbsp;|&nbsp;&nbsp; +91 91860 51499</span></div>
  <div class="sp"></div>
  <div class="card foot"><p class="fh">ViaKashmir</p><p class="fp">{s['foot']}</p></div>
</div>
</body></html>"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", required=True, choices=list(TRACKS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args()
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(build(a.track, a.preview))
    print(a.out)

if __name__ == "__main__":
    main()
