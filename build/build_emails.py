#!/usr/bin/env python3
"""Generate Gmail-safe HTML emails, WhatsApp/LinkedIn/outreach text, and batch.json."""
import os, json, html, datetime, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
CDN = "https://leadloftexporter.vercel.app/email"
WA = "https://wa.me/918218929990"
SITE = "https://hudace.com"
IG = "https://www.instagram.com/hudaceofficial/"
LI = "https://www.linkedin.com/company/hudace"
DATE = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()

def esc(s): return html.escape(str(s), quote=True)

# ---- reusable HTML fragments ----
def cta_pair():
    return f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:6px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="center" bgcolor="#1B90FF" style="border-radius:8px;">
                <a href="{WA}" style="display:block;padding:15px 26px;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Chat on WhatsApp</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="center" bgcolor="#0A0919" style="border-radius:8px;border:1px solid #2A2A40;">
                <a href="{SITE}" style="display:block;padding:15px 26px;font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Visit Our Website</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>"""

def section_label(text):
    return f'<div style="font-family:Montserrat,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;color:#1B90FF;text-transform:uppercase;padding:0 0 12px 0;">{esc(text)}</div>'

def build_email(key, e):
    dl_rows = ""
    for it in e["deliverables"]:
        dl_rows += f"""
        <tr>
          <td valign="top" width="22" style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;font-size:15px;color:#1B90FF;line-height:22px;">&#9642;</td>
          <td valign="top" style="padding:5px 0;font-family:Montserrat,Arial,sans-serif;font-size:15px;color:#EDEDF2;line-height:22px;">{esc(it)}</td>
        </tr>"""

    hooks = ""
    for i, (h, body) in enumerate(e["hooks"], 1):
        hooks += f"""
        <tr>
          <td valign="top" width="40" style="padding:10px 0;font-family:Montserrat,Arial,sans-serif;font-size:22px;font-weight:800;color:#1B90FF;line-height:26px;">{i}</td>
          <td valign="top" style="padding:10px 0;">
            <div style="font-family:Montserrat,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;line-height:22px;">{esc(h)}</div>
            <div style="font-family:Montserrat,Arial,sans-serif;font-size:14px;color:#9A9AAE;line-height:21px;padding-top:4px;">{esc(body)}</div>
          </td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{esc(e['subject'])}</title>
<style>
  :root {{ color-scheme: dark; supported-color-schemes: dark; }}
  body,table,td,a {{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }}
  @media (prefers-color-scheme: light) {{
    .bgmain {{ background:#05050D !important; }}
    .bgcard {{ background:#0A0919 !important; }}
    .bghero {{ background:#08080f !important; }}
    .tw {{ color:#ffffff !important; }}
    .tm {{ color:#9A9AAE !important; }}
  }}
  [data-ogsc] .bgmain {{ background:#05050D !important; }}
  [data-ogsc] .bgcard {{ background:#0A0919 !important; }}
  [data-ogsc] .bghero {{ background:#08080f !important; }}
  [data-ogsc] .tw {{ color:#ffffff !important; }}
  [data-ogsc] .tm {{ color:#9A9AAE !important; }}
  @media only screen and (max-width:600px) {{
    .container {{ width:100% !important; }}
    .px {{ padding-left:22px !important; padding-right:22px !important; }}
  }}
</style>
</head>
<body class="bgmain" bgcolor="#05050D" style="margin:0;padding:0;background:#05050D;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{esc(e['subject'])} . Deliverables-first, from Hudace.</div>
<table role="presentation" class="bgmain" bgcolor="#05050D" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#05050D;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

  <!-- header -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:22px 32px;border-radius:14px 14px 0 0;">
    <img src="{CDN}/logo-hudace.png" width="150" alt="Hudace" style="display:block;border:0;height:auto;">
  </td></tr>

  <!-- hero: live text -->
  <tr><td class="bghero px" bgcolor="#08080f" style="background:#08080f;padding:36px 32px 30px 32px;">
    {section_label('Hudace Growth')}
    <div class="tw" style="font-family:Montserrat,Arial,sans-serif;font-size:38px;line-height:44px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">{esc(e['headline'])}</div>
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:17px;line-height:26px;color:#9A9AAE;padding:12px 0 22px 0;">{esc(e['sub'])}</div>
    {cta_pair()}
  </td></tr>

  <!-- hero photo -->
  <tr><td bgcolor="#08080f" style="background:#08080f;font-size:0;line-height:0;">
    <img src="{CDN}/photo-{key}.jpg" width="600" alt="{esc(e['headline'])}" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
  </td></tr>

  <!-- deliverables -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:34px 32px 10px 32px;">
    {section_label('What you get')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{dl_rows}
    </table>
  </td></tr>

  <!-- scope -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:24px 32px 6px 32px;">
    {section_label('In your industry')}
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:15px;line-height:24px;color:#C7C7D4;">{esc(e['scope'])}</div>
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:23px;color:#9A9AAE;padding-top:12px;">{esc(e['proof'])}</div>
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:23px;color:#9A9AAE;padding-top:12px;">{esc(e['future'])}</div>
  </td></tr>

  <!-- why it works -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:26px 32px 10px 32px;">
    {section_label('Why it works')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{hooks}
    </table>
  </td></tr>

  <!-- closing + CTA -->
  <tr><td class="bghero px" bgcolor="#08080f" style="background:#08080f;padding:30px 32px;border-top:1px solid #17172A;">
    <div class="tw" style="font-family:Montserrat,Arial,sans-serif;font-size:18px;line-height:26px;font-weight:700;color:#ffffff;padding-bottom:6px;">Let us show you what this looks like for your business.</div>
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:14px;line-height:22px;color:#9A9AAE;padding-bottom:18px;">One message and we will map the deliverables to your goals.</div>
    {cta_pair()}
  </td></tr>

  <!-- social -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:24px 32px 8px 32px;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding:0 8px;"><a href="{IG}"><img src="{CDN}/icon-instagram.png" width="26" height="26" alt="Instagram" style="display:block;border:0;"></a></td>
      <td style="padding:0 8px;"><a href="{LI}"><img src="{CDN}/icon-linkedin.png" width="26" height="26" alt="LinkedIn" style="display:block;border:0;"></a></td>
      <td style="padding:0 8px;"><a href="{WA}"><img src="{CDN}/icon-whatsapp.png" width="26" height="26" alt="WhatsApp" style="display:block;border:0;"></a></td>
    </tr></table>
  </td></tr>

  <!-- footer -->
  <tr><td class="bgcard px" bgcolor="#0A0919" style="background:#0A0919;padding:14px 32px 30px 32px;border-radius:0 0 14px 14px;" align="center">
    <img src="{CDN}/mark-hudace.png" width="34" alt="Hudace" style="display:block;border:0;margin:0 auto 12px auto;">
    <div class="tm" style="font-family:Montserrat,Arial,sans-serif;font-size:12px;line-height:20px;color:#9A9AAE;">hudace.com &#183; contact@hudace.com &#183; +91 82189 29990</div>
    <div style="font-family:Montserrat,Arial,sans-serif;font-size:11px;line-height:18px;color:#6A6A7E;padding-top:8px;">You are receiving this from Hudace. <a href="{SITE}" style="color:#6A6A7E;text-decoration:underline;">Unsubscribe</a></div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""

# ---- text channels ----
def whatsapp(e):
    d = e["card_deliverables"]
    return (f"{e['headline'].title()} from Hudace\n\n"
            f"{e['sub']}\n\n"
            f"What you get:\n" + "\n".join(f"- {x}" for x in d) +
            f"\n\nMessage us to map this to your goals.\n{WA}")

def linkedin(e):
    lines = "\n".join(f"- {h}: {b}" for h, b in e["hooks"])
    return (f"{e['headline'].title()}. {e['sub']}\n\n"
            f"What you get:\n" + "\n".join(f"- {x}" for x in e["card_deliverables"]) +
            f"\n\nWhy it works:\n{lines}\n\n"
            f"If this fits where you are headed, we can map it to your goals in one call.\n"
            f"hudace.com | contact@hudace.com | +91 82189 29990")

def outreach(e):
    return (f"Hi,\n\n"
            f"For teams in {e['industry'].lower()}, we deliver {e['headline'].title()} as a fixed, deliverables-first package:\n"
            + "\n".join(f"- {x}" for x in e["card_deliverables"]) +
            f"\n\n{e['scope']}\n\n"
            f"If it is useful, I can share a short plan mapped to your goals. Worth a conversation?\n\n"
            f"Hudace . hudace.com . +91 82189 29990 . {WA}")

def main():
    spec = json.load(open(os.path.join(HERE, "content.json")))
    os.makedirs(os.path.join(HERE, "emails"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "messages"), exist_ok=True)
    batch = []
    order = ["social", "seo", "website", "erp", "aistudio", "schoolos"]
    for key in order:
        e = spec[key]
        name = e["headline"].title()
        card = f"{CDN}/card-{key}.jpg"
        photo = f"{CDN}/photo-{key}.jpg"

        h = build_email(key, e)
        open(os.path.join(HERE, "emails", f"{key}.html"), "w").write(h)
        wa, li, ou = whatsapp(e), linkedin(e), outreach(e)
        open(os.path.join(HERE, "messages", f"{key}.txt"), "w").write(
            f"=== EMAIL {name} ===\n(see emails/{key}.html)\n\n=== WHATSAPP ===\n{wa}\n\n=== LINKEDIN ===\n{li}\n\n=== OUTREACH ===\n{ou}\n")

        batch.append({"title": f"[{DATE}] {name}", "type": "html_email", "body": h, "image_url": photo})
        batch.append({"title": f"[{DATE}] {name} - WhatsApp", "type": "whatsapp", "body": wa, "image_url": card})
        batch.append({"title": f"[{DATE}] {name} - LinkedIn", "type": "caption", "body": li, "image_url": card})
        batch.append({"title": f"[{DATE}] {name} - Outreach", "type": "other", "body": ou, "image_url": card})

    json.dump(batch, open(os.path.join(ROOT, "batch.json"), "w"), indent=2, ensure_ascii=False)
    print(f"Built {len(order)} emails, {len(batch)} batch items for {DATE}")

if __name__ == "__main__":
    main()
