#!/usr/bin/env python3
"""Build Gmail-safe HTML emails + batch.json from content.json. Images self-hosted on Vercel."""
import os, json, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE = "2026-07-02"
BASE = "https://leadloftexporter.vercel.app/email"
FONT = "Montserrat, Arial, Helvetica, sans-serif"

C = json.load(open(os.path.join(ROOT, ".build", "content.json")))
CT = C["contact"]
WA = CT["wa"]
SITE = CT["site_url"]

IG = "https://www.instagram.com/hudaceofficial/"
LI = "https://www.linkedin.com/company/hudace"

def esc(s): return html.escape(s, quote=True)

def cta(mt=26):
    return f"""
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-top:{mt}px;">
        <tr>
          <td class="btntd" style="padding:0 12px 0 0;">
            <a class="btn" href="{WA}" style="background-color:#1B90FF;color:#ffffff;font-family:{FONT};font-size:15px;font-weight:700;line-height:20px;text-decoration:none;padding:14px 28px;border-radius:8px;display:inline-block;text-align:center;">Chat on WhatsApp</a>
          </td>
          <td class="btntd" style="padding:0;">
            <a class="btn" href="{SITE}" style="border:2px solid #ffffff;color:#ffffff;font-family:{FONT};font-size:15px;font-weight:700;line-height:20px;text-decoration:none;padding:12px 26px;border-radius:8px;display:inline-block;text-align:center;">Visit Our Website</a>
          </td>
        </tr>
      </table>"""

def label(text):
    return f'<div style="font-family:{FONT};font-size:12px;letter-spacing:2px;color:#1B90FF;font-weight:700;text-transform:uppercase;">{esc(text)}</div>'

def deliverables_rows(items):
    rows = ""
    for it in items:
        rows += f"""
          <tr>
            <td valign="top" width="20" style="padding:7px 0 0 0;">
              <div style="width:8px;height:8px;background-color:#1B90FF;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div>
            </td>
            <td valign="top" style="font-family:{FONT};font-size:15px;line-height:23px;color:#EDEDF4;padding:2px 0 12px 0;">{esc(it)}</td>
          </tr>"""
    return f'<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">{rows}</table>'

def hook_rows(hooks):
    rows = ""
    for i, h in enumerate(hooks, 1):
        rows += f"""
          <tr>
            <td valign="top" width="42" style="padding:0 14px 18px 0;">
              <div style="width:30px;height:30px;background-color:#12305a;border-radius:15px;color:#5db2ff;font-family:{FONT};font-size:15px;font-weight:800;line-height:30px;text-align:center;">{i}</div>
            </td>
            <td valign="top" style="font-family:{FONT};font-size:15px;line-height:23px;color:#D7D7E4;padding:3px 0 18px 0;">{esc(h)}</td>
          </tr>"""
    return f'<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">{rows}</table>'

def social():
    def ic(href, name, alt):
        return f"""<td style="padding:0 7px;"><a href="{href}"><img src="{BASE}/icon-{name}.png" width="30" height="30" alt="{alt}" style="display:block;width:30px;height:30px;"></a></td>"""
    return f"""
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;">
        <tr>{ic(IG,'instagram','Instagram')}{ic(LI,'linkedin','LinkedIn')}{ic(WA,'whatsapp','WhatsApp')}</tr>
      </table>"""

