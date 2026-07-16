#!/usr/bin/env python3
"""Build Hudace daily content batch: photos, logo, baked promo cards, email HTML, batch.json."""
import os, sys, json, urllib.request, urllib.parse, urllib.error, io, datetime, time
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

RUN_DATE = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()
INDUSTRIES = ["Retail", "Construction and Real Estate"]
PIX = os.environ["PIXABAY_API"]
OUT = "public/email"
BASE = "https://leadloftexporter.vercel.app/email"
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
def _open(url, timeout=60):
    last = None
    for attempt in range(5):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 403, 502, 503):
                time.sleep(2 * (attempt + 1)); continue
            raise
    raise last
USED_IDS = set()

# Brand
BG   = (10, 9, 25)      # 0A0919
BG2  = (5, 5, 13)       # 05050D
HERO = (8, 8, 15)       # 08080f
BLUE = (27, 144, 255)   # 1B90FF
MUTED= (154, 154, 174)  # 9A9AAE
WHITE= (255, 255, 255)
FB = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
def font(bold, sz): return ImageFont.truetype(FB if bold else FR, sz)

CONTACT = "hudace.com  ·  contact@hudace.com  ·  +91 82189 29990"
WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"
SOCIAL = {"instagram":"https://www.instagram.com/hudaceofficial/",
          "linkedin":"https://www.linkedin.com/company/hudace",
          "whatsapp":WA}

# ---------------------------------------------------------------- photo helpers
def pixabay(query):
    q = urllib.parse.urlencode({"key":PIX,"q":query,"image_type":"photo",
        "orientation":"vertical","safesearch":"true","per_page":20,"order":"popular"})
    r = _open(f"https://pixabay.com/api/?{q}", 40)
    hits = json.load(r).get("hits", [])
    vert = [h for h in hits if h.get("imageHeight",0) >= h.get("imageWidth",1)] or hits
    if not vert: raise RuntimeError(f"no pixabay hits for {query!r}")
    for h in vert:
        if h["id"] not in USED_IDS:
            USED_IDS.add(h["id"]); return h["largeImageURL"]
    USED_IDS.add(vert[0]["id"]); return vert[0]["largeImageURL"]

def cover_crop(img, w, h):
    iw, ih = img.size
    scale = max(w/iw, h/ih)
    img = img.resize((int(iw*scale)+1, int(ih*scale)+1), Image.LANCZOS)
    iw, ih = img.size
    l = (iw - w)//2; t = (ih - h)//2
    return img.crop((l, t, l+w, t+h))

def download_photo(query, slug):
    url = pixabay(query)
    raw = _open(url, 60).read()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img = cover_crop(img, 1080, 1350)
    # gentle darken for body photo readability
    img = ImageEnhance.Brightness(img).enhance(0.82)
    img = ImageEnhance.Color(img).enhance(0.9)
    path = f"{OUT}/{slug}-photo.jpg"
    img.save(path, "JPEG", quality=86, optimize=True)
    return img

# ---------------------------------------------------------------- brand assets
def make_logo():
    """White wordmark 'hudace' + blue dot, transparent PNG."""
    w, h = 600, 150
    im = Image.new("RGBA", (w, h), (0,0,0,0))
    d = ImageDraw.Draw(im)
    f = font(True, 96)
    d.text((0, 20), "hudace", font=f, fill=WHITE)
    bb = d.textbbox((0,20), "hudace", font=f)
    d.ellipse([bb[2]+14, bb[3]-26, bb[2]+34, bb[3]-6], fill=BLUE)
    im.save(f"{OUT}/hudace-logo.png")
    # square mark: rounded tile with 'h' + dot
    m = Image.new("RGBA", (160,160), (0,0,0,0))
    dm = ImageDraw.Draw(m)
    dm.rounded_rectangle([0,0,159,159], radius=36, fill=BG)
    dm.rounded_rectangle([0,0,159,159], radius=36, outline=BLUE, width=3)
    fm = font(True, 96)
    tb = dm.textbbox((0,0),"h",font=fm)
    dm.text(((160-(tb[2]-tb[0]))/2-2, (160-(tb[3]-tb[1]))/2 - tb[1]), "h", font=fm, fill=WHITE)
    dm.ellipse([112,104,130,122], fill=BLUE)
    m.save(f"{OUT}/hudace-mark.png")

def make_icons():
    """White rounded-tile social icons with dark monogram."""
    labels = {"instagram":"IG","linkedin":"in","whatsapp":"WA"}
    for name, txt in labels.items():
        s = 96
        im = Image.new("RGBA",(s,s),(0,0,0,0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0,0,s-1,s-1], radius=24, fill=WHITE)
        fs = 40 if len(txt)>1 else 52
        f = font(True, fs)
        tb = d.textbbox((0,0),txt,font=f)
        d.text(((s-(tb[2]-tb[0]))/2 - tb[0], (s-(tb[3]-tb[1]))/2 - tb[1]), txt, font=f, fill=BG)
        im.save(f"{OUT}/ic-{name}.png")

