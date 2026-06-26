# -*- coding: utf-8 -*-
"""Generate the Hudace daily batch: photos, baked cards, email HTML, batch.json."""
import html as _html, json, sys
from pathlib import Path
import imgkit
from content import EMAILS, DELIV, RUN_DATE, INDUSTRIES

ROOT = Path(__file__).resolve().parents[2]
HOST = "https://leadloftexporter.vercel.app/email"
WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"

def esc(s): return _html.escape(s, quote=True)

def deliv_rows(items):
    out = []
    for it in items:
        out.append(
            '      <tr><td style="padding:7px 0 7px 16px;border-left:2px solid #1B90FF;">\n'
            '        <span style="color:#ffffff;font-size:14px;line-height:1.6;font-family:Arial,sans-serif;">%s</span>\n'
            '      </td></tr>' % esc(it))
    return "\n".join(out)

def hook_rows(hooks):
    out = []
    for i,(t,b) in enumerate(hooks, 1):
        out.append(
            '      <tr><td style="padding:0 0 16px;">\n'
            '        <table cellpadding="0" cellspacing="0" border="0" width="100%%"><tr>\n'
            '          <td valign="top" width="34" style="color:#1B90FF;font-size:20px;font-weight:bold;font-family:Arial,sans-serif;">%d</td>\n'
            '          <td valign="top">\n'
            '            <div style="color:#ffffff;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:3px;">%s</div>\n'
            '            <div style="color:#9A9AAE;font-size:13px;line-height:1.6;font-family:Arial,sans-serif;">%s</div>\n'
            '          </td>\n'
            '        </tr></table>\n'
            '      </td></tr>' % (i, esc(t), esc(b)))
    return "\n".join(out)

CTA_PAIR = '''    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td width="50%" style="padding:0 6px 0 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#1B90FF" style="background:#1B90FF;border-radius:4px;">
          <tr><td align="center" style="padding:14px 12px;">
            <a href="''' + WA + '''" style="text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;"><span style="color:#ffffff;">Chat on WhatsApp</span></a>
          </td></tr>
        </table>
      </td>
      <td width="50%" style="padding:0 0 0 6px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#08080f" style="background:#08080f;border:1px solid #1B90FF;border-radius:4px;">
          <tr><td align="center" style="padding:14px 12px;">
            <a href="''' + SITE + '''" style="text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;"><span style="color:#ffffff;">Visit Our Website</span></a>
          </td></tr>
        </table>
      </td>
    </tr></table>'''

def build_email(e, promo_name, body_name):
    items = DELIV[e["title_key"]]
    eyebrow_disp = e["eyebrow"].upper()
    h = '''<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>{title}</title>
  <style>
    @media (prefers-color-scheme: dark) {{
      body, table, td {{ background-color:#0A0919 !important; color:#ffffff !important; }}
    }}
    [data-ogsc] body, [data-ogsc] table, [data-ogsc] td {{ background-color:#0A0919 !important; }}
  </style></head>
<body style="margin:0;padding:0;background-color:#0A0919;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0919" style="background-color:#0A0919;">
<tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0919" style="background-color:#0A0919;max-width:600px;">

  <!-- HEADER LOGO -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:26px 40px 22px;border-bottom:1px solid #1a1a2e;">
    <img src="{host}/hudace-logo.png" alt="Hudace" height="34" style="display:block;height:34px;width:auto;border:0;">
  </td></tr>

  <!-- HERO TEXT -->
  <tr><td bgcolor="#08080f" style="background-color:#08080f;padding:46px 40px 36px;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">{eyebrow}</div>
    <h1 style="color:#ffffff;font-size:32px;line-height:1.22;margin:0 0 14px;font-family:Arial,sans-serif;font-weight:bold;">{headline}</h1>
    <p style="color:#9A9AAE;font-size:15px;line-height:1.65;margin:0 0 26px;font-family:Arial,sans-serif;">{subhead}</p>
{cta}
  </td></tr>

  <!-- HERO PHOTO (baked 4:5 card) -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:0;">
    <img src="{host}/{promo}" alt="Hudace offer" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
  </td></tr>

  <!-- DELIVERABLES -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:34px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">What You Receive</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
{deliv}</table>
  </td></tr>

  <!-- INDUSTRY SCOPE -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:30px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;font-family:Arial,sans-serif;">{scopelabel}</div>
    <p style="color:#ffffff;font-size:14px;line-height:1.7;margin:0;font-family:Arial,sans-serif;">{scope}</p>
  </td></tr>

  <!-- BODY PHOTO -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:28px 40px 0;">
    <img src="{host}/{body}" alt="Hudace work" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:6px;margin:0 auto;">
  </td></tr>

  <!-- WHY IT WORKS -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:30px 40px 0;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px;font-family:Arial,sans-serif;">Why It Works</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
{hooks}</table>
  </td></tr>

  <!-- PROOF + FUTURE -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:6px 40px 0;">
    <p style="color:#9A9AAE;font-size:13px;line-height:1.7;margin:0 0 10px;font-family:Arial,sans-serif;">{proof}</p>
    <p style="color:#9A9AAE;font-size:13px;line-height:1.7;margin:0;font-family:Arial,sans-serif;">{future}</p>
  </td></tr>

  <!-- DIVIDER -->
  <tr><td style="padding:30px 40px 0;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background-color:#1a1a2e;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

  <!-- CLOSING + DUAL CTA -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:26px 40px 0;">
    <p style="color:#ffffff;font-size:15px;line-height:1.6;margin:0 0 22px;font-family:Arial,sans-serif;">{closing}</p>
{cta}
  </td></tr>

  <!-- SOCIAL ICONS -->
  <tr><td bgcolor="#0A0919" style="background-color:#0A0919;padding:28px 40px 4px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:14px;"><a href="https://www.instagram.com/hudaceofficial/"><img src="{host}/icon-instagram.png" alt="Instagram" width="30" height="30" style="display:block;border:0;"></a></td>
      <td style="padding-right:14px;"><a href="https://www.linkedin.com/company/hudace"><img src="{host}/icon-linkedin.png" alt="LinkedIn" width="30" height="30" style="display:block;border:0;"></a></td>
      <td style="padding-right:14px;"><a href="{wa}"><img src="{host}/icon-whatsapp.png" alt="WhatsApp" width="30" height="30" style="display:block;border:0;"></a></td>
    </tr></table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td bgcolor="#05050D" style="background-color:#05050D;padding:24px 40px 30px;border-top:1px solid #1a1a2e;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="46"><img src="{host}/hudace-mark.png" alt="Hudace" width="34" height="34" style="display:block;border:0;"></td>
      <td valign="middle">
        <p style="color:#9A9AAE;font-size:12px;margin:0 0 5px;font-family:Arial,sans-serif;">hudace.com &middot; contact@hudace.com &middot; +91 82189 29990</p>
        <p style="color:#444455;font-size:11px;margin:0;font-family:Arial,sans-serif;"><a href="#" style="color:#444455;text-decoration:underline;">Unsubscribe</a></p>
      </td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>'''.format(
        title=esc(e["caption_h"]), host=HOST, eyebrow=esc(eyebrow_disp),
        headline=esc(e["headline"]), subhead=esc(e["subhead"]), cta=CTA_PAIR,
        promo=promo_name, body=body_name, deliv=deliv_rows(items),
        scopelabel=("In Your Sector" if e["industry"] else "Inside the Institution"),
        scope=esc(e["scope"]), hooks=hook_rows(e["hooks"]),
        proof=esc(e["proof"]), future=esc(e["future"]), closing=esc(e["closing"]), wa=WA)
    return h

