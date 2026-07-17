# -*- coding: utf-8 -*-
import os, io, json, urllib.request, urllib.parse, importlib.util
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

spec=importlib.util.spec_from_file_location('c','.routine/content.py')
C=importlib.util.module_from_spec(spec); spec.loader.exec_module(C)

OUT="public/email"; os.makedirs(OUT,exist_ok=True)
PIX="56316516-fbb10ad7475940758256bc517"
FB="/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FR="/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
BG=(10,9,25); ACC=(27,144,255); MUTE=(154,154,174)
W,H=1080,1350

def font(b,sz): return ImageFont.truetype(FB if b else FR,sz)

def dl(url):
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
    return urllib.request.urlopen(req,timeout=60).read()

def fetch_photo(q,dest):
    u=f"https://pixabay.com/api/?key={PIX}&q={urllib.parse.quote(q)}&image_type=photo&orientation=vertical&safesearch=true&per_page=20"
    data=json.loads(dl(u).decode())
    hits=data.get("hits",[])
    hits=[h for h in hits if h["imageHeight"]>=h["imageWidth"]] or hits
    if not hits: raise SystemExit("no pixabay hits for "+q)
    raw=dl(hits[0]["largeImageURL"])
    im=Image.open(io.BytesIO(raw)).convert("RGB")
    # crop to 4:5
    tw,th=W,H
    sr=im.width/im.height; tr=tw/th
    if sr>tr:
        nw=int(im.height*tr); im=im.crop(((im.width-nw)//2,0,(im.width-nw)//2+nw,im.height))
    else:
        nh=int(im.width/tr); im=im.crop((0,(im.height-nh)//2,im.width,(im.height-nh)//2+nh))
    im=im.resize((tw,th),Image.LANCZOS)
    im.save(os.path.join(OUT,dest),"JPEG",quality=86)
    return im

def wordmark(path,px_h=64,color=(255,255,255)):
    f=font(True,px_h)
    txt="hudace"
    tmp=Image.new("RGBA",(10,10)); d=ImageDraw.Draw(tmp)
    bb=d.textbbox((0,0),txt,font=f)
    tw,th=bb[2]-bb[0],bb[3]-bb[1]
    pad=int(px_h*0.5)
    im=Image.new("RGBA",(tw+pad*2, th+pad),(0,0,0,0)); d=ImageDraw.Draw(im)
    d.text((pad-bb[0], pad//2-bb[1]), txt, font=f, fill=color+(255,))
    # accent dot
    r=int(px_h*0.10)
    cx=pad+tw+int(px_h*0.12); cy=pad//2+th-int(r*0.2)
    d.ellipse((cx,cy-r,cx+2*r,cy+r),fill=ACC+(255,))
    im.save(path)

def mark(path,sz=120):
    im=Image.new("RGBA",(sz,sz),(0,0,0,0)); d=ImageDraw.Draw(im)
    d.rounded_rectangle((4,4,sz-4,sz-4),radius=int(sz*0.22),fill=BG+(255,),outline=ACC+(255,),width=4)
    f=font(True,int(sz*0.6))
    bb=d.textbbox((0,0),"h",font=f); tw,th=bb[2]-bb[0],bb[3]-bb[1]
    d.text(((sz-tw)/2-bb[0],(sz-th)/2-bb[1]),"h",font=f,fill=(255,255,255,255))
    im.save(path)

def icon(path,kind,sz=96):
    im=Image.new("RGBA",(sz,sz),(0,0,0,0)); d=ImageDraw.Draw(im)
    wc=(255,255,255,255); m=int(sz*0.14)
    if kind=="instagram":
        d.rounded_rectangle((m,m,sz-m,sz-m),radius=int(sz*0.22),outline=wc,width=int(sz*0.07))
        r=int(sz*0.18); c=sz//2
        d.ellipse((c-r,c-r,c+r,c+r),outline=wc,width=int(sz*0.07))
        dr=int(sz*0.045); dx=int(sz*0.70); dy=int(sz*0.30)
        d.ellipse((dx-dr,dy-dr,dx+dr,dy+dr),fill=wc)
    elif kind=="linkedin":
        d.rounded_rectangle((m,m,sz-m,sz-m),radius=int(sz*0.16),outline=wc,width=int(sz*0.07))
        x=int(sz*0.30); 
        d.ellipse((x-int(sz*0.05),int(sz*0.28)-int(sz*0.05),x+int(sz*0.05),int(sz*0.28)+int(sz*0.05)),fill=wc)
        d.rectangle((x-int(sz*0.035),int(sz*0.40),x+int(sz*0.035),int(sz*0.72)),fill=wc)
        d.rectangle((int(sz*0.44),int(sz*0.40),int(sz*0.50),int(sz*0.72)),fill=wc)
        d.rounded_rectangle((int(sz*0.50),int(sz*0.46),int(sz*0.72),int(sz*0.72)),radius=int(sz*0.03),fill=wc)
    elif kind=="whatsapp":
        c=sz//2; r=int(sz*0.36)
        d.ellipse((c-r,c-r,c+r,c+r),outline=wc,width=int(sz*0.07))
        d.arc((int(sz*0.36),int(sz*0.36),int(sz*0.64),int(sz*0.64)),200,20,fill=wc,width=int(sz*0.08))
    elif kind=="facebook":
        d.rounded_rectangle((m,m,sz-m,sz-m),radius=int(sz*0.16),outline=wc,width=int(sz*0.07))
        f=font(True,int(sz*0.5)); bb=d.textbbox((0,0),"f",font=f)
        d.text(((sz-(bb[2]-bb[0]))/2-bb[0],(sz-(bb[3]-bb[1]))/2-bb[1]-int(sz*0.02)),"f",font=f,fill=wc)
    im.save(path)

def wrap(d,text,f,maxw):
    words=text.split(); lines=[]; cur=""
    for w in words:
        t=(cur+" "+w).strip()
        if d.textbbox((0,0),t,font=f)[2]<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
    if cur: lines.append(cur)
    return lines

def bake_card(s,photo_im):
    im=photo_im.copy().convert("RGB")
    # darken with gradient
    ov=Image.new("L",(W,H),0)
    for y in range(H):
        a=int(90+150*(y/H))
        ImageDraw.Draw(ov).line([(0,y),(W,y)],fill=min(a,235))
    dark=Image.new("RGB",(W,H),BG)
    im=Image.composite(dark,im,ov)
    d=ImageDraw.Draw(im)
    pad=70
    # logo wordmark top
    lg=Image.open(os.path.join(OUT,"logo.png")).convert("RGBA")
    lw=360; lg=lg.resize((lw,int(lg.height*lw/lg.width)),Image.LANCZOS)
    im.paste(lg,(pad,pad),lg)
    y=pad+lg.height+40
    # kicker
    fk=font(True,30)
    d.text((pad,y),s["name"].upper(),font=fk,fill=ACC); y+=52
    # headline
    fh=font(True,72)
    for ln in wrap(d,s["hero"],fh,W-pad*2):
        d.text((pad,y),ln,font=fh,fill=(255,255,255)); y+=82
    y+=10
    # sub
    fs=font(False,34)
    for ln in wrap(d,s["sub"],fs,W-pad*2):
        d.text((pad,y),ln,font=fs,fill=MUTE); y+=44
    y+=26
    # deliverables label
    d.text((pad,y),"WHAT YOU GET",font=font(True,28),fill=ACC); y+=48
    fd=font(False,32); items=s["deliverables"][:6]
    for it in items:
        d.ellipse((pad,y+10,pad+12,y+22),fill=ACC)
        for i,ln in enumerate(wrap(d,it,fd,W-pad*2-40)):
            d.text((pad+34,y),ln,font=fd,fill=(230,230,238)); y+=42
        y+=8
    # CTA pill
    by=H-230
    d.rounded_rectangle((pad,by,pad+430,by+82),radius=41,fill=ACC)
    ct="Chat on WhatsApp"; fc=font(True,34)
    bb=d.textbbox((0,0),ct,font=fc)
    d.text((pad+ (430-(bb[2]-bb[0]))/2, by+(82-(bb[3]-bb[1]))/2-bb[1]),ct,font=fc,fill=(255,255,255))
    # contact
    fct=font(False,30)
    d.text((pad,by+120),f"{C.DOMAIN}   {C.EMAIL}",font=fct,fill=(220,220,228))
    d.text((pad,by+160),C.PHONE,font=fct,fill=(220,220,228))
    out=os.path.join(OUT,f"card_{s['key']}.jpg")
    im.save(out,"JPEG",quality=88)
    return out

# ---- build brand assets ----
wordmark(os.path.join(OUT,"logo.png"),px_h=72)
mark(os.path.join(OUT,"mark.png"),sz=140)
for k in ["instagram","linkedin","whatsapp","facebook"]:
    icon(os.path.join(OUT,f"{k}.png"),k,sz=96)
print("brand assets built")

# ---- photos + cards ----
for s in C.SERVICES:
    try:
        im=fetch_photo(s["photo_q"],s["photo"])
        card=bake_card(s,im)
        print("built",s["key"],"->",s["photo"],os.path.basename(card))
    except Exception as e:
        print("FAIL photo",s["key"],e)
