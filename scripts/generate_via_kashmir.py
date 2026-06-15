#!/usr/bin/env python3
"""
generate_via_kashmir.py — build one day of Via Kashmir marketing content.

For each currency (INR, USD, AED) it writes 3 themed "sets" (9 total) under:
  content/via-kashmir/<date>/<CUR>/set-<n>/
    email.html       rich, image-embedded marketing email (B2C + B2B)
    email.amp.html   VALID AMP-for-Email version (amp-img, boilerplate)
    whatsapp.txt     WhatsApp broadcast copy
    linkedin.txt     LinkedIn outreach DM
    meta.json        {date,currency,theme,subject,season,image,products[]}
  content/via-kashmir/<date>/manifest.json

Tone: Make My Trip — punchy, product-forward, deal-led, seasonal urgency.
Every button links to https://viakashmir.in/ ; the B2B partner CTA links to
https://viakashmir.in/sign-up?role=vendor . Logo + photos are proxied through
wsrv.nl so they render in Gmail.

Images: real Kashmir photos.
  * If PIXABAY_API_KEY is set → Pixabay API (the preferred source).
  * Else → Wikimedia Commons API (no key, always works).

Usage:
  python3 scripts/generate_via_kashmir.py --date 2026-06-15
"""
import argparse, datetime as dt, html, json, os, time, urllib.parse, urllib.request
from pathlib import Path

# ── Brand ───────────────────────────────────────────────────────────────────
SITE = "https://viakashmir.in/"
B2B = "https://viakashmir.in/sign-up?role=vendor"
LOGO_SRC = "viakashmir.in/logo-colour.svg?v=3"
BRAND = "#e0452c"      # saffron red (Make My Trip energy)
ACCENT = "#0e6b53"     # pine green
GOLD = "#f4a300"
INK = "#1b1b1f"
MUT = "#6b7280"

# ── Currencies (base prices are in INR; convert + round) ────────────────────
CURRENCIES = {
    "INR": {"sym": "₹",   "rate": 1.0,  "round": 1},
    "USD": {"sym": "$",   "rate": 83.0, "round": 1},
    "AED": {"sym": "AED ", "rate": 22.6, "round": 1},
}

# ── Seasonal note shown in every mail ───────────────────────────────────────
def season_for(month: int) -> tuple[str, str]:
    if month in (3, 4, 5):
        return ("spring", "Spring in Kashmir — tulips & blossoms are out, crisp 12–22°C days. Best for gardens & photography.")
    if month in (6, 7, 8):
        return ("summer", "Peak summer — alpine meadows in full green, cool 15–30°C escape from the plains. Houseboats book out fast.")
    if month in (9, 10, 11):
        return ("autumn", "Autumn chinar season — golden valleys & saffron harvest in Pampore. Soft light, fewer crowds.")
    return ("winter", "Winter wonderland — fresh snow in Gulmarg, world-class skiing & cosy houseboats. Book early for snowfall dates.")

