#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hudace daily content batch generator.

- Downloads one dark cinematic 4:5 photo per service from Pixabay into public/email/.
- Renders a baked promo card (4:5 JPG) per service into public/email/.
- Builds Gmail-safe HTML emails referencing the self-hosted production image URLs.
- Emits WhatsApp / LinkedIn / outreach copy per service.
- Writes batch.json for publish_rest.py.

Voice: SAP.com calm, outcome-first, proof over hype. No emojis, no em dashes, no
exclamation marks. No region or country named anywhere.
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "public", "email")
BUILD = os.path.join(ROOT, "build")
os.makedirs(OUT, exist_ok=True)

RUN_DATE = os.environ.get("RUN_DATE", "").strip() or None  # set by caller
PIXABAY = os.environ.get("PIXABAY_API", "56316516-fbb10ad7475940758256bc517")
BASE = "https://leadloftexporter.vercel.app/email"

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# Brand
BG = "#0A0919"
BG2 = "#08080f"
BG3 = "#05050D"
MUTED = "#9A9AAE"
BLUE = "#1B90FF"
WHITE = "#FFFFFF"

WA_LINK = "https://wa.me/918218929990"
SITE = "https://hudace.com"
IG = "https://www.instagram.com/hudaceofficial/"
LI = "https://www.linkedin.com/company/hudace"

CARD_W, CARD_H = 1080, 1350

# --------------------------------------------------------------------------- #
# Content model
# --------------------------------------------------------------------------- #
INDUSTRIES = ["Agribusiness", "Consumer Products"]  # focus for this run (region-agnostic)

