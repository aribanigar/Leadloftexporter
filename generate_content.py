#!/usr/bin/env python3
"""Generate Hudace content batch - 2026-07-06 - Industries: Oil Gas and Energy, Utilities.
Six emails (one per marketing service plus a dedicated SchoolOS School ERP email), each with
a WhatsApp message, a LinkedIn caption, and an outreach message sharing one baked 4:5 card.

All photos and baked cards are 4:5 (1080x1350), downloaded into public/email and referenced by
their deployed Vercel URL. Pixabay is the search source only; chosen photos are downloaded and
committed (never hotlinked). Output is region-agnostic. SAP-calm voice: no emojis, no em dashes,
no exclamation marks.
"""
import json, os, textwrap, time
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from PIL import Image, ImageDraw, ImageFont

DATE = "2026-07-06"
BASE_URL = "https://leadloftexporter.vercel.app/email"
EMAIL_DIR = "public/email"
PIXABAY_KEY = os.environ.get("PIXABAY_API", "56316516-fbb10ad7475940758256bc517")

FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

WHITE = (255, 255, 255)
MUTED = (154, 154, 174)
BLUE = (27, 144, 255)
DARK = (5, 5, 13)

WA_LINK = "https://wa.me/918218929990"
SITE = "https://hudace.com"
CARD_W, CARD_H = 1080, 1350  # 4:5

os.makedirs(EMAIL_DIR, exist_ok=True)


# -- photo fetch (Pixabay -> download -> center-crop to 4:5) --------------------
def fetch_photo(query, out_name):
    out_path = f"{EMAIL_DIR}/{out_name}"
    if os.path.exists(out_path) and os.path.getsize(out_path) > 20000:
        print(f"  photo cached: {out_name}")
        return f"{BASE_URL}/{out_name}"
    params = urlencode({
        "key": PIXABAY_KEY, "q": query, "image_type": "photo",
        "orientation": "vertical", "min_width": 1080, "min_height": 1350,
        "safesearch": "true", "per_page": 20, "order": "popular",
    })
    data = {}
    for attempt in range(4):
        try:
            req = Request(f"https://pixabay.com/api/?{params}", headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=40) as r:
                data = json.loads(r.read())
            break
        except Exception as e:
            print(f"  pixabay retry {attempt+1} ({query}): {e}")
            time.sleep(2 * (attempt + 1))
    hits = data.get("hits", [])
    if not hits:  # fallback to any orientation
        params2 = urlencode({"key": PIXABAY_KEY, "q": query, "image_type": "photo",
                             "safesearch": "true", "per_page": 20, "order": "popular"})
        try:
            req = Request(f"https://pixabay.com/api/?{params2}", headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=40) as r:
                hits = json.loads(r.read()).get("hits", [])
        except Exception as e:
            print(f"  pixabay fallback failed ({query}): {e}")
    if not hits:
        raise RuntimeError(f"no pixabay results for '{query}'")
    img_url = hits[0]["largeImageURL"]
    content = b""
    for attempt in range(4):
        try:
            req = Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=60) as r:
                content = r.read()
            break
        except Exception as e:
            print(f"  download retry {attempt+1}: {e}")
            time.sleep(2 * (attempt + 1))
    tmp = f"{EMAIL_DIR}/_tmp_{out_name}"
    with open(tmp, "wb") as f:
        f.write(content)
    img = Image.open(tmp).convert("RGB")
    img = crop_45(img)
    img.save(out_path, "JPEG", quality=88)
    os.remove(tmp)
    print(f"  photo: {out_name} ({len(content)//1024}KB) <- {query}")
    return f"{BASE_URL}/{out_name}"


