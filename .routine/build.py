#!/usr/bin/env python3
"""Hudace daily content batch builder.
Downloads cinematic photos (Pixabay), bakes 4:5 promo cards, builds email HTML,
and writes batch.json. Each service is isolated so one failure does not stop the rest.
"""
import os, sys, json, io, urllib.request, urllib.parse, html
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = "/home/user/Leadloftexporter"
EMAIL_DIR = os.path.join(ROOT, "public", "email")
os.makedirs(EMAIL_DIR, exist_ok=True)
PIX = "56316516-fbb10ad7475940758256bc517"
BASE_URL = "https://leadloftexporter.vercel.app/email"
RUN_DATE = sys.argv[1] if len(sys.argv) > 1 else "2026-07-10"

# ---- brand ----
BG   = (10, 9, 25)      # #0A0919
BG2  = (8, 8, 15)       # #08080f
BG3  = (5, 5, 13)       # #05050D
WHITE= (255, 255, 255)
MUT  = (154, 154, 174)  # #9A9AAE
BLUE = (27, 144, 255)   # #1B90FF

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
def F(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
def bold(s): return F("DejaVuSans-Bold.ttf", s)
def reg(s):  return F("DejaVuSans.ttf", s)

CONTACT = "hudace.com  |  contact@hudace.com  |  +91 82189 29990"

def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def pixabay_photo(query):
    """Return raw bytes of a large vertical-ish cinematic photo for query."""
    api = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=vertical"
           "&safesearch=true&per_page=20&order=popular" % (PIX, urllib.parse.quote(query)))
    data = json.loads(http_get(api).decode())
    hits = data.get("hits", [])
    if not hits:
        raise RuntimeError("no pixabay hits for %r" % query)
    # prefer the tallest / highest-res
    hits.sort(key=lambda h: h.get("imageHeight", 0) * h.get("imageWidth", 0), reverse=True)
    for h in hits[:6]:
        u = h.get("largeImageURL") or h.get("webformatURL")
        try:
            return http_get(u)
        except Exception:
            continue
    raise RuntimeError("could not download any pixabay hit for %r" % query)

def cover_45(raw, w=1080, h=1350):
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    sw, sh = im.size
    scale = max(w / sw, h / sh)
    nw, nh = int(sw * scale + 1), int(sh * scale + 1)
    im = im.resize((nw, nh), Image.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    return im.crop((left, top, left + w, top + h))

def darken(im, top_a=120, bot_a=235):
    """Vertical dark gradient overlay so overlaid text reads; brand-tinted."""
    w, h = im.size
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = ov.load()
    for y in range(h):
        a = int(top_a + (bot_a - top_a) * (y / h))
        for x in range(0, w, 1):
            px[x, y] = (BG3[0], BG3[1], BG3[2], a)
    base = im.convert("RGBA")
    base.alpha_composite(ov)
    return base.convert("RGB")

def wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines

# ---------- brand assets ----------
def build_logo():
    """White 'hudace' wordmark on transparent."""
    txt = "hudace"
    f = bold(120)
    tmp = Image.new("RGBA", (10, 10))
    d = ImageDraw.Draw(tmp)
    w = int(d.textlength(txt, font=f)) + 40
    img = Image.new("RGBA", (w, 170), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((0, 15), txt, font=f, fill=WHITE)
    # blue dot accent after wordmark
    x = d.textlength(txt, font=f)
    d.ellipse((x + 8, 118, x + 34, 144), fill=BLUE)
    img.save(os.path.join(EMAIL_DIR, "hudace-logo-white.png"))

def build_mark():
    """Rounded-square brand mark with white 'h'."""
    s = 160
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, s - 4, s - 4), radius=36, fill=BLUE)
    f = bold(110)
    tw = d.textlength("h", font=f)
    d.text(((s - tw) / 2, 12), "h", font=f, fill=WHITE)
    img.save(os.path.join(EMAIL_DIR, "hudace-mark.png"))

