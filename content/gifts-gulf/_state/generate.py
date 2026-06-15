#!/usr/bin/env python3
"""
Gifts Gulf daily content generator (by QCKSERVE, part of Jasani).

Builds one full day of product-forward corporate-gifting marketing:
3 markets (AED/SAR/QAR) x 3 themed sets = 9 sets, each rendered as
email.html, email.amp.html, whatsapp.txt, linkedin.txt, meta.json.

Catalogue: real products are read from _state/catalogue.json, a snapshot
parsed from https://www.giftsgulf.com/catalogues/full (sku, name, midocean
image code, USD base price, material). Each tile's image is the wsrv JPEG
proxy of the real midocean original, so it renders in Gmail and Outlook.
Every selected image is HEAD-verified (HTTP 200 + image/jpeg) before it is
allowed into an email; a product whose image does not verify is dropped.

The day's curation lives in PLAN below (per-market angle/season + three
themed sets of real SKUs, each with a short descriptor). Subjects are never
reused (checked against _state/used-subjects.json) and SKUs are not reused
within 14 days (checked against _state/used-skus.json).

Usage: python3 generate.py YYYY-MM-DD
"""
import json, os, sys, html
from urllib.parse import quote_plus
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # content/gifts-gulf
STATE = os.path.join(ROOT, "_state")

# ---- fixed values (never hardcode elsewhere) ------------------------------
WHATSAPP_NUMBER = "916005001499"
CONTACT_EMAIL = "contact@giftsgulf.com"
LOGO_SVG = "https://www.giftsgulf.com/gglogo.svg"

# ---- brand palette --------------------------------------------------------
C = dict(
    green="#00a544", hover="#008138", heading="#18181b", body="#3f3f46",
    muted="#71717b", fine="#9f9fa9", border="#e4e4e7", tile="#f4f4f5",
    page="#fafafa", amber="#fcbb00", white="#ffffff",
)
FONT = "Arial, Helvetica, sans-serif"
RADIUS = "3px"

# ---- currency -------------------------------------------------------------
RATES = {"AED": 3.6725, "SAR": 3.75, "QAR": 3.64}
SYM = {"AED": "AED", "SAR": "SR", "QAR": "QAR"}
VAT = {
    "AED": "before 5% UAE VAT and branding setup",
    "SAR": "before 15% KSA VAT and branding setup",
    "QAR": "branding setup not included, VAT not applicable in Qatar",
}
MARKET = {"AED": "UAE", "SAR": "KSA", "QAR": "Qatar"}


def vol_price(usd, cur):
    """USD base -> local currency, 250+ tier (-15%), 2 decimals."""
    return round(usd * RATES[cur] * 0.85, 2)


def fmt_price(cur, usd):
    return "%s %.2f" % (SYM[cur], vol_price(usd, cur))


def img_src(code, escaped=True):
    """wsrv JPEG proxy of the real midocean original. Renders in Gmail+Outlook."""
    u = ("https://wsrv.nl/?url=ssl:cdn1.midocean.com/image/original/%s.jpg"
         "&w=640&output=jpg&q=80" % code)
    return u.replace("&", "&amp;") if escaped else u


def logo_src(escaped=True):
    u = "https://wsrv.nl/?url=%s&w=360&output=png" % LOGO_SVG
    return u.replace("&", "&amp;") if escaped else u


def product_url(sku):
    return "https://www.giftsgulf.com/product/%s" % sku


def wa_url(prefill):
    return "https://wa.me/%s?text=%s" % (WHATSAPP_NUMBER, quote_plus(prefill))


def verify_image(code):
    """HEAD the wsrv JPEG; True only on HTTP 200 + image/jpeg."""
    url = img_src(code, escaped=False)
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "gifts-gulf/1.0"})
        with urlopen(req, timeout=30) as r:
            return r.status == 200 and "image/jpeg" in r.headers.get("Content-Type", "")
    except (HTTPError, URLError, Exception):
        return False


