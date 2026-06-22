#!/usr/bin/env python3
"""
Gifts Gulf daily content generator (by QCKSERVE, part of Jasani).

Builds ONE day of product-forward corporate-gifting content: 9 sets that cycle
three email designs (set 1/4/7 = A editorial grid, 2/5/8 = B hero spotlight,
3/6/9 = C lookbook stack). Each set is a distinct theme and product mix.

HARD RULES enforced here:
  - No price, no currency, no VAT, no delivery/production time anywhere.
  - No country, region, or currency name (market-neutral).
  - Fixed contact: sales@giftsgulf.com / +916005001499, WhatsApp 916005001499.
  - Every product image is the wsrv JPEG proxy of the real midocean original,
    HEAD-verified (HTTP 200 + image/jpeg) before it is allowed into a set.
  - SKUs not reused within 14 days; subjects never reused.
  - No em dashes.

Outputs per set: email.html, email.amp.html, whatsapp.txt, linkedin.txt,
meta.json (img/whatsapp.jpg is produced separately by make_cards.py).
Also writes manifest.json and a cards.json driver, and updates the _state files.

Usage: python3 generate.py YYYY-MM-DD
"""
import json, os, sys, html, random
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # content/gifts-gulf
STATE = os.path.join(ROOT, "_state")

# ---- fixed values ---------------------------------------------------------
WHATSAPP_NUMBER = "916005001499"
CONTACT_EMAIL = "sales@giftsgulf.com"
CONTACT_PHONE = "+916005001499"
WEBSITE = "www.giftsgulf.com"
LOGO_SVG = "https://www.giftsgulf.com/gglogo.svg"

# ---- brand palette --------------------------------------------------------
C = dict(
    green="#00a544", hover="#008138", heading="#18181b", body="#3f3f46",
    muted="#71717b", fine="#9f9fa9", border="#e4e4e7", tile="#f4f4f5",
    page="#fafafa", amber="#fcbb00", white="#ffffff",
)
FONT = "Arial, Helvetica, sans-serif"
RADIUS = "3px"


def img_src(code, escaped=True):
    u = ("https://wsrv.nl/?url=ssl:cdn1.midocean.com/image/original/%s.jpg"
         "&w=640&output=jpg&q=80" % code)
    return u.replace("&", "&amp;") if escaped else u


def logo_src(escaped=True):
    u = "https://wsrv.nl/?url=%s&w=360&output=png" % LOGO_SVG
    return u.replace("&", "&amp;") if escaped else u


def product_url(sku):
    return "https://www.giftsgulf.com/product/%s" % sku


def wa_url(prefill):
    return "https://wa.me/%s?text=%s" % (WHATSAPP_NUMBER, quote(prefill))


def verify_image(code):
    url = img_src(code, escaped=False)
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "gifts-gulf/1.0"})
        with urlopen(req, timeout=30) as r:
            return r.status == 200 and "image/jpeg" in r.headers.get("Content-Type", "")
    except (HTTPError, URLError, Exception):
        return False


# ===========================================================================
# DAILY RESEARCH BRIEF (2026-06-22)
# Deep summer, mid-year mark. H2 onboarding waves and the summer event and
# conference season run side by side, and teams are sorting mid-year thank-you
# gifts. Live 2026 signals hold: sustainability is the baseline, not a perk
# (recycled steel, recycled cotton, rPET, recycled paper, organic cotton,
# bamboo and wood), plain plastic giveaways are tired, and the gifts that win
# are quality everyday-carry that lives on the desk, in the bag and on the
# move, branded subtly rather than loudly. Yesterday leaned on glassware and
# ceramics, so today rotates to recycled cotton, rPET, wood and natural
# materials, with steel hydration and desk tech holding their place. All SKUs
# and subjects are fresh against the last 14 days.
# ===========================================================================
SEASON = "Deep summer, event season and mid-year onboarding"

