#!/usr/bin/env python3
"""Build the Hudace daily content batch: photos, email HTML, baked promo JPGs,
message variants, and batch.json. Each email is independent; failures are logged
and the rest continue."""
import os, json, io, time, urllib.parse, urllib.request, textwrap, html as _html
from PIL import Image, ImageDraw, ImageFont, ImageFilter

DATE = "2026-06-20"
OUT = "public/email"
FONT = "assets/Montserrat.ttf"
PIX = "56316516-fbb10ad7475940758256bc517"
DOMAIN = "https://leadloftexporter.vercel.app/email"
os.makedirs(OUT, exist_ok=True)

BG0, BG1, BG2 = "#05050D", "#0A0919", "#08080f"
BLUE = "#1B90FF"; WHITE = "#ffffff"; MUTE = "#9A9AAE"
BLUE_RGB = (27, 144, 255)
WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"
PHONE = "+91 82189 29990"
EMAIL = "contact@hudace.com"
WEB = "hudace.com"
errors = []

def font(sz, w=700):
    f = ImageFont.truetype(FONT, sz)
    try: f.set_variation_by_axes([w])
    except Exception: pass
    return f

# ---------------- Pixabay photo -> 4:5 ----------------
def crop_4_5(im, tw=1080, th=1350):
    im = im.convert("RGB")
    w, h = im.size
    target = tw / th
    if w / h > target:
        nw = int(h * target); x = (w - nw) // 2
        im = im.crop((x, 0, x + nw, h))
    else:
        nh = int(w / target); y = (h - nh) // 2
        im = im.crop((0, y, w, y + nh))
    return im.resize((tw, th), Image.LANCZOS)

def fetch_photo(query, dest):
    url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo&orientation=vertical"
           "&safesearch=true&per_page=20&min_width=1080") % (PIX, urllib.parse.quote(query))
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    hits = data.get("hits", [])
    if not hits:
        # retry without vertical constraint
        url = ("https://pixabay.com/api/?key=%s&q=%s&image_type=photo"
               "&safesearch=true&per_page=20&min_width=1280") % (PIX, urllib.parse.quote(query))
        with urllib.request.urlopen(url, timeout=30) as r:
            hits = json.load(r).get("hits", [])
    if not hits:
        raise RuntimeError("no pixabay hits for %r" % query)
    hits.sort(key=lambda h: h.get("imageWidth", 0), reverse=True)
    src = hits[0].get("largeImageURL") or hits[0].get("webformatURL")
    req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    im = crop_4_5(Image.open(io.BytesIO(raw)))
    im.save(dest, "JPEG", quality=86)
    return os.path.basename(dest)

def placeholder(dest):
    im = Image.new("RGB", (1080, 1350), (10, 9, 25))
    d = ImageDraw.Draw(im)
    for y in range(1350):
        t = y / 1350
        d.line([(0, y), (1080, y)], fill=(int(10 + 12 * t), int(9 + 14 * t), int(25 + 40 * t)))
    im.save(dest, "JPEG", quality=86)
    return os.path.basename(dest)

# ---------------- baked promo card ----------------
def wrap_to_width(d, text, fnt, max_w):
    words = text.split(); lines = []; cur = ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def bake_card(hero_path, headline, label, deliverables, dest):
    base = Image.open(hero_path).convert("RGB").resize((1080, 1350), Image.LANCZOS)
    # darken
    dark = Image.new("RGB", base.size, (0, 0, 0))
    base = Image.blend(base, dark, 0.55)
    # bottom gradient
    grad = Image.new("L", (1, 1350), 0)
    for y in range(1350):
        grad.putpixel((0, y), int(235 * max(0, (y - 520) / 830)))
    grad = grad.resize((1080, 1350))
    base = Image.composite(Image.new("RGB", base.size, (5, 5, 13)), base, grad)
    d = ImageDraw.Draw(base)
    M = 80
    # top logo wordmark
    try:
        logo = Image.open("public/email/hudace-logo-white.png").convert("RGBA")
        lw = 300; lh = int(logo.height * lw / logo.width)
        base.paste(logo.resize((lw, lh)), (M, 70), logo.resize((lw, lh)))
    except Exception:
        d.text((M, 78), "HUDACE", font=font(64, 800), fill=WHITE)
    # label eyebrow
    y = 470
    d.text((M, y), label.upper(), font=font(30, 700), fill=BLUE_RGB)
    y += 60
    # headline
    hf = font(82, 800)
    for ln in wrap_to_width(d, headline, hf, 1080 - 2 * M):
        d.text((M, y), ln, font=hf, fill=(255, 255, 255))
        y += 92
    y += 26
    # deliverables
    df = font(34, 600)
    for item in deliverables[:4]:
        d.ellipse([M, y + 14, M + 12, y + 26], fill=BLUE_RGB)
        for i, ln in enumerate(wrap_to_width(d, item, df, 1080 - 2 * M - 40)):
            d.text((M + 36, y), ln, font=df, fill=(232, 232, 240))
            y += 44
        y += 12
    # CTA pill + contact at bottom
    by = 1218
    d.rounded_rectangle([M, by, M + 470, by + 74], radius=37, fill=BLUE_RGB)
    cf = font(32, 700)
    ct = "Chat on WhatsApp"
    tw = d.textlength(ct, font=cf)
    d.text((M + (470 - tw) / 2, by + 19), ct, font=cf, fill=WHITE)
    d.text((M, by + 96), "%s   %s   %s" % (PHONE, EMAIL, WEB), font=font(26, 600), fill=(180, 180, 196))
    base.save(dest, "JPEG", quality=88)
    return os.path.basename(dest)