# ===========================================================================
# DAILY RESEARCH BRIEF (2026-06-14)
# Season: peak Gulf summer (~45C), the week after Eid al-Adha, Islamic New
# Year (1448 AH) approaching mid-month; the business gifting cycle has moved
# to H2/Q3 planning and back-to-office onboarding. 2026 trend signal:
# sustainable gifting and smart tech (wireless charging) lead corporate buys,
# alongside curated executive sets. Markets are kept distinct from yesterday
# (UAE hydration / KSA tech-desk / Qatar eco) so nothing repeats two days
# running.
#   UAE  -> Q3 executive onboarding: onboarding kits, branded notebooks, desk tech
#   KSA  -> sustainable H2 gifting: eco gifts, travel bags, event giveaways
#   QAR  -> smart workspace: desk tech, premium steel drinkware, travel carry
# ===========================================================================
PLAN = {
    "AED": dict(
        angle="Q3 Executive Onboarding", season="Summer H2 onboarding",
        sets=[
            dict(name="UAE Onboarding Kits", theme="Executive onboarding",
                 subject="Hired Monday, equipped Monday",
                 headline="Onboarding kits ready before day one.",
                 subline="Premium sets that put your logo on every new desk.",
                 items=[("GG1145", "Recycled steel bottle and mug set"),
                        ("GG1276", "Cork notebook and pen set"),
                        ("GG1116", "A5 hardcover notebook"),
                        ("GG1502", "Notebook and pen gift box")]),
            dict(name="UAE Branded Notebooks", theme="Notebooks and writing",
                 subject="Where good ideas land",
                 headline="Notebooks worth filling, branded to you.",
                 subline="Recycled covers and clean print, made to be kept.",
                 items=[("GG1177", "A5 notebook, recycled paper"),
                        ("GG1236", "Cork-cover A5 notebook"),
                        ("GG1223", "Recycled card notebook"),
                        ("GG1196", "Wheat-straw ballpoint pen")]),
            dict(name="UAE Desk Tech", theme="Tech and desk",
                 subject="Cut the cable clutter",
                 headline="Branded power for every desk and bag.",
                 subline="Chargers and cables your team keeps reaching for.",
                 items=[("GG1159", "Slim 8000mAh power bank"),
                        ("GG1536", "15W wireless charging pad"),
                        ("GG1097", "Bamboo 4-port USB hub"),
                        ("GG1068", "3-in-1 charging cable")]),
        ],
    ),
    "SAR": dict(
        angle="Sustainable H2 Gifting", season="Summer eco",
        sets=[
            dict(name="KSA Sustainable Gifting", theme="Eco and sustainable",
                 subject="Gifts that give back",
                 headline="Sustainable gifting, no greenwashing.",
                 subline="Recycled, organic and bamboo, branded to your logo.",
                 items=[("GG1530", "Recycled steel bottle, 500ml"),
                        ("GG1117", "Organic cotton tote"),
                        ("GG1239", "Recycled paper sticky set"),
                        ("GG1470", "Bamboo desk accessory set")]),
            dict(name="KSA Travel Bags", theme="Bags and travel",
                 subject="Built to be carried",
                 headline="Bags your team takes everywhere.",
                 subline="RPET and travel ready, printed with your brand.",
                 items=[("GG1061", "RPET laptop backpack"),
                        ("GG1124", "PU city backpack"),
                        ("GG1605", "Weekender travel holdall"),
                        ("GG1170", "RPET sports duffel")]),
            dict(name="KSA Event Giveaways", theme="Event giveaways",
                 subject="Branding by the thousand",
                 headline="Event giveaways that move in volume.",
                 subline="Caps, totes and pens priced for the whole crowd.",
                 items=[("GG1166", "RPET 6-panel cap"),
                        ("GG1646", "Cotton event tote"),
                        ("GG1686", "RPET ballpoint pen"),
                        ("GG1205", "Metal keyring opener")]),
        ],
    ),
    "QAR": dict(
        angle="Smart Workspace Tech", season="Summer",
        sets=[
            dict(name="Qatar Smart Tech", theme="Tech and desk",
                 subject="Power the whole desk",
                 headline="Smart tech your clients actually use.",
                 subline="Chargers, hubs and sound, branded to your logo.",
                 items=[("GG1538", "Power bank with built-in cables"),
                        ("GG1526", "Bamboo 3-in-1 cable"),
                        ("GG1100", "Bamboo stand and USB hub"),
                        ("GG1541", "Wireless mini speaker")]),
            dict(name="Qatar Premium Drinkware", theme="Premium drinkware",
                 subject="Pour something premium",
                 headline="Steel drinkware that earns a place.",
                 subline="Vacuum bottles and mugs, hot or cold for hours.",
                 items=[("GG1370", "Vacuum steel cup, 12h cold"),
                        ("GG1354", "Insulated coffee cup"),
                        ("GG1680", "Steel water bottle, 500ml"),
                        ("GG1531", "Recycled steel travel mug")]),
            dict(name="Qatar Travel Carry", theme="Bags and travel",
                 subject="Pack the brand along",
                 headline="Travel bags that carry your name.",
                 subline="Roll-tops, coolers and totes in recycled RPET.",
                 items=[("GG1062", "Roll-top daypack"),
                        ("GG1093", "RPET cooler backpack"),
                        ("GG1391", "RPET foldable shopper"),
                        ("GG1312", "RPET travel pouch")]),
        ],
    ),
}


