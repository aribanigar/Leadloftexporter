#!/usr/bin/env python3
"""Build the daily Hudace content batch:
  - download a dark cinematic 4:5 photo per service from Pixabay (hosted in repo)
  - bake a 4:5 promo card JPG per service (photo bg + logo + headline + deliverables + CTA)
  - build a Gmail-safe HTML email per service
  - write WhatsApp, LinkedIn and outreach copy per service
  - emit batch.json (email + whatsapp + caption + outreach per service)

Voice: SAP.com calm. No emojis, no em dashes, no exclamation. No region names.
All images referenced by their deployed URL under PUBLIC_BASE.
"""
import os, json, io, textwrap, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMG_DIR = os.path.join(ROOT, "public", "email")
os.makedirs(IMG_DIR, exist_ok=True)

RUN_DATE = os.environ.get("RUN_DATE", "").strip()  # set by runner
assert RUN_DATE, "RUN_DATE env required (YYYY-MM-DD)"

PIXABAY = os.environ.get("PIXABAY_API", "56316516-fbb10ad7475940758256bc517")
PUBLIC_BASE = "https://leadloftexporter.vercel.app/email"

# ---- brand ----
BG = "#0A0919"; BG2 = "#08080f"; BG3 = "#05050D"
BLUE = "#1B90FF"; WHITE = "#ffffff"; MUTE = "#9A9AAE"
WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"
IG = "https://www.instagram.com/hudaceofficial/"
LI = "https://www.linkedin.com/company/hudace"
CONTACT_LINE = "hudace.com &middot; contact@hudace.com &middot; +91 82189 29990"

from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter
FB = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

def font(bold, size):
    return ImageFont.truetype(FB if bold else FR, size)

# ---------------- Pixabay ----------------
def pixabay_download(queries, dest):
    """Try each query; download the first strong hit's largeImageURL to dest."""
    last = None
    for q in queries:
        url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo"
               "&orientation=horizontal&safesearch=true&per_page=30&order=popular"
               % (PIXABAY, urllib.parse.quote(q)))
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                data = json.loads(r.read().decode())
        except Exception as e:
            last = e; continue
        hits = [h for h in data.get("hits", []) if h.get("imageWidth", 0) >= 1280]
        for h in hits:
            src = h.get("largeImageURL") or h.get("webformatURL")
            try:
                req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    raw = r.read()
                im = Image.open(io.BytesIO(raw)).convert("RGB")
                im.save(dest, "JPEG", quality=90)
                return h.get("id"), h.get("pageURL")
            except Exception as e:
                last = e; continue
    raise RuntimeError("pixabay failed for %s: %s" % (queries, last))

def crop_45(src, dst, target=(1080, 1350)):
    im = Image.open(src).convert("RGB")
    tw, th = target
    tr = tw / th
    w, h = im.size
    r = w / h
    if r > tr:  # too wide -> crop width
        nw = int(h * tr); x = (w - nw) // 2
        im = im.crop((x, 0, x + nw, h))
    else:       # too tall -> crop height
        nh = int(w / tr); y = (h - nh) // 2
        im = im.crop((0, y, w, y + nh))
    im = im.resize(target, Image.LANCZOS)
    im.save(dst, "JPEG", quality=88)
    return dst

# ---------------- baked promo card ----------------
def draw_wrapped(d, xy, text, fnt, fill, max_w, leading):
    x, y = xy
    words = text.split()
    line = ""
    for w in words:
        test = (line + " " + w).strip()
        if d.textlength(test, font=fnt) <= max_w:
            line = test
        else:
            d.text((x, y), line, font=fnt, fill=fill); y += leading
            line = w
    if line:
        d.text((x, y), line, font=fnt, fill=fill); y += leading
    return y