# ── Catalogue: themes → products. base in INR. img = Commons/Pixabay query ──
THEMES = [
    {"key": "summer-srinagar", "seasons": {"summer", "spring"}, "kicker": "Summer in Srinagar",
     "headline": "Wake up on the Dal. Gardens, shikaras, sunsets.", "hero": "Dal Lake Srinagar houseboat",
     "sub": "Deluxe houseboats, Mughal gardens and golden-hour shikara rides — the Kashmir everyone falls for.",
     "products": [
         {"sku": "VK-HB2", "name": "Deluxe Houseboat — 2 Nights", "desc": "Dal Lake stay, breakfast + dinner, airport pickup", "inr": 14900, "img": "Houseboat Dal Lake"},
         {"sku": "VK-SGR3", "name": "Srinagar & Mughal Gardens — 3N", "desc": "Nishat, Shalimar, Old City, Hazratbal", "inr": 22500, "img": "Mughal garden Kashmir"},
         {"sku": "VK-SHK", "name": "Private Sunset Shikara", "desc": "Half-day, flowers & kahwa on the lake", "inr": 1800, "img": "Shikara Kashmir"},
     ]},
    {"key": "alpine-meadows", "seasons": {"summer", "spring", "autumn"}, "kicker": "Alpine Meadows",
     "headline": "Gulmarg. Pahalgam. Sonamarg. The big three.", "hero": "Gulmarg meadow Kashmir",
     "sub": "Ride the world's highest gondola, picnic in Betaab Valley, chase glaciers at Sonamarg.",
     "products": [
         {"sku": "VK-GUL", "name": "Gulmarg Gondola Day Trip", "desc": "Phase-1 & 2 gondola, transfers, guide", "inr": 3200, "img": "Gulmarg snow gondola"},
         {"sku": "VK-PHG2", "name": "Pahalgam & Betaab Valley — 2N", "desc": "Aru, Betaab, Chandanwari sightseeing", "inr": 17400, "img": "Betaab valley Kashmir"},
         {"sku": "VK-SON", "name": "Sonamarg Glacier Day", "desc": "Thajiwas glacier, pony optional, transfers", "inr": 2600, "img": "Sonamarg meadow"},
     ]},
    {"key": "grand-tour", "seasons": {"summer", "spring", "autumn", "winter"}, "kicker": "Grand Kashmir Tour",
     "headline": "The whole valley in one unforgettable trip.", "hero": "Kashmir mountains valley",
     "sub": "Srinagar, Gulmarg, Pahalgam and Sonamarg — handcrafted, fully-guided, zero hassle.",
     "products": [
         {"sku": "VK-G6", "name": "Grand Kashmir — 6 Nights", "desc": "Srinagar+Gulmarg+Pahalgam+Sonamarg, all transfers", "inr": 46900, "img": "Kashmir mountains"},
         {"sku": "VK-G4", "name": "Classic Kashmir — 4 Nights", "desc": "Srinagar + Gulmarg, houseboat night", "inr": 31500, "img": "Gulmarg snow"},
         {"sku": "VK-HM5", "name": "Honeymoon Special — 5N", "desc": "Candlelight dinner, private cab, flowers", "inr": 52000, "img": "Pahalgam valley"},
     ]},
    {"key": "honeymoon-luxury", "seasons": {"summer", "spring", "autumn", "winter"}, "kicker": "Honeymoon & Luxury",
     "headline": "Slow mornings, private shikaras, candlelit Dal.", "hero": "Dal Lake houseboat sunset",
     "sub": "Premium houseboats and curated romance — the trip you'll keep talking about.",
     "products": [
         {"sku": "VK-LUX3", "name": "Luxury Houseboat + Candle Dinner — 3N", "desc": "Premium suite, private dining, spa add-on", "inr": 38000, "img": "Houseboat Dal Lake"},
         {"sku": "VK-HM7", "name": "Private Honeymoon — 5N", "desc": "Dedicated cab + guide, gardens & meadows", "inr": 64000, "img": "Pahalgam valley"},
         {"sku": "VK-SHKF", "name": "Sunset Shikara + Flowers", "desc": "Decorated shikara, kahwa, photos", "inr": 2400, "img": "Shikara Kashmir"},
     ]},
    {"key": "gift-escape", "seasons": {"summer", "spring", "autumn", "winter"}, "kicker": "Gift a Kashmir Escape",
     "headline": "Gift the trip everyone wants to take.", "hero": "Tulip garden Srinagar",
     "sub": "Travel gift vouchers and corporate offsites — perfect for teams, clients and milestones.",
     "products": [
         {"sku": "VK-GV2", "name": "Kashmir Gift Voucher — 2N", "desc": "Redeemable houseboat + sightseeing", "inr": 15000, "img": "Dal Lake Srinagar"},
         {"sku": "VK-CORP", "name": "Corporate Offsite (per pax)", "desc": "Meetings + meadows, groups 10+", "inr": 9500, "img": "Mughal garden Kashmir"},
         {"sku": "VK-GP5", "name": "Premium Gift Trip — 5N", "desc": "Full valley, concierge, gift-wrapped", "inr": 55000, "img": "Kashmir mountains"},
     ]},
    {"key": "adventure", "seasons": {"summer", "autumn", "winter"}, "kicker": "Adventure Kashmir",
     "headline": "Trek glaciers. Ski Gulmarg. Go higher.", "hero": "Kashmir trek mountains",
     "sub": "For travellers who want the meadows under their boots, not just their window.",
     "products": [
         {"sku": "VK-SKI", "name": "Gulmarg Gondola + Ski Intro", "desc": "Gear, instructor, gondola pass", "inr": 5500, "img": "Gulmarg snow ski"},
         {"sku": "VK-TM", "name": "Tarsar–Marsar Trek — 6D", "desc": "Guided alpine-lake trek, full board", "inr": 24000, "img": "Kashmir mountains lake"},
         {"sku": "VK-THJ", "name": "Thajiwas Glacier Trek", "desc": "Sonamarg day trek, guide", "inr": 3500, "img": "Sonamarg meadow"},
     ]},
    {"key": "autumn-chinar", "seasons": {"autumn"}, "kicker": "Autumn Chinar & Saffron",
     "headline": "Golden chinars and the saffron harvest.", "hero": "Srinagar autumn chinar",
     "sub": "The valley's most photogenic six weeks — soft light, warm food, fewer crowds.",
     "products": [
         {"sku": "VK-AUT3", "name": "Autumn Srinagar — 3N", "desc": "Chinar gardens, Old City, houseboat", "inr": 24500, "img": "Srinagar autumn"},
         {"sku": "VK-SAF", "name": "Pampore Saffron Day", "desc": "Saffron fields + Kashmiri lunch", "inr": 2800, "img": "Mughal garden Kashmir"},
         {"sku": "VK-PHT", "name": "Chinar Photography Tour", "desc": "Guided golden-hour shoot", "inr": 3200, "img": "Pahalgam valley"},
     ]},
    {"key": "winter-snow", "seasons": {"winter"}, "kicker": "Winter Snow Kashmir",
     "headline": "Fresh powder, frozen Dal, cosy houseboats.", "hero": "Gulmarg snow winter",
     "sub": "Snowfall season is short and books out — lock your Gulmarg dates now.",
     "products": [
         {"sku": "VK-WIN4", "name": "Gulmarg Snow — 4N", "desc": "Snow play, gondola, heated stay", "inr": 34000, "img": "Gulmarg snow"},
         {"sku": "VK-SKC", "name": "Gulmarg Ski Course — 3D", "desc": "Certified instructor, gear, passes", "inr": 12000, "img": "Gulmarg snow ski"},
         {"sku": "VK-SNF3", "name": "Snowfall Srinagar — 3N", "desc": "Houseboat + Gulmarg day, kahwa", "inr": 26000, "img": "Dal Lake Srinagar winter"},
     ]},
]