# Each set is a coherent, material-anchored mix of REAL fresh catalogue SKUs
# (not used in the last 14 days). The catalogue has no category field and brand
# names embed the category in compound words, so explicit SKU lists are far
# more reliable than keyword matching. Every code is HEAD-verified at render.
SETS = [
    dict(design='A', theme='Premium drinkware',
         name='Vacuum Steel Drinkware', angle='Branded daily hydration',
         subject='Steel that sticks around',
         headline='Steel bottles made for daily carry.',
         subline='Vacuum steel bottles and tumblers, branded for the everyday.',
         items=['GG1427', 'GG1148', 'GG1151', 'GG1184', 'GG1187', 'GG1214'],
         descs=['Branded steel they keep', 'Cold all day, your logo',
                'Built to last, not bin', 'A logo they pour from',
                'Refilled, not replaced', 'Daily carry, your brand']),
    dict(design='B', theme='Notebooks and writing',
         name='Pens, Notebooks and Sets', angle='Made for note-takers',
         subject='Pens they keep clicking',
         headline='Pens and notebooks, branded to you.',
         subline='Pens, notebooks and writing sets, branded with your logo.',
         items=['GG1399', 'GG1103', 'GG1191', 'GG1250', 'GG1156', 'GG1449'],
         descs=['Where ideas get written', 'Smooth writer, your logo',
                'Cork accent, clean mark', 'Stylus and pen in one',
                'Pen and notebook set', 'A folio for every meeting']),
    dict(design='C', theme='Eco and sustainable',
         name='Recycled Cotton Carry', angle='Recycled cotton, clearly yours',
         subject='Recycled cotton, clearly yours',
         headline='Recycled cotton, branded for everyday.',
         subline='Recycled cotton bags and accessories, branded with your logo.',
         items=['GG1113', 'GG1115', 'GG1132', 'GG1138', 'GG1141', 'GG1173'],
         descs=['Recycled, clearly yours', 'Soft fibre, clear print',
                'Better made, better gift', 'Carried, not binned',
                'Conscious, never dull', 'A logo they reach for']),
    dict(design='A', theme='Bags and travel',
         name='Cotton Bags and Totes', angle='Carried everywhere',
         subject='Bags built for everywhere',
         headline='Bags your team carries everywhere.',
         subline='Cotton totes and bags, printed with your brand.',
         items=['GG1094', 'GG1127', 'GG1181', 'GG1182', 'GG1206', 'GG1235'],
         descs=['Carried everywhere, branded', 'Natural fibre, clear print',
                'A logo on the move', 'Packed and branded',
                'Carried far, seen often', 'Built to be carried']),
    dict(design='B', theme='Event giveaways',
         name='Booth and Event Giveaways', angle='Crowd-friendly and kept',
         subject='Giveaways worth keeping',
         headline='Booth gifts that get kept.',
         subline='Crowd-friendly branded pieces for event tables and welcome desks.',
         items=['GG1481', 'GG1596', 'GG1570', 'GG1388', 'GG1387', 'GG1386'],
         descs=['Giveaways they keep', 'Notepad and pencils in one',
                'Three highlighters in one', 'Branded paper carrier',
                'Carries the gift, branded', 'Small carrier, big logo']),
    dict(design='C', theme='Executive onboarding',
         name='Soft-Touch Folios and Sets', angle='Welcome them properly',
         subject='First day, done right',
         headline='Welcome them with something kept.',
         subline='Soft-touch folios and sets to greet a new hire, branded with your logo.',
         items=['GG1253', 'GG1294', 'GG1308', 'GG1309', 'GG1367', 'GG1561'],
         descs=['Day one, done right', 'Soft-touch, debossed logo',
                'A welcome they keep', 'Made for the first week',
                'Premium feel, your brand', 'Quiet quality, your logo']),
    dict(design='A', theme='Recycled and rPET',
         name='Recycled rPET Bags', angle='Recycled bags, daily carry',
         subject='Bottles reborn as bags',
         headline='Recycled bottles, reborn as bags.',
         subline='Recycled rPET bags built for daily use.',
         items=['GG1106', 'GG1107', 'GG1133', 'GG1139', 'GG1189', 'GG1210'],
         descs=['Recycled bottles, reborn', 'Eco credentials, daily use',
                'Carried, not binned', 'A logo they reach for',
                'Better material, branded', 'Packed and on the move']),
    dict(design='B', theme='Seasonal occasions',
         name='Summer Cotton Carry', angle='Summer carry, branded',
         subject='Summer carry, branded',
         headline='Summer carry, branded to you.',
         subline='Lightweight summer carry, printed with your brand.',
         items=['GG1238', 'GG1258', 'GG1259', 'GG1380', 'GG1413', 'GG1424'],
         descs=['Summer carry, branded', 'Natural fibre, clear print',
                'Light, packable, yours', 'A logo for warm days',
                'Carried all season', 'Built to be carried']),
    dict(design='C', theme='Eco and sustainable',
         name='Wood, Bamboo and Natural', angle='Natural materials, real branding',
         subject='Natural materials, branded',
         headline='Wood and bamboo, branded clean.',
         subline='Natural wood and bamboo pieces, branded with your logo.',
         items=['GG1428', 'GG1506', 'GG1571', 'GG1434', 'GG1577', 'GG1603'],
         descs=['Warm wood, your logo', 'Bamboo pen, clean mark',
                'Wooden pencil and ruler', 'Natural learning set',
                'Art set in a branded box', 'Coloured pencils, kraft box']),
]