def bake_card(photo_path, dst, headline, kicker, bullets, cta="Chat on WhatsApp"):
    W, H = 1080, 1350
    base = Image.open(photo_path).convert("RGB").resize((W, H), Image.LANCZOS)
    # darken with a vertical gradient toward the bottom for text legibility
    overlay = Image.new("L", (1, H), 0)
    for y in range(H):
        t = y / H
        overlay.putpixel((0, y), int(150 + 95 * (t ** 1.3)))  # 150..245
    overlay = overlay.resize((W, H))
    dark = Image.new("RGB", (W, H), (5, 5, 13))
    base = Image.composite(dark, base, overlay)
    base = ImageEnhance.Brightness(base).enhance(0.92)
    d = ImageDraw.Draw(base)
    m = 80
    # logo lockup top-left
    lock = Image.open(os.path.join(IMG_DIR, "logo-lockup-white.png")).convert("RGBA")
    lw = 300; lh = int(lock.height * lw / lock.width)
    lock = lock.resize((lw, lh), Image.LANCZOS)
    base.paste(lock, (m, m), lock)
    # kicker
    y = 300
    d.text((m, y), kicker.upper(), font=font(True, 30), fill=BLUE)
    # accent underline
    d.rectangle([m, y + 44, m + 64, y + 50], fill=BLUE)
    y += 78
    # headline
    y = draw_wrapped(d, (m, y), headline, font(True, 74), (255, 255, 255), W - 2 * m, 84)
    y += 26
    d.text((m, y), "DELIVERABLES", font=font(True, 26), fill=(154, 154, 174)); y += 52
    fb = font(True, 33)
    for b in bullets:
        d.ellipse([m, y + 12, m + 12, y + 24], fill=BLUE)
        d.text((m + 34, y), b, font=fb, fill=(240, 240, 245)); y += 52
    # CTA pill
    cy = H - 240
    pill_w = int(d.textlength(cta, font=font(True, 34))) + 90
    d.rounded_rectangle([m, cy, m + pill_w, cy + 76], radius=38, fill=BLUE)
    d.text((m + 45, cy + 20), cta, font=font(True, 34), fill=(255, 255, 255))
    # contact
    d.text((m, H - 120), "wa.me/918218929990  |  hudace.com", font=font(True, 30), fill=(255, 255, 255))
    d.text((m, H - 78), "contact@hudace.com  |  +91 82189 29990", font=font(False, 27), fill=(154, 154, 174))
    base.save(dst, "JPEG", quality=90)
    return dst

# ---------------- email HTML ----------------
def btns(center=True):
    align = "center" if center else "left"
    return f'''
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="{align}"><tr>
      <td style="padding:6px 8px 6px 0;">
        <a href="{WA}" style="background:{BLUE};color:{WHITE};text-decoration:none;display:inline-block;padding:14px 26px;border-radius:8px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;">Chat on WhatsApp</a>
      </td>
      <td style="padding:6px 0 6px 0;">
        <a href="{SITE}" style="border:1px solid {BLUE};color:{WHITE};text-decoration:none;display:inline-block;padding:13px 24px;border-radius:8px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;">Visit Our Website</a>
      </td>
    </tr></table>'''

def deliverables_html(items):
    rows = ""
    for it in items:
        rows += f'''<tr><td valign="top" style="padding:5px 10px 5px 0;color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">&#9642;</td>
        <td style="padding:5px 0;color:#e9e9f2;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">{it}</td></tr>'''
    return f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{rows}</table>'

def hooks_html(hooks):
    out = ""
    for i, (h, body) in enumerate(hooks, 1):
        out += f'''<tr><td valign="top" style="padding:8px 14px 8px 0;color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:bold;line-height:26px;">{i}</td>
        <td style="padding:8px 0;font-family:Montserrat,Arial,sans-serif;">
          <div style="color:{WHITE};font-size:16px;font-weight:bold;line-height:22px;">{h}</div>
          <div style="color:{MUTE};font-size:14px;line-height:21px;padding-top:3px;">{body}</div>
        </td></tr>'''
    return f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{out}</table>'

