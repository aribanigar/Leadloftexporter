"""Build Gmail-safe HTML emails + WhatsApp/LinkedIn/outreach text, and batch.json.

HTML: table layout, inline styles, live-text hero title with a plain <img>
photo below (no CSS background images), dual WhatsApp/Website CTAs, deliverables,
industry-scope, WHY IT WORKS hooks, proof, dark-mode-safe bgcolor + media queries.
"""
import os, json, html
from hudace_data import SERVICES, BRAND, CONTACT, IMG_BASE, RUN_DATE, INDUSTRIES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAILS_DIR = os.path.join(ROOT, "content", "emails")
MSG_DIR = os.path.join(ROOT, "content", "messages")
os.makedirs(EMAILS_DIR, exist_ok=True)
os.makedirs(MSG_DIR, exist_ok=True)

A = BRAND["accent"]; BG = BRAND["bg"]; BG2 = BRAND["bg2"]; BG3 = BRAND["bg3"]
WHITE = BRAND["text"]; MUTED = BRAND["muted"]

def e(s):
    return html.escape(s, quote=True)

def cta_pair(align="left"):
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
        <tr>
          <td class="stackbtn" style="padding:0 12px 12px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td bgcolor="{A}" style="border-radius:8px;">
                <a href="{CONTACT['wa']}" target="_blank"
                   style="display:inline-block;padding:14px 26px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Chat on WhatsApp</a>
              </td></tr>
            </table>
          </td>
          <td class="stackbtn" style="padding:0 0 12px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border:1px solid #3a3a52;border-radius:8px;">
                <a href="{CONTACT['web']}" target="_blank"
                   style="display:inline-block;padding:14px 26px;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Visit Our Website</a>
              </td></tr>
            </table>
          </td>
        </tr>
      </table>"""

def deliverables_rows(items):
    out = []
    for it in items:
        out.append(f"""
        <tr>
          <td width="22" valign="top" style="padding:6px 0;">
            <div style="width:8px;height:8px;background:{A};border-radius:2px;margin-top:7px;"></div>
          </td>
          <td valign="top" style="padding:6px 0;font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:22px;color:#e8e8f2;">{e(it)}</td>
        </tr>""")
    return "".join(out)

def hooks_rows(hooks):
    out = []
    for i, (title, body) in enumerate(hooks, 1):
        out.append(f"""
        <tr><td style="padding:0 0 18px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td width="40" valign="top">
                <div style="width:32px;height:32px;background:{A};border-radius:16px;color:#ffffff;font-family:Montserrat,Arial,sans-serif;font-size:15px;font-weight:700;text-align:center;line-height:32px;">{i}</div>
              </td>
              <td valign="top" style="padding-left:6px;">
                <div style="font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;padding-bottom:4px;">{e(title)}</div>
                <div style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:21px;color:{MUTED};">{e(body)}</div>
              </td>
            </tr>
          </table>
        </td></tr>""")
    return "".join(out)

def social_row():
    icons = [
        ("icon-instagram.png", CONTACT["instagram"], "Instagram"),
        ("icon-linkedin.png", CONTACT["linkedin"], "LinkedIn"),
        ("icon-whatsapp.png", CONTACT["wa"], "WhatsApp"),
    ]
    cells = ""
    for fn, url, alt in icons:
        cells += f"""<td style="padding:0 8px;"><a href="{url}" target="_blank"><img src="{IMG_BASE}/{fn}" width="28" height="28" alt="{alt}" style="display:block;border:0;"></a></td>"""
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>{cells}</tr></table>"""

def build_email_html(svc):
    card = f"{IMG_BASE}/{svc['key']}-card.jpg"
    photo = f"{IMG_BASE}/{svc['key']}-photo.jpg"
    label_style = f"font-family:Montserrat,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;color:{A};text-transform:uppercase;"
    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{e(svc['name'])} | Hudace</title>