# ---------------- email HTML ----------------
def esc(s): return _html.escape(s, quote=True)

FAMILY = "Montserrat, Arial, Helvetica, sans-serif"

def cta_pair():
    return (
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%%"><tr>'
      '<td class="btncell" style="padding:0 8px 8px 0;">'
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btna" style="width:100%%;">'
      '<tr><td bgcolor="%s" align="center" style="border-radius:8px;">'
      '<a href="%s" style="display:block;padding:14px 22px;font-family:%s;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Chat on WhatsApp</a>'
      '</td></tr></table></td>'
      '<td class="btncell" style="padding:0 0 8px 0;">'
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btna" style="width:100%%;">'
      '<tr><td align="center" style="border-radius:8px;border:1px solid #2a2a3d;">'
      '<a href="%s" style="display:block;padding:14px 22px;font-family:%s;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Visit Our Website</a>'
      '</td></tr></table></td></tr></table>' % (BLUE, WA, FAMILY, SITE, FAMILY)
    )

def section(label, inner, bg=BG1):
    return (
      '<tr><td class="%s" bgcolor="%s" style="padding:30px 36px;">'
      '<div style="font-family:%s;font-size:12px;font-weight:700;letter-spacing:2px;color:%s;text-transform:uppercase;margin:0 0 14px 0;">%s</div>'
      '%s</td></tr>' % ("bg1" if bg == BG1 else "bg0", bg, FAMILY, BLUE, esc(label), inner)
    )

def para(t, color=MUTE, size=15):
    return '<p class="tm" style="font-family:%s;font-size:%dpx;line-height:1.6;color:%s;margin:0 0 12px 0;">%s</p>' % (FAMILY, size, color, esc(t))

def deliverable_rows(items):
    rows = ""
    for it in items:
        rows += ('<tr><td valign="top" style="padding:0 12px 12px 0;width:10px;">'
                 '<div style="width:7px;height:7px;border-radius:50%%;background:%s;margin-top:7px;"></div></td>'
                 '<td valign="top" style="padding:0 0 12px 0;font-family:%s;font-size:15px;line-height:1.55;color:#e8e8f0;">%s</td></tr>'
                 % (BLUE, FAMILY, esc(it)))
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%%">%s</table>' % rows

def hook_rows(hooks):
    rows = ""
    for i, (h, t) in enumerate(hooks, 1):
        rows += ('<tr><td valign="top" style="padding:0 14px 18px 0;width:34px;">'
                 '<div style="width:30px;height:30px;border-radius:50%%;background:%s;color:#fff;font-family:%s;font-size:14px;font-weight:700;text-align:center;line-height:30px;">%d</div></td>'
                 '<td valign="top" style="padding:0 0 18px 0;">'
                 '<div style="font-family:%s;font-size:15px;font-weight:700;color:#ffffff;margin:0 0 4px 0;">%s</div>'
                 '<div class="tm" style="font-family:%s;font-size:14px;line-height:1.55;color:%s;">%s</div></td></tr>'
                 % (BLUE, FAMILY, i, FAMILY, esc(h), FAMILY, MUTE, esc(t)))
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%%">%s</table>' % rows

def img_tag(fname, alt):
    return ('<img src="%s/%s" width="600" alt="%s" style="display:block;width:100%%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;">'
            % (DOMAIN, fname, esc(alt)))