# ── Image fetch (Pixabay if keyed, else Wikimedia Commons) — cached ─────────
_IMG_CACHE: dict[str, str] = {}
FALLBACK = "upload.wikimedia.org/wikipedia/commons/thumb/1/17/Dal_Lake%2C_Srinagar%2C_Jammu_and_Kashmir.jpg/1280px-Dal_Lake%2C_Srinagar%2C_Jammu_and_Kashmir.jpg"


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "viakashmir-routine/1.0 (+https://viakashmir.in)"})
    return json.load(urllib.request.urlopen(req, timeout=25))


def _raw_image(query: str) -> str:
    """Return a bare https image URL (no proxy) for the query."""
    if query in _IMG_CACHE:
        return _IMG_CACHE[query]
    url = ""
    key = os.environ.get("PIXABAY_API_KEY")
    try:
        if key:
            api = ("https://pixabay.com/api/?key=" + key + "&q=" + urllib.parse.quote(query + " kashmir")
                   + "&image_type=photo&orientation=horizontal&safesearch=true&per_page=3")
            d = _get(api)
            hits = d.get("hits") or []
            if hits:
                url = hits[0].get("largeImageURL") or hits[0].get("webformatURL") or ""
        if not url:
            api = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
                   "&gsrsearch=" + urllib.parse.quote(query) + "&gsrnamespace=6&gsrlimit=3"
                   "&prop=imageinfo&iiprop=url|mime&iiurlwidth=1280")
            d = _get(api)
            for p in (d.get("query", {}).get("pages", {}) or {}).values():
                ii = (p.get("imageinfo") or [{}])[0]
                if ii.get("mime", "").startswith("image") and ii.get("thumburl"):
                    url = ii["thumburl"]
                    break
            time.sleep(0.4)  # be gentle with the Commons API
    except Exception:
        url = ""
    if not url:
        url = "https://" + FALLBACK
    bare = url.replace("https://", "").replace("http://", "")
    _IMG_CACHE[query] = bare
    return bare


