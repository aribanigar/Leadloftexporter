#!/usr/bin/env python3
"""
make_cards.py - promotional WhatsApp graphic: 2 to 3 products in one 1080x1350 JPG,
each with a short description and colour info, the Gifts Gulf logo, and a promo line.
No price, no timeline. Three layout variants (1, 2, 3). Description and colours are
read from the product page and bound to the product's master code.

Spec JSON: {"variant":1,"promo":"...","products":[{"code","sku","name"}],"out":"x.jpg"}
CLI: python3 make_cards.py --variant 1 --promo "..." --out x.jpg \
       --product mo6971-03,GG1542,AIRA --product mo6272-40,GG1408,TAMPERE
"""
import argparse, io, json, re, sys
from urllib.request import urlopen, Request
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

GREEN=(0,165,68); ZINC=(24,24,27); BODY=(63,63,70); MUTED=(113,113,123)
WHITE=(255,255,255); BORDER=(228,228,231)
W,H=1080,1450; M=60
EMAIL_C="sales@giftgulf.com"; PHONE_C="+919186051499"
_FD=Path(__file__).resolve().parent/"fonts"
FB=str(_FD/"DMSans-Bold.ttf")    if (_FD/"DMSans-Bold.ttf").exists()    else "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR=str(_FD/"DMSans-Regular.ttf") if (_FD/"DMSans-Regular.ttf").exists() else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
PROD="https://wsrv.nl/?url=ssl:cdn1.midocean.com/image/original/%s.jpg&w=900&output=jpg&q=85"
LOGO="https://wsrv.nl/?url=https://www.giftsgulf.com/gglogo.svg&w=480&output=png"
PAGE="https://www.giftsgulf.com/product/%s"

def _get(u): return urlopen(Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=40).read()
def fb(s): return ImageFont.truetype(FB,s)
def fr(s): return ImageFont.truetype(FR,s)

def fetch_meta(code, sku):
    """(description, colour_count, first_colour_name), colours bound to master code."""
    desc=""; names=[]
    try:
        h=_get(PAGE % sku).decode("utf-8","ignore")
        m=re.search(r'\\"description\\":\\"(.*?)\\"', h)
        if m:
            # decode JSON \uXXXX / \n / \/ without corrupting existing UTF-8
            raw=m.group(1)
            raw=re.sub(r'\\u([0-9a-fA-F]{4})', lambda x: chr(int(x.group(1),16)), raw)
            desc=raw.replace('\\/','/').replace('\\"','"').replace('\\n',' ').replace('\\t',' ')
        master=re.escape(code.split("-")[0])
        pat=(r'\\"name\\":\\"([^"\\]{1,40})\\",\\"hex\\":\\"#[0-9a-fA-F]{6}\\",'
             r'\\"image\\":\\"https://cdn1\.midocean\.com/image/original/'+master+r'-(\d{2})')
        seen=set()
        for nm,suf in re.findall(pat,h):
            if suf not in seen:
                seen.add(suf); names.append(nm)
    except Exception:
        pass
    # brand rule: no em or en dashes; tidy whitespace
    desc=desc.replace("—",", ").replace("–",", ").replace("’","'")
    desc=re.sub(r"\s+,",",",desc); desc=re.sub(r"\s+"," ",desc)
    return desc.strip(), len(names), (names[0] if names else "")

def badge_text(p):
    n=p.get("colours",0); cn=p.get("cname","")
    return ("%d colours"%n) if n>=2 else (cn if (n==1 and cn) else "")

def wrap(d, text, font, maxw, maxlines=2):
    words=text.split(); lines=[]; cur=""
    for w in words:
        t=(cur+" "+w).strip()
        if d.textlength(t,font=font)<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
            if len(lines)==maxlines: break
    if cur and len(lines)<maxlines: lines.append(cur)
    if lines and len(" ".join(lines))<len(text):
        while lines and d.textlength(lines[-1]+"...",font=font)>maxw: lines[-1]=lines[-1][:-1]
        lines[-1]=lines[-1].rstrip()+"..."
    return lines

def pill(d, x, y, text, font, fill=GREEN, fg=WHITE):
    tb=d.textbbox((0,0),text,font=font); tw=tb[2]-tb[0]; th=tb[3]-tb[1]
    px,py=18,11; w=tw+px*2; hh=th+py*2
    d.rounded_rectangle([x,y,x+w,y+hh],radius=7,fill=fill)
    d.text((x+px,y+py-tb[1]),text,font=font,fill=fg); return w,hh

def logo_png(maxw):
    lg=Image.open(io.BytesIO(_get(LOGO))).convert("RGBA")
    return lg.resize((maxw,int(lg.height*maxw/lg.width)))

def prod_img(code, box):
    im=Image.open(io.BytesIO(_get(PROD%code))).convert("RGB")
    im.thumbnail(box, Image.LANCZOS); return im

