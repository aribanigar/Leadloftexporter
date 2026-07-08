#!/usr/bin/env python3
"""
make_cards.py - promotional WhatsApp graphic: 2 to 3 products in one JPG, each with a
short description and colour info, the Gifts Gulf logo, a promo line, and a contact
banner. No price, no timeline, no date. The canvas height ADAPTS to the content so
there is never an empty gap. Three layout variants (1, 2, 3).
"""
import argparse, io, json, re, sys
from pathlib import Path
from urllib.request import urlopen, Request
from PIL import Image, ImageDraw, ImageFont

GREEN=(0,165,68); ZINC=(24,24,27); BODY=(63,63,70); MUTED=(113,113,123)
WHITE=(255,255,255); BORDER=(228,228,231)
W=1080; M=60; FOOTER_H=120; GAP=44
EMAIL_C="sales@giftsgulf.com"; PHONE_C="+916005001499"
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
    desc=""; names=[]
    try:
        h=_get(PAGE % sku).decode("utf-8","ignore")
        m=re.search(r'\\"description\\":\\"(.*?)\\"', h)
        if m:
            try: desc=m.group(1).encode().decode("unicode_escape")
            except Exception: desc=m.group(1)
        master=re.escape(code.split("-")[0])
        pat=(r'\\"name\\":\\"([^"\\]{1,40})\\",\\"hex\\":\\"#[0-9a-fA-F]{6}\\",'
             r'\\"image\\":\\"https://cdn1\.midocean\.com/image/original/'+master+r'-(\d{2})')
        seen=set()
        for nm,suf in re.findall(pat,h):
            if suf not in seen: seen.add(suf); names.append(nm)
    except Exception: pass
    return desc.strip(), len(names), (names[0] if names else "")

def badge_text(p):
    n=p.get("colours",0); cn=p.get("cname","")
    return ("%d colours"%n) if n>=2 else (cn if (n==1 and cn) else "")

def wrap(d, text, font, maxw, maxlines=2):
    words=(text or "").split(); lines=[]; cur=""
    for w in words:
        t=(cur+" "+w).strip()
        if d.textlength(t,font=font)<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
            if len(lines)==maxlines: break
    if cur and len(lines)<maxlines: lines.append(cur)
    if lines and len(" ".join(lines))<len(text or ""):
        while lines and d.textlength(lines[-1]+"...",font=font)>maxw: lines[-1]=lines[-1][:-1]
        lines[-1]=lines[-1].rstrip()+"..."
    return lines

def pill(d, x, y, text, font, fill=GREEN, fg=WHITE):
    tb=d.textbbox((0,0),text,font=font); tw=tb[2]-tb[0]; th=tb[3]-tb[1]
    px,py=18,11; w=tw+px*2; hh=th+py*2
    d.rounded_rectangle([x,y,x+w,y+hh],radius=7,fill=fill)
    d.text((x+px,y+py-tb[1]),text,font=font,fill=fg); return hh

def logo_png(maxw):
    lg=Image.open(io.BytesIO(_get(LOGO))).convert("RGBA")
    return lg.resize((maxw,int(lg.height*maxw/lg.width)))

def prod_img(src, box):
    url=src if str(src).startswith("http") else (PROD % src)
    im=Image.open(io.BytesIO(_get(url))).convert("RGB"); im.thumbnail(box, Image.LANCZOS); return im

TMP=ImageDraw.Draw(Image.new("RGB",(W,10)))

def header_height(promo_lines): return 176 + len(promo_lines)*54 + 22

def draw_header(d, base, promo_lines):
    lg=logo_png(230); base.paste(lg,(M,58),lg)
    d.line([(M,150),(W-M,150)],fill=GREEN,width=3)
    for i,ln in enumerate(promo_lines): d.text((M,176+i*54),ln,font=fb(44),fill=ZINC)

