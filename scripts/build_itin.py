#!/usr/bin/env python3
"""
build_itin.py - Build ViaKashmir Itinerary B2B content for one or all markets.

Produces per market:  email.html  whatsapp.txt  linkedin.txt  meta.json

Usage:
  python3 scripts/build_itin.py --date 2026-06-22 --all
  python3 scripts/build_itin.py --date 2026-06-22 --market india
  python3 scripts/build_itin.py --date 2026-06-22 --all --preview   # local file:// paths
"""
import argparse, datetime, json, os, sys, textwrap
from pathlib import Path

ROOT = Path(__file__).parent.parent
PHOTOS_DIR = ROOT / "content" / "via-kashmir-itinerary" / "_assets" / "photos"
CONTENT_BASE = ROOT / "content" / "via-kashmir-itinerary"

WSRV = "https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main"
LOGO_URL = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png"
CTA_URL = "https://viakashmiritinerary.in/signup"
MARKETS = ["india", "kashmir", "saudi", "dubai"]


def wsrv_photo(tag: str, w: int = 1200) -> str:
    return f"{WSRV}/content/via-kashmir-itinerary/_assets/photos/{tag}.jpg&w={w}&output=jpg&q=82"


def local_photo(tag: str) -> str:
    return str(PHOTOS_DIR / f"{tag}.jpg")


def fallback_tag(market: str) -> str:
    defaults = {"india": "manali", "kashmir": "kashmir", "saudi": "cappadocia", "dubai": "maldives"}
    return defaults.get(market, "manali")


# ─── Market copy definitions ───────────────────────────────────────────────────