def img(query: str, w: int, h: int, png: bool = False) -> str:
    """Direct CDN image URL — Wikimedia/Pixabay render natively in Gmail, and
    avoid the wsrv→source rate-limit (429) that can blank a proxied tile."""
    return "https://" + _raw_image(query)


def logo(w: int = 320) -> str:
    return f"https://wsrv.nl/?url=ssl:{LOGO_SRC.replace('?', '%3F').replace('=', '%3D')}&w={w}&output=png"


# ── Pricing ─────────────────────────────────────────────────────────────────
def price(inr: int, cur: str) -> str:
    c = CURRENCIES[cur]
    v = inr / c["rate"]
    v = int(round(v / (1 if cur == "INR" else 1)))
    return f"{c['sym']}{v:,}"


# ── Theme selection (season-weighted, deterministic, no same-day repeat) ─────
def pick_themes(date: dt.date) -> list[dict]:
    season, _ = season_for(date.month)
    in_season = [t for t in THEMES if season in t["seasons"]]
    others = [t for t in THEMES if season not in t["seasons"]]
    # Rotate within in-season themes first (they always number >= 3), so a
    # summer day never shows a winter set; fall back to others only if short.
    base = in_season if len(in_season) >= 3 else THEMES
    start = date.toordinal() % len(base)
    seq = [base[(start + i) % len(base)] for i in range(len(base))] + others
    picked, seen = [], set()
    for t in seq:
        if t["key"] not in seen:
            picked.append(t); seen.add(t["key"])
        if len(picked) == 3:
            break
    return picked


# ── Email builders ──────────────────────────────────────────────────────────
def esc(s: str) -> str:
    return html.escape(s, quote=True)


def build_html(theme: dict, cur: str, date: dt.date, imgs: dict) -> str:
    season, note = season_for(date.month)
    # pair tiles two-per-row
    rows = ""
    ps = theme["products"]
    for i in range(0, len(ps), 2):
        pair = "".join(
            f"""<td width="50%" valign="top" style="padding:6px;"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceaf0;border-radius:12px;overflow:hidden;background:#fff;">
            <tr><td><a href="{SITE}"><img src="{imgs[p['img']+'-card']}" width="280" alt="{esc(p['name'])}" style="display:block;width:100%;max-width:280px;height:auto;border:0;"></a></td></tr>
            <tr><td style="padding:12px 14px;"><div style="font:700 15px/1.3 Arial,sans-serif;color:{INK};">{esc(p['name'])}</div>
            <div style="font:400 12.5px/1.5 Arial,sans-serif;color:{MUT};margin:4px 0 8px;">{esc(p['desc'])}</div>
            <div style="font:800 16px/1 Arial,sans-serif;color:{ACCENT};">{price(p['inr'], cur)} <span style="font:400 11px Arial;color:{MUT};">onwards</span></div>
            <a href="{SITE}" style="display:inline-block;margin-top:10px;background:{BRAND};color:#fff;font:700 12px Arial,sans-serif;text-decoration:none;padding:8px 14px;border-radius:8px;">Book now →</a></td></tr></table></td>"""
            for p in ps[i:i + 2]
        )
        if len(ps[i:i + 2]) == 1:
            pair += '<td width="50%"></td>'
        rows += f"<tr>{pair}</tr>"

    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(theme['headline'])}</title></head>
