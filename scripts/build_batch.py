#!/usr/bin/env python3
"""Generate the daily batch: Gmail-safe HTML emails plus WhatsApp / LinkedIn /
outreach copy for each service, and write batch.json for publish_rest.py.

Emails are table-layout, fully inline-styled, dark-mode safe (real bgcolor
attributes + prefers-color-scheme + [data-ogsc]). Hero is live text + a plain
<img> photo (no CSS background images). Images are self-hosted under
public/email and referenced by their deployed URL.
"""
import os, sys, json, datetime, html
sys.path.insert(0, os.path.dirname(__file__))
from content_model import (SERVICES, IMG_BASE, BG, BG_DEEP, BG_HERO, WHITE, MUTED,
                           ACCENT, PHONE_DISPLAY, WA_LINK, EMAIL, SITE, SITE_URL,
                           IG_URL, LI_URL, INDUSTRY_A, INDUSTRY_B)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
RUN_DATE = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()

def e(s):
    return html.escape(s, quote=True)

def cta_pair():
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
      <tr>
        <td style="padding:6px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
            <tr>
              <td bgcolor="{ACCENT}" style="border-radius:8px;background:{ACCENT};" align="center">
                <a href="{WA_LINK}" style="display:block;padding:15px 20px;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Chat on WhatsApp</a>
              </td>
              <td width="14" style="width:14px;line-height:14px;font-size:0;">&nbsp;</td>
              <td bgcolor="{BG_HERO}" style="border-radius:8px;border:1px solid #2b2b40;background:{BG_HERO};" align="center">
                <a href="{SITE_URL}" style="display:block;padding:15px 20px;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Visit Our Website</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>"""

def label(text):
    return (f'<div style="font-family:Montserrat,Arial,sans-serif;font-size:12px;'
            f'font-weight:700;letter-spacing:2px;color:{ACCENT};text-transform:uppercase;'
            f'margin:0 0 10px 0;">{e(text)}</div>')

def deliverables_block(svc):
    rows = ""
    for it in svc["deliverables"]:
        rows += f"""
        <tr>
          <td valign="top" width="22" style="width:22px;padding:7px 0 0 0;">
            <div style="width:8px;height:8px;background:{ACCENT};border-radius:2px;"></div>
          </td>
          <td valign="top" style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;color:#EAEAF2;padding:2px 0;">{e(it)}</td>
        </tr>"""
    return f"""
    {label("Deliverables")}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{rows}</table>"""

def why_block(svc):
    rows = ""
    for i, w in enumerate(svc["why"], 1):
        rows += f"""
        <tr>
          <td valign="top" width="34" style="width:34px;padding:4px 0 0 0;">
            <div style="font-family:Montserrat,Arial,sans-serif;font-size:20px;font-weight:800;color:{ACCENT};">{i}</div>
          </td>
          <td valign="top" style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;color:#D6D6E0;padding:2px 0 16px 0;">{e(w)}</td>
        </tr>"""
    return f"""
    {label("Why it works")}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{rows}</table>"""

def section(inner, bg=BG, pad="26px 30px"):
    return f"""
      <tr>
        <td bgcolor="{bg}" style="background:{bg};padding:{pad};">
          {inner}
        </td>
      </tr>"""

def social_row():
    icons = [("ic_instagram.png", IG_URL, "Instagram"),
             ("ic_linkedin.png", LI_URL, "LinkedIn"),
             ("ic_whatsapp.png", WA_LINK, "WhatsApp")]
    cells = ""
    for fn, url, alt in icons:
        cells += f"""<td style="padding:0 8px;"><a href="{url}"><img src="{IMG_BASE}/{fn}" width="22" height="22" alt="{alt}" style="display:block;border:0;"></a></td>"""
    return f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>{cells}</tr></table>'

def build_email(svc):
    photo = f"{IMG_BASE}/photo-{svc['key']}.jpg"
    card = f"{IMG_BASE}/card-{svc['key']}.jpg"
    preheader = e(svc["subhead"])
    title_word = e(svc["headline"])
    subj = f"{svc['name']}: {svc['headline']}"

    hero = f"""
      <tr>
        <td bgcolor="{BG_HERO}" style="background:{BG_HERO};padding:34px 30px 26px 30px;">
          <img src="{IMG_BASE}/logo-white.png" height="30" alt="Hudace" style="display:block;border:0;height:30px;margin-bottom:26px;">
          {label(svc["label"])}
          <div style="font-family:Montserrat,Arial,sans-serif;font-size:34px;line-height:40px;font-weight:800;color:#ffffff;margin:0 0 12px 0;">{title_word}</div>
          <div style="font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:25px;color:{MUTED};margin:0 0 22px 0;">{e(svc["subhead"])}</div>
          {cta_pair()}
        </td>
      </tr>
      <tr>
        <td bgcolor="{BG_HERO}" style="background:{BG_HERO};padding:0;font-size:0;line-height:0;">
          <img src="{photo}" width="600" alt="{e(svc['name'])}" style="display:block;border:0;width:100%;max-width:600px;height:auto;">
        </td>
      </tr>"""

    scope = f"""
      {label("Scope in your sector")}
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;color:#D6D6E0;margin:0;">{e(svc["scope"])}</div>"""

    proof = f"""
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;color:#EAEAF2;border-left:3px solid {ACCENT};padding:2px 0 2px 16px;margin:0 0 14px 0;">{e(svc["proof"])}</div>
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:23px;color:{MUTED};margin:0;">{e(svc["future"])}</div>"""

    card_img = f"""
      <a href="{WA_LINK}"><img src="{card}" width="600" alt="{e(svc['name'])} offer" style="display:block;border:0;width:100%;max-width:600px;height:auto;border-radius:10px;"></a>"""

    close = f"""
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:25px;color:#ffffff;font-weight:600;margin:0 0 18px 0;">Tell us where you want to grow and we will scope it in a short call.</div>
      {cta_pair()}"""

    footer = f"""
      <tr>
        <td bgcolor="{BG_DEEP}" style="background:{BG_DEEP};padding:26px 30px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="middle"><img src="{IMG_BASE}/mark-white.png" height="26" alt="Hudace" style="display:block;border:0;height:26px;"></td>
              <td align="right" valign="middle">{social_row()}</td>
            </tr>
          </table>
          <div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;line-height:22px;color:{MUTED};margin:18px 0 0 0;">{e(SITE)} &middot; {e(EMAIL)} &middot; {e(PHONE_DISPLAY)}</div>
          <div style="font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;color:#6B6B7E;margin:8px 0 0 0;">Hudace, AI-native industry ERP and growth. <a href="{SITE_URL}" style="color:#6B6B7E;text-decoration:underline;">Unsubscribe</a></div>
        </td>
      </tr>"""

    body = f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{e(subj)}</title>
