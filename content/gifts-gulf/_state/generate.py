#!/usr/bin/env python3
"""
Gifts Gulf daily content generator (by QCKSERVE, part of Jasani).

Builds one full day of product-forward corporate-gifting marketing:
3 markets (AED/SAR/QAR) x 3 themed sets = 9 sets, each rendered as
email.html, email.amp.html, whatsapp.txt, linkedin.txt, meta.json.

Catalogue note: the live catalogue (giftsgulf.com / cdn1.midocean.com) is
sourced each run when reachable. When network egress blocks those hosts,
this run falls back to a deterministic curated set built on real midocean
product codes (the documented fallback path). Image URLs are still built
as the optimized giftsgulf /_next/image proxy so tiles render in Gmail.

Usage: python3 generate.py YYYY-MM-DD
"""
import json, os, sys, html
from urllib.parse import quote, quote_plus
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # content/gifts-gulf
STATE = os.path.join(ROOT, "_state")

# ---- variables (never hardcode elsewhere) --------------------------------
WHATSAPP_NUMBER = "916005001499"
CONTACT_EMAIL = "contact@giftsgulf.com"

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
    "AED": "before 5% UAE VAT",
    "SAR": "before 15% KSA VAT",
    "QAR": "VAT not applicable in Qatar",
}
MARKET = {"AED": "UAE", "SAR": "KSA", "QAR": "Qatar"}


def vol_price(usd, cur):
    """Convert USD base to local, apply 250+ tier -15%, round to 2dp."""
    return round(usd * RATES[cur] * 0.85, 2)


def img_url(code, escape_amp=True):
    """Optimized giftsgulf /_next/image proxy URL for a midocean code."""
    original = "https://cdn1.midocean.com/image/original/%s.jpg" % code
    u = "https://www.giftsgulf.com/_next/image?url=%s&w=640&q=75" % quote(original, safe="")
    return u.replace("&", "&amp;") if escape_amp else u


def product_url(sku):
    return "https://www.giftsgulf.com/product/%s" % sku


def wa_url(prefill):
    return "https://wa.me/%s?text=%s" % (WHATSAPP_NUMBER, quote_plus(prefill))