def draw_footer(d, total):
    text="%s     .     %s"%(EMAIL_C,PHONE_C); y0=total-FOOTER_H
    d.rectangle([0,y0,W,total],fill=GREEN)
    size=40
    while size>22 and TMP.textlength(text,font=fb(size))>W-80: size-=2
    f=fb(size); tb=d.textbbox((0,0),text,font=f); tw=tb[2]-tb[0]; th=tb[3]-tb[1]
    d.text(((W-tw)//2,y0+(FOOTER_H-th)//2-tb[1]),text,font=f,fill=WHITE)

# ---- variant layouts: each returns (content_height, render(base,d,top)) ----
def lay_v1(P):
    colw=470; gap=20; box=colw; P=P[:2]
    imgs=[prod_img(p["_imgurl"],(box,box)) for p in P]
    col_h=[]
    for p in P:
        h=box+18+46
        h+=len(wrap(TMP,p["desc"],fr(22),colw,2))*30
        if badge_text(p): h+=54
        col_h.append(h)
    ch=max(col_h)
    def render(base,d,top):
        for i,p in enumerate(P):
            x=M+i*(colw+gap); im=imgs[i]
            base.paste(im,(x+(colw-im.width)//2, top+(box-im.height)//2))
            d.rectangle([x,top,x+colw,top+box],outline=BORDER,width=1)
            y=top+box+18
            d.text((x,y),p["name"],font=fb(36),fill=ZINC); y+=46
            for ln in wrap(d,p["desc"],fr(22),colw,2): d.text((x,y),ln,font=fr(22),fill=MUTED); y+=30
            bt=badge_text(p)
            if bt: pill(d,x,y+4,bt,fb(22))
    return ch, render

def lay_v2(P):
    P=P[:3]; imgs=[prod_img(p["_imgurl"],(300,300)) for p in P]; rowh=300; gap=34
    ch=len(P)*rowh+(len(P)-1)*gap
    def render(base,d,top):
        y=top
        for i,p in enumerate(P):
            im=imgs[i]; base.paste(im,(M+(300-im.width)//2,y+(300-im.height)//2))
            d.rectangle([M,y,M+300,y+300],outline=BORDER,width=1)
            tx=M+340; d.text((tx,y+6),p["name"],font=fb(40),fill=ZINC)
            yy=y+72
            for ln in wrap(d,p["desc"],fr(24),W-tx-M,3): d.text((tx,yy),ln,font=fr(24),fill=BODY); yy+=34
            bt=badge_text(p)
            if bt: pill(d,tx,max(yy+6,y+210),bt,fb(24))
            y+=rowh+gap
            if i<len(P)-1: d.line([(M,y-gap//2),(W-M,y-gap//2)],fill=BORDER,width=1)
    return ch, render

def lay_v3(P):
    P=P[:3]; hero=prod_img(P[0]["_imgurl"],(W-2*M,560))
    thumbs=[prod_img(p["_imgurl"],(220,190)) for p in P[1:3]]
    desc_lines=wrap(TMP,P[0]["desc"],fr(26),W-2*M,2)
    head=hero.height+20+56+(54 if badge_text(P[0]) else 0)+len(desc_lines)*34+30
    thumb_h=210 if thumbs else 0
    ch=head+thumb_h
    def render(base,d,top):
        base.paste(hero,((W-hero.width)//2,top))
        y=top+hero.height+20
        d.text((M,y),P[0]["name"],font=fb(46),fill=ZINC); y+=58
        bt=badge_text(P[0])
        if bt: y+=pill(d,M,y,bt,fb(26))+10
        for ln in desc_lines: d.text((M,y),ln,font=fr(26),fill=BODY); y+=34
        y+=20
        for i,p in enumerate(P[1:3]):
            x=M+i*((W-2*M)//2); im=thumbs[i]; base.paste(im,(x,y))
            d.text((x+240,y+8),p["name"],font=fb(30),fill=ZINC)
            b2=badge_text(p)
            if b2: pill(d,x+240,y+54,b2,fb(22))
            for j,ln in enumerate(wrap(d,p["desc"],fr(20),(W-2*M)//2-260,2)): d.text((x+240,y+104+j*26),ln,font=fr(20),fill=MUTED)
    return ch, render

def build_promo(spec, out=None):
    out=out or spec["out"]; variant=int(spec.get("variant",1)); promo=spec.get("promo","")
    P=[]
    for p in spec["products"]:
        q=dict(p)
        q["_imgurl"]=p.get("image") or (PROD % p["code"])
        q["desc"]=(p.get("desc") or "").strip()
        q["colours"]=int(p.get("colours",0) or 0)
        q["cname"]=p.get("cname","")
        P.append(q)
    promo_lines=wrap(TMP,promo,fb(44),W-2*M,2)
    hh=header_height(promo_lines)
    ch,render={1:lay_v1,2:lay_v2,3:lay_v3}.get(variant,lay_v1)(P)
    total=hh+ch+GAP+FOOTER_H
    base=Image.new("RGB",(W,total),WHITE); d=ImageDraw.Draw(base)
    draw_header(d,base,promo_lines); render(base,d,hh); draw_footer(d,total)
    base.save(out,"JPEG",quality=88); return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--spec"); ap.add_argument("--variant",type=int,default=1)
    ap.add_argument("--promo",default=""); ap.add_argument("--out")
    ap.add_argument("--product",action="append",default=[],help="code,sku,name")
    a=ap.parse_args()
    if a.spec: spec=json.load(open(a.spec))
    else:
        prods=[]
        for x in a.product:
            if "=" in x:
                d={}
                for kv in x.split(";"):
                    if "=" in kv: k,v=kv.split("=",1); d[k.strip()]=v.strip()
                if "colours" in d: d["colours"]=int(d["colours"] or 0)
                prods.append(d)
            else:
                prods.append(dict(zip(("code","sku","name"),x.split(","))))
        spec={"variant":a.variant,"promo":a.promo,"products":prods,"out":a.out}
    print(build_promo(spec))

if __name__=="__main__": sys.exit(main())