# ---- shared HTML blocks ---------------------------------------------------
def cta_block_html(cta):
    """Green WhatsApp CTA showing the website (white), plus a small phone/email
    button. One WhatsApp CTA. No price."""
    return (
        '<tr><td align="center" style="padding:16px 24px 4px 24px;">'
        '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>'
        '<td bgcolor="%(green)s" align="center" style="border-radius:%(radius)s;">'
        '<a href="%(cta)s" target="_blank" style="display:block;padding:15px 24px;'
        'font:bold 16px %(font)s;color:%(white)s;text-decoration:none;border-radius:%(radius)s;">'
        '<span style="color:%(white)s;">Order on WhatsApp &nbsp;&bull;&nbsp; %(site)s</span></a>'
        '</td></tr></table></td></tr>'
        '<tr><td align="center" style="padding:8px 24px 4px 24px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>'
        '<td align="center" style="border:1px solid %(border)s;border-radius:%(radius)s;">'
        '<a href="mailto:%(email)s" style="display:block;padding:9px 16px;'
        'font:bold 12px %(font)s;color:%(body)s;text-decoration:none;">'
        '%(phone)s &nbsp;&bull;&nbsp; %(email)s</a>'
        '</td></tr></table></td></tr>'
    ) % dict(green=C["green"], white=C["white"], border=C["border"], body=C["body"],
             font=FONT, radius=RADIUS, cta=cta, site=WEBSITE,
             phone=CONTACT_PHONE, email=CONTACT_EMAIL)


def banner_block_html():
    return (
        '<tr><td bgcolor="%(green)s" align="center" style="padding:13px 24px;">'
        '<div style="font:bold 14px %(font)s;color:%(white)s;letter-spacing:.02em;">'
        '%(email)s &nbsp;&nbsp;|&nbsp;&nbsp; %(phone)s</div></td></tr>'
    ) % dict(green=C["green"], white=C["white"], font=FONT,
             email=CONTACT_EMAIL, phone=CONTACT_PHONE)


def footer_block_html():
    return (
        '<tr><td style="padding:14px 24px 18px 24px;border-top:1px solid %(border)s;">'
        '<div style="font:11px %(font)s;color:%(fine)s;line-height:1.7;">'
        'To order, contact <a href="mailto:%(email)s" style="color:%(muted)s;text-decoration:underline;">%(email)s</a> '
        'or WhatsApp %(phone)s.<br>'
        'Free digital mock-up before you commit.<br>'
        '<a href="mailto:%(email)s?subject=Unsubscribe" style="color:%(fine)s;text-decoration:underline;">Unsubscribe</a>'
        '</div></td></tr>'
    ) % dict(border=C["border"], font=FONT, fine=C["fine"], muted=C["muted"],
             email=CONTACT_EMAIL, phone=CONTACT_PHONE)


def head_open(subject, preheader):
    return ("""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>%(subject)s</title></head>
<body style="margin:0;padding:0;background:%(page)s;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:%(page)s;">%(pre)s&#8203;&zwnj;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%(page)s;"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;">
<tr><td style="padding:20px 24px 12px 24px;border-bottom:2px solid %(green)s;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" align="left"><img src="%(logo)s" width="150" alt="Gifts Gulf" style="display:block;width:150px;height:auto;border:0;"></td>
<td valign="middle" align="right" style="font:bold 11px %(font)s;color:%(muted)s;letter-spacing:.08em;text-transform:uppercase;">%(theme)s</td>
</tr></table></td></tr>
<tr><td style="padding:18px 24px 0 24px;"><div style="font:bold 12px %(font)s;color:%(green)s;letter-spacing:.06em;text-transform:uppercase;">%(kicker)s</div></td></tr>
<tr><td style="padding:8px 24px 0 24px;"><div style="font:bold 28px %(font)s;color:%(heading)s;line-height:1.2;letter-spacing:-.01em;">%(headline)s</div></td></tr>
<tr><td style="padding:8px 24px 0 24px;"><div style="font:14px %(font)s;color:%(body)s;line-height:1.45;">%(subline)s</div></td></tr>""")