def build_email(svc):
    big = svc["big"]; sub = svc["sub"]; card = svc["card_url"]; photo = svc["photo_url"]
    email = f'''<!--[if mso]><style>body,table,td{{font-family:Arial,sans-serif !important;}}</style><![endif]-->
<style>
  @media (prefers-color-scheme: dark) {{ body,.bg {{ background:{BG} !important; }} }}
  [data-ogsc] .bg {{ background:{BG} !important; }}
  @media only screen and (max-width:600px) {{
    .container {{ width:100% !important; }}
    .stackbtn {{ display:block !important; width:100% !important; text-align:center !important; }}
    .stackbtn a {{ display:block !important; }}
  }}
</style>
<div class="bg" style="margin:0;padding:0;background:{BG};">
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="background:{BG};">
<tr><td align="center" style="padding:0;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="width:600px;max-width:600px;background:{BG};">

  <!-- header -->
  <tr><td bgcolor="{BG2}" style="background:{BG2};padding:20px 28px;">
    <img src="{PUBLIC_BASE}/logo-lockup-white.png" width="150" alt="Hudace" style="display:block;border:0;height:auto;width:150px;">
  </td></tr>

  <!-- hero: live text -->
  <tr><td bgcolor="{BG2}" style="background:{BG2};padding:34px 28px 26px 28px;">
    <div style="color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:bold;text-transform:uppercase;">Hudace Growth</div>
    <div style="color:{WHITE};font-family:Montserrat,Arial,sans-serif;font-size:40px;line-height:46px;font-weight:bold;padding:10px 0 6px 0;">{big}</div>
    <div style="color:{MUTE};font-family:Montserrat,Arial,sans-serif;font-size:17px;line-height:25px;padding-bottom:20px;">{sub}</div>
    {btns(center=False)}
  </td></tr>

  <!-- hero photo (plain img, never a background) -->
  <tr><td bgcolor="{BG2}" style="background:{BG2};padding:0 28px 28px 28px;">
    <img src="{photo}" width="544" alt="{svc['name']}" style="display:block;border:0;height:auto;width:100%;max-width:544px;border-radius:10px;">
  </td></tr>

  <!-- deliverables -->
  <tr><td bgcolor="{BG}" style="background:{BG};padding:30px 28px 8px 28px;">
    <div style="color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:bold;text-transform:uppercase;padding-bottom:14px;">What you get</div>
    {deliverables_html(svc['deliverables'])}
  </td></tr>

  <!-- industry scope -->
  <tr><td bgcolor="{BG}" style="background:{BG};padding:26px 28px 8px 28px;">
    <div style="color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:bold;text-transform:uppercase;padding-bottom:10px;">In your sector</div>
    <div style="color:#e9e9f2;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:23px;">{svc['scope']}</div>
    <div style="color:{MUTE};font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;padding-top:10px;">{svc['proof']}</div>
    <div style="color:{MUTE};font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;padding-top:8px;">{svc['future']}</div>
  </td></tr>

  <!-- share card -->
  <tr><td bgcolor="{BG}" style="background:{BG};padding:24px 28px 8px 28px;">
    <img src="{card}" width="544" alt="{svc['name']} summary" style="display:block;border:0;height:auto;width:100%;max-width:544px;border-radius:10px;">
  </td></tr>

  <!-- why it works -->
  <tr><td bgcolor="{BG}" style="background:{BG};padding:30px 28px 14px 28px;">
    <div style="color:{BLUE};font-family:Montserrat,Arial,sans-serif;font-size:13px;letter-spacing:2px;font-weight:bold;text-transform:uppercase;padding-bottom:12px;">Why it works</div>
    {hooks_html(svc['hooks'])}
  </td></tr>

  <!-- closing + CTA -->
  <tr><td bgcolor="{BG2}" style="background:{BG2};padding:28px;">
    <div style="color:{WHITE};font-family:Montserrat,Arial,sans-serif;font-size:17px;line-height:25px;font-weight:bold;padding-bottom:16px;">{svc['close']}</div>
    {btns(center=False)}
  </td></tr>

  <!-- social -->
  <tr><td bgcolor="{BG3}" style="background:{BG3};padding:22px 28px 10px 28px;" align="left">
    <a href="{IG}" style="text-decoration:none;"><img src="{PUBLIC_BASE}/icon-instagram.png" width="30" alt="Instagram" style="display:inline-block;border:0;width:30px;height:30px;margin-right:12px;"></a>
    <a href="{LI}" style="text-decoration:none;"><img src="{PUBLIC_BASE}/icon-linkedin.png" width="30" alt="LinkedIn" style="display:inline-block;border:0;width:30px;height:30px;margin-right:12px;"></a>
    <a href="{WA}" style="text-decoration:none;"><img src="{PUBLIC_BASE}/icon-whatsapp.png" width="30" alt="WhatsApp" style="display:inline-block;border:0;width:30px;height:30px;"></a>
  </td></tr>

  <!-- footer -->
  <tr><td bgcolor="{BG3}" style="background:{BG3};padding:10px 28px 30px 28px;">
    <img src="{PUBLIC_BASE}/mark-white.png" width="34" alt="Hudace" style="display:block;border:0;width:34px;height:auto;padding-bottom:12px;">
    <div style="color:{MUTE};font-family:Montserrat,Arial,sans-serif;font-size:13px;line-height:20px;">{CONTACT_LINE}</div>
    <div style="color:#5a5a6e;font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:19px;padding-top:8px;">You are receiving this because you expressed interest in Hudace. <a href="{SITE}" style="color:#7a7a90;">Unsubscribe</a>.</div>
  </td></tr>

</table>
</td></tr></table>
</div>'''
    return email

