# -*- coding: utf-8 -*-
"""Build Gmail-safe HTML emails + WhatsApp/LinkedIn/outreach text, and emit
batch.json for publish.py. Table layout, fully inline styles, dark-mode safe."""
import os, sys, json, html
sys.path.insert(0, os.path.dirname(__file__))
from data import SERVICES, BRAND, CONTACT, DEPLOY_BASE, RUN_DATE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = BRAND
def e(s): return html.escape(s, quote=True)
def url(name): return "%s/%s" % (DEPLOY_BASE, name)

def cta_pair():
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;">
      <tr>
        <td class="btnwrap" style="padding:6px 6px 6px 0;" bgcolor="{B['bg2']}">
          <a href="{CONTACT['wa']}" class="btn" style="display:block;background:{B['accent']};color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:16px;text-align:center;padding:15px 22px;border-radius:8px;">Chat on WhatsApp</a>
        </td>
        <td class="btnwrap" style="padding:6px 0 6px 6px;" bgcolor="{B['bg2']}">
          <a href="{CONTACT['website']}" class="btn" style="display:block;background:transparent;color:#ffffff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:16px;text-align:center;padding:14px 22px;border-radius:8px;border:1px solid #2b2b40;">Visit Our Website</a>
        </td>
      </tr>
    </table>"""

def deliverables_rows(items):
    out = []
    for it in items:
        out.append(f"""
        <tr><td valign="top" width="26" style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:15px;font-weight:700;">+</td>
        <td style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;color:#e7e7ef;font-size:15px;line-height:22px;">{e(it)}</td></tr>""")
    return "".join(out)

def hooks_rows(hooks):
    out = []
    for i, (t, body) in enumerate(hooks, 1):
        out.append(f"""
        <tr><td style="padding:0 0 18px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="top" width="44" style="font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:26px;font-weight:800;line-height:26px;">{i}</td>
              <td style="font-family:Montserrat,Arial,sans-serif;">
                <div style="color:#ffffff;font-size:16px;font-weight:700;line-height:22px;">{e(t)}</div>
                <div style="color:{B['muted']};font-size:14px;line-height:21px;padding-top:4px;">{e(body)}</div>
              </td>
            </tr>
          </table>
        </td></tr>""")
    return "".join(out)

def social_row():
    icons = [
        ("instagram", CONTACT["instagram"]),
        ("linkedin",  CONTACT["linkedin"]),
        ("whatsapp",  CONTACT["wa"]),
        ("facebook",  CONTACT["website"]),
    ]
    cells = "".join(
        f"""<td style="padding:0 6px;"><a href="{href}"><img src="{url('icon-%s.png'%n)}" width="30" height="30" alt="{n}" style="display:block;border:0;"></a></td>"""
        for n, href in icons)
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>{cells}</tr></table>"""

def build_email(svc):
    name = svc["name"]; ind = svc["industry"]
    head = svc["headline"]; sub = svc["subhead"]
    hero_photo = url("photo-%s.jpg" % svc["slug"])
    card_img = url("card-%s.jpg" % svc["slug"])
    title = "Hudace %s" % name
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{e(title)}</title>
<style>
  body{{margin:0;padding:0;background:{B['bg3']};}}
  @media only screen and (max-width:600px){{
    .container{{width:100% !important;}}
    .px{{padding-left:22px !important;padding-right:22px !important;}}
    .h1{{font-size:46px !important;line-height:48px !important;}}
    .btnwrap{{display:block !important;width:100% !important;padding:6px 0 !important;}}
  }}
  @media (prefers-color-scheme: light){{
    body,.bgsafe{{background-color:{B['bg3']} !important;}}
  }}
  [data-ogsc] .bgsafe{{background-color:{B['bg3']} !important;}}
  [data-ogsc] .txtwhite{{color:#ffffff !important;}}
</style>
</head>
<body style="margin:0;padding:0;background-color:{B['bg3']};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{e(sub)} Deliverables, scope and proof inside.</div>
<table role="presentation" class="bgsafe" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{B['bg3']}">
<tr><td align="center" style="padding:0;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <!-- header -->
  <tr><td class="px" bgcolor="{B['bg2']}" style="padding:22px 32px;" align="left">
    <img src="{url('logo.png')}" width="170" alt="Hudace" style="display:block;border:0;">
  </td></tr>

  <!-- hero live text -->
  <tr><td class="px" bgcolor="{B['bg2']}" style="padding:18px 32px 30px 32px;">
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">{e(name)} for {e(ind)}</div>
    <div class="h1 txtwhite" style="font-family:Montserrat,Arial,sans-serif;color:#ffffff;font-size:64px;line-height:64px;font-weight:800;padding:10px 0 6px 0;">{e(head)}</div>
    <div class="txtwhite" style="font-family:Montserrat,Arial,sans-serif;color:#e7e7ef;font-size:18px;line-height:26px;padding-bottom:22px;">{e(sub)}</div>
    {cta_pair()}
  </td></tr>

  <!-- hero photo -->
  <tr><td bgcolor="{B['bg2']}" style="padding:0;font-size:0;line-height:0;">
    <img src="{hero_photo}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
  </td></tr>

  <!-- deliverables -->
  <tr><td class="px" bgcolor="{B['bg']}" style="padding:34px 32px 10px 32px;">
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding-bottom:14px;">What you get</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      {deliverables_rows(svc['deliverables'])}
    </table>
  </td></tr>

  <!-- scope -->
  <tr><td class="px" bgcolor="{B['bg']}" style="padding:24px 32px 6px 32px;">
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding-bottom:10px;">In {e(ind)}</div>
    <div style="font-family:Montserrat,Arial,sans-serif;color:#d8d8e2;font-size:15px;line-height:23px;">{e(svc['scope'])}</div>
  </td></tr>

  <!-- card image -->
  <tr><td class="px" bgcolor="{B['bg']}" style="padding:24px 32px;">
    <img src="{card_img}" width="536" alt="{e(name)} deliverables" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px;">
  </td></tr>

  <!-- why it works -->
  <tr><td class="px" bgcolor="{B['bg2']}" style="padding:32px 32px 14px 32px;">
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['accent']};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding-bottom:18px;">Why it works</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      {hooks_rows(svc['hooks'])}
    </table>
  </td></tr>

  <!-- proof + future -->
  <tr><td class="px" bgcolor="{B['bg2']}" style="padding:6px 32px 30px 32px;">
    <div style="font-family:Montserrat,Arial,sans-serif;color:#c9c9d6;font-size:14px;line-height:22px;border-left:3px solid {B['accent']};padding-left:14px;">{e(svc['proof'])}</div>
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['muted']};font-size:13px;line-height:21px;padding-top:14px;">{e(svc['future'])}</div>
  </td></tr>

  <!-- closing + CTA -->
  <tr><td class="px" bgcolor="{B['bg3']}" style="padding:30px 32px;">
    <div class="txtwhite" style="font-family:Montserrat,Arial,sans-serif;color:#ffffff;font-size:18px;line-height:26px;font-weight:600;padding-bottom:20px;">{e(svc['closing'])}</div>
    {cta_pair()}
  </td></tr>

  <!-- footer -->
  <tr><td class="px" bgcolor="{B['bg3']}" style="padding:10px 32px 34px 32px;" align="left">
    <img src="{url('mark.png')}" width="34" height="34" alt="Hudace" style="display:block;border:0;padding-bottom:14px;">
    <div style="padding-bottom:14px;">{social_row()}</div>
    <div style="font-family:Montserrat,Arial,sans-serif;color:{B['muted']};font-size:12px;line-height:20px;">{CONTACT['site']} &middot; {CONTACT['email']} &middot; {CONTACT['phone_display']}</div>
    <div style="font-family:Montserrat,Arial,sans-serif;color:#5a5a6e;font-size:11px;line-height:18px;padding-top:8px;">You are receiving this because you expressed interest in Hudace. <a href="{CONTACT['website']}" style="color:#5a5a6e;">Unsubscribe</a>.</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>"""