def email_close():
    return "</table></td></tr></table></body></html>"


# ---- Design A: editorial grid --------------------------------------------
def render_A(s, products, cta, campaign_name, subject):
    pre = "%s. Branded to your spec, free mock-up before you commit." % s["subject"]
    parts = [head_open(subject, pre) % dict(
        subject=html.escape(subject), pre=html.escape(pre), page=C["page"],
        white=C["white"], border=C["border"], green=C["green"], radius=RADIUS,
        logo=logo_src(), font=FONT, muted=C["muted"], theme=html.escape(s["theme"]),
        kicker=html.escape(campaign_name), heading=C["heading"],
        headline=html.escape(s["headline"]), body=C["body"],
        subline=html.escape(s["subline"]))]
    parts.append(
        '<tr><td style="padding:12px 24px 0 24px;"><span style="display:inline-block;'
        'background:%s;color:%s;font:bold 11px %s;letter-spacing:.03em;padding:5px 11px;'
        'border-radius:%s;">Branded to your spec</span></td></tr>' % (
            C["amber"], C["heading"], FONT, RADIUS))
    rows = []
    for i in range(0, len(products), 2):
        cells = []
        for p in products[i:i + 2]:
            cells.append(
                '<td width="50%%" valign="top" style="padding:6px;">'
                '<a href="%s" target="_blank" style="text-decoration:none;color:%s;display:block;'
                'background:%s;border:1px solid %s;border-radius:%s;padding:14px;">'
                '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>'
                '<td style="background:%s;border-radius:%s;padding:0;">'
                '<img src="%s" width="100%%" alt="%s" style="display:block;width:100%%;height:auto;border:0;border-radius:%s;">'
                '</td></tr></table>'
                '<div style="font:11px %s;color:%s;letter-spacing:.04em;margin-top:10px;">%s</div>'
                '<div style="font:bold 16px %s;color:%s;margin:2px 0;">%s</div>'
                '<div style="font:13px %s;color:%s;">%s</div>'
                '</a></td>' % (
                    product_url(p["sku"]), C["heading"], C["white"], C["border"], RADIUS,
                    C["tile"], RADIUS, img_src(p["code"]), html.escape(p["name"]), RADIUS,
                    FONT, C["fine"], p["sku"], FONT, C["heading"], html.escape(p["name"]),
                    FONT, C["muted"], html.escape(p["desc"])))
        if len(cells) == 1:
            cells.append('<td width="50%" style="padding:6px;">&nbsp;</td>')
        rows.append("<tr>%s</tr>" % "".join(cells))
    parts.append('<tr><td style="padding:12px 18px 4px 18px;">'
                 '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0">%s</table></td></tr>'
                 % "".join(rows))
    parts.append(cta_block_html(cta))
    parts.append(banner_block_html())
    parts.append(footer_block_html())
    parts.append(email_close())
    return "".join(parts)