# ---------------------------------------------------------------- text wrapping
def wrap(draw, text, f, maxw):
    words = text.split(); lines=[]; cur=""
    for w in words:
        t = (cur+" "+w).strip()
        if draw.textlength(t, font=f) <= maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
    if cur: lines.append(cur)
    return lines

# ---------------------------------------------------------------- baked card
def bake_card(photo, slug, headline, sub, deliverables):
    W,H = 1080,1350
    img = photo.copy()
    img = ImageEnhance.Brightness(img).enhance(0.55)
    # dark gradient overlay bottom -> readable
    grad = Image.new("L",(1,H),0)
    for y in range(H):
        grad.putpixel((0,y), int(235 * (y/H)**1.4))
    grad = grad.resize((W,H))
    overlay = Image.new("RGB",(W,H), BG2)
    img = Image.composite(overlay, img, grad)
    # subtle top scrim for logo
    top = Image.new("L",(1,H),0)
    for y in range(H):
        top.putpixel((0,y), int(150*max(0,1-(y/380))))
    img = Image.composite(Image.new("RGB",(W,H),BG2), img, top.resize((W,H)))
    d = ImageDraw.Draw(img)
    M = 84
    # logo
    logo = Image.open(f"{OUT}/hudace-logo.png").convert("RGBA")
    lw = 300; logo = logo.resize((lw, int(logo.height*lw/logo.width)), Image.LANCZOS)
    img.paste(logo, (M, 70), logo)
    # headline block anchored lower-middle
    y = 560
    hf = font(True, 82)
    for ln in wrap(d, headline, hf, W-2*M):
        d.text((M,y), ln, font=hf, fill=WHITE); y += 92
    y += 6
    sf = font(False, 38)
    for ln in wrap(d, sub, sf, W-2*M):
        d.text((M,y), ln, font=sf, fill=MUTED); y += 48
    # deliverables label
    y += 26
    lf = font(True, 30)
    d.text((M,y), "DELIVERABLES", font=lf, fill=BLUE); y += 50
    bf = font(False, 34)
    for item in deliverables[:6]:
        d.rectangle([M, y+13, M+16, y+29], fill=BLUE)
        for i, ln in enumerate(wrap(d, item, bf, W-2*M-40)):
            d.text((M+40, y), ln, font=bf, fill=(226,226,236)); y += 44
        y += 6
    # CTA pill + contact
    cy = H-150
    d.rounded_rectangle([M, cy, M+430, cy+74], radius=37, fill=BLUE)
    cf = font(True, 34)
    ct = "Chat on WhatsApp"
    tb = d.textbbox((0,0),ct,font=cf)
    d.text((M+215-(tb[2]-tb[0])/2, cy+37-(tb[3]-tb[1])/2 - tb[1]), ct, font=cf, fill=WHITE)
    d.text((M, H-56), CONTACT, font=font(False,27), fill=MUTED)
    path = f"{OUT}/{slug}-card.jpg"
    img.convert("RGB").save(path, "JPEG", quality=88, optimize=True)
    return path

# ---------------------------------------------------------------- email HTML
def btns(center=False):
    al = "center" if center else "left"
    return f'''<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="{al}"><tr>
<td style="padding:6px 10px 6px 0;">
<a href="{WA}" style="display:inline-block;background:#1B90FF;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;padding:13px 26px;border-radius:6px;">Chat on WhatsApp</a></td>
<td style="padding:6px 0;">
<a href="{SITE}" style="display:inline-block;border:1px solid #1B90FF;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;padding:12px 26px;border-radius:6px;">Visit Our Website</a></td>
</tr></table>'''

def email_html(slug, kicker, headline, hero_sub, deliverables, scope_line, proof_line, future_line, hooks, close_line):
    card = f"{BASE}/{slug}-card.jpg"
    photo = f"{BASE}/{slug}-photo.jpg"
    logo = f"{BASE}/hudace-logo.png"
    mark = f"{BASE}/hudace-mark.png"
    deliv_rows = "".join(
        f'<tr><td valign="top" style="padding:6px 12px 6px 0;color:#1B90FF;font-size:16px;line-height:22px;">▪</td>'
        f'<td style="padding:6px 0;color:#e2e2ec;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">{d}</td></tr>'
        for d in deliverables)
    hook_rows = "".join(
        f'<tr><td valign="top" style="padding:8px 14px 8px 0;color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:20px;font-weight:bold;line-height:24px;">{i+1}</td>'
        f'<td style="padding:8px 0;"><div style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;line-height:21px;">{h[0]}</div>'
        f'<div style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:20px;padding-top:3px;">{h[1]}</div></td></tr>'
        for i,h in enumerate(hooks))
    icons = "".join(
        f'<a href="{SOCIAL[n]}" style="text-decoration:none;"><img src="{BASE}/ic-{n}.png" width="30" height="30" alt="{n}" style="border:0;margin:0 5px;"></a>'
        for n in ("instagram","linkedin","whatsapp"))
    return f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>{headline}</title>