def title_for(e):
    if e["industry"]:
        return "[%s] %s | %s" % (RUN_DATE, e["industry"], e["service"])
    return "[%s] %s" % (RUN_DATE, e["service"])

def caption_text(e):
    return ("%s\n\n%s\n\nhudace.com | contact@hudace.com | +91 82189 29990"
            % (e["caption_h"], e["caption_body"]))

def outreach_text(e):
    items = DELIV[e["title_key"]][:6]
    bullets = "\n".join("- %s" % it for it in items)
    return ("Subject: %s\n\nHello,\n\n%s\n\nWhat you would receive:\n%s\n\n%s\n\n"
            "Would a short call this week work to walk through the plan?\n\n"
            "Hudace | hudace.com | contact@hudace.com | +91 82189 29990 | %s"
            % (e["outreach_subj"], e["outreach_open"], bullets, e["outreach_proof"], WA))

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    batch = []
    log = []
    for e in EMAILS:
        if only and e["slug"] != only:
            continue
        promo_name = "promo-%s.jpg" % e["slug"]
        body_name = "body-%s.jpg" % e["slug"]
        bg_name = "_bg-%s.jpg" % e["slug"]
        promo_url = "%s/%s" % (HOST, promo_name)
        # 1. fetch background photo for the card
        try:
            imgkit.fetch_photo(e["bgq"], bg_name, skip=0, darken=0.58)
            imgkit.bake_card(bg_name, promo_name, e["eyebrow"], e["headline"], e["card_items"])
            (ROOT/"public"/"email"/bg_name).unlink(missing_ok=True)
            log.append("OK  card  %s" % promo_name)
        except Exception as ex:
            log.append("FAIL card %s: %s" % (promo_name, ex))
        # 2. fetch body photo
        try:
            imgkit.fetch_photo(e["bodyq"], body_name, skip=1, darken=0.66)
            log.append("OK  body  %s" % body_name)
        except Exception as ex:
            log.append("FAIL body %s: %s" % (body_name, ex))
        # 3. email html
        html_body = build_email(e, promo_name, body_name)
        base_title = title_for(e)
        batch.append({"title": base_title, "type": "html_email", "body": html_body, "image_url": promo_url})
        batch.append({"title": base_title + " (WhatsApp)", "type": "whatsapp", "body": e["wa"], "image_url": promo_url})
        batch.append({"title": base_title + " (LinkedIn)", "type": "caption", "body": caption_text(e), "image_url": promo_url})
        batch.append({"title": base_title + " (Outreach)", "type": "other", "body": outreach_text(e), "image_url": promo_url})
        log.append("BUILT %s (4 items)" % base_title)

    out = ROOT/"batch.json"
    out.write_text(json.dumps(batch, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n".join(log))
    print("\nWROTE %s items -> %s" % (len(batch), out))

if __name__ == "__main__":
    main()