<body style="margin:0;background:#f6f3ee;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ee;"><tr><td align="center" style="padding:18px 10px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.06);">
  <tr><td style="padding:16px 22px;border-bottom:3px solid {BRAND};" align="left">
    <img src="{logo(300)}" height="34" alt="Via Kashmir" style="display:block;border:0;height:34px;">
  </td></tr>
  <tr><td style="position:relative;"><a href="{SITE}"><img src="{imgs['hero']}" width="600" alt="Kashmir" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>
  <tr><td style="padding:20px 24px 4px;">
    <div style="display:inline-block;background:{GOLD};color:{INK};font:800 11px Arial;letter-spacing:.5px;text-transform:uppercase;padding:5px 11px;border-radius:20px;">{esc(theme['kicker'])} · {cur}</div>
    <h1 style="font:800 26px/1.22 'Helvetica Neue',Arial,sans-serif;color:{INK};margin:12px 0 6px;">{esc(theme['headline'])}</h1>
    <p style="font:400 15px/1.55 Arial,sans-serif;color:{MUT};margin:0 0 10px;">{esc(theme['sub'])}</p>
    <div style="background:#fff7ec;border:1px solid #ffe6c2;border-radius:10px;padding:10px 13px;font:600 12.5px/1.5 Arial,sans-serif;color:#8a5a00;">📅 {esc(note)}</div>
  </td></tr>
  <tr><td style="padding:8px 18px 4px;"><table width="100%" cellpadding="0" cellspacing="0">{rows}</table></td></tr>
  <tr><td style="padding:8px 24px 4px;" align="center">
    <a href="{SITE}" style="display:block;background:{BRAND};color:#fff;font:800 16px Arial,sans-serif;text-decoration:none;padding:15px;border-radius:12px;">Plan my Kashmir trip →</a>
  </td></tr>
  <tr><td style="padding:14px 24px 6px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:{ACCENT};border-radius:12px;"><tr><td style="padding:14px 16px;">
      <div style="font:800 14px Arial,sans-serif;color:#fff;">Travel agent, hotelier or corporate?</div>
      <div style="font:400 12.5px/1.5 Arial,sans-serif;color:#d7f0e7;margin:3px 0 9px;">Partner with Via Kashmir for agent rates, ready itineraries & bulk gifting.</div>
      <a href="{B2B}" style="display:inline-block;background:{GOLD};color:{INK};font:800 12.5px Arial,sans-serif;text-decoration:none;padding:9px 15px;border-radius:8px;">Become a partner →</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:16px 24px 22px;border-top:1px solid #efedf2;font:400 11px/1.7 Arial,sans-serif;color:#9aa0a6;" align="center">
    Via Kashmir · Srinagar, J&amp;K · <a href="{SITE}" style="color:{ACCENT};">viakashmir.in</a><br>
    Prices indicative, per person on twin-sharing, before applicable taxes.
  </td></tr>
