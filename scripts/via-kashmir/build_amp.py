#!/usr/bin/env python3
"""
build_amp.py - ViaKashmir email generator (Alpine Editorial, photo-forward) for the
four B2C/B2B tracks. Emits BOTH:
  - email.amp.html : valid amp4email (boilerplate + v0.js + all CSS in <style amp-custom>,
                     every photo an <amp-img>, https-only, < 200 KB)
  - email.html     : the same design with normal <img> (renders photos in every client)

Shell: white logo card -> photo hero on a green-gradient hook (badge, Manrope headline
with a mint accent line, body, dark-green/white pill CTA, reassurance) -> accent strip ->
feature photo + caption card -> green-gradient CTA card (+ WhatsApp link) -> green contact
banner -> footer.

Every image is served through the wsrv proxy, wrapping the committed photo pool on main
(raw.githubusercontent), exactly the pattern that renders in Gmail. The logo is the live
SVG via wsrv. No prices anywhere. CTA rule: every button -> https://viakashmir.in/ ,
EXCEPT B2B "list/sign up" -> https://viakashmir.in/sign-up?role=vendor . The only
non-viakashmir.in link is the WhatsApp pill.

  python3 build_amp.py --track b2c --html out/email.html --amp out/email.amp.html \
      --hero valley --feat gulmarg
"""
import argparse
from pathlib import Path

REPO = "raw.githubusercontent.com/aribanigar/Leadloftexporter/main/content/via-kashmir/_assets/photos"
WA = "https://wa.me/919186051499"
LOGO = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&amp;w=400&amp;output=png"

CTA_B2C = "https://viakashmir.in/"
CTA_VENDOR = "https://viakashmir.in/sign-up?role=vendor"


def pool(file, w=1200):
    return f"https://wsrv.nl/?url={REPO}/{file}.jpg&amp;w={w}&amp;output=jpg&amp;q=82"


TRACKS = {
 "b2c": dict(
   cta_url=CTA_B2C, hero="valley", feat="gulmarg",
   label="KASHMIR  &middot;  EARLY SUMMER 2026",
   hhead="The valley is green,<br>the lake is glass, ", haccent="and it is open.",
   hbody="Flights are landing in Srinagar, the meadows are out, and the mornings on the Dal are still cool. Planned start to finish by people who live here, so you just arrive.",
   cta="Plan my Kashmir trip",
   reassure="Open all season  &middot;  Houseboats, hotels, cabs &amp; shikaras sorted",
   strip="This is the window. Clear roads, green meadows, the lake like glass at dawn.",
   feat_title="Ride the Gulmarg gondola",
   feat_line="One of the highest cable cars on earth, lifting you out of the meadows and into the widest views in the valley.",
   ceyebrow="YOUR DATES, OUR VALLEY", chead="Your Kashmir week is<br>", caccent="one message away.",
   cbody="Tell us when you want to come. We shape the whole trip around your dates and send it back ready, so all you do is land.",
   foot="Houseboats, hotels, cabs and shikaras, planned by people who live here."),

 "b2b-hotels": dict(
   cta_url=CTA_VENDOR, hero="stay", feat="houseboat",
   label="VIAKASHMIR  &mdash;  FOR HOTELS &amp; STAYS",
   hhead="That booking just went<br>to ", haccent="someone else's hotel.",
   hbody="Travellers are searching Kashmir stays right now. The ones who find you, book you. The ones who do not, book the hotel listed next to yours.",
   cta="List my hotel",
   reassure="No cost to list  &middot;  Direct bookings, your guests",
   strip="Every day you are not listed, the search still happens. Someone gets the guest. It just is not you.",
   feat_title="This is what they are searching for",
   feat_line="Lakeside rooms, houseboats, mountain stays. Travellers planning Kashmir want exactly what you already have. Put it where they are looking.",
   ceyebrow="NO COST. NO CONTRACTS.", chead="Get your rooms in front of<br>", caccent="every Kashmir traveller.",
   cbody="List your hotel in minutes. Travellers find you, see your photos, and book directly. You keep the guest relationship.",
   foot="List your hotel, houseboat, cab or shikara, and reach every traveller planning Kashmir."),

 "b2b-cabs-shikaras": dict(
   cta_url=CTA_VENDOR, hero="shikara", feat="boats",
   label="VIAKASHMIR  &mdash;  FOR CABS &amp; SHIKARAS",
   hhead="That ride just went<br>to ", haccent="another driver.",
   hbody="Airport pickups, valley drives, a shikara at golden hour - travellers are booking all of it today. Be the one they find first, and fill the empty days.",
   cta="List my service",
   reassure="No cost to list  &middot;  Riders and riders' plans come to you",
   strip="Empty seats and idle boats do not come back. The traveller who needed that ride just booked someone else.",
   feat_title="The ride is half the trip",
   feat_line="From the airport run to a slow evening on the Dal, travellers want a driver and a boatman they can trust. Be that name when they search.",
   ceyebrow="STEADY BOOKINGS, FEWER GAPS", chead="Put your cab and shikara<br>", caccent="where travellers look.",
   cbody="List your service in minutes. Travellers planning Kashmir see you, message you, and book you direct. Fewer empty days, more paid runs.",
   foot="List your cab, shikara, houseboat or hotel, and reach every traveller planning Kashmir."),

 "b2b-houseboats": dict(
   cta_url=CTA_VENDOR, hero="houseboat", feat="hero_dal",
   label="VIAKASHMIR  &mdash;  FOR HOUSEBOATS",
   hhead="That guest just booked<br>", haccent="another houseboat.",
   hbody="Travellers want the real Dal Lake stay - your carved cedar, your veranda, your sunrise. List your boat where they are already looking and your rooms get seen first. Karew Sa Join Kashrew.",
   cta="List my houseboat",
   reassure="No cost to list  &middot;  Your guests, your relationship",
   strip="The lake is full of boats. The traveller only finds the ones that are listed. Today that was not yours.",
   feat_title="Your veranda, their sunrise",
   feat_line="Nothing sells a Dal Lake morning like the boat itself. Show it where travellers are planning, and let the next guest find you first.",
   ceyebrow="REACH TRAVELLERS DIRECTLY", chead="Put your houseboat<br>", caccent="in front of the lake's guests.",
   cbody="List your boat in minutes. Travellers find you, see your deck and your rooms, and book you direct. Karew Sa Join Kashrew - join, and let others join too.",
   foot="List your houseboat, hotel, cab or shikara, and reach every traveller planning Kashmir."),
}