# ---------------- content data ----------------
SERVICES = [
  {
    "key": "social-media", "name": "Social Media", "big": "Social media, run as a system.",
    "sub": "A full content engine that keeps your brand present, planned and consistent every month.",
    "industry": "Retail",
    "queries": ["dark cinematic content creator studio", "dark neon phone social media night", "dark studio camera bokeh"],
    "deliverables": ["6 short-form videos per month", "12 feed posts per month", "8 stories per month",
      "Captions and hashtag sets", "Content calendar and scheduling", "Community management (comments and DMs)",
      "Monthly performance report"],
    "card_bullets": ["6 short-form videos / month", "12 feed posts / month", "8 stories / month",
      "Captions, calendar, scheduling", "Community management", "Monthly performance report"],
    "scope": "For retail brands, a steady feed keeps buyers close between purchases. We turn product drops, offers and everyday moments into a planned month of content so your audience hears from you before they are ready to buy again.",
    "proof": "We have run content programs for consumer brands where a consistent posting rhythm shortened the path from first discovery to first purchase.",
    "future": "As the program matures, the same pipeline extends into paid amplification and always-on creative, without adding to your team.",
    "hooks": [
      ("Consistency beats bursts", "A planned calendar means you show up every week, which is what builds recall and trust over a quarter."),
      ("Short-form does the reach", "Six videos a month give the algorithm the format it rewards, so new audiences find you without paid spend."),
      ("Managed community keeps intent warm", "Answered comments and DMs turn passive followers into conversations, and conversations into buyers."),
    ],
    "close": "Book a short call and we will map your first month of content this week.",
  },
  {
    "key": "seo-aeo-geo", "name": "SEO / AEO / GEO / SRX", "big": "Be found in search and in AI answers.",
    "sub": "Full-stack visibility across classic search, answer engines and AI-generated results.",
    "industry": "Construction and Real Estate",
    "queries": ["dark data analytics dashboard blue", "dark server data network blue", "dark night city aerial lights"],
    "deliverables": ["Technical SEO audit and fixes", "Keyword and intent research",
      "On-page optimization (titles, meta, headings, schema)", "Content briefs and optimization",
      "Authority and backlink building", "Local SEO (profile, citations, maps)",
      "AEO: answer-engine optimization (FAQ, structured answers)", "GEO: visibility inside AI-generated answers",
      "SRX: search experience and Core Web Vitals", "Monthly ranking and traffic report"],
    "card_bullets": ["Technical audit and fixes", "Keyword and intent research",
      "On-page and schema", "AEO and GEO for AI answers", "Local SEO and backlinks", "Monthly ranking report"],
    "scope": "For construction and real estate teams, buyers research long before they enquire. We make sure your projects, locations and services appear when they search, ask an answer engine, or read an AI-generated summary of the market.",
    "proof": "We have delivered technical and local SEO for property-led businesses where fixing site structure and profiles lifted qualified enquiry volume.",
    "future": "As rankings hold, we extend into answer-engine and AI-answer visibility so you stay present as search behaviour shifts.",
    "hooks": [
      ("One program, every surface", "Classic search, maps, answer engines and AI results are optimised together, so you are not chasing one channel while losing another."),
      ("Technical fixes compound", "Audit-led work on speed, structure and schema keeps paying back long after the month it was done."),
      ("Intent research targets buyers", "We rank you for the terms people use near a decision, not vanity keywords that never convert."),
    ],
    "close": "Ask for a free visibility audit and we will show where you are winning and where you are invisible.",
  },
  {
    "key": "website-design", "name": "Website Design", "big": "A website that sells while you sleep.",
    "sub": "A fast, mobile-first site built to turn visitors into enquiries and bookings.",
    "industry": "Retail",
    "queries": ["dark laptop web design desk night", "dark modern workspace screen blue", "dark ui design mockup"],
    "deliverables": ["Custom multi-page website", "Mobile-first responsive build",
      "Booking, lead, and contact forms", "CMS to edit content yourself", "SEO-ready structure and speed",
      "Analytics and WhatsApp integration", "Hosting and domain setup", "Launch and handover"],
    "card_bullets": ["Custom multi-page site", "Mobile-first responsive build", "Booking and lead forms",
      "CMS you control", "SEO-ready and fast", "Hosting, launch, handover"],
    "scope": "For retail brands, your site is the shop that never closes. We build a fast, mobile-first store front with booking and enquiry forms, WhatsApp integration and a CMS you can edit yourself.",
    "proof": "We have shipped conversion-focused sites for consumer businesses where a faster, clearer build turned more visits into enquiries.",
    "future": "The same foundation scales into full ecommerce, loyalty and integrations as your catalogue and traffic grow.",
    "hooks": [
      ("Speed is conversion", "A mobile-first, fast-loading build keeps visitors from bouncing, which is where most sites quietly lose sales."),
      ("Forms and WhatsApp capture intent", "Every page routes interest into a booking, a lead or a chat, so traffic becomes enquiries."),
      ("You stay in control", "A CMS and clean handover mean you update content without waiting on an agency."),
    ],
    "close": "Send us your current site or your idea and we will return a build plan and timeline.",
  },
  {
    "key": "erp-building", "name": "ERP Building", "big": "Custom software that runs your operations.",
    "sub": "AI-native business systems built around how your company actually works.",
    "industry": "Construction and Real Estate",
    "queries": ["dark server room blue technology", "dark data center blue lights", "dark abstract network technology"],
    "deliverables": ["Discovery and module blueprint", "Custom modules (CRM, inventory, billing, HR, and more)",
      "Role-based access and dashboards", "Workflow automations", "Integrations (payments, messaging, APIs)",
      "Web and mobile access", "Training and documentation", "Ongoing support and iterations"],
    "card_bullets": ["Discovery and module blueprint", "Custom CRM, inventory, billing, HR",
      "Role-based dashboards", "Workflow automations", "Web and mobile access", "Training and ongoing support"],
    "scope": "For construction and real estate operators, projects, sites, inventory and billing rarely fit off-the-shelf tools. We build a custom system that ties them together, with role-based dashboards and automations for the approvals that slow teams down.",
    "proof": "We have built operational software for asset-heavy businesses where replacing spreadsheets with one system cut reporting overhead and delay.",
    "future": "Modules are added as you grow, so the platform expands with new sites, teams and lines of business.",
    "hooks": [
      ("Built around your workflow", "Off-the-shelf tools force your process to bend; a custom build follows how your team already works."),
      ("Automation removes the drag", "Routine approvals, reports and reminders run themselves, freeing people for the work that needs judgement."),
      ("One source of truth", "CRM, inventory, billing and HR in one place ends the reconciliation between disconnected apps."),
    ],
    "close": "Share your biggest operational bottleneck and we will scope a module blueprint for it.",
  },
  {
    "key": "ai-work-studio", "name": "AI Work Studio", "big": "Cinematic films, without a film crew.",
    "sub": "AI-generated cinematic video and stills, concept to delivery in seven working days.",
    "industry": "Retail",
    "queries": ["dark cinematic film production light", "dark cinema camera moody", "dark cinematic bokeh lights"],
    "deliverables": ["60-second cinematic film", "Three 15-second social cuts", "Ten AI-generated stills",
      "Script and concept included", "Delivered in seven working days, no film crew"],
    "card_bullets": ["60-second cinematic film", "Three 15-second social cuts", "Ten AI-generated stills",
      "Script and concept included", "Seven working days, no film crew"],
    "scope": "For retail brands, launches and campaigns need film-grade content on a fast cycle. We produce a cinematic hero film, social cuts and stills from an AI work studio, so you get the look of a shoot without the cost or the calendar of one.",
    "proof": "We have produced AI cinematic content for consumer brands where campaign-ready video shipped in days rather than weeks.",
    "future": "The studio scales to a full always-on content library as your calendar of drops and campaigns fills out.",
    "hooks": [
      ("Film-grade look, no production drag", "You get a cinematic film and cuts without crew, location or a multi-week schedule."),
      ("One shoot, many formats", "A hero film plus three social cuts and ten stills covers a whole campaign from a single concept."),
      ("Seven-day cycle", "A fixed, fast turnaround means your content keeps pace with your launches."),
    ],
    "close": "Send a product or a brief and we will return a concept for your first cinematic film.",
  },
  {
    "key": "schoolos", "name": "SchoolOS", "big": "Run the whole institution on one platform.",
    "sub": "An AI-native school ERP that automates admissions to alumni.",
    "industry": "Education and Research",
    "queries": ["dark modern school building night", "dark university campus evening lights", "dark library study modern"],
    "deliverables": ["Admissions: online enquiry to enrollment", "Student records: profiles, documents, history",
      "Attendance: daily and period, parent alerts", "Fees: invoices, online payments, reminders, receipts",
      "Examinations: marks, grading, report cards", "Timetable: classes, teachers, substitutions",
      "Communication: announcements and parent app", "Transport: routes, vehicles, live tracking",
      "Library: catalog, issue and return", "HR and payroll: staff and salaries",
      "Reports: management dashboards"],
    "card_bullets": ["Admissions to enrollment", "Student records and attendance", "Fees and online payments",
      "Examinations and report cards", "Timetable, transport, library", "HR, payroll and dashboards"],
    "scope": "For education institutions, staff lose hours to admissions follow-up, fee chasing and attendance. SchoolOS puts every module in one platform, with AI that automates the routine admin across admissions, attendance and fees so teams focus on students.",
    "proof": "We have deployed school management systems where moving admissions, fees and attendance into one platform reduced manual follow-up for administrative staff.",
    "future": "The platform grows from a single campus to multi-branch operations, with a parent app and management dashboards across all sites.",
    "hooks": [
      ("One platform, every office", "Admissions, finance, academics and transport share one system, so data is entered once and trusted everywhere."),
      ("AI handles the routine", "Automated follow-up on admissions, attendance and fees removes the repetitive admin that fills staff days."),
      ("Parents stay informed", "Alerts, announcements and a parent app keep families close without extra work for teachers."),
    ],
    "close": "Ask for a SchoolOS walkthrough and we will map your admissions-to-alumni flow.",
  },
]

