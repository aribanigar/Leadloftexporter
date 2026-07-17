# -*- coding: utf-8 -*-
import os, json, html, importlib.util
spec=importlib.util.spec_from_file_location('c','.routine/content.py')
C=importlib.util.module_from_spec(spec); spec.loader.exec_module(C)

IMG=C.IMGBASE
def u(name): return f"{IMG}/{name}"
esc=html.escape

def btns(pad_top=0):
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:{pad_top}px;">
        <tr>
          <td style="padding:6px 8px 6px 0;">
            <a href="{C.WA}" style="display:inline-block;background:#1B90FF;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;padding:14px 26px;border-radius:8px;">Chat on WhatsApp</a>
          </td>
          <td style="padding:6px 0;">
            <a href="{C.SITE}" style="display:inline-block;border:1px solid #1B90FF;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:bold;padding:13px 26px;border-radius:8px;">Visit Our Website</a>
          </td>
        </tr>
      </table>"""

def deliverables_html(s):
    rows=""
    for it in s["deliverables"]:
        rows+=f"""<tr><td valign="top" style="padding:5px 10px 5px 0;color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">&#9679;</td><td style="padding:5px 0;color:#E6E6EE;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;">{esc(it)}</td></tr>"""
    return rows

def hooks_html(s):
    out=""
    for i,(t,body) in enumerate(s["hooks"],1):
        out+=f"""
        <tr><td style="padding:0 0 16px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="top" width="40" style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:bold;">{i}</td>
            <td style="font-family:Montserrat,Arial,sans-serif;">
              <div style="color:#ffffff;font-size:16px;font-weight:bold;line-height:22px;">{esc(t)}</div>
              <div style="color:#9A9AAE;font-size:14px;line-height:21px;margin-top:4px;">{esc(body)}</div>
            </td>
          </tr></table>
        </td></tr>"""
    return out

