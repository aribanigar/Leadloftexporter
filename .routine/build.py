#!/usr/bin/env python3
"""
Hudace content-hub daily batch builder.

Generates, for each marketing service plus SchoolOS:
  - a dark cinematic 4:5 photo (downloaded from Pixabay, cropped, committed)
  - a baked 4:5 promo JPG card (Pillow)
  - a Gmail-safe HTML email
  - WhatsApp / LinkedIn / outreach copy
Writes batch.json (content-hub items) and refreshes .routine/state.json.

No region or country is ever named in any output.
"""
import os, sys, json, io, urllib.parse, urllib.request, datetime, textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAIL_DIR = os.path.join(ROOT, "public", "email")
FONT_DIR = os.path.join(ROOT, "fonts")
STATE = os.path.join(ROOT, ".routine", "state.json")
os.makedirs(EMAIL_DIR, exist_ok=True)

PIXABAY = os.environ.get("PIXABAY_API", "56316516-fbb10ad7475940758256bc517")
BASE_URL = "https://leadloftexporter.vercel.app/email"
RUN_DATE = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()

# Brand
BG       = "#0A0919"
BG2      = "#08080f"
BG3      = "#05050D"
WHITE    = "#FFFFFF"
MUTED    = "#9A9AAE"
ACCENT   = "#1B90FF"
PHONE    = "+918218929990"
PHONE_FMT= "+91 82189 29990"
WA_LINK  = "https://wa.me/918218929990"
SITE     = "https://hudace.com"
EMAIL_ADDR = "contact@hudace.com"
IG_LINK  = "https://www.instagram.com/hudaceofficial/"
LI_LINK  = "https://www.linkedin.com/company/hudace"

def F(name, size):
    p = os.path.join(FONT_DIR, name)
    if not os.path.exists(p):
        p = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
    return ImageFont.truetype(p, size)

def hx(c):
    c = c.lstrip("#"); return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))

# ---------------------------------------------------------------- assets
def gen_logo():
    """White 'hudace' wordmark on transparent."""
    txt = "hudace"
    f = F("Montserrat-ExtraBold.ttf", 120)
    tmp = Image.new("RGBA", (10, 10)); d = ImageDraw.Draw(tmp)
    bb = d.textbbox((0, 0), txt, font=f)
    w, h = bb[2]-bb[0]+20, bb[3]-bb[1]+20
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.text((10-bb[0], 10-bb[1]), txt, font=f, fill=(255, 255, 255, 255))
    # accent dot
    d.ellipse([w-22, h-32, w-2, h-12], fill=hx(ACCENT)+(255,))
    img.save(os.path.join(EMAIL_DIR, "logo.png"))

def gen_mark():
    """Rounded square brand mark with 'h'."""
    s = 200
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s-1, s-1], radius=44, fill=hx(ACCENT)+(255,))
    f = F("Montserrat-ExtraBold.ttf", 150)
    bb = d.textbbox((0, 0), "h", font=f)
    d.text(((s-(bb[2]-bb[0]))/2-bb[0], (s-(bb[3]-bb[1]))/2-bb[1]), "h", font=f, fill=(255, 255, 255, 255))
    img.save(os.path.join(EMAIL_DIR, "mark.png"))

def gen_icons():
    """White rounded-square social glyph tiles."""
    def tile(draw_glyph, name):
        s = 96
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
        d.rounded_rectangle([0, 0, s-1, s-1], radius=22, fill=(255, 255, 255, 255))
        draw_glyph(d, s)
        img.save(os.path.join(EMAIL_DIR, name))
    W = hx(BG)
    def ig(d, s):
        d.rounded_rectangle([26, 26, s-26, s-26], radius=16, outline=W, width=6)
        d.ellipse([38, 38, s-38, s-38], outline=W, width=6)
        d.ellipse([s-36, 30, s-28, 38], fill=W)
    def li(d, s):
        f = F("Montserrat-Bold.ttf", 46)
        bb = d.textbbox((0, 0), "in", font=f)
        d.text(((s-(bb[2]-bb[0]))/2-bb[0], (s-(bb[3]-bb[1]))/2-bb[1]), "in", font=f, fill=W)
    def wa(d, s):
        d.ellipse([20, 20, s-20, s-20], outline=W, width=6)
        d.ellipse([34, 34, s-34, s-34], fill=W)
        d.ellipse([34, 34, s-34, s-34], outline=W, width=2)
        # handset notch
        d.rectangle([s-40, s-40, s-26, s-26], fill=W)
    tile(ig, "icon-instagram.png")
    tile(li, "icon-linkedin.png")
    tile(wa, "icon-whatsapp.png")