def get_copy(market: str, date_str: str) -> dict:
    """Return all copy fields for a given market."""
    copies = {
        "india": {
            "lang": "en",
            "dir": "ltr",
            "bilingual": False,
            "dest_name": "Manali",
            "campaign_code": f"VKI-India-{date_str}-Manali",
            "campaign_name": f"VKI India {date_str} — Manali speed angle",
            "subject": "You lost that Manali booking. Here is why.",
            "preheader": "Another agent quoted in 2 minutes. Yours took 18. That is the whole story.",
            "headline": "That Manali booking went to the agent who quoted first.",
            "subline": "Build any Indian trip — Manali, Goa, Kerala, Rajasthan — in about 2 minutes.",
            "cta_text": "Start Building Free",
            "accent_strip": "Any destination. Any client. Ready in about 2 minutes.",
            "compare_title": "Same trip. Very different timelines.",
            "by_hand": [
                "15–20 minutes in Word",
                "Fonts that reset themselves",
                "Day rates copy-pasted one by one",
                "Client waiting. Agent sweating.",
            ],
            "with_builder": [
                "About 2 minutes, start to PDF",
                "Looks like you designed it",
                "Clean, branded, client-ready",
                "Quote sent. Booking won.",
            ],
            "built_for": "Manali, Goa, Kerala, Rajasthan, Ladakh — any destination your clients ask for. The builder does not care where it is. You fill in the details; it handles the presentation.",
            "cta_card_title": "Send the quote before the other agent does.",
            "cta_card_body": "Two minutes. Any destination. Your name on it. No learning curve, no price tag that makes you think twice.",
            "urgency": "Every minute in Word is a minute your client waits — and considers the agent who replied faster.",
            "whatsapp": textwrap.dedent("""\
                Bhai, ek honest sawaal —

                Client ne Manali ka trip maanga. Tumne Word khola, fonts set karne lage, day rates copy karne lage...

                Doosra agent ne 2 minute mein clean PDF bhej diya. Client gaya.

                *ViaKashmir Itinerary Builder* se koi bhi destination — Manali, Goa, Kerala, Rajasthan — 2 minute mein ready. Branded, client-ready, seedha bhejo.

                Ek baar try karo: viakashmiritinerary.in/signup

                Agli booking miss mat karo.
            """).strip(),
            "linkedin": textwrap.dedent("""\
                Most travel agents are still quoting trips in Word.

                One agent spent 18 minutes on the Manali itinerary. Another used ViaKashmir Itinerary Builder and sent the same quote in under 2 minutes. The client booked with the second.

                Speed is not just efficiency — it is the difference between winning and losing the booking.

                Build any itinerary, any Indian destination, in about 2 minutes. Clean. Branded. Client-ready.

                → viakashmiritinerary.in/signup
            """).strip(),
        },

        "kashmir": {
            "lang": "en",
            "dir": "ltr",
            "bilingual": False,
            "dest_name": "Kashmir",
            "campaign_code": f"VKI-Kashmir-{date_str}-DalLake",
            "campaign_name": f"VKI Kashmir {date_str} — Dal Lake speed",
            "subject": "Dal Lake to Gulmarg in 2 minutes, not 20.",
            "preheader": "Your Kashmir packages are great. Your quoting time is the problem.",
            "headline": "Your Kashmir packages deserve better than a Word doc.",
            "subline": "Dal Lake, Gulmarg, Pahalgam — or Leh, Vaishno Devi, any destination — ready in about 2 minutes.",
            "cta_text": "Build Your First Itinerary",
            "accent_strip": "Local circuit. Global tool. Any destination in minutes.",
            "compare_title": "Same Dal Lake itinerary. Different timelines.",
            "by_hand": [
                "15–20 minutes per itinerary in Word",
                "Formatting the same circuit every time",
                "Client gets a cluttered PDF",
                "You do this 5 times a day",
            ],
            "with_builder": [
                "About 2 minutes per itinerary",
                "Clean design, every time, automatically",
                "Client gets a polished, branded PDF",
                "Same circuit, 5× faster",
            ],
            "built_for": "Dal Lake, Gulmarg, Pahalgam — and Leh, Vaishno Devi, Doodhpathri, or anywhere else your clients want to go. The builder works for every destination, not just Kashmir.",
            "cta_card_title": "Quote faster. Close more.",
            "cta_card_body": "Two minutes per itinerary. Your branding on it. No manual, no training. Works for every destination you sell.",
            "urgency": "The agents closing more Kashmir bookings are not the ones who know the circuit better — they are the ones who quote it faster.",
            "whatsapp": textwrap.dedent("""\
                Kashmir ke agents ke liye ek baat —

                Dal Lake, Gulmarg, Pahalgam ka itinerary banana toh aata hai. But Word mein 15-20 minute waste hote hain — aur phir bhi output average lagta hai.

                *ViaKashmir Itinerary Builder* se wahi trip 2 minute mein — clean PDF, branded, seedha client ke inbox mein.

                Aur sirf Kashmir nahi — Leh, Vaishno Devi, ya koi bhi destination.

                Try karo: viakashmiritinerary.in/signup

                Ek baar use karo toh sab samajh aa jaata hai.
            """).strip(),
            "linkedin": textwrap.dedent("""\
                Kashmir travel agents — you know the Dal Lake circuit inside out.

                The part slowing you down is not knowledge. It is the 15–20 minutes of formatting every single itinerary.

                ViaKashmir Itinerary Builder: Dal Lake – Gulmarg – Pahalgam, fully formatted and client-ready in about 2 minutes. Not 20. Any destination, same speed.

                → viakashmiritinerary.in/signup
            """).strip(),
        },

        "saudi": {
            "lang": "ar",
            "dir": "rtl",
            "bilingual": True,
            "dest_name": "Cappadocia",
            "campaign_code": f"VKI-Saudi-{date_str}-Cappadocia",
            "campaign_name": f"VKI Saudi {date_str} — Cappadocia speed",
            "subject": "Cappadocia itinerary: 2 minutes, not 20 — خطة كابادوكيا في دقيقتين",
            "preheader": "Any destination. Any client. Quoted in minutes — for agents across Saudi Arabia.",
            "headline": "Your clients want Cappadocia. Quote it in 2 minutes.",
            "subline": "Istanbul, Maldives, Baku, Georgia, Bali, the Alps — any destination, any client, ready in about 2 minutes.",
            "cta_text": "Start Building Free",
            "accent_strip": "Any destination, anywhere in the world — quoted in about 2 minutes.",
            "compare_title": "Same Cappadocia itinerary. Very different timelines.",
            "by_hand": [
                "15–20 minutes in Word per client",
                "Fonts, tables, formatting fights",
                "Different file every time, inconsistent look",
                "Client waits. Agent stressed.",
            ],
            "with_builder": [
                "About 2 minutes from start to PDF",
                "Consistent, polished design every time",
                "Your agency name and brand on it",
                "Quote sent. Client impressed.",
            ],
            "built_for": "Cappadocia, Istanbul, Maldives, Baku, Georgia, Bali, Thailand — or any destination your clients ask for. The builder is destination-agnostic. You fill the details; it handles the presentation.",
            "cta_card_title": "The faster agent wins the booking.",
            "cta_card_body": "Two minutes. Any destination on the map. Your brand on every page. No learning curve, no heavy price tag.",
            "urgency": "While you are still in Word, another agent has already sent the Cappadocia PDF. Speed is not a nice-to-have — it is how you win.",
            "arabic_headline": "عملاؤك يريدون كابادوكيا — أرسل العرض في دقيقتين",
            "arabic_body": textwrap.dedent("""\
                بناء أي خط سير سياحي لأي وجهة في العالم — كابادوكيا، إسطنبول، جورجيا، المالديف، بالي، تايلاند — في دقيقتين تقريباً.

                لا مزيد من Word. لا تنسيق مُضيِّع للوقت. عميلك يحصل على PDF احترافي يحمل اسم وكالتك.

                الوكيل الأسرع يفوز بالحجز — دائماً.
            """).strip(),
            "arabic_cta": "ابدأ الآن مجاناً",
            "whatsapp": textwrap.dedent("""\
                Your client wants Cappadocia. You open Word. 20 minutes later you are still fixing fonts.

                Meanwhile another agent used ViaKashmir Itinerary Builder and sent a clean, branded PDF in under 2 minutes.

                Any destination — Cappadocia, Istanbul, Maldives, Baku, Bali — quoted in minutes.

                Try it: viakashmiritinerary.in/signup

                ———

                عميلك يريد كابادوكيا. تفتح Word. بعد 20 دقيقة لا تزال تُعدّل الخطوط.

                بينما وكيل آخر أرسل عرضاً احترافياً في أقل من دقيقتين.

                أي وجهة — كابادوكيا، إسطنبول، المالديف، باكو، بالي — في دقائق.

                جرّبه: viakashmiritinerary.in/signup
            """).strip(),
            "linkedin": textwrap.dedent("""\
                Travel agents in Saudi Arabia — your clients are booking Cappadocia, Istanbul, Maldives, Georgia.

                The question is not which destination. The question is who quotes it first.

                ViaKashmir Itinerary Builder: any itinerary, any destination, in about 2 minutes. Professional PDF, your agency branding, no Word, no formatting struggle.

                → viakashmiritinerary.in/signup
            """).strip(),
        },

        "dubai": {
            "lang": "ar",
            "dir": "rtl",
            "bilingual": True,
            "dest_name": "Maldives",
            "campaign_code": f"VKI-Dubai-{date_str}-Maldives",
            "campaign_name": f"VKI Dubai {date_str} — Maldives speed",
            "subject": "Maldives itinerary in Word: 20 min. In the builder: 2.",
            "preheader": "The faster agent wins the Maldives booking. Every single time.",
            "headline": "Your Maldives quote should not take longer than the flight.",
            "subline": "Istanbul, Georgia, Thailand, Bali, Europe — any itinerary, any destination, ready in about 2 minutes.",
            "cta_text": "Try the Builder Free",
            "accent_strip": "Maldives, Istanbul, Bali, or anywhere. Quoted in 2 minutes.",
            "compare_title": "Same Maldives package. Two very different outcomes.",
            "by_hand": [
                "15–20 minutes per itinerary in Word",
                "Copy-paste from last time, fix errors",
                "Generic-looking PDF clients barely read",
                "You repeat this process daily",
            ],
            "with_builder": [
                "About 2 minutes per itinerary",
                "No copy-paste, no reformatting",
                "Polished PDF clients actually keep",
                "Quote in the time it takes to make coffee",
            ],
            "built_for": "Maldives, Istanbul, Georgia, Thailand, Bali, the Alps, Japan — or wherever your client is going next. The builder works for every destination. Your expertise drives the itinerary; it handles the design.",
            "cta_card_title": "Quote it before anyone else does.",
            "cta_card_body": "Two minutes. Any destination. Your agency name on every page. No complex onboarding, no price tag that makes you think twice.",
            "urgency": "In the Dubai market, your client has already WhatsApped three agents. The one who replies with a polished itinerary first — wins.",
            "arabic_headline": "خطة المالديف لا ينبغي أن تأخذ أكثر من دقيقتين",
            "arabic_body": textwrap.dedent("""\
                المالديف، إسطنبول، جورجيا، تايلاند، بالي — أي وجهة يطلبها عميلك، أرسل خط السير في دقيقتين تقريباً.

                لا مزيد من Word. لا تنسيق يأخذ 20 دقيقة. PDF احترافي يحمل اسم وكالتك، جاهز في لحظات.

                في سوق دبي، العميل يُرسل واتساب لثلاثة وكلاء. من يرد أولاً بعرض جاهز — يأخذ الحجز.
            """).strip(),
            "arabic_cta": "جرّبه مجاناً الآن",
            "whatsapp": textwrap.dedent("""\
                Quick question for UAE travel agents —

                How long does a Maldives itinerary take you in Word? 15–20 minutes of formatting, rate-checking, fixing the same things every time.

                ViaKashmir Itinerary Builder: same itinerary in about 2 minutes. Clean. Branded. Client-ready.

                Works for every destination — Maldives, Istanbul, Georgia, Thailand, Bali.

                Try it free: viakashmiritinerary.in/signup

                ———

                سؤال سريع لوكلاء السفر في الإمارات —

                كم من الوقت يستغرق خط سير المالديف في Word؟ 15-20 دقيقة من التنسيق والتحقق من الأسعار وتكرار نفس الأخطاء.

                ViaKashmir Itinerary Builder: نفس خط السير في دقيقتين تقريباً. نظيف. احترافي. جاهز للعميل.

                يعمل لكل الوجهات — المالديف، إسطنبول، جورجيا، تايلاند، بالي.

                جرّبه مجاناً: viakashmiritinerary.in/signup
            """).strip(),
            "linkedin": textwrap.dedent("""\
                UAE travel agents — your clients are asking for Maldives, Istanbul, Georgia, Thailand.

                The difference between winning that booking and losing it is often just 10 minutes of quoting speed.

                ViaKashmir Itinerary Builder: any itinerary, any destination, in about 2 minutes. Clean PDF, your agency branding, no Word, no formatting.

                → viakashmiritinerary.in/signup
            """).strip(),
        },
    }
    return copies[market]