SERVICES = [
    {
        "slug": "social-media",
        "name": "Social Media",
        "big": "Presence",
        "sub": "Social media that compounds into pipeline",
        "query": "cinematic content creator studio dark",
        "deliverables": [
            "6 short-form videos / month",
            "12 feed posts / month",
            "8 stories / month",
            "Captions and hashtag sets",
            "Content calendar and scheduling",
            "Community management (comments and DMs)",
            "Monthly performance report",
        ],
        "scope": "For a consumer products brand, this becomes an always-on feed that keeps the product in front of buyers between purchase cycles.",
        "proof": "In consumer brand work, a steady posting cadence tied to a clear content calendar moved passive followers into repeat buyers.",
        "future": "As the audience grows, the same engine extends into paid amplification and creator collaborations without rebuilding the plan.",
        "hooks": [
            ("Cadence beats bursts", "Six videos and twelve posts a month keep you present when the buyer is ready, not only when you remember to post."),
            ("Owned community, not rented reach", "Managing comments and DMs turns attention into conversation, and conversation into pipeline."),
            ("Decisions from the report", "A monthly performance report tells you what to make more of, so every month compounds on the last."),
        ],
    },
    {
        "slug": "seo-aeo-geo-srx",
        "name": "SEO / AEO / GEO / SRX",
        "big": "Discovery",
        "sub": "Be the answer, in search and in AI",
        "query": "dark data analytics screen network abstract",
        "deliverables": [
            "Technical SEO audit and fixes",
            "Keyword and intent research",
            "On-page optimization (titles, meta, headings, schema)",
            "Content briefs and optimization",
            "Authority and backlink building",
            "Local SEO (profile, citations, maps)",
            "AEO: answer-engine optimization (FAQ, structured answers)",
            "GEO: visibility inside AI-generated answers",
            "SRX: search experience and Core Web Vitals",
            "Monthly ranking and traffic report",
        ],
        "scope": "For an agribusiness supplier, this puts you in front of buyers researching sourcing, specifications, and suppliers at the moment of intent.",
        "proof": "In sourcing-led sectors, structured answers and technical fixes lifted qualified organic traffic that converts, not vanity impressions.",
        "future": "As answer engines take more of the query, the same structured content keeps you cited inside AI responses, not just blue links.",
        "hooks": [
            ("Found by intent, not luck", "Keyword and intent research aims every page at a buyer who is already looking for what you sell."),
            ("Ready for the AI answer", "AEO and GEO structure your content so it is quoted inside AI answers, where more decisions now start."),
            ("Speed is ranking", "SRX and Core Web Vitals work removes the friction that quietly costs you rankings and conversions."),
        ],
    },
    {
        "slug": "website-design",
        "name": "Website Design",
        "big": "Conversion",
        "sub": "A website built to turn visits into revenue",
        "query": "dark modern web design workspace laptop cinematic",
        "deliverables": [
            "Custom multi-page website",
            "Mobile-first responsive build",
            "Booking, lead, and contact forms",
            "CMS to edit content yourself",
            "SEO-ready structure and speed",
            "Analytics and WhatsApp integration",
            "Hosting and domain setup",
            "Launch and handover",
        ],
        "scope": "For a consumer products brand, the site becomes the always-open storefront that captures demand your marketing creates.",
        "proof": "In brand-led sectors, a faster mobile-first build with clear forms turned more of the same traffic into booked leads.",
        "future": "The CMS and structure are built to grow into catalog, storefront, and portal features as the business expands.",
        "hooks": [
            ("Built for the phone first", "A mobile-first responsive build meets buyers where they already are, so intent is not lost on a slow page."),
            ("Every visit has a next step", "Booking, lead, and contact forms plus WhatsApp integration give every visitor a direct path to talk to you."),
            ("You own the content", "A CMS and clean handover mean you update the site yourself, without waiting on an agency for every change."),
        ],
    },
    {
        "slug": "ai-work-studio",
        "name": "AI Work Studio",
        "big": "Cinematic",
        "sub": "Films and ads, delivered without a crew",
        "query": "cinematic film production dark moody lighting",
        "deliverables": [
            "60-second cinematic film",
            "Three 15-second social cuts",
            "Ten AI-generated stills",
            "Script and concept included",
            "Delivered in seven working days, no film crew",
        ],
        "scope": "For a consumer products brand, this is a full launch set of film and stills produced without the cost and calendar of a shoot.",
        "proof": "In product-launch work, cinematic film plus short cuts gave brands premium creative in days rather than the usual production cycle.",
        "future": "The concept becomes a reusable creative system, so future campaigns extend the same look without starting from zero.",
        "hooks": [
            ("Premium, without the shoot", "A 60-second cinematic film and stills arrive without a crew, location, or the calendar a traditional production demands."),
            ("One shoot, every channel", "Three 15-second cuts give you feed, story, and ad formats from a single concept, ready to run everywhere."),
            ("Seven days, not seven weeks", "Delivery in seven working days means your launch moves at the speed of the market, not the production schedule."),
        ],
    },
    {
        "slug": "erp-building",
        "name": "ERP Building",
        "big": "Operations",
        "sub": "Custom software that runs your business",
        "query": "dark software code developer server abstract cinematic",
        "deliverables": [
            "Discovery and module blueprint",
            "Custom modules (CRM, inventory, billing, HR, and more)",
            "Role-based access and dashboards",
            "Workflow automations",
            "Integrations (payments, messaging, APIs)",
            "Web and mobile access",
            "Training and documentation",
            "Ongoing support and iterations",
        ],
        "scope": "For an agribusiness operation, this connects procurement, inventory, and billing into one system instead of scattered spreadsheets.",
        "proof": "In operations-heavy sectors, moving from spreadsheets to role-based modules removed manual reconciliation and the errors that came with it.",
        "future": "The blueprint is modular, so new lines and locations are added as modules rather than rebuilds.",
        "hooks": [
            ("Built around your workflow", "Discovery and a module blueprint mean the software fits how you already work, not the other way around."),
            ("One source of truth", "CRM, inventory, and billing in role-based dashboards end the reconciliation between disconnected tools."),
            ("Automations that compound", "Workflow automations and integrations remove repeat manual work, and that time saved compounds every week."),
        ],
    },
    {
        "slug": "performance-marketing",
        "name": "Performance Marketing",
        "big": "Growth",
        "sub": "Paid media measured to revenue, not clicks",
        "query": "dark city night advertising lights cinematic",
        "deliverables": [
            "Paid search and paid social campaigns",
            "Audience and keyword targeting",
            "Ad creative (static and video)",
            "Landing pages built to convert",
            "Conversion tracking and attribution setup",
            "A/B testing and budget optimization",
            "Retargeting and lookalike audiences",
            "Monthly spend and revenue report",
        ],
        "scope": "For a consumer products brand, paid media becomes a controllable demand tap tied to cost per acquisition, not to impressions.",
        "proof": "In brand-led sectors, attribution and disciplined testing shifted budget toward the audiences that actually returned revenue.",
        "future": "As the account matures, retargeting and lookalike audiences lower acquisition cost while volume scales.",
        "hooks": [
            ("Measured to revenue", "Conversion tracking and attribution report on spend against revenue, so budget follows what actually returns."),
            ("Creative is the lever", "Static and video ad creative paired with A/B testing find the message that converts before you scale spend behind it."),
            ("Compounding audiences", "Retargeting and lookalike audiences reuse every visit, lowering acquisition cost as the account matures."),
        ],
    },
    {
        "slug": "schoolos",
        "name": "SchoolOS (School ERP)",
        "big": "SchoolOS",
        "sub": "One connected system for the whole school",
        "query": "dark modern school classroom architecture cinematic",
        "deliverables": [
            "Admissions: online enquiry to enrollment",
            "Student records: profiles, documents, history",
            "Attendance: daily and period, parent alerts",
            "Fees: invoices, online payments, reminders, receipts",
            "Examinations: marks, grading, report cards",
            "Timetable: classes, teachers, substitutions",
            "Communication: announcements and parent app",
            "Transport: routes, vehicles, live tracking",
            "Library: catalog, issue and return",
            "HR and payroll: staff and salaries",
            "Reports: management dashboards",
        ],
        "scope": "For a school, admissions, academics, attendance, fees, and communication run on one connected system instead of separate tools.",
        "proof": "In education work, moving fees and attendance onto one system cut the routine administration that pulls staff away from teaching.",
        "future": "The platform grows with the institution, adding transport, library, and payroll as needs expand, all in one place.",
        "hooks": [
            ("One system, not ten", "Admissions, records, fees, and exams on a single platform end the double entry between disconnected tools."),
            ("Parents stay informed", "Attendance alerts, announcements, and the parent app keep families updated without adding work for staff."),
            ("Time back for teaching", "Automating fees, receipts, and reports returns hours that routine administration used to consume."),
        ],
    },
]