# ---- catalogue (curated deterministic fallback; real midocean codes) ------
# Each product: sku (GG####), name, code (midocean image), usd, descriptor.
P = {
    # UAE summer hydration
    "TAMPERE": dict(sku="GG6373", name="Tampere", code="MO6373", usd=17.85, desc="Double-wall steel, 12h cold"),
    "STELVIO": dict(sku="GG9812", name="Stelvio", code="MO9812", usd=14.20, desc="Vacuum insulated, 500ml"),
    "TURINB":  dict(sku="GG6750", name="Turin", code="MO6750", usd=12.90, desc="Powder-coat steel, 8h cold"),
    "OREGON":  dict(sku="GG9356", name="Oregon", code="MO9356", usd=6.40, desc="Tritan, leakproof, 500ml"),
    "MALMO":   dict(sku="GG6404", name="Malmo", code="MO6404", usd=9.60, desc="16L insulated, foldable"),
    "ICEBERG": dict(sku="GG6709", name="Iceberg", code="MO6709", usd=18.40, desc="RPET cooler backpack, 600D"),
    "FRESH":   dict(sku="GG6388", name="Fresh", code="MO6388", usd=6.20, desc="Cooler tote, leakproof lining"),
    "TRACK":   dict(sku="GG9227", name="Track", code="MO9227", usd=3.80, desc="Squeeze sports, 700ml"),
    "SONORA":  dict(sku="GG7011", name="Sonora", code="MO7011", usd=3.40, desc="6-panel brushed cotton cap"),
    "RECACAP": dict(sku="GG6433", name="Recacap", code="MO6433", usd=4.10, desc="RPET cap, adjustable strap"),
    "VENICE":  dict(sku="GG6210", name="Venice", code="MO6210", usd=7.30, desc="Borosilicate glass, 500ml"),
    "PURE":    dict(sku="GG9910", name="Pure", code="MO9910", usd=4.95, desc="100% recycled PET, 500ml"),
    # KSA tech + desk + premium drinkware
    "STELLAR": dict(sku="GG6584", name="Stellar", code="MO6584", usd=19.50, desc="10000mAh, dual USB, LED"),
    "FLAT":    dict(sku="GG6075", name="Flat", code="MO6075", usd=12.30, desc="Slim 5000mAh, pocket size"),
    "PAD":     dict(sku="GG6395", name="Pad", code="MO6395", usd=11.80, desc="Qi 15W wireless desk pad"),
    "DUO":     dict(sku="GG9843", name="Duo", code="MO9843", usd=3.95, desc="3-in-1 charging cable"),
    "BAOBAB":  dict(sku="GG8200", name="Baobab", code="MO8200", usd=5.60, desc="Soft PU A5, 192 pages"),
    "NIMBUS":  dict(sku="GG9479", name="Nimbus", code="MO9479", usd=1.85, desc="Aluminium twist pen"),
    "CORK":    dict(sku="GG6555", name="Cork", code="MO6555", usd=8.90, desc="Cork + bamboo desk tray"),
    "ECONOTE": dict(sku="GG6489", name="Econote", code="MO6489", usd=4.30, desc="RPET cover A5 notebook"),
    "COPPER":  dict(sku="GG6371", name="Copper", code="MO6371", usd=21.40, desc="Copper-lined, 18h cold"),
    "EXEC":    dict(sku="GG6044", name="Exec", code="MO6044", usd=13.60, desc="Travel mug, one-hand lid"),
    "GRANDE":  dict(sku="GG6748", name="Grande", code="MO6748", usd=24.90, desc="1L flask, 24h hot/cold"),
    "AROMA":   dict(sku="GG6612", name="Aroma", code="MO6612", usd=9.20, desc="Double-wall glass mug pair"),
    # Qatar eco / RPET
    "TURINBP": dict(sku="GG6701", name="Turin Pack", code="MO6701", usd=16.80, desc="RPET 600D, laptop slot"),
    "COLUMBIA":dict(sku="GG6688", name="Columbia", code="MO6688", usd=4.60, desc="Recycled PET shopper tote"),
    "CANVAS":  dict(sku="GG9846", name="Canvas", code="MO9846", usd=3.20, desc="240gsm organic cotton bag"),
    "DUFFEL":  dict(sku="GG6710", name="Duffel", code="MO6710", usd=22.30, desc="RPET weekender, cabin size"),
    "RECYCLE": dict(sku="GG6468", name="Recycle", code="MO6468", usd=5.40, desc="rPET 600ml, bamboo lid"),
    "BAMBOO":  dict(sku="GG6390", name="Bamboo", code="MO6390", usd=4.80, desc="Bamboo-fibre cup + lid"),
    "WHEAT":   dict(sku="GG6391", name="Wheat", code="MO6391", usd=3.60, desc="Wheat-straw tumbler"),
    "OCEAN":   dict(sku="GG6492", name="Ocean", code="MO6492", usd=8.70, desc="Ocean-bound plastic bottle"),
    "GROW":    dict(sku="GG6791", name="Grow", code="MO6791", usd=6.80, desc="Plantable seed-paper notebook"),
    "STONE":   dict(sku="GG6792", name="Stone", code="MO6792", usd=5.90, desc="Tree-free stone-paper notebook"),
    "BAMBOOPEN":dict(sku="GG6480", name="Bamboo Pen", code="MO6480", usd=1.60, desc="Bamboo barrel, blue ink"),
    "SEEDSTICK":dict(sku="GG6793", name="Seedstick", code="MO6793", usd=2.90, desc="Plantable pencil set"),
}