# ─── HTML Rendering ────────────────────────────────────────────────────────────

def _li_bad(text: str) -> str:
    return f'<p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b4c3b;line-height:1.4;">✗ {text}</p>'


def _li_good(text: str) -> str:
    return f'<p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a6644;line-height:1.4;">✓ {text}</p>'


def render_html(copy: dict, hero_url: str, feat_url: str, preview: bool = False) -> str:
    by_hand_html = "".join(_li_bad(t) for t in copy["by_hand"])
    with_builder_html = "".join(_li_good(t) for t in copy["with_builder"])

    arabic_section = ""
    if copy.get("bilingual"):
        arabic_section = f"""
<!-- ARABIC SECTION -->
<tr><td bgcolor="#f8f4ee" style="padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#c8a84b" style="padding:10px 40px;">
    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#1a1a1a;letter-spacing:1px;text-transform:uppercase;">العربية</p>
  </td></tr>
  <tr><td bgcolor="#f8f4ee" style="padding:32px 40px;" dir="rtl">
    <h2 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#0e3d2f;text-align:right;">{copy.get("arabic_headline","")}</h2>
    <p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3d3d3d;line-height:1.8;text-align:right;">{copy.get("arabic_body","").replace(chr(10),"<br>")}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" align="right">
    <tr><td bgcolor="#0e3d2f" style="border-radius:6px;padding:14px 28px;">
      <a href="{CTA_URL}" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">{copy.get("arabic_cta","ابدأ الآن")}</a>
    </td></tr>
    </table>
  </td></tr>
  </table>
</td></tr>"""

    return f"""<!DOCTYPE html>
<html lang="{copy['lang']}" dir="{copy['dir']}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="x-apple-disable-message-reformatting">
<title>{copy['subject']}</title>
<style>
body{{margin:0;padding:0;background-color:#f0ede8;}}
table{{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}}
img{{border:0;display:block;outline:none;}}
a{{color:#c8a84b;}}
.btn:hover{{opacity:0.88!important;}}
@media screen and (max-width:620px){{
  .container{{width:100%!important;}}
  .pad{{padding:24px 20px!important;}}
  .hero-h1{{font-size:24px!important;line-height:1.25!important;}}
  .two-col-td{{display:block!important;width:100%!important;box-sizing:border-box!important;margin-bottom:12px!important;}}
  .proof-td{{display:block!important;width:100%!important;padding:16px 20px!important;text-align:left!important;}}
  .spacer-td{{display:none!important;}}
}}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f0ede8;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{copy['preheader']}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0ede8">
<tr><td align="center" style="padding:28px 12px 36px;">

<table class="container" role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">

<!-- ① LOGO CARD -->
<tr><td bgcolor="#ffffff" align="center" style="padding:28px 32px;border-radius:12px 12px 0 0;border-bottom:2px solid #e8e3dc;">
  <a href="https://viakashmiritinerary.in" style="text-decoration:none;">
    <img src="{LOGO_URL}" width="160" height="54" alt="ViaKashmir" style="height:auto;display:block;margin:0 auto;">
  </a>
  <p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#9e9589;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;">Itinerary Builder</p>
</td></tr>

<!-- ② HERO IMAGE -->
<tr><td bgcolor="#0e3d2f" style="padding:0;line-height:0;font-size:0;">
  <img src="{hero_url}" width="600" alt="{copy['dest_name']}" style="width:100%;max-width:600px;height:250px;object-fit:cover;display:block;">
</td></tr>

<!-- ③ HEADLINE CARD -->
<tr><td bgcolor="#0e3d2f" style="padding:36px 40px 40px;" class="pad">
  <h1 class="hero-h1" style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#ffffff;line-height:1.3;">{copy['headline']}</h1>
  <p style="margin:0 0 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#a8d5b8;line-height:1.55;">{copy['subline']}</p>
  <table role="presentation" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#4caf8c" style="border-radius:6px;" class="btn">
    <a href="{CTA_URL}" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;padding:14px 32px;">{copy['cta_text']}</a>
  </td></tr>
  </table>
</td></tr>

<!-- ④ ACCENT STRIP -->
<tr><td bgcolor="#2d7a5f" style="padding:14px 40px;">
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#d4f0e4;letter-spacing:0.3px;">{copy['accent_strip']}</p>
</td></tr>

<!-- ⑤ TWO-COL COMPARISON -->
<tr><td bgcolor="#ffffff" style="padding:36px 40px;" class="pad">
  <h2 style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#1a1a1a;line-height:1.3;">{copy['compare_title']}</h2>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td class="two-col-td" valign="top" width="46%" style="padding:20px;background:#fdf5f0;border-radius:8px;border-top:3px solid #c4a882;">
      <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#7a5540;letter-spacing:1.5px;text-transform:uppercase;">By Hand</p>
      {by_hand_html}
    </td>
    <td class="spacer-td" width="8%">&nbsp;</td>
    <td class="two-col-td" valign="top" width="46%" style="padding:20px;background:#f0f8f4;border-radius:8px;border-top:3px solid #4caf8c;">
      <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#0e6644;letter-spacing:1.5px;text-transform:uppercase;">With VKI Builder</p>
      {with_builder_html}
    </td>
  </tr>
  </table>
</td></tr>

<!-- ⑥ FEATURE IMAGE + CAPTION -->
<tr><td bgcolor="#112b1e" style="padding:0;line-height:0;font-size:0;">
  <img src="{feat_url}" width="600" alt="Built for every trip" style="width:100%;max-width:600px;height:200px;object-fit:cover;display:block;opacity:0.55;">
</td></tr>
<tr><td bgcolor="#112b1e" style="padding:24px 40px 28px;" class="pad">
  <h2 style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#ffffff;">Built for every trip you sell.</h2>
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#7eb898;line-height:1.55;">{copy['built_for']}</p>
</td></tr>

<!-- ⑦ CTA CARD -->
<tr><td bgcolor="#0e3d2f" style="padding:40px;" class="pad">
  <h2 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#ffffff;">{copy['cta_card_title']}</h2>
  <p style="margin:0 0 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#a8d5b8;line-height:1.55;">{copy['cta_card_body']}</p>
  <table role="presentation" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#c8a84b" style="border-radius:6px;" class="btn">
    <a href="{CTA_URL}" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#1a1a1a;text-decoration:none;display:block;padding:14px 32px;">{copy['cta_text']}</a>
  </td></tr>
  </table>
</td></tr>

<!-- ⑧ PROOF POINTS -->
<tr><td bgcolor="#f8faf8" style="padding:36px 24px;" class="pad">
  <h3 style="margin:0 0 28px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#0e3d2f;">Why agents make the switch.</h3>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td class="proof-td" valign="top" align="center" style="width:33%;padding:0 10px;">
      <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1;">⚡</p>
      <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:700;color:#0e3d2f;">Two minutes.</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666;line-height:1.45;">Any destination. Start to client-ready PDF.</p>
    </td>
    <td class="proof-td" valign="top" align="center" style="width:33%;padding:0 10px;">
      <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1;">✦</p>
      <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:700;color:#0e3d2f;">Looks like you.</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666;line-height:1.45;">Your agency name and brand. Not a generic template.</p>
    </td>
    <td class="proof-td" valign="top" align="center" style="width:33%;padding:0 10px;">
      <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1;">↗</p>
      <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:700;color:#0e3d2f;">No learning curve.</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666;line-height:1.45;">Use it today. No manual, no training needed.</p>
    </td>
  </tr>
  </table>
</td></tr>

{arabic_section}

<!-- ⑨ URGENCY STRIP -->
<tr><td bgcolor="#c8a84b" style="padding:20px 40px;" class="pad">
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#1a1a1a;line-height:1.45;">{copy['urgency']}</p>
</td></tr>

<!-- ⑩ CONTACT -->
<tr><td bgcolor="#1a2e25" style="padding:28px 40px;" class="pad">
  <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#7eb898;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Questions?</p>
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#ffffff;line-height:1.7;">
    <a href="mailto:contact@viakashmir.in" style="color:#c8a84b;text-decoration:none;">contact@viakashmir.in</a><br>
    <a href="https://wa.me/919186051499" style="color:#c8a84b;text-decoration:none;">WhatsApp: +91 918 605 1499</a>
  </p>
</td></tr>

<!-- ⑪ FOOTER -->
<tr><td bgcolor="#0a2b1e" style="padding:20px 40px;border-radius:0 0 12px 12px;" class="pad">
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#446655;text-align:center;line-height:1.7;">
    &copy; 2026 ViaKashmir &middot; <a href="https://viakashmiritinerary.in" style="color:#446655;text-decoration:none;">viakashmiritinerary.in</a><br>
    You are receiving this as a travel professional.&nbsp;
    <a href="mailto:contact@viakashmir.in?subject=Unsubscribe" style="color:#446655;text-decoration:none;">Unsubscribe</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


# ─── Helpers ───────────────────────────────────────────────────────────────────

def load_destinations(date_str: str) -> dict:
    dest_file = CONTENT_BASE / date_str / "destinations.json"
    if dest_file.exists():
        return json.loads(dest_file.read_text())
    return {}


def build_market(date_str: str, market: str, destinations: dict, preview: bool = False) -> Path:
    copy = get_copy(market, date_str)
    mkt_data = destinations.get(market, {})

    hero_tag = mkt_data.get("photo") or fallback_tag(market)
    feat_tag = mkt_data.get("feat") or hero_tag

    if preview:
        hero_url = local_photo(hero_tag)
        feat_url = local_photo(feat_tag)
    else:
        hero_url = wsrv_photo(hero_tag, 1200)
        feat_url = wsrv_photo(feat_tag, 800)

    out_dir = CONTENT_BASE / date_str / market
    out_dir.mkdir(parents=True, exist_ok=True)

    # email.html
    html = render_html(copy, hero_url, feat_url, preview=preview)
    (out_dir / "email.html").write_text(html, encoding="utf-8")

    # whatsapp.txt
    (out_dir / "whatsapp.txt").write_text(copy["whatsapp"], encoding="utf-8")

    # linkedin.txt
    (out_dir / "linkedin.txt").write_text(copy["linkedin"], encoding="utf-8")

    # meta.json
    meta = {
        "date": date_str,
        "track": market,
        "market": market,
        "audience": "b2b-travel-agents",
        "bilingual": copy["bilingual"],
        "product": "viakashmiritinerary.in",
        "campaign_code": copy["campaign_code"],
        "campaign_name": copy["campaign_name"],
        "subject": copy["subject"],
        "cta_url": CTA_URL,
        "design": "Alpine",
        "hero_photo": hero_tag,
        "feat_photo": feat_tag,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  [build_itin] ✓ {market}: email.html  whatsapp.txt  linkedin.txt  meta.json")
    return out_dir


def main():
    ap = argparse.ArgumentParser(description="Build ViaKashmir Itinerary daily B2B content.")
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--all", action="store_true", help="Build all 4 markets")
    ap.add_argument("--market", choices=MARKETS, help="Build one market")
    ap.add_argument("--preview", action="store_true", help="Use local file:// paths instead of wsrv")
    args = ap.parse_args()

    if not args.all and not args.market:
        ap.error("Provide --all or --market <name>")

    markets = MARKETS if args.all else [args.market]
    destinations = load_destinations(args.date)

    print(f"[build_itin] Date={args.date}  Markets={markets}")
    for m in markets:
        build_market(args.date, m, destinations, preview=args.preview)

    print(f"[build_itin] Done.")


if __name__ == "__main__":
    main()