# --------------------------------------------------------------------------- #
# Pixabay -> 4:5 cover crop
# --------------------------------------------------------------------------- #
def _http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "hudace-routine/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cover_crop(img, w, h):
    img = img.convert("RGB")
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


def fetch_photo(query, dest):
    """Download a dark cinematic photo, crop to 4:5, save to dest. Returns True/False.
    Reuses an existing non-trivial file to avoid re-spending Pixabay egress on re-runs."""
    if os.path.exists(dest) and os.path.getsize(dest) > 40000:
        print("  reuse", os.path.basename(dest))
        return True
    api = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=all"
           "&safesearch=true&per_page=30&order=popular"
           % (PIXABAY, urllib.parse.quote(query)))
    try:
        data = json.loads(_http_get(api, timeout=40).decode())
    except Exception as e:
        print("  pixabay query failed:", e)
        return False
    hits = data.get("hits", [])
    if not hits:
        print("  no hits for", query)
        return False
    # Prefer darker images: Pixabay does not expose luminance, so try each hit and
    # keep the first that downloads and is on the darker side; fall back to first.
    best = None
    for h in hits[:12]:
        src = h.get("largeImageURL") or h.get("fullHDURL") or h.get("webformatURL")
        if not src:
            continue
        try:
            raw = _http_get(src, timeout=60)
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception:
            continue
        # mean luminance of a downscaled copy
        small = im.convert("L").resize((32, 32))
        lum = sum(small.getdata()) / (32 * 32)
        cand = (lum, im)
        if best is None or lum < best[0]:
            best = cand
        if lum < 90:  # dark enough, take it
            best = cand
            break
    if best is None:
        return False
    crop = cover_crop(best[1], CARD_W, CARD_H)
    crop.save(dest, "JPEG", quality=88)
    return True