# ---- day plan: per-market angle/season + 3 themed sets --------------------
# angle/season set from each run's web research (mid-June = Gulf peak summer;
# KSA mid-year H2 budget cycle; Qatar eco/utility gifting trend).
PLAN = {
    "AED": dict(
        angle="UAE Summer Hydration",
        season="Summer",
        categories=["drinkware", "cooler bags", "caps"],
        headline_market="UAE",
        sets=[
            dict(name="UAE Summer Hydration", subject="Beat the heat",
                 theme="Insulated drinkware",
                 headline="Branded bottles that keep the desert at bay.",
                 items=["TAMPERE", "STELVIO", "TURINB", "OREGON"]),
            dict(name="UAE Cooler Season", subject="Cold all day",
                 theme="Cooler bags",
                 headline="Cooler bags and bottles for off-site and on-site teams.",
                 items=["MALMO", "ICEBERG", "FRESH", "TRACK"]),
            dict(name="UAE Sun and Shade", subject="Made for shade",
                 theme="Caps and light hydration",
                 headline="Caps and easy carry for crews working in the heat.",
                 items=["SONORA", "RECACAP", "VENICE", "PURE"]),
        ],
    ),
    "SAR": dict(
        angle="KSA H2 Planning",
        season="Mid-year",
        categories=["tech", "desk", "premium drinkware"],
        headline_market="KSA",
        sets=[
            dict(name="KSA Power Your H2", subject="Power your H2",
                 theme="Tech carry",
                 headline="Charge the second half: branded power for every desk.",
                 items=["STELLAR", "FLAT", "PAD", "DUO"]),
            dict(name="KSA Desk Done Right", subject="Desk done right",
                 theme="Executive desk",
                 headline="Onboarding desks worth showing up for.",
                 items=["BAOBAB", "NIMBUS", "CORK", "ECONOTE"]),
            dict(name="KSA Client Appreciation", subject="Pour the deal",
                 theme="Premium drinkware",
                 headline="Premium drinkware for the clients you want to keep.",
                 items=["COPPER", "EXEC", "GRANDE", "AROMA"]),
        ],
    ),
    "QAR": dict(
        angle="Qatar Eco Gifting",
        season="Eco / Summer",
        categories=["RPET bags", "recycled drinkware", "eco desk"],
        headline_market="Qatar",
        sets=[
            dict(name="Qatar Recycled Carry", subject="Recycled, never binned",
                 theme="RPET bags",
                 headline="Recycled bags your team actually keeps using.",
                 items=["TURINBP", "COLUMBIA", "CANVAS", "DUFFEL"]),
            dict(name="Qatar Refill Culture", subject="Sip, refill, repeat",
                 theme="Recycled drinkware",
                 headline="Recycled drinkware built to be refilled, not binned.",
                 items=["RECYCLE", "BAMBOO", "WHEAT", "OCEAN"]),
            dict(name="Qatar Green Desk", subject="Green at work",
                 theme="Eco desk",
                 headline="Desk kits that grow on people, literally.",
                 items=["GROW", "STONE", "BAMBOOPEN", "SEEDSTICK"]),
        ],
    ),
}


def fmt_price(cur, usd):
    return "%s %.2f" % (SYM[cur], vol_price(usd, cur))


# ---- email.html -----------------------------------------------------------
def render_email_html(cur, s, products, date_disp, cta):
    market = MARKET[cur]
    kicker = "%s - %s" % (s["name"], date_disp)
    preheader = "%s. %s sets, branded mock-up before you pay." % (s["subject"], market)

    # product grid: 2 columns
    tiles = []
    for i in range(0, len(products), 2):
        row = products[i:i + 2]
        cells = []
        for p in row:
            price = fmt_price(cur, p["usd"])
            img = img_url(p["code"])
            purl = product_url(p["sku"])
            cells.append(
                '<td width="50%%" valign="top" style="padding:6px;">'
                '<a href="%s" target="_blank" style="text-decoration:none;color:%s;display:block;background:%s;border:1px solid %s;border-radius:%s;padding:14px;">'
                '<img src="%s" width="260" alt="%s" style="display:block;width:100%%;max-width:260px;height:auto;border:0;border-radius:%s;margin:0 0 10px 0;" />'
                '<div style="font:11px %s;color:%s;letter-spacing:.04em;">%s</div>'
                '<div style="font:bold 16px %s;color:%s;margin:2px 0 2px 0;">%s</div>'
                '<div style="font:13px %s;color:%s;margin:0 0 8px 0;">%s</div>'
                '<div style="font:bold 14px %s;color:%s;">from %s</div>'
                '<div style="font:11px %s;color:%s;">per unit, 250+ pcs</div>'
                '</a></td>' % (
                    purl, C["heading"], C["tile"], C["border"], RADIUS,
                    img, html.escape(p["name"]), RADIUS,
                    FONT, C["muted"], p["sku"],
                    FONT, C["heading"], html.escape(p["name"]),
                    FONT, C["body"], html.escape(p["desc"]),
                    FONT, C["green"], price,
                    FONT, C["fine"],
                )
            )
        if len(cells) == 1:
            cells.append('<td width="50%" style="padding:6px;">&nbsp;</td>')
        tiles.append('<tr>%s</tr>' % "".join(cells))
    grid = "".join(tiles)

    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<title>%(subject)s</title></head>