# ---- Design B: hero spotlight --------------------------------------------
def render_B(s, products, cta, campaign_name, subject):
    pre = "%s. One star product, the rest of the set in support." % s["subject"]
    hero, rest = products[0], products[1:4]
    parts = [head_open(subject, pre) % dict(
        subject=html.escape(subject), pre=html.escape(pre), page=C["page"],
        white=C["white"], border=C["border"], green=C["green"], radius=RADIUS,
        logo=logo_src(), font=FONT, muted=C["muted"], theme=html.escape(s["theme"]),
        kicker=html.escape(campaign_name), heading=C["heading"],
        headline=html.escape(s["headline"]), body=C["body"],
        subline=html.escape(s["subline"]))]
    parts.append(
        '<tr><td style="padding:14px 24px 0 24px;">'
        '<a href="%s" target="_blank" style="display:block;text-decoration:none;">'
        '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>'
        '<td style="background:%s;border:1px solid %s;border-radius:%s;padding:0;">'
        '<img src="%s" width="100%%" alt="%s" style="display:block;width:100%%;height:auto;border:0;border-radius:%s;">'
        '</td></tr></table>'
        '<div style="font:11px %s;color:%s;letter-spacing:.04em;margin-top:10px;">%s</div>'
        '<div style="font:bold 18px %s;color:%s;margin:2px 0;">%s</div>'
        '<div style="font:13px %s;color:%s;">%s</div></a></td></tr>' % (
            product_url(hero["sku"]), C["tile"], C["border"], RADIUS,
            img_src(hero["code"]), html.escape(hero["name"]), RADIUS,
            FONT, C["fine"], hero["sku"], FONT, C["heading"], html.escape(hero["name"]),
            FONT, C["muted"], html.escape(hero["desc"])))
    cells = []
    for p in rest:
        cells.append(
            '<td width="33%%" valign="top" style="padding:6px;">'
            '<a href="%s" target="_blank" style="text-decoration:none;color:%s;display:block;'
            'background:%s;border:1px solid %s;border-radius:%s;padding:10px;">'
            '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>'
            '<td style="background:%s;border-radius:%s;padding:0;">'
            '<img src="%s" width="100%%" alt="%s" style="display:block;width:100%%;height:auto;border:0;border-radius:%s;">'
            '</td></tr></table>'
            '<div style="font:bold 13px %s;color:%s;margin:8px 0 1px;">%s</div>'
            '<div style="font:10px %s;color:%s;letter-spacing:.04em;">%s</div>'
            '</a></td>' % (
                product_url(p["sku"]), C["heading"], C["white"], C["border"], RADIUS,
                C["tile"], RADIUS, img_src(p["code"]), html.escape(p["name"]), RADIUS,
                FONT, C["heading"], html.escape(p["name"]), FONT, C["fine"], p["sku"]))
    parts.append('<tr><td style="padding:12px 18px 4px 18px;">'
                 '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>%s</tr></table></td></tr>'
                 % "".join(cells))
    parts.append(cta_block_html(cta))
    parts.append(banner_block_html())
    parts.append(footer_block_html())
    parts.append(email_close())
    return "".join(parts)


# ---- Design C: lookbook stack --------------------------------------------
def render_C(s, products, cta, campaign_name, subject):
    pre = "%s. A lookbook stack, one product per row." % s["subject"]
    parts = [head_open(subject, pre) % dict(
        subject=html.escape(subject), pre=html.escape(pre), page=C["page"],
        white=C["white"], border=C["border"], green=C["green"], radius=RADIUS,
        logo=logo_src(), font=FONT, muted=C["muted"], theme=html.escape(s["theme"]),
        kicker=html.escape(campaign_name), heading=C["heading"],
        headline=html.escape(s["headline"]), body=C["body"],
        subline=html.escape(s["subline"]))]
    rows = []
    for i, p in enumerate(products):
        img_cell = (
            '<td width="45%%" valign="top" style="padding:6px;">'
            '<a href="%s" target="_blank" style="display:block;background:%s;border:1px solid %s;'
            'border-radius:%s;padding:0;"><img src="%s" width="100%%" alt="%s" '
            'style="display:block;width:100%%;height:auto;border:0;border-radius:%s;"></a></td>' % (
                product_url(p["sku"]), C["tile"], C["border"], RADIUS,
                img_src(p["code"]), html.escape(p["name"]), RADIUS))
        txt_cell = (
            '<td width="55%%" valign="middle" style="padding:6px 12px;">'
            '<a href="%s" target="_blank" style="text-decoration:none;color:%s;display:block;">'
            '<div style="font:11px %s;color:%s;letter-spacing:.04em;">%s</div>'
            '<div style="font:bold 18px %s;color:%s;margin:2px 0 4px;">%s</div>'
            '<div style="font:13px %s;color:%s;line-height:1.45;">%s</div></a></td>' % (
                product_url(p["sku"]), C["heading"], FONT, C["fine"], p["sku"],
                FONT, C["heading"], html.escape(p["name"]), FONT, C["muted"],
                html.escape(p["desc"])))
        cells = (img_cell + txt_cell) if i % 2 == 0 else (txt_cell + img_cell)
        divider = ("border-top:1px solid %s;" % C["border"]) if i else ""
        rows.append('<tr><td style="padding:10px 18px;%s">'
                    '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0">'
                    '<tr>%s</tr></table></td></tr>' % (divider, cells))
    parts.append("".join(rows))
    parts.append(cta_block_html(cta))
    parts.append(banner_block_html())
    parts.append(footer_block_html())
    parts.append(email_close())
    return "".join(parts)