def _icon_canvas(s=96):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def build_icons():
    s = 96
    # Instagram: rounded square outline + circle + dot
    img, d = _icon_canvas(s)
    d.rounded_rectangle((10, 10, s - 10, s - 10), radius=24, outline=WHITE, width=7)
    d.ellipse((30, 30, s - 30, s - 30), outline=WHITE, width=7)
    d.ellipse((s - 30, 20, s - 20, 30), fill=WHITE)
    img.save(os.path.join(EMAIL_DIR, "icon-instagram.png"))
    # LinkedIn: rounded square with 'in'
    img, d = _icon_canvas(s)
    d.rounded_rectangle((8, 8, s - 8, s - 8), radius=20, outline=WHITE, width=7)
    f = bold(46)
    tw = d.textlength("in", font=f)
    d.text(((s - tw) / 2, 20), "in", font=f, fill=WHITE)
    img.save(os.path.join(EMAIL_DIR, "icon-linkedin.png"))
    # WhatsApp: white circle with phone glyph
    img, d = _icon_canvas(s)
    d.ellipse((8, 8, s - 8, s - 8), outline=WHITE, width=7)
    f = reg(46)
    g = "☎"  # telephone
    tw = d.textlength(g, font=f)
    d.text(((s - tw) / 2, 20), g, font=f, fill=WHITE)
    img.save(os.path.join(EMAIL_DIR, "icon-whatsapp.png"))
    # Facebook: rounded square with 'f'
    img, d = _icon_canvas(s)
    d.rounded_rectangle((8, 8, s - 8, s - 8), radius=20, outline=WHITE, width=7)
    f = bold(56)
    tw = d.textlength("f", font=f)
    d.text(((s - tw) / 2, 14), "f", font=f, fill=WHITE)
    img.save(os.path.join(EMAIL_DIR, "icon-facebook.png"))

# ---------- baked promo card ----------
def build_card(slug, headline, deliverables, cta="Chat on WhatsApp"):
    hero = os.path.join(EMAIL_DIR, "hero-%s.jpg" % slug)
    im = Image.open(hero).convert("RGB")
    im = darken(im, 130, 240)
    w, h = im.size
    d = ImageDraw.Draw(im)
    # logo
    logo = Image.open(os.path.join(EMAIL_DIR, "hudace-logo-white.png")).convert("RGBA")
    lw = 300
    logo = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
    im.paste(logo, (72, 70), logo)
    # headline
    hf = bold(72)
    y = 230
    for ln in wrap(d, headline, hf, w - 144):
        d.text((72, y), ln, font=hf, fill=WHITE)
        y += 84
    # blue rule
    y += 8
    d.rectangle((74, y, 74 + 110, y + 8), fill=BLUE)
    y += 46
    # deliverables label
    lf = bold(30)
    d.text((72, y), "WHAT YOU GET", font=lf, fill=BLUE)
    y += 54
    bf = reg(34)
    shown = deliverables[:7]
    for item in shown:
        d.ellipse((78, y + 12, 92, y + 26), fill=BLUE)
        for i, ln in enumerate(wrap(d, item, bf, w - 220)):
            d.text((112, y), ln, font=bf, fill=(232, 232, 240))
            y += 44
        y += 8
    if len(deliverables) > len(shown):
        d.text((112, y), "and more", font=reg(30), fill=MUT)
        y += 46
    # CTA pill near bottom
    py = h - 200
    pf = bold(36)
    ptw = d.textlength(cta, font=pf)
    d.rounded_rectangle((72, py, 72 + ptw + 80, py + 78), radius=39, fill=BLUE)
    d.text((72 + 40, py + 18), cta, font=pf, fill=WHITE)
    # contact footer
    cf = reg(28)
    d.text((72, h - 90), CONTACT, font=cf, fill=(210, 210, 220))
    out = os.path.join(EMAIL_DIR, "card-%s.jpg" % slug)
    im.save(out, "JPEG", quality=88)
    return out

# ---------- email HTML ----------
def esc(s): return html.escape(s, quote=True)

def cta_pair():
    return (
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">'
      '<tr>'
      '<td style="padding:6px;">'
      '<a href="https://wa.me/918218929990" style="display:block;background:#1B90FF;color:#ffffff;'
      'font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;'
      'padding:14px 26px;border-radius:8px;text-align:center;">Chat on WhatsApp</a></td>'
      '<td style="padding:6px;">'
      '<a href="https://hudace.com" style="display:block;border:1px solid #1B90FF;color:#ffffff;'
      'font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;'
      'padding:13px 26px;border-radius:8px;text-align:center;">Visit Our Website</a></td>'
      '</tr></table>')