def whatsapp_text(svc):
    d = svc["deliverables"]
    top = "\n".join("- " + x for x in d[:4])
    return (f"{svc['name']} for {svc['industry'].lower()} by Hudace.\n\n{svc['subhead']}\n\n"
            f"{top}\n- and more\n\n{svc['closing']}\n\nChat: {CONTACT['wa']}\n{CONTACT['site']}")

def linkedin_text(svc):
    hooks = "\n".join(f"- {t}. {b}" for t, b in svc["hooks"])
    d = ", ".join(svc["deliverables"][:4]).lower()
    return (f"{svc['headline'].title()}: {svc['subhead']}\n\n"
            f"What {svc['name']} delivers for {svc['industry'].lower()}: {d}, and more.\n\n"
            f"{hooks}\n\n{svc['proof']}\n\n{svc['closing']}\n\n"
            f"Talk to us: {CONTACT['wa']} | {CONTACT['email']} | {CONTACT['site']}")

def outreach_text(svc):
    return (f"Subject: {svc['name']} for {svc['industry']}, deliverables ready\n\n"
            f"Hello,\n\n"
            f"Most {svc['industry'].lower()} teams do not need more tools. They need the work done. "
            f"Hudace delivers {svc['name']} as a finished monthly output: {', '.join(svc['deliverables'][:5]).lower()}, and more.\n\n"
            f"{svc['scope']}\n\n{svc['proof']}\n\n"
            f"One ask: a short call to map this to your goals. Reply here or message {CONTACT['wa']}.\n\n"
            f"Hudace\n{CONTACT['site']} | {CONTACT['email']} | {CONTACT['phone_display']}")

def main():
    batch = []
    previews = os.path.join(ROOT, ".routine", "previews")
    os.makedirs(previews, exist_ok=True)
    for svc in SERVICES:
        tag = "[%s] %s | %s" % (RUN_DATE, svc["industry"], svc["name"])
        card = url("card-%s.jpg" % svc["slug"])
        em = build_email(svc)
        with open(os.path.join(previews, "%s.html" % svc["slug"]), "w") as f:
            f.write(em)
        batch.append({"title": tag, "type": "html_email", "body": em, "image_url": card})
        batch.append({"title": tag + " (WhatsApp)", "type": "whatsapp", "body": whatsapp_text(svc), "image_url": card})
        batch.append({"title": tag + " (LinkedIn)", "type": "caption", "body": linkedin_text(svc), "image_url": card})
        batch.append({"title": tag + " (Outreach)", "type": "other", "body": outreach_text(svc), "image_url": card})
    with open(os.path.join(ROOT, "batch.json"), "w") as f:
        json.dump(batch, f, ensure_ascii=False, indent=2)
    print("wrote batch.json with", len(batch), "items across", len(SERVICES), "services")

if __name__ == "__main__":
    main()