# ---- email.html -----------------------------------------------------------
def render_email_html(cur, s, products, date_disp, cta, campaign_name):
    market = MARKET[cur]
    preheader = "%s. %s sets, free branded mock-up before you pay." % (s["subject"], market)

    tiles = []
    for i in range(0, len(products), 2):
        row, cells = products[i:i + 2], []
        for p in row:
            cells.append(
                '<td width="50%%" valign="top" style="padding:6px;">'
                '<a href="%s" target="_blank" style="text-decoration:none;color:%s;display:block;background:%s;border:1px solid %s;border-radius:%s;padding:14px;">'
                '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr><td style="background:%s;border-radius:%s;padding:0;">'
                '<img src="%s" width="100%%" alt="%s" style="display:block;width:100%%;height:auto;border:0;border-radius:%s;">'
                '</td></tr></table>'
                '<div style="font:11px %s;color:%s;letter-spacing:.04em;margin-top:10px;">%s</div>'
                '<div style="font:bold 16px %s;color:%s;margin:2px 0;">%s</div>'
                '<div style="font:13px %s;color:%s;margin-bottom:8px;">%s</div>'
                '<div style="font:bold 14px %s;color:%s;">from %s</div>'
                '<div style="font:11px %s;color:%s;">per unit, 250+ pcs</div>'
                '</a></td>' % (
                    product_url(p["sku"]), C["heading"], C["white"], C["border"], RADIUS,
                    C["tile"], RADIUS,
                    img_src(p["code"]), html.escape(p["name"]), RADIUS,
                    FONT, C["fine"], p["sku"],
                    FONT, C["heading"], html.escape(p["name"]),
                    FONT, C["muted"], html.escape(p["desc"]),
                    FONT, C["hover"], fmt_price(cur, p["usd"]),
                    FONT, C["fine"]))
        if len(cells) == 1:
            cells.append('<td width="50%" style="padding:6px;">&nbsp;</td>')
        tiles.append('<tr>%s</tr>' % "".join(cells))
    grid = "".join(tiles)

    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>%(subject)s</title></head>