# --------------------------------------------------------------------------- #
# Baked promo card (4:5 JPG)
# --------------------------------------------------------------------------- #
def _font(path, size):
    return ImageFont.truetype(path, size)


def _wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def darken(photo):
    base = photo.convert("RGB").copy()
    ov = Image.new("RGB", base.size, (0, 0, 0))
    # vertical gradient: lighter at top, heavier at bottom for text legibility
    grad = Image.new("L", (1, base.size[1]))
    for y in range(base.size[1]):
        a = int(90 + (y / base.size[1]) * 150)  # 90 -> 240
        grad.putpixel((0, y), a)
    grad = grad.resize(base.size)
    base = Image.composite(ov, base, grad)
    return base


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def build_card(svc, photo_path, dest):
    photo = Image.open(photo_path)
    img = darken(photo).convert("RGBA")
    d = ImageDraw.Draw(img)
    blue = hex2rgb(BLUE)
    muted = hex2rgb(MUTED)
    M = 84  # margin

    # logo wordmark top-left
    wm = Image.open(os.path.join(OUT, "logo-wordmark.png"))
    wm_w = 300
    wm = wm.resize((wm_w, int(wm.height * wm_w / wm.width)), Image.LANCZOS)
    img.alpha_composite(wm, (M, 70))

    # eyebrow
    f_eye = _font(BOLD, 30)
    d.text((M, 190), svc["name"].upper(), font=f_eye, fill=blue)

    # headline
    f_h = _font(BOLD, 120)
    d.text((M, 232), svc["big"], font=f_h, fill=(255, 255, 255))
    # sub
    f_sub = _font(REG, 38)
    sub_lines = _wrap(d, svc["sub"], f_sub, CARD_W - 2 * M)
    y = 232 + 132
    for ln in sub_lines:
        d.text((M, y), ln, font=f_sub, fill=(230, 230, 240))
        y += 50

    # deliverables label
    y += 34
    f_lbl = _font(BOLD, 30)
    d.text((M, y), "DELIVERABLES", font=f_lbl, fill=blue)
    y += 56

    # deliverable bullets (up to 6)
    f_item = _font(BOLD, 37)
    for item in svc["deliverables"][:6]:
        d.ellipse([M, y + 15, M + 14, y + 29], fill=blue)
        lines = _wrap(d, item, f_item, CARD_W - 2 * M - 44)
        for i, ln in enumerate(lines):
            d.text((M + 40, y), ln, font=f_item, fill=(240, 240, 246))
            y += 50
        y += 12

    # CTA pill + contact pinned near bottom
    cta_y = CARD_H - 210
    pill_w, pill_h = 520, 92
    d.rounded_rectangle([M, cta_y, M + pill_w, cta_y + pill_h], radius=46, fill=blue)
    f_cta = _font(BOLD, 40)
    cta_t = "Chat on WhatsApp"
    tw = d.textlength(cta_t, font=f_cta)
    d.text((M + (pill_w - tw) / 2, cta_y + 24), cta_t, font=f_cta, fill=(255, 255, 255))

    f_ct = _font(BOLD, 32)
    d.text((M, cta_y + pill_h + 34), "+91 82189 29990   contact@hudace.com   hudace.com",
           font=f_ct, fill=muted)

    img.convert("RGB").save(dest, "JPEG", quality=90)


