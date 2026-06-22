#!/usr/bin/env python3
"""
build_itin.py — ViaKashmir Itinerary content engine.
Generates email.html, whatsapp.txt, linkedin.txt, meta.json for each market.

Usage:
    python3 scripts/build_itin.py --date 2026-06-22 --all
    python3 scripts/build_itin.py --date 2026-06-22 --market india
    python3 scripts/build_itin.py --date 2026-06-22 --all --preview   # local img paths
"""
import argparse, datetime as dt, json, os, sys
from pathlib import Path
from textwrap import dedent

ROOT       = Path(__file__).resolve().parent.parent
CONTENT    = ROOT / "content" / "via-kashmir-itinerary"
PHOTO_DIR  = CONTENT / "_assets" / "photos"
CTA_URL    = "https://viakashmiritinerary.in/signup"
LOGO_URL   = "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png"
CONTACT_EMAIL = "contact@viakashmir.in"
CONTACT_WA    = "wa.me/919186051499"
CONTACT_PHONE = "+91 918 605 1499"
REPO_RAW   = "https://raw.githubusercontent.com/aribanigar/Leadloftexporter/main"
WSRV_BASE  = "https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main"

GREEN      = "#0e3d2f"
GREEN2     = "#1a5c44"
MINT       = "#7dd9b0"
MINT_LIGHT = "#e8f5f0"
SAFFRON    = "#c8a84b"
WHITE      = "#ffffff"
TEXT       = "#2d2d2d"
TEXT_LIGHT = "#555555"
BG         = "#f5f5f5"


# ---------------------------------------------------------------------------
# Market content definitions
# ---------------------------------------------------------------------------