# ---- AMP (one template, classes; visually matched per design) -------------
AMP_CSS = """
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
.trio{padding:12px 18px 4px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
.tile{background:%(white)s;border:1px solid %(border)s;border-radius:%(radius)s;padding:14px;}
.tile a,.row a,.hero a{text-decoration:none;color:%(heading)s;display:block;}
.imgcell{background:%(tile)s;border-radius:%(radius)s;overflow:hidden;}
.sku{font-size:11px;color:%(fine)s;letter-spacing:.04em;margin-top:10px;}
.name{font-size:16px;font-weight:bold;color:%(heading)s;margin:2px 0;}
.sname{font-size:13px;font-weight:bold;color:%(heading)s;margin:8px 0 1px;}
.desc{font-size:13px;color:%(muted)s;}
.hero{padding:14px 24px 0;}
.row{padding:10px 18px;border-top:1px solid %(border)s;}
.rowgrid{display:grid;grid-template-columns:45%% 55%%;gap:10px;align-items:center;}
.ctawrap{padding:16px 24px 4px;}
a.cta,a.cta:visited{display:block;text-align:center;padding:15px 24px;font-size:16px;font-weight:bold;color:%(white)s;background:%(green)s;border-radius:%(radius)s;text-decoration:none;}
.cta2wrap{padding:8px 24px 4px;text-align:center;}
a.cta2{display:inline-block;padding:9px 16px;font-size:12px;font-weight:bold;color:%(body)s;border:1px solid %(border)s;border-radius:%(radius)s;text-decoration:none;}
.banner{background:%(green)s;text-align:center;padding:13px 24px;font-size:14px;font-weight:bold;color:%(white)s;}
.foot{padding:14px 24px 18px;border-top:1px solid %(border)s;font-size:11px;color:%(fine)s;line-height:1.7;}
.foot a{color:%(muted)s;}
"""


def amp_shell(s, body_html, cta, campaign_name, subject):
    css = AMP_CSS % dict(
        page=C["page"], white=C["white"], border=C["border"], green=C["green"],
        amber=C["amber"], heading=C["heading"], body=C["body"], muted=C["muted"],
        fine=C["fine"], tile=C["tile"], font=FONT, radius=RADIUS)
    cta_html = (
        '<div class="ctawrap"><a class="cta" href="%s" target="_blank">'
        'Order on WhatsApp &bull; %s</a></div>'
        '<div class="cta2wrap"><a class="cta2" href="mailto:%s">%s &bull; %s</a></div>'
        '<div class="banner">%s &nbsp;|&nbsp; %s</div>' % (
            cta, WEBSITE, CONTACT_EMAIL, CONTACT_PHONE, CONTACT_EMAIL,
            CONTACT_EMAIL, CONTACT_PHONE))
    foot = ('<div class="foot">To order, contact <a href="mailto:%s">%s</a> or WhatsApp %s.<br>'
            'Free digital mock-up before you commit.<br>'
            '<a href="mailto:%s?subject=Unsubscribe">Unsubscribe</a></div>' % (
                CONTACT_EMAIL, CONTACT_EMAIL, CONTACT_PHONE, CONTACT_EMAIL))
    return """<!doctype html>
<html amp4email><head><meta charset="utf-8">
<script async src="https://cdn.ampproject.org/v0.js"></script>
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>%(css)s</style></head>
<body><div class="wrap">
<div class="head"><amp-img src="%(logo)s" width="150" height="45" alt="Gifts Gulf"></amp-img><span class="theme">%(theme)s</span></div>
<div class="kicker">%(kicker)s</div>
<div class="headline">%(headline)s</div>
<div class="subline">%(subline)s</div>
%(body)s
%(cta)s
%(foot)s
</div></body></html>""" % dict(
        css=css, logo=logo_src(), theme=html.escape(s["theme"]),
        kicker=html.escape(campaign_name), headline=html.escape(s["headline"]),
        subline=html.escape(s["subline"]), body=body_html, cta=cta_html, foot=foot)


def amp_tile(p):
    return ('<div class="tile"><a href="%s" target="_blank">'
            '<div class="imgcell"><amp-img src="%s" width="640" height="640" layout="responsive" alt="%s"></amp-img></div>'
            '<div class="sku">%s</div><div class="name">%s</div><div class="desc">%s</div></a></div>' % (
                product_url(p["sku"]), img_src(p["code"]), html.escape(p["name"]),
                p["sku"], html.escape(p["name"]), html.escape(p["desc"])))