def social_row():
    icons = [("instagram", "https://www.instagram.com/hudaceofficial/"),
             ("linkedin", "https://www.linkedin.com/company/hudace"),
             ("whatsapp", WA)]
    cells = ""
    for name, link in icons:
        cells += ('<td style="padding:0 6px;"><a href="%s"><img src="%s/icon-%s.png" width="34" height="34" alt="%s" style="display:block;border:0;"></a></td>'
                  % (link, DOMAIN, name, name))
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>%s</tr></table>' % cells

def build_email(spec):
    delivers_label = spec.get("deliver_label", "What We Deliver")
    scope_label = spec.get("scope_label", "Scope For Your Industry")
    body_img = img_tag(spec["body_file"], spec["headline"]) if spec.get("body_file") else ""
    future_html = section("Future Scope", para(spec["future"]), BG1) if spec.get("future") else ""
    proof_html = ""
    if spec.get("proof"):
        proof_html = ('<tr><td class="bg0" bgcolor="%s" style="padding:24px 36px;">'
                      '<div style="border-left:3px solid %s;padding:4px 0 4px 16px;font-family:%s;font-size:15px;line-height:1.6;color:#e8e8f0;font-style:italic;">%s</div></td></tr>'
                      % (BG0, BLUE, FAMILY, esc(spec["proof"])))
    html = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>{title}</title>