# ---------------------------------------------------------------- photos
def pixabay_pick(query):
    url = (f"https://pixabay.com/api/?key={PIXABAY}&q={urllib.parse.quote(query)}"
           f"&image_type=photo&orientation=vertical&per_page=20&safesearch=true&order=popular")
    req = urllib.request.Request(url, headers={"User-Agent": "hudace-routine/1.0"})
    d = json.load(urllib.request.urlopen(req, timeout=40))
    hits = [h for h in d.get("hits", []) if h["imageHeight"] >= h["imageWidth"]] or d.get("hits", [])
    if not hits:
        raise RuntimeError(f"no pixabay hits for {query!r}")
    return hits

def download_photo(query, outname, used_ids):
    hits = pixabay_pick(query)
    hit = next((h for h in hits if h["id"] not in used_ids), hits[0])
    used_ids.add(hit["id"])
    req = urllib.request.Request(hit["largeImageURL"], headers={"User-Agent": "hudace-routine/1.0"})
    raw = urllib.request.urlopen(req, timeout=90).read()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    # center-crop to 4:5
    tw, th = 1080, 1350
    target = tw/th
    w, h = img.size
    if w/h > target:
        nw = int(h*target); img = img.crop(((w-nw)//2, 0, (w-nw)//2+nw, h))
    else:
        nh = int(w/target); img = img.crop((0, (h-nh)//2, w, (h-nh)//2+nh))
    img = img.resize((tw, th), Image.LANCZOS)
    img.save(os.path.join(EMAIL_DIR, outname), "JPEG", quality=88)
    return outname

# ---------------------------------------------------------------- baked card
def wrap_text(draw, text, font, max_w):
    words = text.split(); lines = []; cur = ""
    for w in words:
        t = (cur+" "+w).strip()
        if draw.textbbox((0, 0), t, font=font)[2] <= max_w:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def bake_card(svc, photo_name, outname):
    W, H = 1080, 1350
    base = Image.open(os.path.join(EMAIL_DIR, photo_name)).convert("RGB").resize((W, H), Image.LANCZOS)
    # darken with vertical gradient toward bottom
    overlay = Image.new("RGB", (W, H), hx(BG3))
    base = Image.blend(base, overlay, 0.45)
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        grad.putpixel((0, y), int(235*(y/H)**1.5))
    grad = grad.resize((W, H))
    base = Image.composite(Image.new("RGB", (W, H), hx(BG3)), base, grad)
    d = ImageDraw.Draw(base, "RGBA")

    # logo
    logo = Image.open(os.path.join(EMAIL_DIR, "logo.png"))
    lw = 300; logo = logo.resize((lw, int(logo.height*lw/logo.width)), Image.LANCZOS)
    base.paste(logo, (70, 70), logo)
    d.text((70, 70+logo.height+14), svc["eyebrow"].upper(), font=F("Montserrat-SemiBold.ttf", 26),
           fill=hx(ACCENT), spacing=2)

    # headline (anchored lower-middle)
    f_head = F("Montserrat-ExtraBold.ttf", 78)
    lines = wrap_text(d, svc["headline"], f_head, W-140)
    y = 470
    for ln in lines:
        d.text((70, y), ln, font=f_head, fill=(255, 255, 255, 255))
        y += 88
    y += 10
    f_sub = F("Montserrat-Medium.ttf", 31)
    for ln in wrap_text(d, svc["sub"], f_sub, W-140)[:2]:
        d.text((70, y), ln, font=f_sub, fill=hx(MUTED)); y += 40
    y += 30

    # deliverables (accent rule + up to 6)
    d.line([(72, y), (140, y)], fill=hx(ACCENT), width=5); y += 28
    f_item = F("Montserrat-Medium.ttf", 33)
    for it in svc["card_items"][:6]:
        d.ellipse([74, y+12, 88, y+26], fill=hx(ACCENT))
        for j, ln in enumerate(wrap_text(d, it, f_item, W-180)):
            d.text((112, y), ln, font=f_item, fill=(236, 236, 244, 255)); y += 44
        y += 8

    # CTA pill + contact
    cy = H-150
    d.rounded_rectangle([70, cy, 470, cy+72], radius=36, fill=hx(ACCENT)+(255,))
    ct = "Chat on WhatsApp"
    f_c = F("Montserrat-Bold.ttf", 32)
    bb = d.textbbox((0, 0), ct, font=f_c)
    d.text((70+(400-(bb[2]-bb[0]))/2, cy+(72-(bb[3]-bb[1]))/2-bb[1]), ct, font=f_c, fill=(255, 255, 255, 255))
    d.text((70, H-58), f"{PHONE}   |   hudace.com", font=F("Montserrat-Medium.ttf", 28), fill=hx(MUTED))

    base.save(os.path.join(EMAIL_DIR, outname), "JPEG", quality=90)
    return outname

# ---------------------------------------------------------------- email html
def btns(center=False):
    al = "center" if center else "left"
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="{al}">
      <tr>
        <td style="padding:6px 8px 6px 0;">
          <a href="{WA_LINK}" style="display:inline-block;background:{ACCENT};color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:8px;">Chat on WhatsApp</a>
        </td>
        <td style="padding:6px 0;">
          <a href="{SITE}" style="display:inline-block;border:1px solid {ACCENT};color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:8px;">Visit Our Website</a>
        </td>
      </tr>
    </table>"""

def deliverable_rows(items):
    out = ""
    for it in items:
        out += f"""<tr><td valign="top" style="padding:5px 10px 5px 0;color:{ACCENT};font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">&#9679;</td>
        <td valign="top" style="padding:5px 0;color:#E9E9F2;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">{it}</td></tr>"""
    return out

def hook_rows(hooks):
    out = ""
    for i, (h, b) in enumerate(hooks, 1):
        out += f"""<tr><td valign="top" style="padding:8px 12px 8px 0;"><span style="display:inline-block;width:30px;height:30px;background:{ACCENT};color:#ffffff;border-radius:15px;text-align:center;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;line-height:30px;">{i}</span></td>
        <td valign="top" style="padding:6px 0;"><div style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;line-height:21px;">{h}</div>
        <div style="color:{MUTED};font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:21px;padding-top:2px;">{b}</div></td></tr>"""
    return out

def build_email(svc, industry, photo_url, card_url):
    deliv = deliverable_rows(svc["deliverables"])
    hooks = hook_rows(svc["hooks"])
    scope = svc["scope"].format(industry=industry)
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>{svc['name']} | Hudace</title>
<style>
  @media (prefers-color-scheme: light) {{
    .bgmain{{background:{BG}!important;}} .bgcard{{background:{BG2}!important;}}
    .tw{{color:#ffffff!important;}} .tm{{color:{MUTED}!important;}}
  }}
  [data-ogsc] .bgmain{{background:{BG}!important;}} [data-ogsc] .bgcard{{background:{BG2}!important;}}
  [data-ogsc] .tw{{color:#ffffff!important;}} [data-ogsc] .tm{{color:{MUTED}!important;}}
  @media only screen and (max-width:480px) {{
    .stackbtn a{{display:block!important;width:auto!important;text-align:center!important;margin-bottom:10px!important;}}
  }}
</style></head>
<body style="margin:0;padding:0;background:{BG3};" bgcolor="{BG3}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:{BG3};">{svc['preheader']}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG3}" style="background:{BG3};">
<tr><td align="center" style="padding:0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="bgmain" bgcolor="{BG}" style="width:600px;max-width:600px;background:{BG};">

  <!-- header -->
  <tr><td bgcolor="{BG2}" class="bgcard" style="background:{BG2};padding:20px 28px;">
    <img src="{BASE_URL}/logo.png" width="150" alt="Hudace" style="display:block;border:0;height:auto;">
  </td></tr>

  <!-- hero: live text -->
  <tr><td bgcolor="{BG2}" class="bgcard" style="background:{BG2};padding:34px 28px 24px 28px;">
    <div style="color:{ACCENT};font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">{svc['eyebrow']}</div>
    <div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:34px;line-height:40px;font-weight:800;padding-top:10px;">{svc['headline']}</div>
    <div class="tm" style="color:{MUTED};font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;padding-top:12px;">{svc['sub']}</div>
    <div style="padding-top:18px;" class="stackbtn">{btns()}</div>
  </td></tr>

  <!-- hero photo -->
  <tr><td bgcolor="{BG2}" class="bgcard" style="background:{BG2};padding:0 0 4px 0;">
    <img src="{photo_url}" width="600" alt="{svc['name']}" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
  </td></tr>

  <!-- deliverables -->
  <tr><td style="padding:30px 28px 6px 28px;">
    <div style="color:{ACCENT};font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">What you get</div>
    <div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:700;padding:8px 0 14px 0;">{svc['deliver_title']}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{deliv}</table>
  </td></tr>

  <!-- industry scope -->
  <tr><td style="padding:22px 28px 6px 28px;">
    <div style="color:{ACCENT};font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">In your sector</div>
    <div class="tm" style="color:#D4D4E0;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;padding-top:10px;">{scope}</div>
    <div class="tm" style="color:{MUTED};font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:23px;padding-top:10px;">{svc['proof']}</div>
  </td></tr>

  <!-- why it works -->
  <tr><td style="padding:24px 28px 6px 28px;">
    <div style="color:{ACCENT};font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Why it works</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding-top:8px;">{hooks}</table>
  </td></tr>

  <!-- future scope + close -->
  <tr><td style="padding:22px 28px 4px 28px;">
    <div class="tm" style="color:#D4D4E0;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;">{svc['future']}</div>
    <div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:17px;line-height:25px;font-weight:700;padding-top:14px;">{svc['close']}</div>
  </td></tr>

  <!-- close CTA -->
  <tr><td align="center" style="padding:18px 28px 30px 28px;" class="stackbtn">{btns(center=True)}</td></tr>

  <!-- footer -->
  <tr><td bgcolor="{BG3}" style="background:{BG3};padding:24px 28px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:6px;"><img src="{BASE_URL}/mark.png" width="34" alt="Hudace" style="display:block;border:0;border-radius:8px;"></td>
      <td style="vertical-align:middle;">
        <a href="{IG_LINK}" style="text-decoration:none;"><img src="{BASE_URL}/icon-instagram.png" width="30" alt="Instagram" style="border:0;margin:0 4px;"></a>
        <a href="{LI_LINK}" style="text-decoration:none;"><img src="{BASE_URL}/icon-linkedin.png" width="30" alt="LinkedIn" style="border:0;margin:0 4px;"></a>
        <a href="{WA_LINK}" style="text-decoration:none;"><img src="{BASE_URL}/icon-whatsapp.png" width="30" alt="WhatsApp" style="border:0;margin:0 4px;"></a>
      </td>
    </tr></table>
    <div style="color:{MUTED};font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;padding-top:14px;">hudace.com &middot; {EMAIL_ADDR} &middot; {PHONE_FMT}</div>
    <div style="color:#6A6A7E;font-family:Montserrat,Arial,sans-serif;font-size:11px;line-height:18px;padding-top:6px;">You are receiving this because you expressed interest in Hudace. <a href="{SITE}" style="color:#6A6A7E;">Unsubscribe</a></div>
  </td></tr>

</table></td></tr></table></body></html>"""

# ---------------------------------------------------------------- messages
def whatsapp_text(svc, industry):
    items = " | ".join(svc["card_items"][:4])
    return (f"{svc['headline']} for {industry.lower()}.\n\n"
            f"What you get: {items}.\n\n{svc['wa_line']}\n\n"
            f"Talk to us on WhatsApp: {WA_LINK}\nhudace.com")

def linkedin_text(svc, industry):
    lines = "\n".join(f"- {x}" for x in svc["card_items"][:5])
    return (f"{svc['headline']}\n\n{svc['li_hook'].format(industry=industry)}\n\n"
            f"What teams get from Hudace:\n{lines}\n\n"
            f"{svc['proof']}\n\n"
            f"If this fits your roadmap, a short conversation is the fastest next step.\n"
            f"WhatsApp {PHONE_FMT} | hudace.com | {EMAIL_ADDR}\n\n"
            f"#Hudace #AI #{svc['hashtag']}")

def outreach_text(svc, industry):
    items = ", ".join(svc["card_items"][:4])
    return (f"Subject: {svc['headline']} for {industry.lower()} teams\n\n"
            f"Hello,\n\n{svc['out_open'].format(industry=industry)}\n\n"
            f"Hudace would deliver: {items}, with {svc['out_scope']}.\n\n"
            f"{svc['proof']}\n\n"
            f"Would you be open to a short call this week? You can also reach us on "
            f"WhatsApp at {PHONE_FMT}.\n\nHudace\nhudace.com | {EMAIL_ADDR}")

# ---------------------------------------------------------------- service data
SERVICES = [
    {
        "key": "social-media", "name": "Social Media", "eyebrow": "Social Media",
        "hashtag": "SocialMedia", "query": "dark cinematic video production studio",
        "headline": "A social presence that compounds", "sub": "Six short videos a month and a full content engine, managed end to end.",
        "preheader": "Six short videos, twelve posts, and full community management every month.",
        "deliver_title": "A complete monthly social engine",
        "deliverables": ["6 short-form videos / month", "12 feed posts / month", "8 stories / month",
            "Captions and hashtag sets", "Content calendar and scheduling",
            "Community management (comments and DMs)", "Monthly performance report"],
        "card_items": ["6 short videos / month", "12 feed posts / month", "8 stories / month",
            "Community management", "Monthly performance report"],
        "scope": "For {industry}, we turn product launches, offers, and behind-the-scenes moments into a steady stream of short video and feed content that keeps the brand in front of buyers between purchases.",
        "proof": "We have run social programs for product and service brands where consistent short-form output lifted reach and inbound messages without raising ad spend.",
        "future": "As the account matures we layer in paid amplification and creator collaborations, so organic reach and performance budget work from the same calendar.",
        "close": "Hand us the calendar and we keep the channel alive every week.",
        "wa_line": "One team handles filming, posting, and replies so your channel never goes quiet.",
        "li_hook": "Most {industry} brands post in bursts, then go quiet for weeks. Buyers notice the silence.",
        "out_open": "I noticed your {industry} brand has room to show up more consistently on social.",
        "out_scope": "a content calendar and community management handled for you",
        "hooks": [("Consistency beats intensity", "A fixed monthly output keeps the brand visible every week, not just at launch."),
            ("Video is the format buyers watch", "Six short videos a month meet people where attention already is."),
            ("Replies close the loop", "Managed comments and DMs turn passive reach into real conversations.")],
    },
    {
        "key": "seo", "name": "SEO / AEO / GEO / SRX", "eyebrow": "Search Visibility",
        "hashtag": "SEO", "query": "dark data analytics dashboard screen",
        "headline": "Be found in search and in AI answers", "sub": "Classic SEO plus visibility inside the AI answers your buyers now read first.",
        "preheader": "Technical SEO, content, and visibility inside AI-generated answers.",
        "deliver_title": "Full-spectrum search visibility",
        "deliverables": ["Technical SEO audit and fixes", "Keyword and intent research",
            "On-page optimization (titles, meta, headings, schema)", "Content briefs and optimization",
            "Authority and backlink building", "Local SEO (profile, citations, maps)",
            "AEO: answer-engine optimization (FAQ, structured answers)", "GEO: visibility inside AI-generated answers",
            "SRX: search experience and Core Web Vitals", "Monthly ranking and traffic report"],
        "card_items": ["Technical SEO audit and fixes", "Keyword and intent research",
            "Answer-engine optimization (AEO)", "Visibility in AI answers (GEO)", "Monthly ranking report"],
        "scope": "For {industry}, we map the questions buyers actually type and ask, then make sure the brand answers them in search results, in maps, and inside AI-generated responses.",
        "proof": "We have moved service and product sites from page two to consistent top placements while cleaning up the technical issues that quietly cap traffic.",
        "future": "Once rankings stabilize we extend coverage into new buyer questions and AI surfaces, so the brand keeps appearing as search behavior shifts.",
        "close": "We make your site the answer, not just a result.",
        "wa_line": "We cover classic rankings and the new AI answer surfaces in one program.",
        "li_hook": "Buyers in {industry} increasingly get answers from AI before they ever click a link.",
        "out_open": "A quick look suggests your {industry} site is missing visibility in both search and AI answers.",
        "out_scope": "technical fixes and answer-ready content",
        "hooks": [("Intent over volume", "We target the questions that signal a buyer, not just high traffic terms."),
            ("AI answers are the new front page", "GEO and AEO put the brand inside the responses buyers read first."),
            ("Speed and structure rank", "Core Web Vitals and schema make pages both faster and easier to surface.")],
    },
    {
        "key": "website", "name": "Website Design", "eyebrow": "Website Design",
        "hashtag": "WebDesign", "query": "dark modern laptop website interface",
        "headline": "A website built to convert", "sub": "A fast, mobile-first site with the forms and integrations that turn visits into leads.",
        "preheader": "Custom, mobile-first website with forms, CMS, and WhatsApp built in.",
        "deliver_title": "A launch-ready website you can run yourself",
        "deliverables": ["Custom multi-page website", "Mobile-first responsive build",
            "Booking, lead, and contact forms", "CMS to edit content yourself",
            "SEO-ready structure and speed", "Analytics and WhatsApp integration",
            "Hosting and domain setup", "Launch and handover"],
        "card_items": ["Custom multi-page website", "Mobile-first responsive build",
            "Booking and lead forms", "CMS to edit it yourself", "WhatsApp and analytics"],
        "scope": "For {industry}, we design pages around the decisions buyers make, with clear paths to enquire, book, or message so the site does sales work around the clock.",
        "proof": "We have rebuilt sites where a cleaner structure and faster load lifted enquiries from the same traffic the brand already had.",
        "future": "The CMS and modular build mean new services, locations, or campaigns can be added later without a rebuild.",
        "close": "We design it, build it, and hand you the keys.",
        "wa_line": "Mobile-first, form-ready, and editable by your own team after launch.",
        "li_hook": "For many {industry} brands the website looks fine but quietly loses the enquiry.",
        "out_open": "Your {industry} site may be costing enquiries through speed or unclear paths to contact.",
        "out_scope": "hosting, forms, and handover included",
        "hooks": [("Mobile-first by default", "Most visits are on a phone, so the build starts there, not as an afterthought."),
            ("Every page has a next step", "Forms, booking, and WhatsApp turn interest into a captured lead."),
            ("You stay in control", "A CMS lets your team update content without waiting on a developer.")],
    },
    {
        "key": "erp", "name": "ERP Building", "eyebrow": "Custom Software",
        "hashtag": "ERP", "query": "dark server room blue technology",
        "headline": "Software shaped around how you work", "sub": "Custom modules, automations, and dashboards that replace the spreadsheets holding teams back.",
        "preheader": "Custom business software: CRM, inventory, billing, automations, dashboards.",
        "deliver_title": "A custom platform for your operation",
        "deliverables": ["Discovery and module blueprint", "Custom modules (CRM, inventory, billing, HR, and more)",
            "Role-based access and dashboards", "Workflow automations",
            "Integrations (payments, messaging, APIs)", "Web and mobile access",
            "Training and documentation", "Ongoing support and iterations"],
        "card_items": ["Discovery and module blueprint", "Custom CRM, inventory, billing, HR",
            "Role-based dashboards", "Workflow automations", "Web and mobile access"],
        "scope": "For {industry}, we map the daily workflow and build the exact modules the team needs, so quoting, stock, billing, and reporting live in one system instead of scattered files.",
        "proof": "We have replaced spreadsheet-driven operations with custom platforms that cut manual handoffs and gave leaders a single live view.",
        "future": "Built modular, the platform grows with new workflows and integrations as the operation scales, without starting over.",
        "close": "One system your team actually wants to use.",
        "wa_line": "We build the modules your business runs on, then support them as you grow.",
        "li_hook": "Many {industry} teams run critical work on spreadsheets that no longer keep up.",
        "out_open": "If your {industry} operation still runs on spreadsheets, a custom system could remove the manual work.",
        "out_scope": "training and ongoing support included",
        "hooks": [("Built for your workflow", "Modules match how the team actually works, not a generic template."),
            ("Automation removes the busywork", "Workflows handle the repetitive steps that drain hours each week."),
            ("One live source of truth", "Role-based dashboards give every level the view it needs.")],
    },
    {
        "key": "ai-work-studio", "name": "AI Work Studio", "eyebrow": "AI Work Studio",
        "hashtag": "AIVideo", "query": "dark cinematic film lighting moody",
        "headline": "A cinematic film without a film crew", "sub": "AI-generated film, social cuts, and stills delivered in seven working days.",
        "preheader": "A 60-second cinematic film, three social cuts, and ten stills in seven days.",
        "deliver_title": "A full cinematic package, AI-generated",
        "deliverables": ["60-second cinematic film", "Three 15-second social cuts",
            "Ten AI-generated stills", "Script and concept included",
            "Delivered in seven working days, no film crew"],
        "card_items": ["60-second cinematic film", "Three 15-second social cuts",
            "Ten AI-generated stills", "Script and concept included", "Delivered in seven days"],
        "scope": "For {industry}, we turn a product or service story into a cinematic film and a set of social cuts, without the cost and scheduling of a live shoot.",
        "proof": "We have produced launch films and ad cuts entirely with AI that gave brands a premium look at a fraction of traditional production time.",
        "future": "Once the visual style is set, new films and seasonal cuts can be produced quickly from the same concept system.",
        "close": "Premium film, delivered in a week.",
        "wa_line": "Cinematic film plus social cuts and stills, all AI-generated in seven days.",
        "li_hook": "A cinematic launch in {industry} no longer needs a crew, a set, or weeks of scheduling.",
        "out_open": "If your {industry} brand needs a premium video without a shoot, this is built for you.",
        "out_scope": "script and concept included",
        "hooks": [("Premium look, no production drag", "AI generation removes crews, sets, and scheduling from the timeline."),
            ("One shoot, many cuts", "A film plus three social cuts feed every channel from one concept."),
            ("Seven-day delivery", "A fixed, fast turnaround keeps launches on schedule.")],
    },
    {
        "key": "schoolos", "name": "SchoolOS School ERP", "eyebrow": "SchoolOS School ERP",
        "hashtag": "SchoolERP", "query": "dark modern classroom technology",
        "headline": "One system to run the whole school", "sub": "Admissions to fees, attendance to report cards, with a parent app on top.",
        "preheader": "Admissions, fees, attendance, exams, and a parent app in one system.",
        "deliver_title": "Every school operation in one platform",
        "deliverables": ["Admissions: online enquiry to enrollment", "Student records: profiles, documents, history",
            "Attendance: daily and period, parent alerts", "Fees: invoices, online payments, reminders, receipts",
            "Examinations: marks, grading, report cards", "Timetable: classes, teachers, substitutions",
            "Communication: announcements and parent app", "Transport: routes, vehicles, live tracking",
            "Library: catalog, issue and return", "HR and payroll: staff and salaries",
            "Reports: management dashboards"],
        "card_items": ["Admissions to enrollment", "Fees, online payments, receipts",
            "Attendance with parent alerts", "Exams and report cards", "Parent app and dashboards"],
        "scope": "For an education institution, SchoolOS connects admissions, fees, attendance, exams, transport, and HR so staff stop rekeying data across disconnected tools and parents get one app.",
        "proof": "We have moved schools off scattered registers and spreadsheets onto one platform that cut fee-collection effort and gave leadership live dashboards.",
        "future": "With Nectar, our AI layer, routine admin and follow-up are automated and management gets summaries across every module as the institution grows.",
        "close": "Run the whole campus from one screen.",
        "wa_line": "Admissions, fees, attendance, exams, and a parent app in a single platform.",
        "li_hook": "Many institutions still run admissions, fees, and attendance in separate tools that never talk to each other.",
        "out_open": "If your institution runs on disconnected registers and spreadsheets, SchoolOS brings it into one system.",
        "out_scope": "a parent app and management dashboards included",
        "hooks": [("One record, every module", "Admissions, attendance, fees, and exams share a single student record."),
            ("Parents stay informed", "A parent app turns alerts, fees, and results into one familiar place."),
            ("Leaders see everything live", "Dashboards and AI summaries replace manual report gathering.")],
    },
]

INDUSTRIES = ["Retail", "Construction and Real Estate"]

def main():
    used_ids = set()
    gen_logo(); gen_mark(); gen_icons()
    batch = []
    report = []
    for i, svc in enumerate(SERVICES):
        industry = INDUSTRIES[i % len(INDUSTRIES)]
        photo_name = f"{svc['key']}-photo.jpg"
        card_name = f"{svc['key']}-card.jpg"
        try:
            download_photo(svc["query"], photo_name, used_ids)
        except Exception as e:
            report.append(f"PHOTO FAIL {svc['key']}: {e!r}")
            # fallback solid
            Image.new("RGB", (1080, 1350), hx(BG3)).save(os.path.join(EMAIL_DIR, photo_name), "JPEG")
        try:
            bake_card(svc, photo_name, card_name)
        except Exception as e:
            report.append(f"CARD FAIL {svc['key']}: {e!r}")
        photo_url = f"{BASE_URL}/{photo_name}"
        card_url = f"{BASE_URL}/{card_name}"
        html = build_email(svc, industry, photo_url, card_url)
        tag = f"[{RUN_DATE}]"
        title = f"{tag} {industry} | {svc['name']}"
        batch.append({"title": title, "type": "html_email", "body": html, "image_url": card_url})
        batch.append({"title": f"{title} (WhatsApp)", "type": "whatsapp",
                      "body": whatsapp_text(svc, industry), "image_url": card_url})
        batch.append({"title": f"{title} (LinkedIn)", "type": "caption",
                      "body": linkedin_text(svc, industry), "image_url": card_url})
        batch.append({"title": f"{title} (Outreach)", "type": "other",
                      "body": outreach_text(svc, industry), "image_url": card_url})
        report.append(f"OK {svc['key']} -> industry {industry}")

    with open(os.path.join(ROOT, "batch.json"), "w") as f:
        json.dump(batch, f, indent=2, ensure_ascii=False)

    # state
    prev = {}
    if os.path.exists(STATE):
        prev = json.load(open(STATE))
    used = prev.get("used_industries", [])
    for ind in INDUSTRIES:
        if ind not in used:
            used.append(ind)
    runs = prev.get("runs", [])
    runs.append({"date": RUN_DATE, "industries": INDUSTRIES, "items": len(batch)})
    json.dump({"used_industries": used, "last_run": RUN_DATE, "runs": runs},
              open(STATE, "w"), indent=2)

    print(f"BUILT items={len(batch)} emails={len(SERVICES)} industries={INDUSTRIES}")
    for r in report:
        print("  ", r)

if __name__ == "__main__":
    main()