def render_amp(s, products, cta, campaign_name, subject):
    d = s["design"]
    if d == "A":
        body = ('<div class="pillwrap"><span class="pill">Branded to your spec</span></div>'
                '<div class="grid">%s</div>' % "".join(amp_tile(p) for p in products))
    elif d == "B":
        hero, rest = products[0], products[1:4]
        body = ('<div class="hero"><a href="%s" target="_blank">'
                '<div class="imgcell"><amp-img src="%s" width="640" height="640" layout="responsive" alt="%s"></amp-img></div>'
                '<div class="sku">%s</div><div class="name">%s</div><div class="desc">%s</div></a></div>'
                '<div class="trio">%s</div>' % (
                    product_url(hero["sku"]), img_src(hero["code"]), html.escape(hero["name"]),
                    hero["sku"], html.escape(hero["name"]), html.escape(hero["desc"]),
                    "".join('<div class="tile"><a href="%s" target="_blank">'
                            '<div class="imgcell"><amp-img src="%s" width="640" height="640" layout="responsive" alt="%s"></amp-img></div>'
                            '<div class="sname">%s</div><div class="sku">%s</div></a></div>' % (
                                product_url(p["sku"]), img_src(p["code"]), html.escape(p["name"]),
                                html.escape(p["name"]), p["sku"]) for p in rest)))
    else:
        rows = []
        for p in products:
            rows.append('<div class="row"><div class="rowgrid">'
                        '<a href="%s" target="_blank"><div class="imgcell"><amp-img src="%s" width="640" height="640" layout="responsive" alt="%s"></amp-img></div></a>'
                        '<a href="%s" target="_blank"><div class="sku">%s</div><div class="name">%s</div><div class="desc">%s</div></a>'
                        '</div></div>' % (
                            product_url(p["sku"]), img_src(p["code"]), html.escape(p["name"]),
                            product_url(p["sku"]), p["sku"], html.escape(p["name"]),
                            html.escape(p["desc"])))
        body = "".join(rows)
    return amp_shell(s, body, cta, campaign_name, subject)


# ---- whatsapp.txt / linkedin.txt -----------------------------------------
def render_whatsapp(s, products, n):
    style = (n - 1) % 3  # 0 pitch, 1 question, 2 teaser
    if style == 0:
        lead = ["%s Branded to your logo, free mock-up first." % s["headline"]]
    elif style == 1:
        lead = ["Looking for %s your team will keep?" % s["theme"].lower()]
    else:
        lead = ["%s, branded and ready." % s["theme"]]
    links = [product_url(p["sku"]) for p in products]
    return "\n".join(lead + links) + "\n"


def render_linkedin(s, products, n, cta):
    names = ", ".join(p["name"] for p in products[:3])
    tone = (n - 1) % 3
    if tone == 0:
        opener = "We built the %s mix for teams that want their logo carried, not filed away." % s["theme"].lower()
    elif tone == 1:
        opener = "Planning %s for staff or an event? Here is a mix worth a look." % s["theme"].lower()
    else:
        opener = "A quick one for anyone sorting %s this season." % s["theme"].lower()
    return (
        "%s Think %s and more, every piece branded with your logo. "
        "You approve a free digital mock-up before you pay anything. "
        "Want it sized to your headcount? Message us on WhatsApp (%s) or %s.\n"
    ) % (opener, names, cta, CONTACT_EMAIL)