<style>
:root{{color-scheme:dark;supported-color-schemes:dark;}}
body{{margin:0;padding:0;background:#05050D;}}
@media (prefers-color-scheme:light){{
 .bg0{{background-color:#05050D!important;}} .bg1{{background-color:#0A0919!important;}} .bg2{{background-color:#08080f!important;}}
 .tw{{color:#ffffff!important;}} .tm{{color:#9A9AAE!important;}}
}}
[data-ogsc] .bg0{{background-color:#05050D!important;}} [data-ogsc] .bg1{{background-color:#0A0919!important;}} [data-ogsc] .bg2{{background-color:#08080f!important;}}
[data-ogsc] .tw{{color:#ffffff!important;}} [data-ogsc] .tm{{color:#9A9AAE!important;}}
@media only screen and (max-width:600px){{
 .container{{width:100%!important;}}
 .btncell{{display:block!important;width:100%!important;padding:0 0 8px 0!important;}}
 .btna{{width:100%!important;}}
}}
</style></head>
<body class="bg0" bgcolor="#05050D" style="margin:0;padding:0;background-color:#05050D;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#05050D" class="bg0" style="background-color:#05050D;"><tr><td align="center" style="padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="width:600px;max-width:600px;">

 <tr><td class="bg2" bgcolor="#08080f" style="padding:20px 36px;border-bottom:1px solid #16162a;">
   <img src="{domain}/hudace-logo-white.png" width="132" alt="Hudace" style="display:block;border:0;height:auto;">
 </td></tr>

 <tr><td class="bg2" bgcolor="#08080f" style="padding:40px 36px 28px 36px;">
   <div style="font-family:{fam};font-size:12px;font-weight:700;letter-spacing:2px;color:{blue};text-transform:uppercase;margin:0 0 16px 0;">{label}</div>
   <div class="tw" style="font-family:{fam};font-size:34px;line-height:1.15;font-weight:800;color:#ffffff;margin:0 0 14px 0;">{headline}</div>
   <div class="tm" style="font-family:{fam};font-size:16px;line-height:1.55;color:{mute};margin:0 0 26px 0;">{subhead}</div>
   {cta}
 </td></tr>

 <tr><td class="bg2" bgcolor="#08080f" style="padding:0;">{hero}</td></tr>

 {deliver}
 {scope}
 {why}
 {proof}
 {future}

 <tr><td class="bg2" bgcolor="#08080f" style="padding:34px 36px;border-top:1px solid #16162a;">
   <div class="tw" style="font-family:{fam};font-size:20px;font-weight:800;color:#ffffff;margin:0 0 6px 0;">Start the conversation</div>
   <div class="tm" style="font-family:{fam};font-size:14px;line-height:1.55;color:{mute};margin:0 0 20px 0;">No pitch. No obligation. We map the work to your outcomes, then deliver.</div>
   {cta}
 </td></tr>

 <tr><td class="bg0" bgcolor="#05050D" style="padding:30px 36px;text-align:center;border-top:1px solid #16162a;">
   <img src="{domain}/hudace-mark.png" width="40" height="40" alt="Hudace" style="display:inline-block;border:0;margin-bottom:14px;">
   <div style="margin:6px 0 16px 0;">{social}</div>
   <div class="tm" style="font-family:{fam};font-size:12px;line-height:1.7;color:{mute};">{web} &middot; {email} &middot; {phone}</div>
   <div class="tm" style="font-family:{fam};font-size:11px;color:#5a5a6e;margin-top:10px;">You are receiving this because you expressed interest in Hudace. <a href="{site}" style="color:#5a5a6e;">Unsubscribe</a></div>
 </td></tr>

</table></td></tr></table></body></html>""".format(
        title=esc(spec["title"]), preheader=esc(spec["subhead"]), domain=DOMAIN, fam=FAMILY,
        blue=BLUE, mute=MUTE, label=esc(spec["label"]), headline=esc(spec["headline"]),
        subhead=esc(spec["subhead"]), cta=cta_pair(), hero=img_tag(spec["hero_file"], spec["headline"]),
        deliver=section(delivers_label, deliverable_rows(spec["deliverables"]), BG1),
        scope=section(scope_label, para(spec["scope"]) + body_img, BG0),
        why=section("Why It Works", hook_rows(spec["hooks"]), BG1),
        proof=proof_html, future=future_html, social=social_row(),
        web=WEB, email=EMAIL, phone=PHONE, site=SITE)
    return html

# ---------------- message variants ----------------
def whatsapp_text(s):
    d = "\n".join("- " + x for x in s["card_deliverables"])
    return ("%s\n\n%s\n\n%s\n\nStart here: %s\n%s | %s" %
            (s["headline"], s["subhead"], d, WA, WEB, PHONE))

def linkedin_text(s):
    lines = "\n".join("- " + h for h, _ in s["hooks"])
    return ("%s\n\n%s\n\n%s\n\nWe run this as one accountable system, measured on outcomes.\n"
            "Start the conversation: %s | %s | %s" %
            (s["headline"], s["subhead"], lines, WA, EMAIL, WEB))

def outreach_text(s):
    d = "\n".join("- " + x for x in s["card_deliverables"])
    return ("Subject: %s\n\nHello,\n\n%s\n\nWhat we deliver:\n%s\n\n%s\n\n"
            "If useful, reply here or message %s and we will map this to your goals.\n\n%s | %s | %s" %
            (s["label"].title(), s["subhead"], d, s.get("proof", ""), WA, PHONE, EMAIL, WEB))

# ---------------- content specs ----------------
from content_specs import EMAILS  # noqa

def run():
    batch = []
    for s in EMAILS:
        key = s["key"]
        try:
            hero = "%s/hudace-%s-hero.jpg" % (OUT, key)
            body = "%s/hudace-%s-body.jpg" % (OUT, key)
            card = "%s/hudace-%s-card.jpg" % (OUT, key)
            if not os.path.exists(hero):
                try:
                    fetch_photo(s["hero_query"], hero)
                except Exception as e:
                    errors.append("hero %s: %r" % (key, e)); placeholder(hero)
            if not os.path.exists(body):
                try:
                    fetch_photo(s["body_query"], body)
                except Exception as e:
                    errors.append("body %s: %r" % (key, e)); placeholder(body)
            s["hero_file"] = os.path.basename(hero)
            s["body_file"] = os.path.basename(body)
            bake_card(hero, s["headline"], s["label"], s["card_deliverables"], card)
            card_url = "%s/%s" % (DOMAIN, os.path.basename(card))

            html = build_email(s)
            with open("%s/hudace-%s.html" % (OUT, key), "w") as f:
                f.write(html)

            base_title = "[%s] %s" % (DATE, s["title"])
            batch.append({"title": base_title, "type": "html_email", "body": html,
                          "image_url": card_url, "subject": s["headline"], "platform": "email"})
            batch.append({"title": base_title + " (WhatsApp)", "type": "whatsapp",
                          "body": whatsapp_text(s), "image_url": card_url, "platform": "whatsapp"})
            batch.append({"title": base_title + " (LinkedIn)", "type": "caption",
                          "body": linkedin_text(s), "image_url": card_url, "platform": "linkedin"})
            batch.append({"title": base_title + " (Outreach)", "type": "other",
                          "body": outreach_text(s), "image_url": card_url, "platform": "outreach"})
            print("built:", key)
        except Exception as e:
            errors.append("EMAIL %s FAILED: %r" % (key, e))
            print("FAILED:", key, e)
    with open("batch.json", "w") as f:
        json.dump(batch, f, indent=2, ensure_ascii=False)
    print("\nbatch items:", len(batch))
    if errors:
        print("ERRORS:")
        for e in errors: print("  -", e)

if __name__ == "__main__":
    run()