<style>
  :root {{ color-scheme: dark; supported-color-schemes: dark; }}
  body {{ margin:0; padding:0; background:{BG3}; }}
  @media (prefers-color-scheme: light) {{
    .darkbg {{ background:{BG} !important; }}
    .darkbg2 {{ background:{BG2} !important; }}
  }}
  [data-ogsc] .darkbg {{ background:{BG} !important; }}
  [data-ogsc] .darkbg2 {{ background:{BG2} !important; }}
  [data-ogsc] .wtext {{ color:#ffffff !important; }}
  @media only screen and (max-width:600px) {{
    .container {{ width:100% !important; }}
    .px {{ padding-left:22px !important; padding-right:22px !important; }}
    .stackbtn {{ display:block !important; width:100% !important; padding-right:0 !important; }}
    .stackbtn a {{ display:block !important; text-align:center !important; }}
    .heroword {{ font-size:34px !important; line-height:40px !important; }}
  }}
</style>
</head>
<body class="darkbg" style="margin:0;padding:0;background:{BG3};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">{e(svc['sub'])}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG3}" style="background:{BG3};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

    <!-- Header -->
    <tr><td class="darkbg px" bgcolor="{BG}" style="background:{BG};padding:22px 32px;border-radius:14px 14px 0 0;">
      <img src="{IMG_BASE}/hudace-logo-white.png" height="26" alt="Hudace" style="display:block;border:0;height:26px;">
    </td></tr>

    <!-- Hero: live text title -->
    <tr><td class="darkbg2 px" bgcolor="{BG2}" style="background:{BG2};padding:36px 32px 8px 32px;">
      <div style="{label_style}">Hudace {'Growth' if svc['key']!='schoolos' else 'SchoolOS'}</div>
      <div class="heroword wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:40px;line-height:46px;font-weight:800;color:#ffffff;padding:12px 0 10px 0;">{e(svc['hero_word'])}</div>
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:16px;line-height:24px;color:#c9c9d8;padding-bottom:22px;">{e(svc['sub'])}</div>
      {cta_pair()}
    </td></tr>

    <!-- Hero photo -->
    <tr><td class="darkbg2" bgcolor="{BG2}" style="background:{BG2};padding:8px 32px 24px 32px;">
      <img src="{photo}" width="536" alt="{e(svc['name'])}" style="display:block;border:0;width:100%;max-width:536px;border-radius:10px;">
    </td></tr>

    <!-- Deliverables -->
    <tr><td class="darkbg px" bgcolor="{BG}" style="background:{BG};padding:30px 32px 10px 32px;">
      <div style="{label_style}">What you get</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding-top:12px;">
        {deliverables_rows(svc['deliverables'])}
      </table>
    </td></tr>

    <!-- Industry scope -->
    <tr><td class="darkbg px" bgcolor="{BG}" style="background:{BG};padding:22px 32px 6px 32px;">
      <div style="{label_style}">Scope</div>
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:23px;color:#d8d8e6;padding-top:10px;">{e(svc['scope'])}</div>
    </td></tr>

    <!-- Why it works -->
    <tr><td class="darkbg px" bgcolor="{BG}" style="background:{BG};padding:26px 32px 8px 32px;">
      <div style="{label_style}">Why it works</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding-top:16px;">
        {hooks_rows(svc['hooks'])}
      </table>
    </td></tr>

    <!-- Proof + future -->
    <tr><td class="darkbg px" bgcolor="{BG}" style="background:{BG};padding:8px 32px 6px 32px;">
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;color:{MUTED};padding-bottom:10px;">{e(svc['proof'])}</div>
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;color:{MUTED};">{e(svc['future'])}</div>
    </td></tr>

    <!-- Close + CTA -->
    <tr><td class="darkbg2 px" bgcolor="{BG2}" style="background:{BG2};padding:28px 32px;">
      <div class="wtext" style="font-family:Montserrat,Arial,sans-serif;font-size:18px;line-height:26px;font-weight:700;color:#ffffff;padding-bottom:18px;">{e(svc['closing'])}</div>
      {cta_pair()}
    </td></tr>

    <!-- Footer -->
    <tr><td class="darkbg px" bgcolor="{BG3}" style="background:{BG3};padding:26px 32px;border-radius:0 0 14px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle"><img src="{IMG_BASE}/hudace-mark.png" width="30" height="30" alt="Hudace" style="display:block;border:0;"></td>
          <td valign="middle" align="right">{social_row()}</td>
        </tr>
      </table>
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;color:{MUTED};padding-top:16px;">{CONTACT['site']} &middot; {CONTACT['email']} &middot; {CONTACT['phone_display']}</div>
      <div style="font-family:Montserrat,Arial,sans-serif;font-size:11px;line-height:18px;color:#6b6b80;padding-top:8px;">You are receiving this because you expressed interest in Hudace. <a href="{CONTACT['web']}" style="color:#6b6b80;text-decoration:underline;">Unsubscribe</a></div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>"""

def whatsapp_text(svc):
    top = svc["deliverables"][:3]
    return (
        f"Hudace | {svc['card_headline']}\n\n"
        f"{svc['sub']}\n\n"
        "You get:\n" + "\n".join(f"- {d}" for d in top) + "\nand more.\n\n"
        f"{svc['closing']}\n"
        f"Chat: {CONTACT['wa']}\n"
        f"{CONTACT['site']} | {CONTACT['phone_display']}"
    )

def linkedin_text(svc):
    lines = [
        f"{svc['card_headline']}.",
        "",
        svc["scope"],
        "",
        "What Hudace delivers:",
    ]
    lines += [f"- {d}" for d in svc["deliverables"][:5]]
    lines += [
        "",
        svc["proof"],
        "",
        f"{svc['closing']}",
        f"{CONTACT['site']} | {CONTACT['email']} | {CONTACT['phone_display']}",
    ]
    return "\n".join(lines)

def outreach_text(svc):
    return (
        f"Subject: {svc['card_headline']}\n\n"
        "Hello,\n\n"
        f"{svc['scope']}\n\n"
        f"Hudace runs this as a defined package, not an open-ended retainer. You get:\n"
        + "\n".join(f"- {d}" for d in svc["deliverables"][:5]) + "\nand more.\n\n"
        f"{svc['proof']}\n\n"
        f"Would a short call this week work to walk through it on your own numbers.\n\n"
        f"Hudace\n{CONTACT['site']} | {CONTACT['email']} | {CONTACT['phone_display']}"
    )

def main():
    batch = []
    for svc in SERVICES:
        card = f"{IMG_BASE}/{svc['key']}-card.jpg"
        # HTML email
        h = build_email_html(svc)
        with open(os.path.join(EMAILS_DIR, f"{svc['key']}.html"), "w") as f:
            f.write(h)
        batch.append({
            "title": f"[{RUN_DATE}] {svc['subject']}",
            "type": "html_email",
            "body": h,
            "image_url": card,
        })
        # WhatsApp
        wa = whatsapp_text(svc)
        with open(os.path.join(MSG_DIR, f"{svc['key']}-whatsapp.txt"), "w") as f:
            f.write(wa)
        batch.append({
            "title": f"[{RUN_DATE}] {svc['subject']} - WhatsApp",
            "type": "whatsapp", "body": wa, "image_url": card,
        })
        # LinkedIn
        li = linkedin_text(svc)
        with open(os.path.join(MSG_DIR, f"{svc['key']}-linkedin.txt"), "w") as f:
            f.write(li)
        batch.append({
            "title": f"[{RUN_DATE}] {svc['subject']} - LinkedIn",
            "type": "caption", "body": li, "image_url": card,
        })
        # Outreach
        o = outreach_text(svc)
        with open(os.path.join(MSG_DIR, f"{svc['key']}-outreach.txt"), "w") as f:
            f.write(o)
        batch.append({
            "title": f"[{RUN_DATE}] {svc['subject']} - Outreach",
            "type": "other", "body": o, "image_url": card,
        })

    with open(os.path.join(ROOT, "batch.json"), "w") as f:
        json.dump(batch, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(batch)} items to batch.json ({len(SERVICES)} services x 4)")
    print(f"Emails in {EMAILS_DIR}, messages in {MSG_DIR}")

if __name__ == "__main__":
    main()
