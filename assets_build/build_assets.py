#!/usr/bin/env python3
"""Build Hudace email assets: download cinematic photos (4:5), bake promo cards,
generate brand logo + social icons. All output -> public/email/ (self-hosted)."""
import os, io, json, urllib.request, urllib.parse
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "email")
FONTS = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
KEY = "56316516-fbb10ad7475940758256bc517"

BG = (10, 9, 25)          # #0A0919
BG2 = (5, 5, 13)          # #05050D
BLUE = (27, 144, 255)     # #1B90FF
WHITE = (255, 255, 255)
MUTED = (154, 154, 174)   # #9A9AAE
W, H = 1080, 1350         # 4:5

def F(weight, size):
    return ImageFont.truetype(os.path.join(FONTS, f"Montserrat-{weight}.ttf"), size)

# ---- services --------------------------------------------------------------
SERVICES = [
 {"key":"social","label":"SOCIAL MEDIA","pid":10216710,
  "headline":"Turn attention into demand.",
  "deliv":["6 short-form videos / month","12 feed posts, 8 stories","Captions and hashtag sets",
           "Community management","Monthly performance report"]},
 {"key":"seo","label":"SEO / AEO / GEO / SRX","pid":3622942,
  "headline":"Be found before your competitors.",
  "deliv":["Technical SEO audit and fixes","Keyword and intent research","On-page and schema",
           "Answer and AI-answer visibility","Monthly ranking report"]},
 {"key":"website","label":"WEBSITE DESIGN","pid":3625356,
  "headline":"A website that sells while you sleep.",
  "deliv":["Custom multi-page website","Mobile-first responsive build","Booking and lead forms",
           "CMS you can edit yourself","Analytics and WhatsApp"]},
 {"key":"erp","label":"ERP BUILDING","pid":838377,
  "headline":"Run the whole business on one system.",
  "deliv":["Discovery and module blueprint","CRM, inventory, billing, HR","Role-based dashboards",
           "Workflow automations","Web and mobile access"]},
 {"key":"aistudio","label":"AI WORK STUDIO","pid":8191564,
  "headline":"Cinematic ads. No film crew.",
  "deliv":["60-second cinematic film","Three 15-second social cuts","Ten AI-generated stills",
           "Script and concept included","Delivered in seven working days"]},
 {"key":"schoolos","label":"SCHOOLOS  ·  SCHOOL ERP","pid":7053263,
  "headline":"One connected system for your school.",
  "deliv":["Admissions to enrollment","Attendance with parent alerts","Fees, invoices, online payment",
           "Exams, grading, report cards","Transport, library, HR and payroll"]},
]

def fetch_photo(pid):
    """Fresh URL by id, download pixels immediately (never hotlink)."""
    u = "https://pixabay.com/api/?" + urllib.parse.urlencode({"key":KEY,"id":pid})
    hits = json.load(urllib.request.urlopen(u, timeout=40)).get("hits", [])
    if not hits:
        raise RuntimeError(f"no hit for id {pid}")
    src = hits[0].get("largeImageURL") or hits[0].get("webformatURL")
    req = urllib.request.Request(src, headers={
        "User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept":"image/avif,image/webp,image/*,*/*;q=0.8"})
    data = urllib.request.urlopen(req, timeout=60).read()
    return Image.open(io.BytesIO(data)).convert("RGB")

def cover(img, w, h):
    """Center-crop cover to w x h."""
    r = max(w/img.width, h/img.height)
    nimg = img.resize((int(img.width*r)+1, int(img.height*r)+1), Image.LANCZOS)
    x = (nimg.width - w)//2; y = (nimg.height - h)//2
    return nimg.crop((x, y, x+w, y+h))

def darken(img, top=0.35, bottom=0.86, flat=0.30):
    """Flat darken + vertical gradient (stronger at bottom for text)."""
    base = img.copy()
    # flat multiply toward BG2
    ov = Image.new("RGB",(base.width,base.height),BG2)
    base = Image.blend(base, ov, flat)
    grad = Image.new("L",(1,base.height))
    for y in range(base.height):
        a = top + (bottom-top)*(y/base.height)
        grad.putpixel((0,y), int(a*255))
    grad = grad.resize((base.width,base.height))
    dark = Image.new("RGB",(base.width,base.height),(3,3,8))
    return Image.composite(dark, base, grad)

def wrap(draw, text, font, maxw):
    words=text.split(); lines=[]; cur=""
    for wd in words:
        t=(cur+" "+wd).strip()
        if draw.textlength(t,font=font)<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=wd
    if cur: lines.append(cur)
    return lines