CSS = """
body{margin:0;padding:0;background:#f3f4f5;font-family:'Inter',Arial,sans-serif;}
.wrap{max-width:600px;margin:0 auto;padding:30px 16px 48px;}
.card{background:#ffffff;border-radius:16px;}
.logo{padding:20px 0;text-align:center;}
.sp{height:18px;}.sp24{height:24px;}.sp30{height:30px;}
.heroimg img,.featimg img,.heroimg amp-img,.featimg amp-img{border-radius:20px 20px 0 0;display:block;width:100%;}
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
.wa{display:block;margin:18px 0 0;font-size:13px;font-weight:700;color:#9dd3aa;text-decoration:none;}
.contact{background:#0e3d2f;border-radius:16px;padding:18px 20px;text-align:center;}
.contact span{font-family:'Manrope',Arial,sans-serif;font-size:14px;color:#ffffff;font-weight:700;}
.foot{padding:24px 28px;text-align:center;}
.fh{font-family:'Manrope',Arial,sans-serif;font-size:17px;font-weight:800;color:#00361a;margin:0;}
.fp{font-size:11px;color:#717971;margin:5px 0 0;}
"""


def amp_img(src, w, h, cls):
    return f'<div class="{cls}"><amp-img src="{src}" width="{w}" height="{h}" layout="responsive" alt="Kashmir"></amp-img></div>'


def plain_img(src, cls):
    return f'<div class="{cls}"><img src="{src}" width="600" alt="Kashmir" style="display:block;width:100%;height:300px;object-fit:cover;border:0;border-radius:20px 20px 0 0;"></div>'


def build(track, hero, feat, amp=False):
    s = TRACKS[track]
    hero_src, feat_src = pool(hero), pool(feat)
    if amp:
        IM = amp_img
        hero_tag = IM(hero_src, 600, 300, "heroimg")
        feat_tag = IM(feat_src, 600, 300, "featimg")
        logo_tag = (f'<amp-img src="{LOGO}" width="172" height="40" layout="fixed" '
                    f'alt="ViaKashmir"></amp-img>')
        head = ('<style amp4email-boilerplate>body{visibility:hidden}</style>'
                '<script async src="https://cdn.ampproject.org/v0.js"></script>')
        htmltag = '<html ⚡4email data-css-strict>'
    else:
        hero_tag = plain_img(hero_src, "heroimg")
        feat_tag = plain_img(feat_src, "featimg")
        logo_tag = (f'<img src="{LOGO}" width="172" alt="ViaKashmir" '
                    f'style="display:block;width:172px;height:auto;border:0;margin:0 auto;">')
        head = '<meta name="x-apple-disable-message-reformatting">'
        htmltag = "<html>"
    pre = ("&#8203;" * 0)
    return f"""<!doctype html>{htmltag}<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
{head}
<style amp-custom>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&family=Inter:wght@400;500;600;700&display=swap');
{CSS}</style></head>
<body>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{s['strip']}</div>
<div class="wrap">
  <div class="card logo">{logo_tag}</div>
  <div class="sp"></div>
  {hero_tag}
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
  {feat_tag}
  <div class="featcap"><p class="ft">{s['feat_title']}</p><p class="fl">{s['feat_line']}</p></div>
  <div class="sp30"></div>
  <div class="cta2">
    <p class="ce">{s['ceyebrow']}</p>
    <p class="ch">{s['chead']}<span class="acc">{s['caccent']}</span></p>
    <p class="cb">{s['cbody']}</p>
    <a class="btn" href="{s['cta_url']}">{s['cta']} &rarr;</a>
    <a class="wa" href="{WA}">or message us on WhatsApp &rarr;</a>
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
    ap.add_argument("--html")
    ap.add_argument("--amp")
    ap.add_argument("--hero")
    ap.add_argument("--feat")
    a = ap.parse_args()
    s = TRACKS[a.track]
    hero = a.hero or s["hero"]
    feat = a.feat or s["feat"]
    if a.html:
        Path(a.html).parent.mkdir(parents=True, exist_ok=True)
        Path(a.html).write_text(build(a.track, hero, feat, amp=False))
        print(a.html)
    if a.amp:
        Path(a.amp).parent.mkdir(parents=True, exist_ok=True)
        Path(a.amp).write_text(build(a.track, hero, feat, amp=True))
        print(a.amp)


if __name__ == "__main__":
    main()