MARKETS = {
    "india": {
        "audience":     "india",
        "bilingual":    False,
        "subject":      "Kerala quote in 2 minutes — before the next agent sends theirs",
        "tag":          "Kerala · Monsoon 2026",
        "hook_headline":"Kerala clients are calling. Who sends the itinerary first?",
        "hook_sub":     "Monsoon turns Kerala into the most visual sell in India — backwaters, tea hills, waterfalls. Agents who quote fast win the booking.",
        "comparison_pain": "Your competitor opens ViaKashmir Itinerary. You open Word.",
        "byhand_title": "By hand",
        "byhand_items": [
            "15–20 minutes per itinerary",
            "Copy-paste from last year's doc",
            "Fix fonts, adjust spacing",
            "Miss a detail, send it late",
        ],
        "withtool_title": "With ViaKashmir Itinerary",
        "withtool_items": [
            "~2 minutes from blank to client-ready",
            "Pick destinations, add days, preview",
            "Branded, professional PDF output",
            "Client receives it before the call ends",
        ],
        "feat_headline": "Built for every trip you sell — not just Kerala",
        "feat_body":     "Kerala today. Spiti tomorrow. Andaman next week. One builder for every route you handle — any destination, any number of days.",
        "proof": [
            ("Two minutes",        "From blank to client-ready itinerary in about 2 minutes. Not 15."),
            ("Looks like you",     "Branded output — clients receive a formatted itinerary, not a Word doc."),
            ("Any destination",    "Kerala, Rajasthan, Leh, Andaman — the builder handles every route you sell."),
        ],
        "urgency":   "Clients who don't get a quote today book with someone who does.",
        "cta_headline": "Build a Kerala itinerary right now — free to start",
        "cta_sub":      "No learning curve. No setup. Ready in minutes.",
        "whatsapp": dedent("""\
            Ek client ne Kerala trip ke liye quote maanga — aapne kitna time lagaya?

            Agar 15-20 minute lage, toh next time try karo ViaKashmir Itinerary builder:
            → viakashmiritinerary.in/signup

            Kerala se Rajasthan tak — koi bhi itinerary, 2 minute mein ready.
            Client-ready PDF, apna branding, seedha phone pe share karo.

            Ek baar use karo, phir Word kabhi mat kholo 😄
        """).strip(),
        "linkedin": dedent("""\
            Kerala monsoon season is here — and the agents who quote first are winning the bookings.

            If you're still building itineraries in Word, you're spending 15-20 minutes on something that takes about 2 minutes in ViaKashmir Itinerary.

            → Pick destinations. Add days. Preview. Send.
            → Client-ready PDF. Your branding. Any route.

            Kerala, Rajasthan, Ladakh, Andaman — one builder for every trip you sell.

            Try it free: viakashmiritinerary.in/signup
        """).strip(),
        "campaign_name": "IB-india-kerala-2026-06-22",
    },

    "kashmir": {
        "audience":     "kashmir",
        "bilingual":    False,
        "subject":      "Dal Lake to Gulmarg — full Kashmir circuit, ready in 2 minutes",
        "tag":          "Kashmir · Summer 2026",
        "hook_headline":"Kashmir season is live. First agent to quote wins.",
        "hook_sub":     "Dal Lake, Pahalgam, Gulmarg — your clients know what they want. They just need the itinerary. Get it to them in 2 minutes.",
        "comparison_pain": "Every Kashmir agent is quoting right now. The polished one arrives first.",
        "byhand_title": "By hand",
        "byhand_items": [
            "15–20 minutes per itinerary",
            "Juggle Word, Excel, photos, pricing",
            "Format manually for each client",
            "Risk errors in the final PDF",
        ],
        "withtool_title": "With ViaKashmir Itinerary",
        "withtool_items": [
            "~2 minutes: full Kashmir circuit ready",
            "Dal Lake, Gulmarg, Pahalgam — one flow",
            "Client-ready branded output instantly",
            "Add Leh or Vaishno Devi leg in seconds",
        ],
        "feat_headline": "Not just Kashmir — any destination your client asks for",
        "feat_body":     "Build Kashmir routes for your local clients. Then quote Rajasthan, Leh, or Vaishno Devi for the next call — the same builder handles everything.",
        "proof": [
            ("Two minutes",        "Full Dal Lake–Gulmarg–Pahalgam circuit built in about 2 minutes."),
            ("Looks like you",     "Professional, branded itinerary — not a forwarded Word doc."),
            ("Any route",          "Add a Leh extension, a Vaishno Devi leg — the builder is flexible."),
        ],
        "urgency":   "The client who calls three agents books with whoever sends a clean itinerary first.",
        "cta_headline": "Build a Kashmir itinerary right now — free to start",
        "cta_sub":      "No setup time. Quote any circuit in minutes.",
        "whatsapp": dedent("""\
            Kashmir season chalu ho gaya — aur clients 3-4 agents ko saath mein quote kar rahe hain.

            Jo agent pehle clean itinerary bhejta hai, woh booking leta hai.

            ViaKashmir Itinerary builder se:
            → Dal Lake + Pahalgam + Gulmarg — 2 minute mein ready
            → Branded PDF, seedha WhatsApp pe share karo
            → Leh ya Vaishno Devi add karna ho? 30 second

            Try karo: viakashmiritinerary.in/signup
        """).strip(),
        "linkedin": dedent("""\
            Kashmir season is here — and your clients are comparing 3-4 quotes simultaneously.

            The one who sends a clean, professional itinerary first, wins.

            ViaKashmir Itinerary lets you build a full Dal Lake–Gulmarg–Pahalgam circuit in about 2 minutes. Add a Leh leg. Add Vaishno Devi. Branded, client-ready output.

            No Word. No Excel. No losing a booking to a faster agent.

            Try it free: viakashmiritinerary.in/signup
        """).strip(),
        "campaign_name": "IB-kashmir-2026-06-22",
    },

    "saudi": {
        "audience":     "saudi",
        "bilingual":    True,
        "subject":      "Quote Cappadocia in 2 minutes — not 20",
        "subject_ar":   "أنجز عرض تركيا لعميلك في دقيقتين",
        "tag":          "Cappadocia · Turkey",
        "hook_headline":"Your client wants Cappadocia. Quote them before the next agent does.",
        "hook_sub":     "Turkey is the top summer destination for Saudi travellers in 2026. Agents who quote clean, fast, professional itineraries win the booking.",
        "hook_headline_ar": "عميلك يريد كابادوكيا — هل ستكون أول من يرسل العرض؟",
        "hook_sub_ar":  "تركيا هي الوجهة الأولى للمسافرين السعوديين هذا الصيف. الوكالة التي ترسل عرضاً احترافياً أولاً تكسب الحجز.",
        "comparison_pain": "You open Word. A competitor opens ViaKashmir Itinerary and sends a polished quote in 2 minutes.",
        "byhand_title": "By hand",
        "byhand_items": [
            "15–20 minutes per itinerary",
            "Copy-paste from previous trips",
            "Format manually for each client",
            "Risk losing the booking to a faster agent",
        ],
        "withtool_title": "With ViaKashmir Itinerary",
        "withtool_items": [
            "~2 minutes: Cappadocia itinerary ready",
            "Istanbul, Antalya, Trabzon — same tool",
            "Client-ready professional output",
            "Build any destination, any route",
        ],
        "feat_headline": "Istanbul today. Maldives tomorrow. Any destination, 2 minutes.",
        "feat_body":     "Build Cappadocia routes, Istanbul city breaks, Maldives escapes, Baku weekends — whatever your Saudi clients want, built in minutes on one platform.",
        "feat_headline_ar": "إسطنبول اليوم. المالديف غداً. أي وجهة، في دقيقتين.",
        "feat_body_ar":  "سواء أراد عميلك كابادوكيا أو إسطنبول أو المالديف أو باكو — ابنِ أي مسار في دقائق.",
        "proof": [
            ("دقيقتان / 2 minutes",  "Build any itinerary in about 2 minutes. Not 15–20."),
            ("يعكس هويتك / Looks like you", "Professional branded output — not a forwarded Word file."),
            ("أي وجهة / Any destination", "Turkey, Maldives, Georgia, Bali — one builder for every trip."),
        ],
        "urgency":   "The agent who sends first gets the booking. Don't let it be someone else.",
        "urgency_ar": "الوكيل الذي يرسل العرض أولاً يحصل على الحجز.",
        "cta_headline": "Build a Cappadocia itinerary right now",
        "cta_headline_ar": "ابنِ خط سير كابادوكيا الآن",
        "cta_sub":      "Free to start. No learning curve. Any destination.",
        "whatsapp": dedent("""\
            Your client is asking for Cappadocia — and comparing 3 agents at once.

            With ViaKashmir Itinerary:
            → Full Turkey itinerary in ~2 minutes
            → Istanbul, Cappadocia, Antalya, Trabzon — same tool
            → Professional branded output, ready to share

            Try it free: viakashmiritinerary.in/signup

            ---
            عميلك يريد كابادوكيا، وهو يقارن بين ثلاثة وكلاء في نفس الوقت.

            مع ViaKashmir Itinerary:
            → خط سير تركيا كامل في دقيقتين تقريباً
            → إسطنبول، كابادوكيا، أنطاليا — نفس الأداة
            → عرض احترافي جاهز للإرسال

            جرّبه مجاناً: viakashmiritinerary.in/signup
        """).strip(),
        "linkedin": dedent("""\
            Turkey is the #1 summer destination for Saudi travellers in 2026 — and your clients are comparing quotes from multiple agents right now.

            The one who sends a clean, professional Cappadocia itinerary first, wins.

            ViaKashmir Itinerary builds any itinerary — Turkey, Maldives, Georgia, Bali, anywhere — in about 2 minutes. No Word. No 20-minute grind.

            Branded, client-ready output. Any destination. Any route.

            Try it free: viakashmiritinerary.in/signup
        """).strip(),
        "campaign_name": "IB-saudi-cappadocia-2026-06-22",
    },

    "dubai": {
        "audience":     "dubai",
        "bilingual":    True,
        "subject":      "Bali itinerary — quoted and sent in 2 minutes",
        "subject_ar":   "اعرض رحلة بالي لعميلك في دقيقتين",
        "tag":          "Bali · Indonesia",
        "hook_headline":"Your client wants Bali. Close the booking before another agent does.",
        "hook_sub":     "Bali is among the top 3 destinations for UAE travellers this summer. Speed and professionalism win the booking.",
        "hook_headline_ar": "عميلك يريد بالي — أرسل العرض قبل منافسك",
        "hook_sub_ar":  "بالي من أكثر الوجهات طلباً من مسافري الإمارات هذا الصيف. الحجز يذهب لأسرع وكيل.",
        "comparison_pain": "While you're formatting a Word doc, another agent sends a polished Bali itinerary in 2 minutes.",
        "byhand_title": "By hand",
        "byhand_items": [
            "15–20 minutes per itinerary",
            "Manually format for each client",
            "Risk mistakes under pressure",
            "Lose the booking to a faster agent",
        ],
        "withtool_title": "With ViaKashmir Itinerary",
        "withtool_items": [
            "~2 minutes: Bali itinerary ready",
            "Maldives, Thailand, Europe — same tool",
            "Branded, professional PDF output",
            "Share before the call ends",
        ],
        "feat_headline": "Bali today. Maldives tomorrow. Any destination, 2 minutes.",
        "feat_body":     "One builder for every global destination your UAE clients ask about — Bali, Maldives, Thailand, Georgia, the Alps, Morocco, anywhere.",
        "feat_headline_ar": "بالي اليوم. المالديف غداً. أي وجهة، في دقيقتين.",
        "feat_body_ar":  "أداة واحدة لكل الوجهات التي يسأل عنها عملاؤك — بالي والمالديف وتايلاند وجورجيا وأوروبا وأي مكان.",
        "proof": [
            ("دقيقتان / 2 minutes",  "Build any itinerary in about 2 minutes. No 15-minute grind."),
            ("يعكس هويتك / Looks like you", "Professional branded output — not a pasted Word document."),
            ("أي وجهة / Any destination", "Bali, Maldives, Thailand, Europe — one builder for every route."),
        ],
        "urgency":   "The faster agent gets the booking. Every time.",
        "urgency_ar": "الوكيل الأسرع يحصل على الحجز دائماً.",
        "cta_headline": "Build a Bali itinerary right now",
        "cta_headline_ar": "ابنِ خط سير بالي الآن",
        "cta_sub":      "Free to start. No setup. Any destination in minutes.",
        "whatsapp": dedent("""\
            Your client wants Bali — and they're asking 3 different agents right now.

            With ViaKashmir Itinerary:
            → Full Bali itinerary in ~2 minutes
            → Maldives, Thailand, Georgia, Europe — same tool
            → Professional branded output, share instantly

            Try it free: viakashmiritinerary.in/signup

            ---
            عميلك يريد بالي، وهو يسأل ثلاثة وكلاء في الوقت ذاته.

            مع ViaKashmir Itinerary:
            → خط سير بالي كامل في دقيقتين تقريباً
            → المالديف وتايلاند وجورجيا وأوروبا — نفس الأداة
            → عرض احترافي جاهز للمشاركة فوراً

            جرّبه مجاناً: viakashmiritinerary.in/signup
        """).strip(),
        "linkedin": dedent("""\
            Bali is one of the top summer destinations for UAE travellers in 2026 — and clients are comparing quotes from multiple agents simultaneously.

            The agent who sends a polished, professional itinerary first wins the booking.

            ViaKashmir Itinerary: build any trip — Bali, Maldives, Thailand, Georgia, Europe — in about 2 minutes. Branded output. No Word files. No losing a client to a faster competitor.

            Try it free: viakashmiritinerary.in/signup
        """).strip(),
        "campaign_name": "IB-dubai-bali-2026-06-22",
    },
}