def header(base, d, promo):
    lg=logo_png(230); base.paste(lg,(M,58),lg)
    d.line([(M,150),(W-M,150)],fill=GREEN,width=3)
    for i,ln in enumerate(wrap(d,promo,fb(44),W-2*M,2)):
        d.text((M,176+i*54),ln,font=fb(44),fill=ZINC)

def footer_band(base, d):
    text="%s     .     %s" % (EMAIL_C, PHONE_C)
    bh=120; y0=H-bh
    d.rectangle([0,y0,W,H],fill=GREEN)
    size=40
    while size>22 and d.textlength(text,font=fb(size))>W-80: size-=2
    f=fb(size); tb=d.textbbox((0,0),text,font=f); tw=tb[2]-tb[0]; th=tb[3]-tb[1]
    d.text(((W-tw)//2, y0+(bh-th)//2-tb[1]), text, font=f, fill=WHITE)

def v1(base,d,P):
    y0=300; colw=460
    for i,p in enumerate(P[:2]):
        x=M+i*(colw+40)
        im=prod_img(p["code"],(colw,460))
        base.paste(im,(x+(colw-im.width)//2,y0+(460-im.height)//2))
        d.rectangle([x,y0,x+colw,y0+460],outline=BORDER,width=1)
        d.text((x,y0+480),p["name"],font=fb(36),fill=ZINC)
        for j,ln in enumerate(wrap(d,p["desc"],fr(22),colw,2)):
            d.text((x,y0+528+j*30),ln,font=fr(22),fill=MUTED)
        bt=badge_text(p)
        if bt: pill(d,x,y0+600,bt,fb(22))
    footer_band(base,d)

def v2(base,d,P):
    y=300; rowh=330
    for p in P[:3]:
        im=prod_img(p["code"],(300,300))
        base.paste(im,(M+(300-im.width)//2,y+(300-im.height)//2))
        d.rectangle([M,y,M+300,y+300],outline=BORDER,width=1)
        tx=M+340
        d.text((tx,y+8),p["name"],font=fb(40),fill=ZINC)
        for j,ln in enumerate(wrap(d,p["desc"],fr(24),W-tx-M,3)):
            d.text((tx,y+70+j*34),ln,font=fr(24),fill=BODY)
        bt=badge_text(p)
        if bt: pill(d,tx,y+218,bt,fb(24))
        y+=rowh
        if y<H-200: d.line([(M,y-15),(W-M,y-15)],fill=BORDER,width=1)
    footer_band(base,d)

def v3(base,d,P):
    hero=P[0]
    im=prod_img(hero["code"],(W-2*M,560)); base.paste(im,((W-im.width)//2,300))
    d.text((M,880),hero["name"],font=fb(46),fill=ZINC)
    bt=badge_text(hero)
    if bt: pill(d,M,948,bt,fb(26))
    for j,ln in enumerate(wrap(d,hero["desc"],fr(26),W-2*M,2)):
        d.text((M,1010+j*34),ln,font=fr(26),fill=BODY)
    y=1130
    for i,p in enumerate(P[1:3]):
        x=M+i*((W-2*M)//2)
        im=prod_img(p["code"],(220,180)); base.paste(im,(x,y))
        d.text((x+240,y+10),p["name"],font=fb(30),fill=ZINC)
        b2=badge_text(p)
        if b2: pill(d,x+240,y+58,b2,fb(22))
        for j,ln in enumerate(wrap(d,p["desc"],fr(20),(W-2*M)//2-260,2)):
            d.text((x+240,y+108+j*26),ln,font=fr(20),fill=MUTED)
    footer_band(base,d)

def build_promo(spec, out=None):
    out=out or spec["out"]; variant=int(spec.get("variant",1))
    P=[]
    for p in spec["products"]:
        desc,n,cname=fetch_meta(p["code"],p["sku"])
        P.append({**p,"desc":p.get("desc") or desc,"colours":p.get("colours",n),"cname":cname})
    base=Image.new("RGB",(W,H),WHITE); d=ImageDraw.Draw(base)
    header(base,d,spec.get("promo",""))
    {1:v1,2:v2,3:v3}.get(variant,v1)(base,d,P)
    base.save(out,"JPEG",quality=88); return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--spec"); ap.add_argument("--variant",type=int,default=1)
    ap.add_argument("--promo",default=""); ap.add_argument("--out")
    ap.add_argument("--product",action="append",default=[],help="code,sku,name")
    a=ap.parse_args()
    if a.spec: spec=json.load(open(a.spec))
    else:
        prods=[dict(zip(("code","sku","name"),x.split(","))) for x in a.product]
        spec={"variant":a.variant,"promo":a.promo,"products":prods,"out":a.out}
    print(build_promo(spec))

if __name__=="__main__":
    sys.exit(main())