<style>
:root{{color-scheme:dark;supported-color-schemes:dark;}}
body{{margin:0;padding:0;background:#05050D;}}
@media (prefers-color-scheme:light){{
 .bg0{{background:#05050D!important;}} .bg1{{background:#0A0919!important;}} .bg2{{background:#08080f!important;}}
 .tw{{color:#ffffff!important;}} .tm{{color:#9A9AAE!important;}}
}}
[data-ogsc] .bg0{{background:#05050D!important;}} [data-ogsc] .bg1{{background:#0A0919!important;}}
[data-ogsc] .bg2{{background:#08080f!important;}} [data-ogsc] .tw{{color:#ffffff!important;}} [data-ogsc] .tm{{color:#9A9AAE!important;}}
@media only screen and (max-width:480px){{ .stack{{display:block!important;width:100%!important;text-align:center!important;}} .stack a{{display:block!important;}} }}
</style></head>
<body class="bg0" bgcolor="#05050D" style="margin:0;padding:0;background:#05050D;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#05050D" class="bg0" style="background:#05050D;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

<tr><td class="bg1" bgcolor="#0A0919" style="background:#0A0919;padding:20px 28px;border-radius:12px 12px 0 0;">
<img src="{logo}" width="150" alt="Hudace" style="border:0;display:block;"></td></tr>

<tr><td class="bg2" bgcolor="#08080f" style="background:#08080f;padding:40px 28px 28px 28px;">
<div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">{kicker}</div>
<div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:34px;line-height:40px;font-weight:bold;padding:12px 0 8px 0;">{headline}</div>
<div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;padding-bottom:22px;">{hero_sub}</div>
{btns()}
</td></tr>

<tr><td class="bg1" bgcolor="#0A0919" style="background:#0A0919;padding:0;">
<img src="{card}" width="600" alt="{headline}" style="border:0;display:block;width:100%;max-width:600px;height:auto;"></td></tr>

<tr><td class="bg1" bgcolor="#0A0919" style="background:#0A0919;padding:32px 28px 8px 28px;">
<div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding-bottom:10px;">What you get</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{deliv_rows}</table>
</td></tr>

<tr><td class="bg1" bgcolor="#0A0919" style="background:#0A0919;padding:20px 28px 8px 28px;">
<div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding-bottom:8px;">Built for your sector</div>
<div class="tm" style="color:#c9c9d6;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:23px;">{scope_line}</div>
<div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;padding-top:10px;">{proof_line}</div>
<div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;padding-top:6px;">{future_line}</div>
</td></tr>

<tr><td class="bg2" bgcolor="#08080f" style="background:#08080f;padding:26px 28px 10px 28px;">
<div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding-bottom:12px;">Why it works</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{hook_rows}</table>
</td></tr>

<tr><td class="bg2" bgcolor="#08080f" style="background:#08080f;padding:16px 28px 34px 28px;">
<div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;font-weight:bold;padding-bottom:18px;">{close_line}</div>
{btns()}
</td></tr>

<tr><td class="bg1" bgcolor="#0A0919" style="background:#0A0919;padding:26px 28px;border-radius:0 0 12px 12px;text-align:center;">
<img src="{mark}" width="40" alt="Hudace" style="border:0;display:inline-block;"><br>
<div style="padding:12px 0;">{icons}</div>
<div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;">hudace.com &nbsp;·&nbsp; contact@hudace.com &nbsp;·&nbsp; +91 82189 29990</div>
<div class="tm" style="color:#6f6f80;font-family:Montserrat,Arial,sans-serif;font-size:11px;line-height:18px;padding-top:6px;">You are receiving this because you opted in to Hudace updates. <a href="{SITE}" style="color:#6f6f80;">Unsubscribe</a>.</div>
</td></tr>

</table></td></tr></table></body></html>'''

# ---------------------------------------------------------------- run
def main():
    make_logo(); make_icons()
    data = json.load(open("emails.json"))
    batch = []
    for e in data:
        slug = e["slug"]
        try:
            photo = download_photo(e["query"], slug)
            bake_card(photo, slug, e["card_headline"], e["card_sub"], e["deliverables"])
            html = email_html(slug, e["kicker"], e["headline"], e["hero_sub"], e["deliverables"],
                              e["scope_line"], e["proof_line"], e["future_line"], e["hooks"], e["close_line"])
            open(f"{OUT}/{slug}.html","w").write(html)
            card_url = f"{BASE}/{slug}-card.jpg"
            batch.append({"title":f"[{RUN_DATE}] {e['name']}","type":"email","body":html,"image_url":card_url})
            batch.append({"title":f"[{RUN_DATE}] {e['name']} - WhatsApp","type":"whatsapp","body":e["whatsapp"],"image_url":card_url})
            batch.append({"title":f"[{RUN_DATE}] {e['name']} - LinkedIn","type":"linkedin","body":e["linkedin"],"image_url":card_url})
            batch.append({"title":f"[{RUN_DATE}] {e['name']} - Outreach","type":"outreach","body":e["outreach"],"image_url":card_url})
            print("built", slug)
            time.sleep(1.5)
        except Exception as ex:
            print("FAIL", slug, repr(ex), file=sys.stderr)
    json.dump(batch, open("batch.json","w"), indent=1, ensure_ascii=False)
    print(f"batch items: {len(batch)}")

if __name__ == "__main__":
    main()