# ---------------------------------------------------------------------------
# Image URL helpers
# ---------------------------------------------------------------------------

def photo_url(name: str, preview: bool = False) -> str:
    path = f"content/via-kashmir-itinerary/_assets/photos/{name}.jpg"
    if preview:
        local = ROOT / path
        return f"file://{local}"
    return f"{WSRV_BASE}/{path}&w=1200&output=jpg&q=82"


# ---------------------------------------------------------------------------
# HTML email builder
# ---------------------------------------------------------------------------

def build_email_html(market: str, data: dict, dest: dict, preview: bool = False) -> str:
    photo_name = dest.get("photo", "kerala")
    feat_name  = dest.get("feat",  "rajasthan")
    hero_img   = photo_url(photo_name, preview)
    feat_img   = photo_url(feat_name, preview)
    bilingual  = data.get("bilingual", False)

    # -- Comparison rows
    byhand_rows = "".join(
        f'<tr><td style="padding:6px 0;color:{TEXT_LIGHT};font-size:14px;border-bottom:1px solid #eee">✗ {item}</td></tr>'
        for item in data["byhand_items"]
    )
    withtool_rows = "".join(
        f'<tr><td style="padding:6px 0;color:{TEXT_LIGHT};font-size:14px;border-bottom:1px solid #eee">✓ {item}</td></tr>'
        for item in data["withtool_items"]
    )

    # -- Proof points
    proofs_html = ""
    for (title, body) in data["proof"]:
        proofs_html += f"""
        <td width="33%" style="padding:0 12px;text-align:center;vertical-align:top">
          <div style="width:48px;height:48px;background:{GREEN};border-radius:50%;margin:0 auto 12px;line-height:48px;text-align:center">
            <span style="color:{SAFFRON};font-size:20px;font-weight:700">✓</span>
          </div>
          <div style="font-size:14px;font-weight:700;color:{GREEN};margin-bottom:6px">{title}</div>
          <div style="font-size:13px;color:{TEXT_LIGHT};line-height:1.5">{body}</div>
        </td>"""

    # -- Arabic section (GCC only)
    arabic_hero = ""
    arabic_feat = ""
    arabic_urgency = ""
    if bilingual:
        arabic_hero = f"""
      <!-- Arabic hero text -->
      <tr>
        <td style="background:linear-gradient(180deg,{GREEN2} 0%,{GREEN} 100%);padding:32px 40px;text-align:right;direction:rtl;font-family:Arial,sans-serif">
          <p style="margin:0 0 8px;color:{MINT};font-size:12px;letter-spacing:1px">{dest.get('place','')}</p>
          <h2 style="margin:0 0 16px;color:{WHITE};font-size:24px;line-height:1.4;font-weight:700">{data.get('hook_headline_ar','')}</h2>
          <p style="margin:0 0 24px;color:#cceedf;font-size:15px;line-height:1.6">{data.get('hook_sub_ar','')}</p>
          <a href="{CTA_URL}" style="display:inline-block;background:{WHITE};color:{GREEN};padding:12px 32px;border-radius:50px;font-size:14px;font-weight:700;text-decoration:none">{data.get('cta_headline_ar','ابدأ الآن')} ←</a>
        </td>
      </tr>"""
        arabic_feat = f"""
      <!-- Arabic feature text -->
      <tr>
        <td style="padding:32px 40px;background:{MINT_LIGHT};text-align:right;direction:rtl;font-family:Arial,sans-serif">
          <h3 style="margin:0 0 12px;color:{GREEN};font-size:20px">{data.get('feat_headline_ar','')}</h3>
          <p style="margin:0;color:{TEXT_LIGHT};font-size:15px;line-height:1.7">{data.get('feat_body_ar','')}</p>
        </td>
      </tr>"""
        arabic_urgency = f"""
      <!-- Arabic urgency -->
      <tr>
        <td style="background:{SAFFRON};padding:20px 40px;text-align:center;direction:rtl;font-family:Arial,sans-serif">
          <p style="margin:0;color:{GREEN};font-size:15px;font-weight:700">{data.get('urgency_ar','')}</p>
        </td>
      </tr>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{data['subject']}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background:{BG};font-family:'Helvetica Neue',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG}">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:{WHITE};border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

  <!-- LOGO CARD -->
  <tr>
    <td style="padding:28px 40px;text-align:center;background:{WHITE};border-bottom:1px solid #f0f0f0">
      <img src="{LOGO_URL}" width="160" alt="ViaKashmir" style="display:inline-block;max-width:160px;height:auto">
      <div style="margin-top:8px;font-size:11px;letter-spacing:3px;color:#aaa;text-transform:uppercase;font-weight:600">Itinerary Builder</div>
    </td>
  </tr>

  <!-- HERO PHOTO -->
  <tr>
    <td style="padding:0;background:{GREEN}">
      <img src="{hero_img}" width="600" alt="{dest.get('place','')}" style="display:block;width:100%;max-height:320px;object-fit:cover;border:0">
    </td>
  </tr>

  <!-- HERO TEXT -->
  <tr>
    <td style="background:linear-gradient(180deg,{GREEN} 0%,{GREEN2} 100%);padding:40px 40px 48px">
      <p style="margin:0 0 10px;color:{MINT};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600">{data['tag']}</p>
      <h1 style="margin:0 0 18px;color:{WHITE};font-size:26px;line-height:1.35;font-weight:700">{data['hook_headline']}</h1>
      <p style="margin:0 0 28px;color:#cceedf;font-size:15px;line-height:1.65">{data['hook_sub']}</p>
      <a href="{CTA_URL}" style="display:inline-block;background:{WHITE};color:{GREEN};padding:14px 36px;border-radius:50px;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.3px">Build your first itinerary →</a>
    </td>
  </tr>

  {arabic_hero}

  <!-- MINT ACCENT STRIP -->
  <tr>
    <td style="height:5px;background:linear-gradient(90deg,{MINT} 0%,{SAFFRON} 100%)"></td>
  </tr>

  <!-- COMPARISON SECTION -->
  <tr>
    <td style="padding:40px 40px 32px">
      <p style="margin:0 0 6px;color:{TEXT_LIGHT};font-size:12px;text-transform:uppercase;letter-spacing:2px;font-weight:600">The difference</p>
      <h2 style="margin:0 0 24px;color:{GREEN};font-size:22px;font-weight:700">{data['comparison_pain']}</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="48%" style="vertical-align:top;padding-right:16px">
            <div style="background:#fff5f5;border-radius:8px;padding:20px;border-top:3px solid #e05c5c">
              <div style="font-size:13px;font-weight:700;color:#c0392b;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">{data['byhand_title']}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                {byhand_rows}
              </table>
            </div>
          </td>
          <td width="4%"></td>
          <td width="48%" style="vertical-align:top">
            <div style="background:{MINT_LIGHT};border-radius:8px;padding:20px;border-top:3px solid {GREEN}">
              <div style="font-size:13px;font-weight:700;color:{GREEN};text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">{data['withtool_title']}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                {withtool_rows}
              </table>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- FEATURE PHOTO SECTION -->
  <tr>
    <td style="padding:0;background:{GREEN}">
      <img src="{feat_img}" width="600" alt="Any destination" style="display:block;width:100%;max-height:260px;object-fit:cover;border:0;opacity:0.85">
    </td>
  </tr>
  <tr>
    <td style="padding:32px 40px;background:{MINT_LIGHT}">
      <h3 style="margin:0 0 12px;color:{GREEN};font-size:20px;font-weight:700">{data['feat_headline']}</h3>
      <p style="margin:0;color:{TEXT_LIGHT};font-size:15px;line-height:1.7">{data['feat_body']}</p>
    </td>
  </tr>

  {arabic_feat}

  <!-- GREEN CTA CARD -->
  <tr>
    <td style="padding:48px 40px;background:{GREEN};text-align:center">
      <h2 style="margin:0 0 12px;color:{WHITE};font-size:24px;font-weight:700">{data['cta_headline']}</h2>
      <p style="margin:0 0 28px;color:#aaddcc;font-size:15px">{data['cta_sub']}</p>
      <a href="{CTA_URL}" style="display:inline-block;background:{SAFFRON};color:{GREEN};padding:16px 44px;border-radius:50px;font-size:16px;font-weight:700;text-decoration:none;letter-spacing:0.3px">Get started — it's free →</a>
    </td>
  </tr>

  <!-- 3 PROOF POINTS -->
  <tr>
    <td style="padding:40px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          {proofs_html}
        </tr>
      </table>
    </td>
  </tr>

  <!-- SAFFRON URGENCY STRIP -->
  <tr>
    <td style="background:{SAFFRON};padding:20px 40px;text-align:center">
      <p style="margin:0;color:{GREEN};font-size:15px;font-weight:700;line-height:1.5">{data['urgency']}</p>
    </td>
  </tr>

  {arabic_urgency}

  <!-- CONTACT BANNER -->
  <tr>
    <td style="padding:32px 40px;background:{MINT_LIGHT};text-align:center;border-top:1px solid #d4ece3">
      <p style="margin:0 0 8px;color:{GREEN};font-size:14px;font-weight:600">Questions? We're here.</p>
      <p style="margin:0;color:{TEXT_LIGHT};font-size:14px;line-height:1.8">
        <a href="mailto:{CONTACT_EMAIL}" style="color:{GREEN};text-decoration:none">{CONTACT_EMAIL}</a>
        &nbsp;·&nbsp;
        <a href="https://{CONTACT_WA}" style="color:{GREEN};text-decoration:none">WhatsApp {CONTACT_PHONE}</a>
      </p>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="padding:24px 40px;text-align:center;background:#fafafa;border-top:1px solid #eee">
      <p style="margin:0;color:#999;font-size:12px;line-height:1.8">
        ViaKashmir Itinerary Builder &nbsp;·&nbsp;
        <a href="{CTA_URL}" style="color:#999;text-decoration:underline">viakashmiritinerary.in</a><br>
        You're receiving this because you work in travel. To stop: reply "unsubscribe".
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>"""
    return html