# --------------------------------------------------------------------------- #
# Gmail-safe HTML email
# --------------------------------------------------------------------------- #
def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def btn_pair(align="center"):
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="padding:6px;">
            <a href="{WA_LINK}" style="display:block;background:{BLUE};color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:bold;padding:15px 30px;border-radius:8px;text-align:center;">Chat on WhatsApp</a>
          </td>
          <td style="padding:6px;">
            <a href="{SITE}" style="display:block;background:transparent;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:bold;padding:14px 29px;border:1px solid #3a3a52;border-radius:8px;text-align:center;">Visit Our Website</a>
          </td>
        </tr>
      </table>"""


def deliverables_html(items):
    rows = ""
    for it in items:
        rows += f"""
        <tr>
          <td valign="top" width="24" style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;color:{BLUE};font-size:16px;line-height:22px;">&#8226;</td>
          <td valign="top" style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;color:#e9e9f2;font-size:15px;line-height:22px;">{esc(it)}</td>
        </tr>"""
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>'


def hooks_html(hooks):
    out = ""
    for i, (title, body) in enumerate(hooks, 1):
        out += f"""
        <tr>
          <td valign="top" width="42" style="padding:8px 0;font-family:Montserrat,Arial,sans-serif;color:{BLUE};font-size:22px;font-weight:bold;line-height:26px;">{i}</td>
          <td valign="top" style="padding:8px 0;">
            <div style="font-family:Montserrat,Arial,sans-serif;color:#ffffff;font-size:16px;font-weight:bold;line-height:22px;">{esc(title)}</div>
            <div style="font-family:Montserrat,Arial,sans-serif;color:{MUTED};font-size:14px;line-height:21px;padding-top:3px;">{esc(body)}</div>
          </td>
        </tr>"""
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{out}</table>'


def section_label(text):
    return f'<div style="font-family:Montserrat,Arial,sans-serif;color:{BLUE};font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding-bottom:10px;">{esc(text)}</div>'


def build_email(svc):
    hero_img = f"{BASE}/{svc['slug']}-hero.jpg"
    card_img = f"{BASE}/{svc['slug']}-card.jpg"
    title = f"{esc(svc['big'])}"
    sub = esc(svc["sub"])

    html = f"""<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>{esc(svc['name'])} | Hudace</title>