# ---------------- build ----------------
def wa_text(svc):
    b = "\n".join("- " + x for x in svc["card_bullets"])
    return (f"{svc['big']}\n\n{svc['sub']}\n\nWhat you get:\n{b}\n\n"
            f"{svc['scope'].split('. ')[0]}.\n\nTalk to us: {WA}\nhudace.com | contact@hudace.com")

def li_text(svc):
    lines = [svc["big"], "", svc["sub"], ""]
    for k, _ in svc["hooks"]:
        lines.append("- " + k)
    lines += ["", svc["proof"], "",
              f"To see how this fits your team, message us on WhatsApp {WA} or visit hudace.com.",
              "contact@hudace.com | +91 82189 29990"]
    return "\n".join(lines)

def outreach_text(svc):
    return (f"Subject: {svc['name']} for {svc['industry'].split(' and ')[0].lower()} teams\n\n"
            f"Hello,\n\n"
            f"{svc['scope']}\n\n"
            f"What we deliver:\n" + "\n".join("- " + x for x in svc["card_bullets"]) + "\n\n"
            f"{svc['proof']}\n\n"
            f"If this is useful, are you open to a short call this week. You can also reach us on WhatsApp at {WA}.\n\n"
            f"Hudace\nhudace.com | contact@hudace.com | +91 82189 29990")