<body style="margin:0;padding:0;background:%(page)s;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:%(page)s;">%(preheader)s&#8203;&zwnj;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%(page)s;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;">
<tr><td style="padding:20px 24px 12px 24px;border-bottom:2px solid %(green)s;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" align="left"><img src="%(logo)s" width="150" alt="Gifts Gulf" style="display:block;width:150px;height:auto;border:0;"></td>
<td valign="middle" align="right" style="font:bold 11px %(font)s;color:%(muted)s;letter-spacing:.08em;text-transform:uppercase;">%(theme)s</td>
</tr></table></td></tr>
<tr><td style="padding:18px 24px 0 24px;"><div style="font:bold 12px %(font)s;color:%(green)s;letter-spacing:.06em;text-transform:uppercase;">%(kicker)s</div></td></tr>
<tr><td style="padding:8px 24px 0 24px;"><div style="font:bold 28px %(font)s;color:%(heading)s;line-height:1.2;letter-spacing:-.01em;">%(headline)s</div></td></tr>
<tr><td style="padding:8px 24px 0 24px;"><div style="font:14px %(font)s;color:%(body)s;line-height:1.45;">%(subline)s</div></td></tr>
<tr><td style="padding:12px 24px 0 24px;"><span style="display:inline-block;background:%(amber)s;color:%(heading)s;font:bold 11px %(font)s;letter-spacing:.03em;padding:5px 11px;border-radius:%(radius)s;">Save up to 25%% at volume</span></td></tr>
<tr><td style="padding:12px 18px 4px 18px;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0">%(grid)s</table></td></tr>
<tr><td align="center" style="padding:14px 24px 6px 24px;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>
<td bgcolor="%(green)s" align="center" style="border-radius:%(radius)s;">
<a href="%(cta)s" target="_blank" style="display:block;padding:15px 24px;font:bold 15px %(font)s;color:%(white)s;text-decoration:none;border-radius:%(radius)s;"><span style="color:%(white)s;">Request this set on WhatsApp</span></a>
</td></tr></table></td></tr>
<tr><td style="padding:14px 24px 18px 24px;border-top:1px solid %(border)s;">
<div style="font:11px %(font)s;color:%(fine)s;line-height:1.7;">
Indicative volume pricing, %(vat)s. Production 7 to 10 working days after artwork approval.<br>
Questions? <a href="mailto:%(email)s" style="color:%(muted)s;text-decoration:underline;">%(email)s</a><br>
<a href="%(cta)s" style="color:%(fine)s;text-decoration:underline;">Unsubscribe</a>
</div></td></tr>
</table></td></tr></table></body></html>""" % dict(
        subject=html.escape(s["subject"]), preheader=html.escape(preheader),
        page=C["page"], white=C["white"], border=C["border"], green=C["green"],
        amber=C["amber"], heading=C["heading"], body=C["body"], muted=C["muted"],
        fine=C["fine"], font=FONT, radius=RADIUS, logo=logo_src(),
        theme=html.escape(s["theme"]), kicker=html.escape(campaign_name),
        headline=html.escape(s["headline"]), subline=html.escape(s["subline"]),
        grid=grid, cta=cta, vat=VAT[cur], email=CONTACT_EMAIL)


# ---- email.amp.html -------------------------------------------------------
def render_email_amp(cur, s, products, date_disp, cta, campaign_name):
    tiles = []
    for p in products:
        tiles.append(
            '<div class="tile"><a href="%s" target="_blank">'
            '<div class="imgcell"><amp-img src="%s" width="640" height="640" layout="responsive" alt="%s"></amp-img></div>'
            '<div class="sku">%s</div><div class="name">%s</div>'
            '<div class="desc">%s</div><div class="price">from %s</div>'
            '<div class="unit">per unit, 250+ pcs</div></a></div>' % (
                product_url(p["sku"]), img_src(p["code"]), html.escape(p["name"]),
                p["sku"], html.escape(p["name"]), html.escape(p["desc"]),
                fmt_price(cur, p["usd"])))
    grid = "".join(tiles)
    return """<!doctype html>