def social_row():
    def ic(name, href):
        return ('<a href="%s" style="text-decoration:none;"><img src="%s/icon-%s.png" width="26" height="26" '
                'alt="%s" style="display:inline-block;margin:0 7px;"></a>' % (href, BASE_URL, name, name))
    return ('<div style="text-align:center;">'
            + ic("instagram", "https://www.instagram.com/hudaceofficial/")
            + ic("linkedin", "https://www.linkedin.com/company/hudace")
            + ic("whatsapp", "https://wa.me/918218929990")
            + '</div>')

def build_email(slug, kicker, headline, sub, deliv_label, deliverables,
                scope_line, proof_line, future_line, hooks, closing):
    hero_img = "%s/hero-%s.jpg" % (BASE_URL, slug)
    card_img = "%s/card-%s.jpg" % (BASE_URL, slug)
    logo_img = "%s/hudace-logo-white.png" % BASE_URL
    mark_img = "%s/hudace-mark.png" % BASE_URL

    deliv_rows = ""
    for item in deliverables:
        deliv_rows += (
          '<tr><td valign="top" style="padding:5px 10px 5px 0;color:#1B90FF;'
          'font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;">&bull;</td>'
          '<td style="padding:5px 0;color:#e8e8f0;font-family:Montserrat,Arial,sans-serif;'
          'font-size:15px;line-height:1.5;">%s</td></tr>' % esc(item))

    hook_rows = ""
    for i, (ht, hb) in enumerate(hooks, 1):
        hook_rows += (
          '<tr><td valign="top" style="padding:8px 12px 8px 0;color:#1B90FF;'
          'font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:800;">%d</td>'
          '<td style="padding:8px 0;">'
          '<div style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;">%s</div>'
          '<div style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:1.5;">%s</div>'
          '</td></tr>' % (i, esc(ht), esc(hb)))

    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{sub}</title>