batch = []
summary = []
for svc in SERVICES:
    key = svc["key"]
    photo_src = os.path.join(IMG_DIR, f"{key}-src.jpg")
    photo_45 = os.path.join(IMG_DIR, f"{key}-photo.jpg")
    card = os.path.join(IMG_DIR, f"{key}-card.jpg")
    try:
        pid, page = pixabay_download(svc["queries"], photo_src)
        crop_45(photo_src, photo_45)
        os.remove(photo_src)
        bake_card(photo_45, card, svc["big"], svc["name"], svc["card_bullets"])
        svc["photo_url"] = f"{PUBLIC_BASE}/{key}-photo.jpg"
        svc["card_url"] = f"{PUBLIC_BASE}/{key}-card.jpg"
        summary.append(f"{key}: photo+card ok (pixabay {pid})")
    except Exception as e:
        # fallback: no photo, still build with card missing -> use a plain dark card
        svc["photo_url"] = f"{PUBLIC_BASE}/{key}-photo.jpg"
        svc["card_url"] = f"{PUBLIC_BASE}/{key}-card.jpg"
        summary.append(f"{key}: IMAGE FAILED {e}")
        continue

    html = build_email(svc)
    batch.append({"title": f"[{RUN_DATE}] {svc['name']}", "type": "html_email",
                  "body": html, "image_url": svc["card_url"]})
    batch.append({"title": f"[{RUN_DATE}] {svc['name']} WhatsApp", "type": "whatsapp",
                  "body": wa_text(svc), "image_url": svc["card_url"]})
    batch.append({"title": f"[{RUN_DATE}] {svc['name']} LinkedIn", "type": "caption",
                  "body": li_text(svc), "image_url": svc["card_url"]})
    batch.append({"title": f"[{RUN_DATE}] {svc['name']} Outreach", "type": "other",
                  "body": outreach_text(svc), "image_url": svc["card_url"]})

with open(os.path.join(ROOT, "batch.json"), "w") as f:
    json.dump(batch, f, indent=2, ensure_ascii=False)

print("BATCH ITEMS:", len(batch))
for s in summary:
    print(" ", s)