<html amp4email><head><meta charset="utf-8">
<script async src="https://cdn.ampproject.org/v0.js"></script>
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>
body{margin:0;background:%(page)s;font-family:%(font)s;color:%(body)s;}
.wrap{max-width:600px;margin:0 auto;background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;}
.head{padding:20px 24px 12px;border-bottom:2px solid %(green)s;display:flex;align-items:center;justify-content:space-between;}
.theme{font-size:11px;font-weight:bold;color:%(muted)s;letter-spacing:.08em;text-transform:uppercase;}
.kicker{padding:18px 24px 0;font-size:12px;font-weight:bold;color:%(green)s;letter-spacing:.06em;text-transform:uppercase;}
.headline{padding:8px 24px 0;font-size:28px;font-weight:bold;color:%(heading)s;line-height:1.2;letter-spacing:-.01em;}
.subline{padding:8px 24px 0;font-size:14px;color:%(body)s;line-height:1.45;}
.pillwrap{padding:12px 24px 0;}
.pill{display:inline-block;background:%(amber)s;color:%(heading)s;font-size:11px;font-weight:bold;letter-spacing:.03em;padding:5px 11px;border-radius:%(radius)s;}
.grid{padding:12px 18px 4px;display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.tile{background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;padding:14px;}
.tile a{text-decoration:none;color:%(heading)s;display:block;}
.imgcell{background:%(tile)s;border-radius:%(radius)s;overflow:hidden;}
.sku{font-size:11px;color:%(fine)s;letter-spacing:.04em;margin-top:10px;}
.name{font-size:16px;font-weight:bold;color:%(heading)s;margin:2px 0;}
.desc{font-size:13px;color:%(muted)s;margin-bottom:8px;}
.price{font-size:14px;font-weight:bold;color:%(accent)s;}
.unit{font-size:11px;color:%(fine)s;}
.ctawrap{padding:14px 24px 6px;}
a.cta,a.cta:visited{display:block;text-align:center;padding:15px 24px;font-size:15px;font-weight:bold;color:%(white)s;background:%(green)s;border-radius:%(radius)s;text-decoration:none;}
.foot{padding:14px 24px 18px;border-top:1px solid %(border)s;font-size:11px;color:%(fine)s;line-height:1.7;}
.foot a{color:%(muted)s;}
</style></head>
<body><div class="wrap">
<div class="head"><amp-img src="%(logo)s" width="150" height="45" alt="Gifts Gulf"></amp-img><span class="theme">%(theme)s</span></div>
<div class="kicker">%(kicker)s</div>
<div class="headline">%(headline)s</div>
<div class="subline">%(subline)s</div>
<div class="pillwrap"><span class="pill">Save up to 25%% at volume</span></div>
<div class="grid">%(grid)s</div>
<div class="ctawrap"><a class="cta" href="%(cta)s" target="_blank">Request this set on WhatsApp</a></div>
<div class="foot">Indicative volume pricing, %(vat)s. Production 7 to 10 working days after artwork approval.<br>
<a href="mailto:%(email)s">%(email)s</a></div>
</div></body></html>""" % dict(
        page=C["page"], white=C["white"], border=C["border"], green=C["green"],
        amber=C["amber"], heading=C["heading"], body=C["body"], muted=C["muted"],
        fine=C["fine"], tile=C["tile"], accent=C["hover"], font=FONT, radius=RADIUS,
        logo=logo_src(), theme=html.escape(s["theme"]), kicker=html.escape(campaign_name),
        headline=html.escape(s["headline"]), subline=html.escape(s["subline"]),
        grid=grid, cta=cta, vat=VAT[cur], email=CONTACT_EMAIL)


# ---- whatsapp.txt ---------------------------------------------------------
def render_whatsapp(cur, s, products):
    lines = [s["headline"]]
    for p in products[:3]:
        lines.append("%s, from %s/unit" % (p["name"], fmt_price(cur, p["usd"])))
    lines.append("Free branded mock-up first, then production in 7 to 10 working days.")
    lines.append("Send your set: %s" % wa_url("Send me the %s set for %s" % (s["theme"], MARKET[cur])))
    return "\n".join(lines) + "\n"


# ---- linkedin.txt ---------------------------------------------------------
def render_linkedin(cur, s, products):
    names = ", ".join(p["name"] for p in products[:3])
    return (
        "%s We built the %s set for %s teams: %s and more, every piece branded to your logo. "
        "You approve a free digital mock-up before you pay anything, with volume pricing from 250 pieces and delivery in 7 to 10 working days. "
        "Want it sized to your headcount? Message us on WhatsApp (%s) or %s.\n"
    ) % (s["headline"], s["theme"].lower(), MARKET[cur], names,
         wa_url("LinkedIn: %s set for %s" % (s["theme"], MARKET[cur])), CONTACT_EMAIL)


# ---- main -----------------------------------------------------------------
def main():
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.utcnow().strftime("%Y-%m-%d")
    d = datetime.strptime(date, "%Y-%m-%d")
    date_disp, ymd = d.strftime("%d %b %Y"), d.strftime("%Y%m%d")

    catalogue = {p["sku"]: p for p in json.load(open(os.path.join(STATE, "catalogue.json")))}
    day_dir = os.path.join(ROOT, date)
    os.makedirs(day_dir, exist_ok=True)

    def load(name, default):
        path = os.path.join(STATE, name)
        return json.load(open(path)) if os.path.exists(path) else default

    history = load("history.json", [])
    used_subjects = set(load("used-subjects.json", []))
    used_skus_log = load("used-skus.json", [])  # [{date, skus:[...]}]
    recent_skus = set()
    for e in used_skus_log:
        try:
            age = (d - datetime.strptime(e["date"], "%Y-%m-%d")).days
        except Exception:
            age = 99
        if 0 <= age < 14:
            recent_skus.update(e.get("skus", []))

    manifest = {"date": date, "generated_utc": datetime.utcnow().isoformat() + "Z", "sets": []}
    day_skus, problems = [], []

    for cur in ("AED", "SAR", "QAR"):
        plan = PLAN[cur]
        for n, s in enumerate(plan["sets"], start=1):
            code = "GG-%s-%s-%d" % (cur, ymd, n)
            campaign_name = "%s - %s" % (s["name"], date_disp)

            if s["subject"] in used_subjects:
                problems.append("subject reused: %r (%s)" % (s["subject"], code))

            products = []
            for sku, desc in s["items"]:
                cp = catalogue.get(sku)
                if not cp:
                    problems.append("sku not in catalogue: %s (%s)" % (sku, code)); continue
                if sku in recent_skus:
                    problems.append("sku reused within 14d: %s (%s)" % (sku, code))
                if not verify_image(cp["code"]):
                    problems.append("image failed verify: %s/%s (%s)" % (sku, cp["code"], code)); continue
                products.append(dict(sku=sku, name=cp["name"].title(), code=cp["code"],
                                     usd=cp["usd"], desc=desc))
            if len(products) < 4:
                problems.append("set under 4 verified products: %s (%d)" % (code, len(products)))

            cta = wa_url("Send me the %s set (%s) for %s" % (s["theme"], code, MARKET[cur]))
            set_dir = os.path.join(day_dir, cur, "set-%d" % n)
            os.makedirs(set_dir, exist_ok=True)
            open(os.path.join(set_dir, "email.html"), "w").write(
                render_email_html(cur, s, products, date_disp, cta, campaign_name))
            open(os.path.join(set_dir, "email.amp.html"), "w").write(
                render_email_amp(cur, s, products, date_disp, cta, campaign_name))
            open(os.path.join(set_dir, "whatsapp.txt"), "w").write(
                render_whatsapp(cur, s, products))
            open(os.path.join(set_dir, "linkedin.txt"), "w").write(
                render_linkedin(cur, s, products))

            skus = [p["sku"] for p in products]
            meta = dict(
                date=date, market=MARKET[cur], currency=cur, theme=s["theme"],
                season=plan["season"], angle=plan["angle"], campaign_code=code,
                campaign_name=campaign_name, subject=s["subject"], skus=skus,
                products=[dict(name=p["name"], sku=p["sku"],
                               image=img_src(p["code"], escaped=False),
                               product_url=product_url(p["sku"]),
                               price="%s %.2f" % (SYM[cur], vol_price(p["usd"], cur))) for p in products],
                cta_url=cta)
            json.dump(meta, open(os.path.join(set_dir, "meta.json"), "w"), indent=2)

            manifest["sets"].append(dict(
                currency=cur, market=MARKET[cur], theme=s["theme"], angle=plan["angle"],
                season=plan["season"], campaign_code=code, campaign_name=campaign_name,
                subject=s["subject"], skus=skus))
            history.append(dict(
                date=date, market=MARKET[cur], campaign_code=code,
                campaign_name=campaign_name, subject=s["subject"], theme=s["theme"],
                angle=plan["angle"], skus=skus))
            used_subjects.add(s["subject"])
            day_skus.extend(skus)

    json.dump(manifest, open(os.path.join(day_dir, "manifest.json"), "w"), indent=2)
    json.dump(history, open(os.path.join(STATE, "history.json"), "w"), indent=2)
    json.dump(sorted(used_subjects), open(os.path.join(STATE, "used-subjects.json"), "w"), indent=2)
    used_skus_log = [e for e in used_skus_log if e.get("date") != date]
    used_skus_log.append(dict(date=date, skus=day_skus))
    json.dump(used_skus_log, open(os.path.join(STATE, "used-skus.json"), "w"), indent=2)

    print("Generated 9 sets for %s -> %s" % (date, day_dir))
    print("Products placed: %d  Unique SKUs: %d" % (len(day_skus), len(set(day_skus))))
    if problems:
        print("PROBLEMS (%d):" % len(problems))
        for p in problems:
            print("  -", p)
        sys.exit(3)


if __name__ == "__main__":
    main()