# ---------------------------------------------------------------------------
# Helpers to write per-market files
# ---------------------------------------------------------------------------

def build_market(market: str, date_str: str, dest_data: dict, preview: bool = False):
    data = MARKETS[market]
    dest = dest_data.get(market, {})
    out_dir = CONTENT / date_str / market
    out_dir.mkdir(parents=True, exist_ok=True)

    # email.html
    html = build_email_html(market, data, dest, preview)
    (out_dir / "email.html").write_text(html, encoding="utf-8")

    # whatsapp.txt
    (out_dir / "whatsapp.txt").write_text(data["whatsapp"] + "\n", encoding="utf-8")

    # linkedin.txt
    (out_dir / "linkedin.txt").write_text(data["linkedin"] + "\n", encoding="utf-8")

    # meta.json
    meta = {
        "date":          date_str,
        "track":         market,
        "market":        market,
        "audience":      "b2b-travel-agents",
        "bilingual":     data.get("bilingual", False),
        "product":       "viakashmiritinerary.in",
        "campaign_name": data["campaign_name"],
        "campaign_code": data["campaign_name"],
        "subject":       data["subject"],
        "cta_url":       CTA_URL,
        "design":        "Alpine",
        "destination":   dest.get("place", ""),
        "photo":         dest.get("photo", ""),
        "feat_photo":    dest.get("feat", ""),
    }
    if data.get("bilingual"):
        meta["subject_ar"] = data.get("subject_ar", "")
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"  [{market}] email.html + whatsapp.txt + linkedin.txt + meta.json → {out_dir}")
    return out_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--market", choices=list(MARKETS.keys()))
    ap.add_argument("--preview", action="store_true", help="Use local file:// paths for images")
    args = ap.parse_args()

    dest_file = CONTENT / args.date / "destinations.json"
    dest_data = json.loads(dest_file.read_text()) if dest_file.exists() else {}

    markets = list(MARKETS.keys()) if args.all else [args.market]
    if not markets or markets == [None]:
        print("Specify --all or --market <name>", file=sys.stderr)
        sys.exit(1)

    print(f"build_itin.py — date={args.date}  markets={markets}")
    for m in markets:
        build_market(m, args.date, dest_data, args.preview)
    print("Done.")


if __name__ == "__main__":
    main()