def email_html(s):
    card=u(f"card_{s['key']}.jpg")
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{esc(s['subject'])} - Hudace</title>
<style>
  @media (prefers-color-scheme: light) {{
    .bgmain{{background:#0A0919!important;}} .bghero{{background:#08080f!important;}}
    .bgcard{{background:#05050D!important;}} .tw{{color:#ffffff!important;}} .tm{{color:#9A9AAE!important;}}
  }}
  [data-ogsc] .bgmain{{background:#0A0919!important;}} [data-ogsc] .bghero{{background:#08080f!important;}}
  [data-ogsc] .bgcard{{background:#05050D!important;}} [data-ogsc] .tw{{color:#ffffff!important;}} [data-ogsc] .tm{{color:#9A9AAE!important;}}
  @media only screen and (max-width:600px) {{ .btn{{display:block!important;width:100%!important;text-align:center!important;}} }}
</style>
</head>
<body style="margin:0;padding:0;background:#05050D;" bgcolor="#05050D">
<table role="presentation" class="bgcard" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#05050D" style="background:#05050D;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <!-- header logo -->
  <tr><td class="bghero" bgcolor="#08080f" style="background:#08080f;padding:20px 28px;border-radius:12px 12px 0 0;">
    <img src="{u('logo.png')}" width="150" alt="Hudace" style="display:block;border:0;height:auto;">
  </td></tr>

  <!-- hero live text -->
  <tr><td class="bghero" bgcolor="#08080f" style="background:#08080f;padding:14px 28px 28px 28px;">
    <div class="tm" style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">{esc(s['name'])}</div>
    <div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:32px;line-height:38px;font-weight:bold;margin-top:10px;">{esc(s['hero'])}</div>
    <div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;margin-top:10px;">{esc(s['sub'])}</div>
    {btns(18)}
  </td></tr>

  <!-- hero photo (plain img, no bg-image) -->
  <tr><td class="bgmain" bgcolor="#0A0919" style="background:#0A0919;">
    <img src="{card}" width="600" alt="{esc(s['hero'])}" style="display:block;border:0;width:100%;max-width:600px;height:auto;">
  </td></tr>

  <!-- deliverables -->
  <tr><td class="bgmain" bgcolor="#0A0919" style="background:#0A0919;padding:30px 28px 10px 28px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">What you get</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
      {deliverables_html(s)}
    </table>
  </td></tr>

  <!-- scope + proof -->
  <tr><td class="bgmain" bgcolor="#0A0919" style="background:#0A0919;padding:22px 28px 6px 28px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">In your industry</div>
    <div class="tm" style="color:#C7C7D4;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;margin-top:10px;">{esc(C.scope_line(s))}</div>
    <div class="tm" style="color:#C7C7D4;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;margin-top:8px;">{esc(C.proof_line(s))}</div>
    <div class="tm" style="color:#C7C7D4;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;margin-top:8px;">Future scope: {esc(s['future'])}</div>
  </td></tr>

  <!-- why it works -->
  <tr><td class="bgmain" bgcolor="#0A0919" style="background:#0A0919;padding:24px 28px 8px 28px;">
    <div style="color:#1B90FF;font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;">Why it works</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      {hooks_html(s)}
    </table>
  </td></tr>

  <!-- closing + CTA -->
  <tr><td class="bghero" bgcolor="#08080f" style="background:#08080f;padding:28px;">
    <div class="tw" style="color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:18px;line-height:26px;font-weight:bold;">Let us map this to your business.</div>
    <div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;margin-top:6px;">A short conversation is enough to scope the work and show you what the first month looks like.</div>
    {btns(18)}
  </td></tr>

  <!-- social -->
  <tr><td class="bgcard" bgcolor="#05050D" style="background:#05050D;padding:22px 28px 6px 28px;" align="center">
    <a href="{C.IG}" style="text-decoration:none;"><img src="{u('instagram.png')}" width="26" alt="Instagram" style="border:0;margin:0 8px;"></a>
    <a href="{C.LI}" style="text-decoration:none;"><img src="{u('linkedin.png')}" width="26" alt="LinkedIn" style="border:0;margin:0 8px;"></a>
    <a href="{C.WA}" style="text-decoration:none;"><img src="{u('whatsapp.png')}" width="26" alt="WhatsApp" style="border:0;margin:0 8px;"></a>
  </td></tr>

  <!-- footer -->
  <tr><td class="bgcard" bgcolor="#05050D" style="background:#05050D;padding:10px 28px 30px 28px;" align="center">
    <img src="{u('mark.png')}" width="34" alt="Hudace" style="border:0;display:inline-block;margin-bottom:10px;">
    <div class="tm" style="color:#9A9AAE;font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;">{C.DOMAIN} &middot; {C.EMAIL} &middot; {C.PHONE}</div>
    <div style="color:#5A5A6E;font-family:Montserrat,Arial,sans-serif;font-size:11px;line-height:18px;margin-top:8px;">You are receiving this because you enquired about Hudace. <a href="{C.SITE}" style="color:#5A5A6E;">Unsubscribe</a>.</div>
  </td></tr>

</table>
</td></tr></table>
</body></html>"""

# ---- message text ----
def deliv_lines(s,n=None):
    items=s["deliverables"][:n] if n else s["deliverables"]
    return "\n".join(f"- {i}" for i in items)

def whatsapp(s):
    return (f"{s['hero']} - Hudace {s['name']}\n\n"
            f"{s['sub']}\n\nWhat you get:\n{deliv_lines(s,5)}\n\n"
            f"Let us scope it for your business.\nChat: {C.WA}\n{C.DOMAIN} | {C.PHONE}")

def linkedin(s):
    return (f"{s['hero']}.\n\n"
            f"{s['sub']} Hudace {s['name']} is built around outcomes, not activity.\n\n"
            f"{s['hooks'][0][1]}\n{s['hooks'][1][1]}\n{s['hooks'][2][1]}\n\n"
            f"What is included:\n{deliv_lines(s,6)}\n\n"
            f"If this fits where you want to take the business, a short conversation is the fastest way to see the plan.\n\n"
            f"{C.DOMAIN} | {C.EMAIL} | {C.PHONE}")

def outreach(s):
    inds=" and ".join(C.INDUSTRIES).lower()
    return (f"Subject: {s['hero']} for {inds} operators\n\n"
            f"Hello,\n\n"
            f"Most teams in {inds} lose ground not from lack of effort but from output that is inconsistent and hard to measure. "
            f"Hudace {s['name']} fixes that with a clear, deliverables-first program.\n\n"
            f"In the first engagement you receive:\n{deliv_lines(s,5)}\n\n"
            f"{C.proof_line(s).replace('Proof: ','')}\n\n"
            f"Would you be open to a short call to see how this maps to your operation?\n\n"
            f"Hudace\n{C.DOMAIN} | {C.EMAIL} | {C.PHONE}")

# ---- write emails + batch ----
os.makedirs(".routine/emails",exist_ok=True)
batch=[]
for s in C.SERVICES:
    hb=email_html(s)
    fn=f".routine/emails/{s['key']}.html"
    open(fn,"w").write(hb)
    card=u(f"card_{s['key']}.jpg")
    batch.append({"title":f"[{C.DATE}] {s['subject']}","type":"html_email","body":hb,"image_url":card})
    batch.append({"title":f"[{C.DATE}] {s['subject']} - WhatsApp","type":"whatsapp","body":whatsapp(s),"image_url":card})
    batch.append({"title":f"[{C.DATE}] {s['subject']} - LinkedIn","type":"caption","body":linkedin(s),"image_url":card})
    batch.append({"title":f"[{C.DATE}] {s['subject']} - Outreach","type":"other","body":outreach(s),"image_url":card})

json.dump(batch,open("batch.json","w"),indent=2)
print("emails written:",len(C.SERVICES),"| batch items:",len(batch))