def build_email(svc):
    name, slug = svc["name"], svc["slug"]
    photo = f"{BASE}/{slug}-photo.jpg"
    card = f"{BASE}/{slug}-card.jpg"
    preheader = svc["hero_sub"]
    html_doc = f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{esc(name)} · Hudace</title>
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<!--<![endif]-->
<style>
  body,table,td,a{{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }}
  table,td{{ mso-table-lspace:0pt; mso-table-rspace:0pt; }}
  img{{ -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }}
  body{{ margin:0; padding:0; width:100% !important; background-color:#05050D; }}
  :root{{ color-scheme:dark; supported-color-schemes:dark; }}
  @media only screen and (max-width:600px){{
    .container{{ width:100% !important; }}
    .px{{ padding-left:22px !important; padding-right:22px !important; }}
    .h1{{ font-size:38px !important; line-height:42px !important; }}
    .btn{{ display:block !important; width:100% !important; box-sizing:border-box; margin-bottom:12px !important; }}
    .btntd{{ display:block !important; width:100% !important; padding:0 !important; }}
  }}
  @media (prefers-color-scheme: light){{
    body,.darkbody{{ background-color:#05050D !important; }}
    .darkcard{{ background-color:#0A0919 !important; }}
    .lighttext{{ color:#ffffff !important; }}
  }}
  [data-ogsc] body,[data-ogsc] .darkbody{{ background-color:#05050D !important; }}
  [data-ogsc] .darkcard{{ background-color:#0A0919 !important; }}
  [data-ogsc] .lighttext{{ color:#ffffff !important; }}
</style>
</head>
<body class="darkbody" style="margin:0;padding:0;background-color:#05050D;" bgcolor="#05050D">
<div style="display:none;max-height:0px;overflow:hidden;opacity:0;mso-hide:all;">{esc(preheader)}</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#05050D" style="background-color:#05050D;">
  <tr><td align="center" style="padding:0;">
    <table role="presentation" class="container darkcard" border="0" cellpadding="0" cellspacing="0" width="600" bgcolor="#0A0919" style="width:600px;max-width:600px;background-color:#0A0919;">

      <tr><td class="px" bgcolor="#05050D" style="background-color:#05050D;padding:22px 32px;">
        <img src="{BASE}/hudace-logo-white.png" width="150" alt="Hudace" style="display:block;width:150px;height:auto;">
      </td></tr>

      <tr><td class="px" bgcolor="#08080f" style="background-color:#08080f;padding:42px 32px 32px 32px;">
        {label(name)}
        <div class="h1 lighttext" style="font-family:{FONT};font-size:48px;line-height:52px;color:#ffffff;font-weight:800;margin-top:14px;letter-spacing:-0.5px;">{esc(svc['headline'])}</div>
        <div style="font-family:{FONT};font-size:17px;line-height:26px;color:#B0B0C4;margin-top:16px;max-width:440px;">{esc(svc['hero_sub'])}</div>
        {cta()}
      </td></tr>

      <tr><td bgcolor="#08080f" style="background-color:#08080f;padding:0;font-size:0;line-height:0;">
        <img src="{photo}" width="600" alt="{esc(name)}" style="display:block;width:100%;max-width:600px;height:auto;">
      </td></tr>

      <tr><td class="px darkcard" bgcolor="#0A0919" style="background-color:#0A0919;padding:38px 32px 22px 32px;">
        {label('What you get')}
        {deliverables_rows(svc['deliverables'])}
      </td></tr>

      <tr><td class="px darkcard" bgcolor="#0A0919" style="background-color:#0A0919;padding:14px 32px 24px 32px;">
        {label('In your industry')}
        <div class="lighttext" style="font-family:{FONT};font-size:15px;line-height:24px;color:#EDEDF4;margin-top:14px;">{esc(svc['scope_line'])}</div>
        <div style="font-family:{FONT};font-size:14px;line-height:23px;color:#9A9AAE;margin-top:14px;border-left:3px solid #1B90FF;padding-left:14px;">{esc(svc['proof_line'])}</div>
      </td></tr>

      <tr><td class="px darkcard" bgcolor="#0A0919" style="background-color:#0A0919;padding:14px 32px 26px 32px;">
        {label('Why it works')}
        {hook_rows(svc['hooks'])}
      </td></tr>

      <tr><td class="px" bgcolor="#05050D" style="background-color:#05050D;padding:26px 32px;">
        <img src="{card}" width="536" alt="{esc(name)} overview" style="display:block;width:100%;max-width:536px;height:auto;border-radius:10px;">
      </td></tr>

      <tr><td class="px" bgcolor="#08080f" style="background-color:#08080f;padding:32px 32px 34px 32px;">
        <div class="lighttext" style="font-family:{FONT};font-size:17px;line-height:26px;color:#ffffff;font-weight:600;">{esc(svc['closing_line'])}</div>
        <div style="font-family:{FONT};font-size:14px;line-height:22px;color:#9A9AAE;margin-top:10px;">{esc(svc['future_line'])}</div>
        {cta(mt=22)}
      </td></tr>

      <tr><td class="px" bgcolor="#05050D" align="center" style="background-color:#05050D;padding:34px 32px 40px 32px;">
        <img src="{BASE}/hudace-mark.png" width="46" alt="Hudace" style="display:inline-block;width:46px;height:46px;margin-bottom:16px;">
        {social()}
        <div style="font-family:{FONT};font-size:13px;line-height:20px;color:#9A9AAE;margin-top:18px;">hudace.com &nbsp;&middot;&nbsp; contact@hudace.com &nbsp;&middot;&nbsp; +91 82189 29990</div>
        <div style="font-family:{FONT};font-size:12px;line-height:18px;color:#5f5f70;margin-top:12px;">You are receiving this because you expressed interest in Hudace. <a href="{SITE}" style="color:#7a7a8c;text-decoration:underline;">Unsubscribe</a></div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""
    return html_doc

def main():
    outdir = os.path.join(ROOT, ".build", "emails")
    os.makedirs(outdir, exist_ok=True)
    batch = []
    for svc in C["services"]:
        name, slug = svc["name"], svc["slug"]
        card_url = f"{BASE}/{slug}-card.jpg"
        email_html = build_email(svc)
        with open(os.path.join(outdir, f"{slug}.html"), "w") as fp:
            fp.write(email_html)
        # email
        batch.append({"title": f"[{DATE}] {name}", "type": "html_email", "body": email_html, "image_url": card_url})
        # whatsapp
        batch.append({"title": f"[{DATE}] {name} - WhatsApp", "type": "whatsapp", "body": svc["whatsapp"], "image_url": card_url})
        # linkedin -> caption
        batch.append({"title": f"[{DATE}] {name} - LinkedIn", "type": "caption", "body": svc["linkedin"], "image_url": card_url})
        # outreach -> other
        batch.append({"title": f"[{DATE}] {name} - Outreach", "type": "other", "body": svc["outreach"], "image_url": card_url})
    with open(os.path.join(ROOT, "batch.json"), "w") as fp:
        json.dump(batch, fp, indent=2, ensure_ascii=False)
    print(f"built {len(C['services'])} emails, {len(batch)} batch items -> batch.json")

if __name__ == "__main__":
    main()