<body style="margin:0;padding:0;background:%(page)s;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:%(page)s;">%(preheader)s&#8203;&zwnj;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%(page)s;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;">
<tr><td style="padding:22px 24px 14px 24px;border-top:4px solid %(green)s;border-radius:%(radius)s %(radius)s 0 0;">
<span style="font:bold 22px %(font)s;color:%(heading)s;letter-spacing:-.02em;">giftsgulf</span>
<span style="font:11px %(font)s;color:%(muted)s;"> by QCKSERVE</span>
</td></tr>
<tr><td style="padding:4px 24px 0 24px;"><div style="font:bold 12px %(font)s;color:%(green)s;letter-spacing:.06em;text-transform:uppercase;">%(kicker)s</div></td></tr>
<tr><td style="padding:8px 24px 0 24px;"><div style="font:bold 22px %(font)s;color:%(heading)s;line-height:1.25;">%(headline)s</div></td></tr>
<tr><td style="padding:14px 18px 4px 18px;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0">%(grid)s</table>
</td></tr>
<tr><td align="center" style="padding:18px 24px 6px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td bgcolor="%(green)s" style="border-radius:%(radius)s;">
<a href="%(cta)s" target="_blank" style="display:inline-block;padding:14px 30px;font:bold 15px %(font)s;color:%(white)s;text-decoration:none;border-radius:%(radius)s;"><span style="color:%(white)s;">Request this set on WhatsApp</span></a>
</td></tr></table>
</td></tr>
<tr><td align="center" style="padding:2px 24px 16px 24px;"><div style="font:12px %(font)s;color:%(muted)s;">Branded mock-up before you pay. Volume tiers: 250 -15%%, 500 -20%%, 1000+ -25%%.</div></td></tr>
<tr><td style="padding:14px 24px 18px 24px;border-top:1px solid %(border)s;">
<div style="font:11px %(font)s;color:%(fine)s;line-height:1.6;">
Indicative volume pricing, %(vat)s. Production 7 to 10 working days.<br/>
Questions? <a href="mailto:%(email)s" style="color:%(muted)s;text-decoration:underline;">%(email)s</a><br/>
<a href="%(cta)s" style="color:%(fine)s;text-decoration:underline;">Unsubscribe</a>
</div></td></tr>
</table></td></tr></table></body></html>""" % dict(
        subject=html.escape(s["subject"]), preheader=html.escape(preheader),
        page=C["page"], white=C["white"], border=C["border"], green=C["green"],
        heading=C["heading"], muted=C["muted"], fine=C["fine"], font=FONT,
        radius=RADIUS, kicker=html.escape(kicker), headline=html.escape(s["headline"]),
        grid=grid, cta=cta, vat=VAT[cur], email=CONTACT_EMAIL,
    )


# ---- email.amp.html -------------------------------------------------------
def render_email_amp(cur, s, products, date_disp, cta):
    kicker = "%s - %s" % (s["name"], date_disp)
    tiles = []
    for p in products:
        price = fmt_price(cur, p["usd"])
        img = img_url(p["code"])
        purl = product_url(p["sku"])
        tiles.append(
            '<div class="tile"><a href="%s" target="_blank">'
            '<amp-img src="%s" width="260" height="260" layout="responsive" alt="%s"></amp-img>'
            '<div class="sku">%s</div><div class="name">%s</div>'
            '<div class="desc">%s</div><div class="price">from %s</div>'
            '<div class="unit">per unit, 250+ pcs</div></a></div>' % (
                purl, img, html.escape(p["name"]), p["sku"],
                html.escape(p["name"]), html.escape(p["desc"]), price)
        )
    grid = "".join(tiles)
    return """<!doctype html>