# ---- selection ------------------------------------------------------------
def pick_products(pool, used_now, need=5, cap=6):
    chosen = []
    for p in pool:
        if len(chosen) >= cap:
            break
        if p["sku"] in used_now:
            continue
        if not verify_image(p["code"]):
            continue
        used_now.add(p["sku"])
        chosen.append(p)
    return chosen


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.utcnow().strftime("%Y-%m-%d")
    d = datetime.strptime(date, "%Y-%m-%d")
    date_disp, ymd = d.strftime("%d %b %Y"), d.strftime("%Y%m%d")
    seed = int(ymd)

    catalogue = json.load(open(os.path.join(STATE, "catalogue.json")))
    cat_by_sku = {p["sku"]: p for p in catalogue}
    day_dir = os.path.join(ROOT, date)
    os.makedirs(day_dir, exist_ok=True)

    def load(name, default):
        path = os.path.join(STATE, name)
        return json.load(open(path)) if os.path.exists(path) else default

    history = load("history.json", [])
    used_subjects = set(load("used-subjects.json", []))
    used_skus_log = load("used-skus.json", [])
    recent = set()
    for e in used_skus_log:
        try:
            age = (d - datetime.strptime(e["date"], "%Y-%m-%d")).days
        except Exception:
            age = 99
        if 0 <= age < 14:
            recent.update(e.get("skus", []))

    fresh = [p for p in catalogue if p["sku"] not in recent]
    used_now = set()

    manifest = {"date": date, "season": SEASON,
                "generated_utc": datetime.utcnow().isoformat() + "Z", "sets": []}
    cards = {"date": date, "sets": []}
    day_skus, problems = [], []
    seen_names = set()

    for n, s in enumerate(SETS, start=1):
        code = "GG-%s-%d" % (ymd, n)
        campaign_name = "%s - %s" % (s["name"], date_disp)
        if campaign_name in seen_names:
            problems.append("campaign_name not unique: %s" % campaign_name)
        seen_names.add(campaign_name)
        subject = s["subject"]
        if subject in used_subjects:
            problems.append("subject reused: %r (%s)" % (subject, code))

        # curated SKU list for this theme; verify image, flag stale/recent
        products = []
        for sku in s["items"]:
            cp = cat_by_sku.get(sku)
            if not cp:
                problems.append("sku not in catalogue: %s (%s)" % (sku, code)); continue
            if sku in recent:
                problems.append("sku reused within 14d: %s (%s)" % (sku, code))
            if sku in used_now:
                problems.append("sku duplicated across sets: %s (%s)" % (sku, code)); continue
            if not verify_image(cp["code"]):
                problems.append("image failed verify: %s/%s (%s)" % (sku, cp["code"], code)); continue
            used_now.add(sku)
            products.append(cp)
        if len(products) < 4:
            problems.append("set under 4 verified products: %s (%d)" % (code, len(products)))

        # attach descriptor + clean name
        prods = []
        for idx, p in enumerate(products):
            prods.append(dict(sku=p["sku"], name=p["name"].title(), code=p["code"],
                              desc=s["descs"][idx % len(s["descs"])]))

        cta = wa_url("Hi Gifts Gulf, please share branded %s options for our team."
                     % s["theme"].lower())
        renderer = {"A": render_A, "B": render_B, "C": render_C}[s["design"]]
        set_dir = os.path.join(day_dir, "set-%d" % n)
        os.makedirs(os.path.join(set_dir, "img"), exist_ok=True)
        open(os.path.join(set_dir, "email.html"), "w").write(
            renderer(s, prods, cta, campaign_name, subject))
        open(os.path.join(set_dir, "email.amp.html"), "w").write(
            render_amp(s, prods, cta, campaign_name, subject))
        open(os.path.join(set_dir, "whatsapp.txt"), "w").write(
            render_whatsapp(s, prods, n))
        open(os.path.join(set_dir, "linkedin.txt"), "w").write(
            render_linkedin(s, prods, n, cta))

        skus = [p["sku"] for p in prods]
        promo_image = ("https://raw.githubusercontent.com/aribanigar/Leadloftexporter/"
                       "main/content/gifts-gulf/%s/set-%d/img/whatsapp.jpg" % (date, n))
        meta = dict(
            date=date, theme=s["theme"], season=SEASON, design=s["design"],
            campaign_code=code, campaign_name=campaign_name, subject=subject,
            skus=skus,
            products=[dict(name=p["name"], sku=p["sku"],
                           image=img_src(p["code"], escaped=False),
                           product_url=product_url(p["sku"])) for p in prods],
            promo_image=promo_image, image=promo_image, cta_url=cta)
        json.dump(meta, open(os.path.join(set_dir, "meta.json"), "w"), indent=2)

        variant = {"A": 1, "B": 2, "C": 3}[s["design"]]
        ncard = 2 if variant == 1 else 3
        promo_line = s["descs"][0]
        cards["sets"].append(dict(
            set=n, variant=variant, promo=promo_line,
            out="content/gifts-gulf/%s/set-%d/img/whatsapp.jpg" % (date, n),
            products=[dict(code=p["code"], sku=p["sku"], name=p["name"])
                      for p in prods[:ncard]]))

        manifest["sets"].append(dict(
            set=n, design=s["design"], theme=s["theme"], angle=s["angle"],
            campaign_code=code, campaign_name=campaign_name, subject=subject, skus=skus))
        history.append(dict(date=date, set=n, design=s["design"],
                            campaign_code=code, campaign_name=campaign_name,
                            subject=subject, theme=s["theme"], skus=skus))
        used_subjects.add(subject)
        day_skus.extend(skus)

    json.dump(manifest, open(os.path.join(day_dir, "manifest.json"), "w"), indent=2)
    json.dump(cards, open(os.path.join(day_dir, "cards.json"), "w"), indent=2)
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