def crop_45(img, w=CARD_W, h=CARD_H):
    target = w / h
    iw, ih = img.size
    if iw / ih > target:  # too wide, crop sides
        nw = int(ih * target)
        img = img.crop(((iw - nw) // 2, 0, (iw - nw) // 2 + nw, ih))
    else:  # too tall, crop top/bottom
        nh = int(iw / target)
        img = img.crop((0, (ih - nh) // 2, iw, (ih - nh) // 2 + nh))
    return img.resize((w, h), Image.LANCZOS)


# -- baked promo card (4:5) -----------------------------------------------------
def make_card(bg_name, out_name, label, headline, bullets, cta="Chat on WhatsApp"):
    base = Image.open(f"{EMAIL_DIR}/{bg_name}").convert("RGB")
    base = crop_45(base).convert("RGBA")
    # darken with a top-to-bottom gradient so text reads
    grad = Image.new("L", (1, CARD_H), 0)
    for y in range(CARD_H):
        grad.putpixel((0, y), int(150 + 80 * (y / CARD_H)))
    alpha = grad.resize((CARD_W, CARD_H))
    overlay = Image.new("RGBA", (CARD_W, CARD_H), (5, 5, 13, 255))
    overlay.putalpha(alpha)
    img = Image.alpha_composite(base, overlay).convert("RGB")
    d = ImageDraw.Draw(img)
    f_word = ImageFont.truetype(FONT_BOLD, 52)
    f_label = ImageFont.truetype(FONT_BOLD, 30)
    f_head = ImageFont.truetype(FONT_BOLD, 78)
    f_bul = ImageFont.truetype(FONT_REG, 40)
    f_cta = ImageFont.truetype(FONT_BOLD, 40)
    f_foot = ImageFont.truetype(FONT_REG, 30)
    M = 84
    # wordmark
    d.text((M, 70), "HUDACE", fill=WHITE, font=f_word)
    wlen = d.textlength("HUDACE", font=f_word)
    d.rectangle([(M, 138), (M + wlen, 146)], fill=BLUE)
    # label
    y = 250
    d.text((M, y), label.upper(), fill=BLUE, font=f_label)
    y += 64
    # headline (wrap)
    for ln in textwrap.wrap(headline, width=20)[:3]:
        d.text((M, y), ln, fill=WHITE, font=f_head)
        y += 92
    y += 30
    # bullets
    for b in bullets[:5]:
        d.rectangle([(M, y + 12), (M + 8, y + 44)], fill=BLUE)
        for ln in textwrap.wrap(b, width=34)[:2]:
            d.text((M + 30, y), ln, fill=WHITE, font=f_bul)
            y += 52
        y += 12
    # CTA pill near bottom
    cy = CARD_H - 240
    cta_w = d.textlength(cta, font=f_cta)
    d.rounded_rectangle([(M, cy), (M + cta_w + 80, cy + 92)], radius=12, fill=BLUE)
    d.text((M + 40, cy + 24), cta, fill=WHITE, font=f_cta)
    # contact footer
    d.text((M, CARD_H - 96), "hudace.com   contact@hudace.com   +91 82189 29990", fill=MUTED, font=f_foot)
    img.save(f"{EMAIL_DIR}/{out_name}", "JPEG", quality=90)
    print(f"  card: {out_name}")
    return f"{BASE_URL}/{out_name}"


# -- email HTML (Gmail-safe, dark-mode-safe, dual CTA) --------------------------
HEAD_STYLE = """
  <style>
    @media (prefers-color-scheme: dark) {
      body, table, td { background-color:#0A0919 !important; color:#ffffff !important; }
    }
    [data-ogsc] body, [data-ogsc] table, [data-ogsc] td { background-color:#0A0919 !important; }
  </style>"""


def cta_pair():
    return f"""
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td width="50%" style="padding:0 6px 0 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#1B90FF" style="background:#1B90FF;border-radius:4px;">
          <tr><td align="center" style="padding:14px 12px;">
            <a href="{WA_LINK}" style="text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;"><span style="color:#ffffff;">Chat on WhatsApp</span></a>
          </td></tr>
        </table>
      </td>
      <td width="50%" style="padding:0 0 0 6px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#08080f" style="background:#08080f;border:1px solid #1B90FF;border-radius:4px;">
          <tr><td align="center" style="padding:14px 12px;">
            <a href="{SITE}" style="text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;"><span style="color:#ffffff;">Visit Our Website</span></a>
          </td></tr>
        </table>
      </td>
    </tr></table>"""


def deliverables_block(rows):
    return "".join(f"""
      <tr><td style="padding:7px 0 7px 16px;border-left:2px solid #1B90FF;">
        <span style="color:#ffffff;font-size:14px;line-height:1.6;font-family:Arial,sans-serif;">{r}</span>
      </td></tr>""" for r in rows)


def hooks_block(hooks):
    out = ""
    for i, (t, txt) in enumerate(hooks, 1):
        out += f"""
      <tr><td style="padding:0 0 16px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td valign="top" width="34" style="color:#1B90FF;font-size:20px;font-weight:bold;font-family:Arial,sans-serif;">{i}</td>
          <td valign="top">
            <div style="color:#ffffff;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:3px;">{t}</div>
            <div style="color:#9A9AAE;font-size:13px;line-height:1.6;font-family:Arial,sans-serif;">{txt}</div>
          </td>
        </tr></table>
      </td></tr>"""
    return out


def email_html(label, headline, sub, card_url, body_url, deliverables, scope, proof, future, hooks, closing):
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>{headline}</title>{HEAD_STYLE}</head>
<body style="margin:0;padding:0;background-color:#0A0919;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0919" style="background-color:#0A0919;">
<tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0919" style="background-color:#0A0919;max-width:600px;">

  <!-- HEADER LOGO -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:26px 40px 22px;border-bottom:1px solid #1a1a2e;">
    <img src="{BASE_URL}/hudace-logo.png" alt="Hudace" height="34" style="display:block;height:34px;width:auto;border:0;">
  </td></tr>

  <!-- HERO TEXT (live text on dark) -->
  <tr><td bgcolor="#08080f" style="background-color:#08080f;padding:46px 40px 36px;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">{label}</div>
    <h1 style="color:#ffffff;font-size:32px;line-height:1.22;margin:0 0 14px;font-family:Arial,sans-serif;font-weight:bold;">{headline}</h1>
    <p style="color:#9A9AAE;font-size:15px;line-height:1.65;margin:0 0 26px;font-family:Arial,sans-serif;">{sub}</p>
    {cta_pair()}
  </td></tr>

  <!-- HERO PHOTO (baked 4:5 card) -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:0;">
    <img src="{card_url}" alt="Hudace offer" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
  </td></tr>

  <!-- DELIVERABLES -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:34px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">What You Receive</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">{deliverables_block(deliverables)}</table>
  </td></tr>

  <!-- INDUSTRY SCOPE -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:30px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;font-family:Arial,sans-serif;">In Your Sector</div>
    <p style="color:#ffffff;font-size:14px;line-height:1.7;margin:0;font-family:Arial,sans-serif;">{scope}</p>
  </td></tr>

  <!-- BODY PHOTO -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:28px 40px 0;">
    <img src="{body_url}" alt="Hudace work" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:6px;margin:0 auto;">
  </td></tr>

  <!-- WHY IT WORKS -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:30px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px;font-family:Arial,sans-serif;">Why It Works</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">{hooks_block(hooks)}</table>
  </td></tr>

  <!-- PROOF + FUTURE -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:6px 40px 0;">
    <p style="color:#9A9AAE;font-size:13px;line-height:1.7;margin:0 0 10px;font-family:Arial,sans-serif;">{proof}</p>
    <p style="color:#9A9AAE;font-size:13px;line-height:1.7;margin:0;font-family:Arial,sans-serif;">{future}</p>
  </td></tr>

  <!-- DIVIDER -->
  <tr><td style="padding:30px 40px 0;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background-color:#1a1a2e;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

  <!-- CLOSING + DUAL CTA -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:26px 40px 0;">
    <p style="color:#ffffff;font-size:15px;line-height:1.6;margin:0 0 22px;font-family:Arial,sans-serif;">{closing}</p>
    {cta_pair()}
  </td></tr>

  <!-- SOCIAL ICONS -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:28px 40px 4px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:14px;"><a href="https://www.instagram.com/hudaceofficial/"><img src="{BASE_URL}/icon-instagram.png" alt="Instagram" width="30" height="30" style="display:block;border:0;"></a></td>
      <td style="padding-right:14px;"><a href="https://www.linkedin.com/company/hudace"><img src="{BASE_URL}/icon-linkedin.png" alt="LinkedIn" width="30" height="30" style="display:block;border:0;"></a></td>
      <td style="padding-right:14px;"><a href="{WA_LINK}"><img src="{BASE_URL}/icon-whatsapp.png" alt="WhatsApp" width="30" height="30" style="display:block;border:0;"></a></td>
    </tr></table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:24px 40px 30px;border-top:1px solid #1a1a2e;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="46"><img src="{BASE_URL}/hudace-mark.png" alt="Hudace" width="34" height="34" style="display:block;border:0;"></td>
      <td valign="middle">
        <p style="color:#9A9AAE;font-size:12px;margin:0 0 5px;font-family:Arial,sans-serif;">hudace.com &middot; contact@hudace.com &middot; +91 82189 29990</p>
        <p style="color:#444455;font-size:11px;margin:0;font-family:Arial,sans-serif;"><a href="#" style="color:#444455;text-decoration:underline;">Unsubscribe</a></p>
      </td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


# -- batch content (region-agnostic, SAP-calm) ---------------------------------
EMAILS = [
    {
        "key": "oilgas-erp",
        "industry": "Oil Gas and Energy",
        "label": "ERP BUILDING - OIL GAS AND ENERGY",
        "headline": "Custom Software That Ties Assets, Work Orders, and Compliance to One Record",
        "sub": "Energy operations run distributed assets, strict safety regimes, and unforgiving compliance, and the exposure sits where work orders, inspections, and asset histories fail to reference each other. Hudace builds custom business software on the Xenon AI platform so the operation runs as one connected system.",
        "bg_query": "oil gas refinery pipeline industrial night dark cinematic",
        "body_query": "industrial control room dashboard dark",
        "card_head": "Custom ERP and SaaS",
        "card_bullets": ["Discovery and module blueprint", "Assets, work orders, inspections", "Role-based access and dashboards", "Web and mobile access"],
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
        "scope": "Energy operations run distributed assets across sites, each with its own maintenance cycle, inspection schedule, and compliance record, and the risk sits in the handoffs where a work order, an inspection result, and an asset history fail to reference each other. Custom software built to your process, with role-based access and automation across the steps crews repeat every shift, keeps asset, work order, and compliance record tied to one traceable system, so an audit or an incident review is a query rather than a search through files and inboxes.",
        "proof": "We have built operational software for industrial and asset-heavy businesses, with reported reductions in administrative overhead and cleaner traceability once manual reconciliation moved into controlled, automated workflows.",
        "future": "The platform grows with the operation. New modules for HSE, procurement, and field service add without replacing the systems that already work.",
        "hooks": [
            ("Traceability becomes a query", "When asset, work order, and compliance records share one controlled system, an audit or an incident review is answered in minutes rather than reconstructed from files."),
            ("Automation returns hours, and accuracy", "Workflows handle the repeated inspection and maintenance records with a consistent trail, so crews spend time on the asset, not on cross-checking spreadsheets."),
            ("Built to your process, not a template", "A blueprint drawn from how the operation actually runs means the controls fit your safety regime and asset classes on day one."),
        ],
        "closing": "Tell us the workflow that costs you the most time and we will scope a module for it.",
    },
    {
        "key": "oilgas-seo",
        "industry": "Oil Gas and Energy",
        "label": "SEO / AEO / GEO / SRX - OIL GAS AND ENERGY",
        "headline": "Be the Provider Found First When a Capability or Scope Is Searched",
        "sub": "Energy procurement is technical and research-led, and it now plays out across search results and AI answers at once. Hudace optimizes for both so your capabilities, certifications, and coverage are visible at the moment a requirement is being defined.",
        "bg_query": "oil rig platform offshore industrial dark cinematic",
        "body_query": "engineering data analytics screen dark",
        "card_head": "SEO, AEO, GEO and SRX",
        "card_bullets": ["Technical SEO audit and fixes", "On-page and schema", "Authority and local SEO", "Visibility in AI answers"],
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
        "scope": "Energy procurement is technical, high-value, and quietly research-led. Buyers and operators scope requirements through capability searches, specification comparisons, and compliance documentation that now play out across search engines and AI answers together. Optimizing service, capability, and coverage pages for both, with structured data and clear technical detail, means your operation is the one cited when an engineer or purchaser investigates who can deliver a scope, rather than a competitor whose pages were structured to be found.",
        "proof": "We have run search programs that lifted both ranking positions and the share of AI-generated answers that cite the brand, turning technical discovery into a dependable source of qualified enquiries.",
        "future": "Search creates demand that does not reset each month. It compounds with a fast website and a steady content presence into a pipeline that no longer depends on tenders and referrals alone.",
        "hooks": [
            ("Intent is the cheapest demand", "Ranking for the capabilities and scopes buyers already search means meeting them as a requirement forms, not interrupting them later."),
            ("AI answers are the new shortlist", "Structured answers and GEO place your capabilities and coverage inside the response, where a growing share of technical supplier research now begins."),
            ("Experience is a ranking factor", "Core Web Vitals and SRX work means the pages that rank also read as credible, so technical traffic turns into qualified enquiries."),
        ],
        "closing": "Share your domain and we will return an audit summary and the first priorities.",
    },
    {
        "key": "oilgas-website",
        "industry": "Oil Gas and Energy",
        "label": "WEBSITE DESIGN - OIL GAS AND ENERGY",
        "headline": "A Website That Turns Technical Visitors Into Qualified Enquiries",
        "sub": "Most energy sites list services and certifications. Few are built to turn a researching engineer or buyer into an enquiry with a scope attached. Hudace delivers a fast, mobile-first site engineered to convert technical traffic into contact.",
        "bg_query": "power plant energy facility night industrial dark blue",
        "body_query": "laptop website design office dark",
        "card_head": "Website Design for Energy",
        "card_bullets": ["Custom multi-page website", "Mobile-first responsive build", "Capability pages and lead forms", "Analytics and WhatsApp"],
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
        "scope": "Technical research happens on a phone, on site, and between other tasks, and the enquiry is won or lost on speed and clarity. A mobile-first site with clear capability and coverage pages, downloadable certifications and safety documentation, fast load times, and lead and WhatsApp paths removes friction at the decision, so a qualified buyer sends the enquiry on the same visit rather than leaving to compare elsewhere.",
        "proof": "We have built and launched sites that paired clean structure with fast load times, so both search engines and visitors rewarded the page with rankings and conversions.",
        "future": "The site becomes the hub. SEO drives qualified traffic to it and a steady content presence keeps it warm between enquiries.",
        "hooks": [
            ("Speed protects the visit", "A fast, mobile-first build keeps a buyer on the page where a slow one loses them before the enquiry."),
            ("Structure earns the ranking", "An SEO-ready architecture lets search engines place you for the capabilities and scopes buyers actually search."),
            ("Forms turn traffic into pipeline", "Lead, contact, and WhatsApp paths capture intent at the moment it peaks, not days later."),
        ],
        "closing": "Send us your current site and we will return a build plan and a launch timeline.",
    },
    {
        "key": "utilities-social",
        "industry": "Utilities",
        "label": "SOCIAL MEDIA - UTILITIES",
        "headline": "Social Media That Builds Standing With the Communities and Partners You Serve",
        "sub": "Utilities operate in public view, where reliability, safety, and clear communication shape trust with customers, regulators, and partners. Hudace runs a fully managed social function so your organization stays visible, credible, and responsive.",
        "bg_query": "electric grid power lines utility infrastructure dark cinematic",
        "body_query": "smartphone social media content dark",
        "card_head": "Social Media for Utilities",
        "card_bullets": ["6 short-form videos monthly", "12 feed posts, 8 stories", "Community management", "Monthly performance report"],
        "deliverables": [
            "6 short-form videos per month",
            "12 feed posts per month",
            "8 stories per month",
            "Captions and hashtag sets",
            "Content calendar and scheduling",
            "Community management (comments and DMs)",
            "Monthly performance report",
        ],
        "scope": "Utilities are judged in public on reliability, safety, and how clearly they communicate, and the organization customers and partners keep seeing is the one that feels dependable. A structured calendar built around service updates, safety practice, and community programs turns routine activity into steady visibility, while managed comments and messages handle the questions that shape public trust and partner confidence through every season of demand.",
        "proof": "We have run managed social programs that replaced irregular posting with a steady calendar, keeping the brand present and responsive through every demand and maintenance cycle.",
        "future": "Social builds the first impression and the daily relationship. It layers into SEO, website, and AI cinematic video so attention moves into a measurable pipeline of enquiries and partnerships.",
        "hooks": [
            ("Presence signals reliability", "Six videos and twelve posts a month keep a utility visible and credible with the customers and partners who depend on it."),
            ("Response builds public trust", "Managed community handling answers comments and messages quickly, so a concern becomes a resolved conversation instead of a public complaint."),
            ("Owned attention reduces ad dependence", "A steady, useful feed builds an audience the organization reaches without paying for every impression."),
        ],
        "closing": "Tell us your service area and priorities and we will return a content calendar built for them.",
    },
    {
        "key": "utilities-aistudio",
        "industry": "Utilities",
        "label": "AI WORK STUDIO - UTILITIES",
        "headline": "A Cinematic Film of Your Network and Operations, Without a Crew on Site",
        "sub": "Scale, reliability, and the engineering behind a dependable service are what set a utility apart, and they are communicated best on screen. Hudace AI Work Studio produces a cinematic film of your operation in seven working days, with no crew on a live network.",
        "bg_query": "power station turbines energy infrastructure cinematic dark",
        "body_query": "film camera production cinematic dark",
        "card_head": "AI Work Studio for Utilities",
        "card_bullets": ["60-second cinematic film", "Three 15-second social cuts", "Ten AI-generated stills", "Delivered in 7 working days"],
        "deliverables": [
            "60-second cinematic film",
            "Three 15-second social cuts",
            "Ten AI-generated stills",
            "Script and concept included",
            "Delivered in seven working days, no film crew",
        ],
        "scope": "A customer, regulator, or partner assessing a utility responds to scale, reliability, and command of a demanding network that they can see. A cinematic film communicates the organization's standing and engineering in sixty seconds, in a format that travels across stakeholder briefings, recruitment, and partner conversations, without the access, safety clearance, and delay of putting a crew on live infrastructure.",
        "proof": "We have produced cinematic films for industrial and infrastructure operations, delivering finished work in days rather than the weeks a traditional shoot requires.",
        "future": "One film fuels months of presence. The social cuts and stills feed the content calendar and stakeholder decks long after delivery.",
        "hooks": [
            ("Scale is best shown, not described", "A cinematic treatment conveys network capacity and engineering in seconds that a brochure cannot."),
            ("Seven days keeps pace with the moment", "AI production removes the crew, the site access, and the wait, so the film ships while the story is current."),
            ("One shoot, many assets", "A film, three cuts, and ten stills give every channel something to run from a single brief."),
        ],
        "closing": "Describe your network and we will return a concept and a delivery date.",
    },
    {
        "key": "schoolos",
        "imgbase": "schoolos-jul06",
        "industry": None,
        "label": "SCHOOLOS - SCHOOL ERP",
        "headline": "Run the Whole School on One Connected Platform",
        "sub": "When admissions, fees, attendance, and exams sit in separate systems, staff spend their day reconciling them. SchoolOS, the Hudace School ERP, runs every function on one platform with Nectar AI built in.",
        "bg_query": "school building campus students learning dark",
        "body_query": "students classroom technology learning",
        "card_head": "SchoolOS School ERP",
        "card_bullets": ["Admissions to enrollment", "Fees, exams, attendance", "Parent app and transport", "Management dashboards"],
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
        "scope": "A school runs on parallel cycles of admissions, academics, finance, and operations. SchoolOS connects them so a fee status, an attendance record, and an exam result all reference the same student, and Nectar AI handles routine admin across admissions, attendance, and fees so staff return to teaching and leadership.",
        "proof": "We have deployed connected school operations where leadership reported lower administrative overhead and parents reported clearer, more timely communication once records moved onto one platform.",
        "future": "SchoolOS scales from a single campus to a group, with management dashboards that give leadership one view across every site.",
        "hooks": [
            ("One record, no reconciliation", "When fees, attendance, and exams share one student profile, staff stop cross-checking systems and start acting on the data."),
            ("Parents stay informed automatically", "Alerts, announcements, and the parent app keep families current without a manual message from the office."),
            ("Leadership sees the whole school", "Management dashboards turn daily operations into decisions, from fee collection to attendance trends, in one view."),
        ],
        "closing": "Tell us your campus size and we will return a module rollout plan for your term.",
    },
]

SERVICE_NAME = {
    "oilgas-erp": "ERP Building",
    "oilgas-seo": "SEO / AEO / GEO / SRX",
    "oilgas-website": "Website Design",
    "utilities-social": "Social Media",
    "utilities-aistudio": "AI Work Studio",
    "schoolos": "SchoolOS School ERP",
}


def wa_text(e):
    bl = "\n".join(f"- {b}" for b in e["card_bullets"])
    return f"{e['card_head']} from Hudace.\n\n{bl}\n\nOne predictable monthly engagement. Want the full plan?\n\n{WA_LINK}"


def li_text(e):
    h = "\n".join(f"{i}. {t}: {txt}" for i, (t, txt) in enumerate(e["hooks"], 1))
    return (f"{e['headline']}\n\n{e['sub']}\n\n{h}\n\nThe outcome is a function that runs on schedule, not a task that waits for time.\n\n"
            f"hudace.com | contact@hudace.com | +91 82189 29990")


def outreach_text(e):
    return (f"Subject: {e['card_head']} for your operation\n\n"
            f"Hello,\n\n{e['sub']}\n\nWhat you would receive:\n" +
            "\n".join(f"- {b}" for b in e["deliverables"][:6]) +
            f"\n\n{e['proof']}\n\nWould a short call this week work to walk through the plan?\n\n"
            f"Hudace | hudace.com | contact@hudace.com | +91 82189 29990 | {WA_LINK}")


def main():
    batch = []
    failures = []
    for e in EMAILS:
        svc = SERVICE_NAME[e["key"]]
        prefix = f"[{DATE}] {e['industry']} | {svc}" if e["industry"] else f"[{DATE}] {svc}"
        print(f"\n== {prefix} ==")
        base = e.get("imgbase", e["key"])
        try:
            bg = f"bg-{base}.jpg"
            body = f"body-{base}.jpg"
            card = f"promo-{base}.jpg"
            fetch_photo(e["bg_query"], bg)
            body_url = fetch_photo(e["body_query"], body)
            card_url = make_card(bg, card, e["label"], e["card_head"], e["card_bullets"])
            html = email_html(e["label"], e["headline"], e["sub"], card_url, body_url,
                              e["deliverables"], e["scope"], e["proof"], e["future"], e["hooks"], e["closing"])
            batch.append({"title": prefix, "type": "html_email", "body": html, "image_url": card_url})
            batch.append({"title": f"{prefix} (WhatsApp)", "type": "whatsapp", "body": wa_text(e), "image_url": card_url})
            batch.append({"title": f"{prefix} (LinkedIn)", "type": "caption", "body": li_text(e), "image_url": card_url})
            batch.append({"title": f"{prefix} (Outreach)", "type": "other", "body": outreach_text(e), "image_url": card_url})
        except Exception as ex:
            print(f"  FAILED {prefix}: {ex}")
            failures.append((prefix, str(ex)))
    os.makedirs(".routine/batches", exist_ok=True)
    for path in ("batch.json", f".routine/batches/{DATE}.json"):
        with open(path, "w") as f:
            json.dump(batch, f, indent=2)
    print(f"\nWrote batch.json and .routine/batches/{DATE}.json with {len(batch)} items. Failures: {len(failures)}")
    for p, m in failures:
        print("  FAIL", p, m)


if __name__ == "__main__":
    main()