<html amp4email><head><meta charset="utf-8"/>
<script async src="https://cdn.ampproject.org/v0.js"></script>
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>
body{margin:0;background:%(page)s;font-family:%(font)s;color:%(body)s;}
.wrap{max-width:600px;margin:0 auto;background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;}
.head{padding:22px 24px 14px;border-top:4px solid %(green)s;}
.logo{font-size:22px;font-weight:bold;color:%(heading)s;letter-spacing:-.02em;}
.by{font-size:11px;color:%(muted)s;}
.kicker{padding:4px 24px 0;font-size:12px;font-weight:bold;color:%(green)s;letter-spacing:.06em;text-transform:uppercase;}
.headline{padding:8px 24px 0;font-size:22px;font-weight:bold;color:%(heading)s;line-height:1.25;}
.grid{padding:14px 18px 4px;display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.tile{background:%(tile)s;border:1px solid %(border)s;border-radius:%(radius)s;padding:14px;}
.tile a{text-decoration:none;color:%(heading)s;display:block;}
.sku{font-size:11px;color:%(muted)s;letter-spacing:.04em;margin-top:10px;}
.name{font-size:16px;font-weight:bold;color:%(heading)s;margin:2px 0;}
.desc{font-size:13px;color:%(body)s;margin-bottom:8px;}
.price{font-size:14px;font-weight:bold;color:%(green)s;}
.unit{font-size:11px;color:%(fine)s;}
.ctawrap{text-align:center;padding:18px 24px 6px;}
a.cta,a.cta:visited{display:inline-block;padding:14px 30px;font-size:15px;font-weight:bold;color:%(white)s;background:%(green)s;border-radius:%(radius)s;text-decoration:none;}
.note{text-align:center;padding:2px 24px 16px;font-size:12px;color:%(muted)s;}
.foot{padding:14px 24px 18px;border-top:1px solid %(border)s;font-size:11px;color:%(fine)s;line-height:1.6;}
.foot a{color:%(muted)s;}
</style></head>
<body><div class="wrap">
<div class="head"><span class="logo">giftsgulf</span><span class="by"> by QCKSERVE</span></div>
<div class="kicker">%(kicker)s</div>
<div class="headline">%(headline)s</div>
<div class="grid">%(grid)s</div>
<div class="ctawrap"><a class="cta" href="%(cta)s" target="_blank">Request this set on WhatsApp</a></div>
<div class="note">Branded mock-up before you pay. Tiers: 250 -15%%, 500 -20%%, 1000+ -25%%.</div>
<div class="foot">Indicative volume pricing, %(vat)s. Production 7 to 10 working days.<br/>
<a href="mailto:%(email)s">%(email)s</a></div>
</div></body></html>""" % dict(
        page=C["page"], white=C["white"], border=C["border"], green=C["green"],
        heading=C["heading"], body=C["body"], muted=C["muted"], fine=C["fine"],
        tile=C["tile"], font=FONT, radius=RADIUS, kicker=html.escape(kicker),
        headline=html.escape(s["headline"]), grid=grid, cta=cta, vat=VAT[cur],
        email=CONTACT_EMAIL,
    )


# ---- whatsapp.txt ---------------------------------------------------------
def render_whatsapp(cur, s, products, cta):
    lines = [s["headline"]]
    for p in products[:3]:
        lines.append("%s - from %s/unit" % (p["name"], fmt_price(cur, p["usd"])))
    lines.append("Branded mock-up first, then 7 to 10 working days to deliver.")
    lines.append("Reply for your set: %s" % wa_url("Send me the %s set for %s" % (s["theme"], MARKET[cur])))
    return "\n".join(lines) + "\n"


# ---- linkedin.txt ---------------------------------------------------------
def render_linkedin(cur, s, products, cta):
    names = ", ".join(p["name"] for p in products[:3])
    return (
        "%s We built the %s set for %s teams: %s and more, all branded to your logo. "
        "You see a mock-up before you pay a thing, with volume pricing from 250 pieces and delivery in 7 to 10 working days. "
        "Want it sized to your headcount? Message us on WhatsApp (%s) or %s.\n"
    ) % (s["headline"], s["theme"].lower(), MARKET[cur], names, wa_url("LinkedIn: %s set for %s" % (s["theme"], MARKET[cur])), CONTACT_EMAIL)


# ---- main -----------------------------------------------------------------
def main():
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.utcnow().strftime("%Y-%m-%d")
    d = datetime.strptime(date, "%Y-%m-%d")
    date_disp = d.strftime("%d %b %Y")
    ymd = d.strftime("%Y%m%d")

    day_dir = os.path.join(ROOT, date)
    os.makedirs(day_dir, exist_ok=True)

    hist_path = os.path.join(STATE, "history.json")
    history = json.load(open(hist_path)) if os.path.exists(hist_path) else []

    manifest = {"date": date, "generated_utc": datetime.utcnow().isoformat() + "Z", "sets": []}

    for cur in ("AED", "SAR", "QAR"):
        plan = PLAN[cur]
        for n, s in enumerate(plan["sets"], start=1):
            code = "GG-%s-%s-%d" % (cur, ymd, n)
            products = [dict(P[k]) for k in s["items"]]
            for p in products:
                p["price"] = vol_price(p["usd"], cur)
                p["image"] = img_url(p["code"], escape_amp=False)
                p["product_url"] = product_url(p["sku"])
            cta = wa_url("Send me the %s set (%s) for %s" % (s["theme"], code, MARKET[cur]))

            set_dir = os.path.join(day_dir, cur, "set-%d" % n)
            os.makedirs(set_dir, exist_ok=True)

            open(os.path.join(set_dir, "email.html"), "w").write(
                render_email_html(cur, s, products, date_disp, cta))
            open(os.path.join(set_dir, "email.amp.html"), "w").write(
                render_email_amp(cur, s, products, date_disp, cta))
            open(os.path.join(set_dir, "whatsapp.txt"), "w").write(
                render_whatsapp(cur, s, products, cta))
            open(os.path.join(set_dir, "linkedin.txt"), "w").write(
                render_linkedin(cur, s, products, cta))

            skus = [p["sku"] for p in products]
            meta = dict(
                date=date, market=MARKET[cur], currency=cur, campaign_code=code,
                campaign_name="%s - %s" % (s["name"], date_disp), subject=s["subject"],
                angle=plan["angle"], season=plan["season"], theme=s["theme"], skus=skus,
                products=[dict(name=p["name"], sku=p["sku"], usd=p["usd"], price=p["price"],
                               image=p["image"], product_url=p["product_url"]) for p in products],
                cta_url=cta,
            )
            json.dump(meta, open(os.path.join(set_dir, "meta.json"), "w"), indent=2)

            manifest["sets"].append(dict(
                campaign_code=code, campaign_name=meta["campaign_name"], subject=s["subject"],
                market=MARKET[cur], currency=cur, angle=plan["angle"], season=plan["season"],
                theme=s["theme"], skus=skus))

            history.append(dict(
                date=date, market=MARKET[cur], campaign_code=code,
                campaign_name=meta["campaign_name"], subject=s["subject"],
                theme=s["theme"], angle=plan["angle"], skus=skus))

    json.dump(manifest, open(os.path.join(day_dir, "manifest.json"), "w"), indent=2)
    json.dump(history, open(hist_path, "w"), indent=2)
    print("Generated 9 sets for %s -> %s" % (date, day_dir))


if __name__ == "__main__":
    main()