<style>
  @media (prefers-color-scheme: light) {{
    body, .bg1 {{ background:#0A0919 !important; }}
  }}
  @media only screen and (max-width:480px) {{
    .stackbtn {{ display:block !important; width:100% !important; }}
    .stackbtn a {{ display:block !important; }}
    .h1 {{ font-size:30px !important; }}
  }}
  [data-ogsc] body, [data-ogsc] .bg1 {{ background:#0A0919 !important; }}
  [data-ogsc] .txt {{ color:#e8e8f0 !important; }}
</style>
</head>
<body style="margin:0;padding:0;background:#05050D;" bgcolor="#05050D">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{sub}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#05050D" style="background:#05050D;"><tr><td align="center" style="padding:0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="bg1" bgcolor="#0A0919" style="width:600px;max-width:600px;background:#0A0919;">

  <!-- header -->
  <tr><td bgcolor="#05050D" style="background:#05050D;padding:20px 28px;" align="left">
    <img src="{logo}" width="150" alt="Hudace" style="display:block;">
  </td></tr>

  <!-- hero live text -->
  <tr><td bgcolor="#08080f" style="background:#08080f;padding:34px 28px 26px 28px;" align="center">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">{kicker}</div>
    <div class="h1" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:36px;font-weight:800;line-height:1.15;margin:12px 0 10px 0;">{headline}</div>
    <div class="txt" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:1.6;max-width:440px;margin:0 auto 22px auto;">{sub}</div>
    {cta}
  </td></tr>

  <!-- hero photo -->
  <tr><td bgcolor="#08080f" style="background:#08080f;padding:0;" align="center">
    <img src="{hero}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;">
  </td></tr>

  <!-- deliverables -->
  <tr><td bgcolor="#0A0919" style="background:#0A0919;padding:34px 32px 10px 32px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">{deliv_label}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">{deliv_rows}</table>
  </td></tr>

  <!-- industry scope -->
  <tr><td bgcolor="#0A0919" style="background:#0A0919;padding:14px 32px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">In Your Sector</div>
    <div class="txt" style="color:#e8e8f0;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:1.6;margin-top:10px;">{scope}</div>
    <div style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:1.6;margin-top:8px;">{proof}</div>
    <div style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:1.6;margin-top:8px;">{future}</div>
  </td></tr>

  <!-- baked card image -->
  <tr><td bgcolor="#0A0919" style="background:#0A0919;padding:20px 32px;" align="center">
    <img src="{card}" width="440" alt="" style="display:block;width:100%;max-width:440px;height:auto;border-radius:10px;">
  </td></tr>

  <!-- why it works -->
  <tr><td bgcolor="#08080f" style="background:#08080f;padding:30px 32px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Why It Works</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">{hook_rows}</table>
  </td></tr>

  <!-- closing + cta -->
  <tr><td bgcolor="#0A0919" style="background:#0A0919;padding:30px 32px;" align="center">
    <div class="txt" style="color:#e8e8f0;font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:1.6;margin-bottom:20px;">{closing}</div>
    {cta}
  </td></tr>

  <!-- footer -->
  <tr><td bgcolor="#05050D" style="background:#05050D;padding:26px 32px;" align="center">
    <img src="{mark}" width="40" height="40" alt="Hudace" style="display:block;margin:0 auto 14px auto;">
    {social}
    <div style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:13px;margin-top:16px;">hudace.com &middot; contact@hudace.com &middot; +91 82189 29990</div>
    <div style="color:#6b6b7e;font-family:Montserrat,Arial,sans-serif;font-size:12px;margin-top:10px;">
      You are receiving this because you expressed interest in Hudace. <a href="https://hudace.com" style="color:#6b6b7e;">Unsubscribe</a>.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>""".format(
        sub=esc(sub), kicker=esc(kicker), headline=esc(headline),
        deliv_label=esc(deliv_label), deliv_rows=deliv_rows, hook_rows=hook_rows,
        scope=esc(scope_line), proof=esc(proof_line), future=esc(future_line),
        closing=esc(closing), cta=cta_pair(), social=social_row(),
        hero=hero_img, card=card_img, logo=logo_img, mark=mark_img)

# ---------- service definitions ----------
SERVICES = json.load(open(os.path.join(os.path.dirname(__file__), "services.json")))

def main():
    print("Building brand assets...")
    build_logo(); build_mark(); build_icons()
    batch = []
    failures = []
    for sv in SERVICES:
        slug = sv["slug"]
        try:
            print("== %s ==" % slug)
            raw = pixabay_photo(sv["query"])
            hero = cover_45(raw)
            hero.save(os.path.join(EMAIL_DIR, "hero-%s.jpg" % slug), "JPEG", quality=88)
            build_card(slug, sv["card_headline"], sv["deliverables"])
            email_html = build_email(
                slug, sv["kicker"], sv["headline"], sv["sub"],
                sv["deliv_label"], sv["deliverables"],
                sv["scope"], sv["proof"], sv["future"], sv["hooks"], sv["closing"])
            card_url = "%s/card-%s.jpg" % (BASE_URL, slug)
            name = sv["name"]
            batch.append({"title": "[%s] %s" % (RUN_DATE, name), "type": "html_email",
                          "body": email_html, "image_url": card_url})
            batch.append({"title": "[%s] %s - WhatsApp" % (RUN_DATE, name), "type": "whatsapp",
                          "body": sv["whatsapp"], "image_url": card_url})
            batch.append({"title": "[%s] %s - LinkedIn" % (RUN_DATE, name), "type": "caption",
                          "body": sv["linkedin"], "image_url": card_url})
            batch.append({"title": "[%s] %s - Outreach" % (RUN_DATE, name), "type": "other",
                          "body": sv["outreach"], "image_url": card_url})
            print("  ok")
        except Exception as e:
            print("  FAILED:", e)
            failures.append("%s: %s" % (slug, e))
    with open(os.path.join(ROOT, "batch.json"), "w") as f:
        json.dump(batch, f, indent=2, ensure_ascii=False)
    print("\nBatch items:", len(batch), " failures:", len(failures))
    for x in failures: print("  -", x)

if __name__ == "__main__":
    main()