<style>
  body{{margin:0;padding:0;background:{BG_DEEP};}}
  a{{color:{ACCENT};}}
  @media (prefers-color-scheme: light) {{
    .bg-body{{background:{BG_DEEP} !important;}}
  }}
  @media (prefers-color-scheme: dark) {{
    .bg-body{{background:{BG_DEEP} !important;}}
  }}
  u + .body .bg-body{{background:{BG_DEEP} !important;}}
  [data-ogsc] .bg-body{{background:{BG_DEEP} !important;}}
  @media only screen and (max-width:600px) {{
    .stack{{display:block !important;width:100% !important;}}
  }}
</style>
</head>
<body class="body" style="margin:0;padding:0;background:{BG_DEEP};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:{BG_DEEP};">{preheader}</div>
<table role="presentation" class="bg-body" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="{BG_DEEP}" style="background:{BG_DEEP};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;" bgcolor="{BG}">
        {hero}
        {section(deliverables_block(svc))}
        {section(scope, bg=BG_HERO)}
        {section(why_block(svc))}
        {section(card_img, bg=BG_HERO, pad="24px 30px")}
        {section(proof)}
        {section(close, bg=BG_HERO)}
        {footer}
      </table>
    </td>
  </tr>
</table>
</body>
</html>"""
    return subj, body

def whatsapp_text(svc):
    d = svc["deliverables"]
    top = "\n".join("- " + x for x in d[:5])
    return (f"{svc['name']} from Hudace\n\n{svc['subhead']}\n\nWhat you get:\n{top}\n"
            f"{'' if len(d)<=5 else f'- and {len(d)-5} more' + chr(10)}"
            f"\n{svc['proof']}\n\nChat with us: {WA_LINK}\n{SITE} | {PHONE_DISPLAY}")

def linkedin_text(svc):
    lines = "\n".join("- " + x for x in svc["deliverables"][:4])
    hooks = svc["why"][0]
    return (f"{svc['headline']}.\n\n{svc['subhead']}\n\n{svc['scope']}\n\n"
            f"What a Hudace {svc['name']} engagement delivers:\n{lines}\n- and more\n\n"
            f"{hooks}\n\nIf this maps to where you want to grow, message us or write to {EMAIL}.\n"
            f"{SITE} | {PHONE_DISPLAY}")

def outreach_text(svc):
    ind = svc["industry"]
    return (f"Subject: {svc['name']} for {ind.lower()} teams\n\n"
            f"Hello,\n\n"
            f"We work with {ind.lower()} organizations on {svc['name'].lower()}, and the goal is simple: "
            f"{svc['subhead'][0].lower() + svc['subhead'][1:]}\n\n"
            f"A typical engagement includes {svc['deliverables'][0].lower()}, {svc['deliverables'][1].lower()}, "
            f"and {svc['deliverables'][2].lower()}, delivered on a clear monthly plan.\n\n"
            f"{svc['scope']}\n\n"
            f"Would a short call this week make sense to scope it for your team?\n\n"
            f"Hudace | {SITE} | {EMAIL} | {PHONE_DISPLAY}")

def main():
    batch = []
    for svc in SERVICES:
        card_url = f"{IMG_BASE}/card-{svc['key']}.jpg"
        subj, body = build_email(svc)
        base = svc["name"]
        batch.append({"title": f"[{RUN_DATE}] {base}", "type": "html_email",
                      "body": body, "image_url": f"{IMG_BASE}/photo-{svc['key']}.jpg"})
        batch.append({"title": f"[{RUN_DATE}] {base} WhatsApp", "type": "whatsapp",
                      "body": whatsapp_text(svc), "image_url": card_url})
        batch.append({"title": f"[{RUN_DATE}] {base} LinkedIn", "type": "caption",
                      "body": linkedin_text(svc), "image_url": card_url})
        batch.append({"title": f"[{RUN_DATE}] {base} Outreach", "type": "other",
                      "body": outreach_text(svc), "image_url": card_url})
        # also write a preview HTML file for local inspection
        with open(os.path.join(ROOT, "public", "email", f"preview-{svc['key']}.html"), "w") as f:
            f.write(body)
    with open(os.path.join(ROOT, "batch.json"), "w") as f:
        json.dump(batch, f, indent=2, ensure_ascii=False)
    print(f"batch.json written: {len(batch)} items ({len(SERVICES)} services x 4)")

if __name__ == "__main__":
    main()