def rrect(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

def logo_wordmark(size=46, color=WHITE):
    """'hudace' wordmark with blue accent dot -> transparent PNG."""
    f=F(700,size)
    tmp=Image.new("RGBA",(size*8,size*2),(0,0,0,0)); d=ImageDraw.Draw(tmp)
    d.text((0,0),"hudace",font=f,fill=color)
    w=int(d.textlength("hudace",font=f))
    d.ellipse([w+size*0.12,size*0.62,w+size*0.12+size*0.22,size*0.62+size*0.22],fill=BLUE)
    return tmp.crop((0,0,int(w+size*0.5),int(size*1.4)))

def bake_card(svc, photo):
    canvas = darken(cover(photo, W, H)) if photo else None
    if canvas is None:
        canvas = Image.new("RGB",(W,H),BG)
        d=ImageDraw.Draw(canvas)
        for y in range(H):
            a=y/H; d.line([(0,y),(W,y)],fill=(int(10+ a*0),int(9),int(25+a*10)))
    d = ImageDraw.Draw(canvas)
    PADX=84
    # logo top-left
    lw = logo_wordmark(46)
    canvas.paste(lw, (PADX, 78), lw)
    # blue category label
    d.text((PADX, 150), svc["label"], font=F(700,27), fill=BLUE)
    # headline (lower third area, start ~ 470)
    hf=F(700,74); lines=wrap(d, svc["headline"], hf, W-2*PADX)
    y=470
    for ln in lines:
        d.text((PADX,y),ln,font=hf,fill=WHITE); y+=90
    y+=18
    # deliverables
    df=F(600,34)
    for item in svc["deliv"]:
        d.rectangle([PADX,y+14,PADX+26,y+18],fill=BLUE)  # blue dash
        d.text((PADX+42,y),item,font=df,fill=(233,233,240)); y+=58
    # CTA pill
    y+=26
    cta="Chat on WhatsApp"; cf=F(700,34)
    cw=d.textlength(cta,font=cf)
    rrect(d,[PADX,y,PADX+cw+72,y+74],37,BLUE)
    d.text((PADX+36,y+18),cta,font=cf,fill=WHITE)
    d.text((PADX+cw+96,y+18),"Visit hudace.com",font=F(600,30),fill=WHITE)
    # contact strip bottom
    d.text((PADX,H-84),"hudace.com   ·   contact@hudace.com   ·   +91 82189 29990",
           font=F(600,26),fill=MUTED)
    p=os.path.join(OUT,f"card_{svc['key']}.jpg")
    canvas.convert("RGB").save(p,"JPEG",quality=88,optimize=True)
    return p

def save_photo(svc, photo):
    """Plain darkened cinematic hero photo, 4:5."""
    img = darken(cover(photo,W,H), top=0.15, bottom=0.62, flat=0.18) if photo else Image.new("RGB",(W,H),BG)
    p=os.path.join(OUT,f"photo_{svc['key']}.jpg")
    img.convert("RGB").save(p,"JPEG",quality=88,optimize=True)
    return p

# ---- brand assets (once) ---------------------------------------------------
def brand_assets():
    made=[]
    lw=logo_wordmark(52); lw.save(os.path.join(OUT,"logo_white.png")); made.append("logo_white.png")
    # footer mark: 'h' in a rounded blue square
    m=Image.new("RGBA",(96,96),(0,0,0,0)); dm=ImageDraw.Draw(m)
    dm.rounded_rectangle([0,0,96,96],radius=22,fill=BLUE)
    dm.text((26,8),"h",font=F(700,72),fill=WHITE); m.save(os.path.join(OUT,"mark.png")); made.append("mark.png")
    # social icons: white glyphs on transparent, 64x64
    def canvasi():
        i=Image.new("RGBA",(64,64),(0,0,0,0)); return i, ImageDraw.Draw(i)
    # instagram
    i,dd=canvasi(); dd.rounded_rectangle([8,8,56,56],radius=15,outline=WHITE,width=5)
    dd.ellipse([22,22,42,42],outline=WHITE,width=5); dd.ellipse([46,14,52,20],fill=WHITE)
    i.save(os.path.join(OUT,"icon_instagram.png")); made.append("icon_instagram.png")
    # linkedin
    i,dd=canvasi(); dd.rounded_rectangle([8,8,56,56],radius=12,fill=WHITE)
    dd.rectangle([16,28,24,48],fill=BG); dd.ellipse([15,15,25,25],fill=BG)
    dd.rectangle([30,28,38,48],fill=BG); dd.rectangle([38,34,48,48],fill=BG); dd.rectangle([30,34,48,40],fill=BG)
    i.save(os.path.join(OUT,"icon_linkedin.png")); made.append("icon_linkedin.png")
    # whatsapp
    i,dd=canvasi(); dd.ellipse([8,8,56,56],fill=WHITE); dd.ellipse([20,20,44,44],outline=BG,width=5)
    dd.polygon([(20,44),(28,38),(24,48)],fill=BG); i.save(os.path.join(OUT,"icon_whatsapp.png")); made.append("icon_whatsapp.png")
    # facebook
    i,dd=canvasi(); dd.ellipse([8,8,56,56],fill=WHITE); dd.text((26,16),"f",font=F(700,40),fill=BG)
    i.save(os.path.join(OUT,"icon_facebook.png")); made.append("icon_facebook.png")
    return made

if __name__=="__main__":
    report={"photos":[],"cards":[],"brand":[],"failed":[]}
    report["brand"]=brand_assets()
    for svc in SERVICES:
        try:
            photo=fetch_photo(svc["pid"])
        except Exception as e:
            print("PHOTO FAIL",svc["key"],e); report["failed"].append(f"photo_{svc['key']}: {e}"); photo=None
        try:
            report["photos"].append(os.path.basename(save_photo(svc,photo)))
            report["cards"].append(os.path.basename(bake_card(svc,photo)))
            print("built",svc["key"])
        except Exception as e:
            print("BAKE FAIL",svc["key"],e); report["failed"].append(f"card_{svc['key']}: {e}")
    print(json.dumps(report,indent=2))