<style>
  :root {{ color-scheme: dark; supported-color-schemes: dark; }}
  body,table,td,a {{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }}
  body {{ margin:0; padding:0; width:100% !important; background:{BG3}; }}
  img {{ border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }}
  a {{ color:{BLUE}; }}
  @media only screen and (max-width:620px) {{
    .container {{ width:100% !important; }}
    .px {{ padding-left:22px !important; padding-right:22px !important; }}
    .stackbtn td {{ display:block !important; width:100% !important; }}
    .stackbtn a {{ width:auto !important; }}
  }}
  @media (prefers-color-scheme: light) {{
    body, .bgmain {{ background:{BG3} !important; }}
    .darkcard {{ background:{BG} !important; }}
  }}
  [data-ogsc] body, [data-ogsc] .bgmain {{ background:{BG3} !important; }}
  [data-ogsc] .darkcard {{ background:{BG} !important; }}
  [data-ogsc] .wtext {{ color:#ffffff !important; }}
</style>
</head>
<body bgcolor="{BG3}" style="margin:0;padding:0;background:{BG3};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Deliverables-first: {sub}. Run smarter, grow faster with Hudace.</div>
<table role="presentation" class="bgmain" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG3}" style="background:{BG3};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

    <!-- Header -->
    <tr><td class="px" bgcolor="{BG}" style="background:{BG};padding:22px 32px;border-radius:14px 14px 0 0;">
      <img src="{BASE}/logo-wordmark.png" width="150" alt="Hudace" style="width:150px;height:auto;"/>
    </td></tr>

    <!-- Hero live-text -->
    <tr><td class="px darkcard" bgcolor="{BG2}" style="background:{BG2};padding:44px 32px 36px 32px;">
      {section_label('Hudace ' + ('School ERP' if svc['slug']=='schoolos' else 'Growth'))}
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;color:#ffffff;font-size:52px;line-height:56px;font-weight:bold;margin:0;">{title}</div>
      <div style="font-family:Montserrat,Arial,sans-serif;color:#d7d7e2;font-size:19px;line-height:27px;padding-top:12px;">{sub}</div>
      <div style="padding-top:26px;">{btn_pair()}</div>
    </td></tr>

    <!-- Hero photo (plain img, never a background) -->
    <tr><td bgcolor="{BG2}" style="background:{BG2};font-size:0;line-height:0;">
      <img src="{hero_img}" width="600" alt="{esc(svc['name'])}" style="width:100%;max-width:600px;height:auto;display:block;"/>
    </td></tr>

    <!-- Deliverables -->
    <tr><td class="px darkcard" bgcolor="{BG}" style="background:{BG};padding:36px 32px 10px 32px;">
      {section_label('What you get')}
      {deliverables_html(svc['deliverables'])}
    </td></tr>

    <!-- Industry scope -->
    <tr><td class="px darkcard" bgcolor="{BG}" style="background:{BG};padding:26px 32px 6px 32px;">
      {section_label('In your industry')}
      <div style="font-family:Montserrat,Arial,sans-serif;color:#e9e9f2;font-size:15px;line-height:23px;">{esc(svc['scope'])}</div>
      <div style="font-family:Montserrat,Arial,sans-serif;color:{MUTED};font-size:14px;line-height:22px;padding-top:12px;">{esc(svc['proof'])}</div>
    </td></tr>

    <!-- Baked share card -->
    <tr><td class="px darkcard" bgcolor="{BG}" style="background:{BG};padding:26px 32px 10px 32px;">
      <img src="{card_img}" width="536" alt="{esc(svc['name'])} deliverables" style="width:100%;max-width:536px;height:auto;border-radius:12px;margin:0 auto;"/>
    </td></tr>

    <!-- Why it works -->
    <tr><td class="px darkcard" bgcolor="{BG}" style="background:{BG};padding:30px 32px 8px 32px;">
      {section_label('Why it works')}
      {hooks_html(svc['hooks'])}
    </td></tr>

    <!-- Closing + CTA -->
    <tr><td class="px darkcard" bgcolor="{BG2}" style="background:{BG2};padding:34px 32px;text-align:center;">
      <div style="font-family:Montserrat,Arial,sans-serif;color:#ffffff;font-size:20px;line-height:28px;font-weight:bold;padding-bottom:6px;">Run smarter. Grow faster.</div>
      <div style="font-family:Montserrat,Arial,sans-serif;color:{MUTED};font-size:14px;line-height:22px;padding-bottom:22px;">{esc(svc['future'])}</div>
      {btn_pair()}
    </td></tr>

    <!-- Footer -->
    <tr><td class="px" bgcolor="{BG3}" style="background:{BG3};padding:26px 32px;border-radius:0 0 14px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">
          <img src="{BASE}/logo-mark.png" width="34" alt="Hudace" style="width:34px;height:34px;border-radius:8px;"/>
        </td>
        <td valign="middle" align="right">
          <a href="{IG}" style="text-decoration:none;"><img src="{BASE}/ig.png" width="26" alt="Instagram" style="width:26px;height:26px;display:inline-block;margin-left:12px;"/></a>
          <a href="{LI}" style="text-decoration:none;"><img src="{BASE}/li.png" width="26" alt="LinkedIn" style="width:26px;height:26px;display:inline-block;margin-left:12px;"/></a>
          <a href="{WA_LINK}" style="text-decoration:none;"><img src="{BASE}/wa.png" width="26" alt="WhatsApp" style="width:26px;height:26px;display:inline-block;margin-left:12px;"/></a>
        </td>
      </tr></table>
      <div style="font-family:Montserrat,Arial,sans-serif;color:{MUTED};font-size:12px;line-height:20px;padding-top:18px;">
        hudace.com &middot; contact@hudace.com &middot; +91 82189 29990
      </div>
      <div style="font-family:Montserrat,Arial,sans-serif;color:#5a5a70;font-size:11px;line-height:18px;padding-top:8px;">
        You are receiving this because you expressed interest in Hudace. <a href="{SITE}" style="color:#6a6a86;">Unsubscribe</a>.
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>"""
    return html


# --------------------------------------------------------------------------- #
# Channel copy
# --------------------------------------------------------------------------- #
def whatsapp_text(svc):
    top = svc["deliverables"][:4]
    lines = "\n".join("- " + t for t in top)
    return (f"{svc['name']} by Hudace\n{svc['sub']}.\n\nWhat you get:\n{lines}\n\n"
            f"Run smarter, grow faster. Message us to start.\n{WA_LINK}")


def linkedin_text(svc):
    hooks = "\n".join(f"- {t}: {b}" for t, b in svc["hooks"])
    return (f"{svc['big']}. {svc['sub']}.\n\n"
            f"{svc['scope']}\n\n"
            f"Why it works:\n{hooks}\n\n"
            f"{svc['proof']}\n\n"
            f"Run smarter. Grow faster.\n"
            f"Talk to Hudace: {WA_LINK} | hudace.com | contact@hudace.com")


def outreach_text(svc, industry):
    top = svc["deliverables"][:5]
    lines = "\n".join("- " + t for t in top)
    return (f"Subject: {svc['name']} for {industry} teams\n\n"
            f"Hello,\n\n"
            f"Most {industry.lower()} teams lose demand somewhere between interest and action. "
            f"Hudace closes that gap with {svc['name'].lower()} built around the outcome, then the method.\n\n"
            f"What you would get:\n{lines}\n\n"
            f"{svc['scope']}\n\n"
            f"Would a short call this week make sense to see if it fits. "
            f"Reply here or reach us at {WA_LINK} or contact@hudace.com.\n\n"
            f"Hudace. Run smarter, grow faster. hudace.com")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    if not RUN_DATE:
        print("RUN_DATE env required", file=sys.stderr)
        sys.exit(2)
    batch = []
    failures = []
    for i, svc in enumerate(SERVICES):
        slug = svc["slug"]
        hero_path = os.path.join(OUT, f"{slug}-hero.jpg")
        card_path = os.path.join(OUT, f"{slug}-card.jpg")
        print(f"[{svc['name']}] photo…")
        ok = fetch_photo(svc["query"], hero_path)
        if not ok:
            failures.append(f"photo:{slug}")
            # fallback: solid brand gradient so the card and email still build
            fb = Image.new("RGB", (CARD_W, CARD_H), hex2rgb(BG))
            fb.save(hero_path, "JPEG", quality=88)
        try:
            build_card(svc, hero_path, card_path)
        except Exception as e:
            failures.append(f"card:{slug}:{e}")
            print("  card failed:", e)
        card_url = f"{BASE}/{slug}-card.jpg"

        # Email
        html = build_email(svc)
        with open(os.path.join(BUILD, f"{slug}.html"), "w", encoding="utf-8") as f:
            f.write(html)
        batch.append({"title": f"[{RUN_DATE}] {svc['name']}", "type": "html_email",
                      "body": html, "image_url": card_url})
        # WhatsApp
        batch.append({"title": f"[{RUN_DATE}] {svc['name']} - WhatsApp", "type": "whatsapp",
                      "body": whatsapp_text(svc), "image_url": card_url})
        # LinkedIn
        batch.append({"title": f"[{RUN_DATE}] {svc['name']} - LinkedIn", "type": "caption",
                      "body": linkedin_text(svc), "image_url": card_url})
        # Outreach
        industry = INDUSTRIES[i % len(INDUSTRIES)]
        batch.append({"title": f"[{RUN_DATE}] {svc['name']} - Outreach", "type": "other",
                      "body": outreach_text(svc, industry), "image_url": card_url})

    with open(os.path.join(ROOT, "batch.json"), "w", encoding="utf-8") as f:
        json.dump(batch, f, ensure_ascii=False, indent=2)
    print(f"\nbatch.json -> {len(batch)} items ({len(SERVICES)} services x 4 channels)")
    if failures:
        print("FAILURES:", failures)


if __name__ == "__main__":
    main()