</table></td></tr></table></body></html>"""


def build_amp(theme: dict, cur: str, date: dt.date, imgs: dict) -> str:
    season, note = season_for(date.month)
    tiles = ""
    for p in theme["products"]:
        tiles += f"""<div class="tile"><a href="{SITE}" target="_blank">
      <amp-img src="{imgs[p['img']+'-card']}" width="600" height="400" layout="responsive" alt="{esc(p['name'])}"></amp-img>
      <div class="tb"><div class="tn">{esc(p['name'])}</div><div class="td">{esc(p['desc'])}</div>
      <div class="tp">{price(p['inr'], cur)} <span class="tpu">onwards</span></div>
      <span class="tcta">Book now →</span></div></a></div>"""
    return f"""<!doctype html>
<html amp4email><head><meta charset="utf-8">
<script async src="https://cdn.ampproject.org/v0.js"></script>
<style amp4email-boilerplate>body{{visibility:hidden}}</style>
<style amp-custom>
body{{margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:{INK};}}
.wrap{{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;}}
.hd{{padding:16px 22px;border-bottom:3px solid {BRAND};}}
.kick{{display:inline-block;background:{GOLD};color:{INK};font-size:11px;font-weight:bold;letter-spacing:.5px;text-transform:uppercase;padding:5px 11px;border-radius:20px;}}
.h1{{font-size:26px;font-weight:bold;line-height:1.22;margin:12px 24px 6px;}}
.sub{{font-size:15px;line-height:1.55;color:{MUT};margin:0 24px 10px;}}
.note{{background:#fff7ec;border:1px solid #ffe6c2;border-radius:10px;padding:10px 13px;font-size:12.5px;line-height:1.5;color:#8a5a00;margin:0 24px;}}
.kwrap{{padding:20px 0 4px;}}
.grid{{padding:10px 12px 4px;}}
.tile{{border:1px solid #eceaf0;border-radius:12px;overflow:hidden;background:#fff;margin:6px;}}
.tile a{{text-decoration:none;color:{INK};display:block;}}
amp-img img{{object-fit:cover;}}
.tb{{padding:12px 14px;}}
.tn{{font-size:15px;font-weight:bold;line-height:1.3;}}
.td{{font-size:12.5px;line-height:1.5;color:{MUT};margin:4px 0 8px;}}
.tp{{font-size:16px;font-weight:bold;color:{ACCENT};}}
.tpu{{font-size:11px;font-weight:normal;color:{MUT};}}
.tcta{{display:inline-block;margin-top:10px;background:{BRAND};color:#fff;font-size:12px;font-weight:bold;padding:8px 14px;border-radius:8px;}}
a.cta,a.cta:visited{{display:block;text-align:center;background:{BRAND};color:#fff;font-size:16px;font-weight:bold;text-decoration:none;padding:15px;border-radius:12px;margin:8px 24px 4px;}}
.b2b{{background:{ACCENT};border-radius:12px;margin:14px 24px 6px;padding:14px 16px;}}
.b2bh{{font-size:14px;font-weight:bold;color:#fff;}}
.b2bs{{font-size:12.5px;line-height:1.5;color:#d7f0e7;margin:3px 0 9px;}}
a.b2bc,a.b2bc:visited{{display:inline-block;background:{GOLD};color:{INK};font-size:12.5px;font-weight:bold;text-decoration:none;padding:9px 15px;border-radius:8px;}}
.foot{{padding:16px 24px 22px;border-top:1px solid #efedf2;font-size:11px;line-height:1.7;color:#9aa0a6;text-align:center;}}
.foot a{{color:{ACCENT};}}
</style></head>
<body><div class="wrap">
  <div class="hd"><amp-img src="{logo(300)}" width="150" height="34" alt="Via Kashmir"></amp-img></div>
  <a href="{SITE}" target="_blank"><amp-img src="{imgs['hero']}" width="600" height="360" layout="responsive" alt="Kashmir"></amp-img></a>
  <div class="kwrap"><span class="kick" style="margin-left:24px;">{esc(theme['kicker'])} · {cur}</span>
  <div class="h1">{esc(theme['headline'])}</div>
  <div class="sub">{esc(theme['sub'])}</div>
  <div class="note">📅 {esc(note)}</div></div>
  <div class="grid">{tiles}</div>
  <a class="cta" href="{SITE}" target="_blank">Plan my Kashmir trip →</a>
  <div class="b2b"><div class="b2bh">Travel agent, hotelier or corporate?</div>
    <div class="b2bs">Partner with Via Kashmir for agent rates, ready itineraries &amp; bulk gifting.</div>
    <a class="b2bc" href="{B2B}" target="_blank">Become a partner →</a></div>
  <div class="foot">Via Kashmir · Srinagar, J&amp;K · <a href="{SITE}">viakashmir.in</a><br>
  Prices indicative, per person on twin-sharing, before applicable taxes.</div>
</div></body></html>"""


def build_whatsapp(theme: dict, cur: str) -> str:
    lines = [f"*{theme['headline']}*", "", theme["sub"], ""]
    for p in theme["products"]:
        lines.append(f"• {p['name']} — {price(p['inr'], cur)} onwards")
    lines += ["", f"Book / plan your trip 👉 {SITE}", f"Travel agents & corporates 👉 {B2B}"]
    return "\n".join(lines)


def build_linkedin(theme: dict, cur: str) -> str:
    return (
        f"Hi {{first_name}},\n\n"
        f"{theme['kicker']} is open at Via Kashmir — {theme['sub'].lower()}\n\n"
        f"Packages from {price(theme['products'][0]['inr'], cur)}. If you run travel, corporate gifting "
        f"or offsites, we offer agent rates and ready itineraries.\n\n"
        f"Plan a trip: {SITE}\nPartner with us: {B2B}\n\n— Team Via Kashmir"
    )


def build_subject(theme: dict, cur: str) -> str:
    return f"{theme['kicker']}: {theme['products'][0]['name']} from {price(theme['products'][0]['inr'], cur)}"


# ── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--slug", default="via-kashmir")
    args = ap.parse_args()
    date = dt.date.fromisoformat(args.date)
    root = Path(__file__).resolve().parent.parent / "content" / args.slug / args.date

    themes = pick_themes(date)
    season, _ = season_for(date.month)

    # Pre-fetch images per theme (shared across currencies).
    theme_imgs: dict[str, dict] = {}
    for t in themes:
        d = {"hero": img(t["hero"], 600, 360)}
        for p in t["products"]:
            d[p["img"] + "-card"] = img(p["img"], 600, 400)
        # hero (proxied) also used as the whatsapp asset photo
        d["_hero_photo"] = img(t["hero"], 900, 600)
        theme_imgs[t["key"]] = d

    manifest = {"date": args.date, "business": args.slug, "season": season, "currencies": list(CURRENCIES), "sets": []}
    for cur in CURRENCIES:
        for n, t in enumerate(themes, start=1):
            sd = root / cur / f"set-{n}"
            sd.mkdir(parents=True, exist_ok=True)
            imgs = theme_imgs[t["key"]]
            (sd / "email.html").write_text(build_html(t, cur, date, imgs), encoding="utf-8")
            (sd / "email.amp.html").write_text(build_amp(t, cur, date, imgs), encoding="utf-8")
            (sd / "whatsapp.txt").write_text(build_whatsapp(t, cur), encoding="utf-8")
            (sd / "linkedin.txt").write_text(build_linkedin(t, cur), encoding="utf-8")
            meta = {
                "date": args.date, "currency": cur, "theme": t["key"], "season": season,
                "subject": build_subject(t, cur), "image": imgs["_hero_photo"],
                "products": [{"sku": p["sku"], "name": p["name"], "price": price(p["inr"], cur)} for p in t["products"]],
            }
            (sd / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            manifest["sets"].append({"currency": cur, "set": n, "theme": t["key"], "subject": meta["subject"]})

    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"date": args.date, "slug": args.slug, "season": season,
                      "themes": [t["key"] for t in themes], "sets": len(manifest["sets"])}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
