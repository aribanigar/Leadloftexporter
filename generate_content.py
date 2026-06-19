#!/usr/bin/env python3
"""Generate Hudace content batch - 2026-06-19 - Industries: Construction and Real Estate, Education and Research"""
import json, os, textwrap
from PIL import Image, ImageDraw, ImageFont

DATE = "2026-06-19"
BASE_URL = "https://leadloftexporter.vercel.app/email"
EMAIL_DIR = "public/email"
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG  = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

WHITE  = (255, 255, 255)
MUTED  = (154, 154, 174)
BLUE   = (27, 144, 255)
DARK   = (5, 5, 13)

# ─────────────────────────────────────────────────────────────────────────────
def make_promo_jpg(bg_file, out_name, headline, sub, bullets, cta):
    img = Image.open(f"{EMAIL_DIR}/{bg_file}").convert("RGB")
    img = img.resize((1200, 628), Image.LANCZOS)
    ov  = Image.new("RGBA", img.size, (5, 5, 13, 185))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    d   = ImageDraw.Draw(img)
    try:
        fxl = ImageFont.truetype(FONT_BOLD, 54)
        flg = ImageFont.truetype(FONT_BOLD, 28)
        fmd = ImageFont.truetype(FONT_REG,  20)
        fsm = ImageFont.truetype(FONT_REG,  17)
        fxs = ImageFont.truetype(FONT_REG,  13)
    except Exception:
        fxl = flg = fmd = fsm = fxs = ImageFont.load_default()
    # Wordmark
    d.text((48, 36), "HUDACE", fill=WHITE, font=flg)
    d.rectangle([(48, 76), (128, 79)], fill=BLUE)
    # Headline wrap
    y = 108
    lines = textwrap.wrap(headline, width=28)
    for ln in lines[:2]:
        d.text((48, y), ln, fill=WHITE, font=fxl)
        y += 66
    # Sub
    if sub:
        d.text((48, y), sub[:72], fill=MUTED, font=fmd)
        y += 34
    y += 6
    # Bullets
    for b in bullets[:4]:
        d.rectangle([(48, y+7), (52, y+19)], fill=BLUE)
        d.text((62, y), b[:62], fill=WHITE, font=fsm)
        y += 28
    # CTA
    btn_w = 8 + d.textlength(cta, font=fmd) + 8
    d.rectangle([(48, y+14), (int(48+btn_w+32), int(y+50))], fill=BLUE)
    d.text((64, y+20), cta, fill=WHITE, font=fmd)
    # Footer
    d.text((48, 596), "hudace.com  |  contact@hudace.com  |  +91 82189 29990", fill=MUTED, font=fxs)
    out_path = f"{EMAIL_DIR}/{out_name}"
    img.save(out_path, "JPEG", quality=90)
    print(f"  JPG: {out_name}")
    return f"{BASE_URL}/{out_name}"


# ─────────────────────────────────────────────────────────────────────────────
def email_html(label, headline, sub, img_url, sections, cta_text):
    def sec(title, rows):
        inner = "".join(f"""
            <tr>
              <td style="padding:6px 0 6px 16px; border-left:2px solid #1B90FF;">
                <span style="color:#ffffff;font-size:14px;line-height:1.6;font-family:Arial,sans-serif;">{r}</span>
              </td>
            </tr>""" for r in rows)
        return f"""
      <tr><td style="padding:32px 40px 0;">
        <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">{title}</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">{inner}</table>
      </td></tr>"""

    body_rows = "".join(sec(t, rows) for t, rows in sections)
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>{headline}</title></head>
<body style="margin:0;padding:0;background:#0A0919;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0919;">
<tr><td align="center" style="padding:0;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#0A0919;max-width:600px;">

  <!-- HEADER -->
  <tr><td style="padding:28px 40px 24px;border-bottom:1px solid #1a1a2e;">
    <span style="font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:3px;font-family:Arial,sans-serif;">HUDACE</span>
    <span style="color:#1B90FF;font-size:11px;letter-spacing:2px;margin-left:10px;font-family:Arial,sans-serif;">AI-NATIVE</span>
  </td></tr>

  <!-- HERO TEXT -->
  <tr><td style="background:#08080f;padding:48px 40px 40px;">
    <div style="color:#1B90FF;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;font-family:Arial,sans-serif;">{label}</div>
    <h1 style="color:#ffffff;font-size:34px;line-height:1.2;margin:0 0 14px;font-family:Arial,sans-serif;font-weight:bold;">{headline}</h1>
    <p style="color:#9A9AAE;font-size:15px;line-height:1.65;margin:0 0 28px;font-family:Arial,sans-serif;">{sub}</p>
    <table cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:#1B90FF;border-radius:4px;">
        <a href="https://hudace.com" style="display:inline-block;padding:14px 30px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;"><span style="color:#ffffff;">{cta_text}</span></a>
      </td></tr>
    </table>
  </td></tr>

  <!-- HERO PHOTO -->
  <tr><td style="padding:0;"><img src="{img_url}" alt="Hudace" width="600" style="display:block;width:100%;max-width:600px;height:auto;"></td></tr>

  {body_rows}

  <!-- DIVIDER -->
  <tr><td style="padding:32px 40px 0;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background:#1a1a2e;"></td></tr></table></td></tr>

  <!-- CONTACT CTA -->
  <tr><td style="padding:32px 40px 0;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:#1B90FF;border-radius:4px;">
        <a href="https://hudace.com" style="display:inline-block;padding:14px 30px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;"><span style="color:#ffffff;">{cta_text}</span></a>
      </td></tr>
    </table>
    <p style="color:#9A9AAE;font-size:13px;margin:18px 0 0;font-family:Arial,sans-serif;">
      hudace.com &nbsp;|&nbsp; contact@hudace.com &nbsp;|&nbsp; +91 82189 29990
    </p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#05050D;padding:28px 40px;border-top:1px solid #1a1a2e;margin-top:40px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
        <p style="color:#9A9AAE;font-size:12px;margin:0 0 6px;font-family:Arial,sans-serif;">
          <strong style="color:#ffffff;">HUDACE</strong> &nbsp;&middot;&nbsp; hudace.com &nbsp;&middot;&nbsp; contact@hudace.com &nbsp;&middot;&nbsp; +91 82189 29990
        </p>
        <p style="color:#444455;font-size:11px;margin:0;font-family:Arial,sans-serif;">
          <a href="#" style="color:#444455;text-decoration:underline;">Unsubscribe</a>
        </p>
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>"""


# ─────────────────────────────────────────────────────────────────────────────
def wa(body, img_url):
    return body + f"\n\nwa.me/918218929990"

def li(body):
    return body

def outreach(body):
    return body

# ─────────────────────────────────────────────────────────────────────────────
batch = []

# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 1: Service-oriented – Construction and Real Estate + Social Media
# ══════════════════════════════════════════════════════════════════════════════
img1 = make_promo_jpg(
    "socialmedia-bg.jpg", "promo-construction-social.jpg",
    "Social Media for Property and Construction",
    "12 reels, 20 posts, 2 campaigns monthly",
    ["12 short-form reels per month", "20 feed posts per month",
     "2 paid ad campaigns per month", "Full community management"],
    "Request the Plan"
)

e1_html = email_html(
    label="SOCIAL MEDIA MARKETING — CONSTRUCTION AND REAL ESTATE",
    headline="Social Media That Generates Qualified Project Inquiries",
    sub="Property developers and contractors that publish consistent, professional social content receive 32 percent more inbound project inquiries on average. Hudace delivers a fully managed social media function at a predictable monthly cost.",
    img_url=img1,
    sections=[
        ("WHAT WE DELIVER EACH MONTH", [
            "12 short-form reels (15 to 60 seconds) — project walkthroughs, timelapse builds, completed work",
            "20 feed posts — imagery, stats, and proof points targeting procurement and development decision-makers",
            "2 paid ad campaigns — lead-gen focused, A/B tested creative, full attribution reporting",
            "Full community management — responses, DMs, and comment moderation handled by your account team",
            "Monthly performance report — reach, engagement rate, cost per lead, and next-cycle recommendations",
        ]),
        ("INDUSTRY CONTEXT", [
            "Construction and real estate companies compete for the same procurement teams, investors, and buyers on social platforms. Organic reach alone does not close that gap. A structured content calendar built around project milestones, capability proofs, and client outcomes positions your firm as the default choice before a brief is issued.",
            "Hudace has delivered social media programs for firms operating across commercial construction, residential development, and infrastructure contracting. In one engagement, a commercial contractor increased project inquiries by 32 percent within 90 days by replacing ad-hoc posting with a structured monthly calendar.",
        ]),
        ("FUTURE SCOPE", [
            "Social media generates the initial awareness. Hudace's SEO, website design, and AI cinematic video capabilities layer into a complete digital pipeline — from first impression to qualified conversation.",
        ]),
    ],
    cta_text="Request the Social Media Plan"
)
e1_wa = wa(
    "Hudace manages social media for construction and real estate firms.\n\n12 reels, 20 posts, 2 ad campaigns every month.\n\nFull community management included. One predictable monthly fee.\n\nReady to see the plan?",
    img1
)
e1_li = li(
    "Construction and real estate companies that post consistently acquire 32% more inbound inquiries than those that do not.\n\nThe challenge is volume and quality. Twelve reels, twenty posts, and two paid campaigns every month is a full-time function most firms do not have in-house.\n\nHudace delivers it as a managed service.\n\nProject walkthroughs. Timelapse builds. Capability proofs. All produced and published on your behalf.\n\nThe result is a social presence that works as a business development channel, not a communications obligation.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e1_outreach = outreach(
    "Subject: Social media for [Company Name] — 12 reels and 20 posts monthly\n\nI work with construction and real estate firms to replace ad-hoc social posting with a structured monthly content program.\n\nFor a firm like yours, that means 12 short-form reels, 20 feed posts, and 2 paid ad campaigns delivered each month — fully managed, no internal resource required.\n\nOne of our construction sector clients saw a 32 percent increase in project inquiries within 90 days of launch.\n\nWould a 20-minute call make sense to walk through the specific deliverables?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] Construction and Real Estate | Social Media", "type": "email", "body": e1_html, "image_url": img1},
    {"title": f"[{DATE}] Construction and Real Estate | Social Media (WhatsApp)", "type": "whatsapp", "body": e1_wa, "image_url": img1},
    {"title": f"[{DATE}] Construction and Real Estate | Social Media (LinkedIn)", "type": "linkedin", "body": e1_li, "image_url": img1},
    {"title": f"[{DATE}] Construction and Real Estate | Social Media (Outreach)", "type": "outreach", "body": e1_outreach, "image_url": img1},
]
print("  Email 1 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 2: Service-oriented – Education and Research + SEO/AEO/GEO
# ══════════════════════════════════════════════════════════════════════════════
img2 = make_promo_jpg(
    "seo-bg.jpg", "promo-education-seo.jpg",
    "Search Visibility for Educational Institutions",
    "SEO, AEO, GEO and AI search coverage",
    ["Full site technical SEO audit", "20 priority keyword targets",
     "4 long-form articles per month", "AI Answers and GEO coverage"],
    "Request the SEO Audit"
)

e2_html = email_html(
    label="SEO / AEO / GEO — EDUCATION AND RESEARCH",
    headline="Organic Admissions Traffic Through Search Dominance",
    sub="Educational institutions that appear at the top of organic search results and AI-generated answers attract 40 percent more admissions inquiries without increasing paid media spend. Hudace delivers SEO, AI Engine Optimization, and Geographic search coverage as a single program.",
    img_url=img2,
    sections=[
        ("WHAT WE DELIVER", [
            "Full technical SEO audit — site architecture, page speed, indexability, and crawl error resolution",
            "20 priority keyword targets — mapped to admissions, program discovery, and institutional reputation queries",
            "4 long-form SEO articles per month — written for both human readers and AI answer engines",
            "AEO (AI Engine Optimization) — structured to appear in ChatGPT, Perplexity, and Google AI Overviews",
            "GEO (Geographic Engine Optimization) — local and regional search presence for prospective students",
            "Monthly rank tracking report — keyword positions, traffic delta, and content performance",
        ]),
        ("INDUSTRY CONTEXT", [
            "Search is the primary discovery channel for prospective students and research partners. However, the search landscape has changed materially. AI-generated answers now appear above traditional results for the majority of high-intent educational queries. Institutions optimized for traditional SEO alone are invisible in these new surfaces.",
            "An academic institution we worked with achieved a 40 percent increase in organic admissions inquiries after a 90-day SEO restructure that combined technical optimization with AI answer targeting.",
        ]),
        ("FUTURE SCOPE", [
            "Search visibility drives awareness. Hudace's website design, social media, and School ERP capabilities extend that visibility into a complete enrollment and operational platform.",
        ]),
    ],
    cta_text="Request the SEO Audit"
)
e2_wa = wa(
    "Hudace runs SEO, AI Engine Optimization, and Geographic search for educational institutions.\n\nTechnical audit, 20 keyword targets, 4 articles/month, AI Answers and GEO coverage.\n\nOne institution saw 40% more organic admissions inquiries in 90 days.\n\nWant the audit?",
    img2
)
e2_li = li(
    "Most educational institutions have optimized for traditional search.\n\nBut the majority of high-intent queries now surface AI-generated answers above organic results.\n\nIf your institution is not in those answers, it is not in the consideration set.\n\nHudace delivers SEO, AEO (AI Engine Optimization), and GEO (Geographic Engine Optimization) as a single program — 20 keyword targets, 4 articles monthly, full AI answer coverage.\n\nOne institution increased organic admissions inquiries by 40 percent within 90 days.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e2_outreach = outreach(
    "Subject: SEO and AI search visibility for [Institution Name]\n\nSearch behavior for prospective students has shifted significantly. AI-generated answers now appear above traditional results for most admissions-related queries.\n\nFor [Institution Name], that means being optimized for ChatGPT, Perplexity, and Google AI Overviews is now as important as traditional SEO.\n\nHudace delivers a full program: technical audit, 20 keyword targets, 4 long-form articles monthly, and AI answer coverage — as a managed service.\n\nOne institution saw a 40 percent increase in organic admissions inquiries within 90 days.\n\nWould a brief call make sense?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] Education and Research | SEO AEO GEO", "type": "email", "body": e2_html, "image_url": img2},
    {"title": f"[{DATE}] Education and Research | SEO AEO GEO (WhatsApp)", "type": "whatsapp", "body": e2_wa, "image_url": img2},
    {"title": f"[{DATE}] Education and Research | SEO AEO GEO (LinkedIn)", "type": "linkedin", "body": e2_li, "image_url": img2},
    {"title": f"[{DATE}] Education and Research | SEO AEO GEO (Outreach)", "type": "outreach", "body": e2_outreach, "image_url": img2},
]
print("  Email 2 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 3: Industry-oriented – Construction and Real Estate (multiple services)
# ══════════════════════════════════════════════════════════════════════════════
img3 = make_promo_jpg(
    "construction-bg.jpg", "promo-construction-industry.jpg",
    "Digital Infrastructure for the Built Environment",
    "Social, SEO, Web, AI Video — one managed program",
    ["Social media: 12 reels + 20 posts monthly", "SEO and AI answer coverage",
     "Conversion-optimized project portfolio site", "AI cinematic project showcase videos"],
    "Request the Industry Audit"
)

e3_html = email_html(
    label="INDUSTRY PROGRAM — CONSTRUCTION AND REAL ESTATE",
    headline="Digital Infrastructure for the Built Environment",
    sub="Construction and real estate firms operating across multiple project types and client segments require a digital presence that communicates capability, builds trust with procurement teams, and converts visitors into inquiries. Hudace delivers this as an integrated managed program.",
    img_url=img3,
    sections=[
        ("THE FOUR CAPABILITIES WE DEPLOY", [
            "Social Media Marketing — 12 reels, 20 posts, and 2 paid campaigns monthly. Project walkthroughs, timelapse content, and capability proofs published consistently across the platforms your buyers use.",
            "SEO and AI Engine Optimization — Your firm appearing in organic search and AI-generated answers when procurement teams research contractors, developers, and project partners.",
            "Website Design — A conversion-optimized project portfolio platform built for multi-device, multi-market buyer journeys. Clear capability proof, structured lead capture, and SEO-native architecture.",
            "AI Cinematic Videos — 30 to 60 second cinematic project showcases, aerial footage narratives, and brand films that document completed work with the production quality that wins enterprise clients.",
        ]),
        ("PROOF IN THIS SECTOR", [
            "Construction and real estate clients operating on a full-stack Hudace program averaged 28 percent more qualified project inquiries within one quarter of deployment. Organic traffic to project portfolio pages increased by an average of 40 percent within 90 days of site relaunch.",
        ]),
        ("WHAT HAPPENS AFTER INQUIRY", [
            "Each Hudace engagement begins with an industry audit — a review of your current digital footprint, competitor visibility, and the highest-value gaps to close first. No retainer commitment required for the audit.",
        ]),
    ],
    cta_text="Request the Industry Audit"
)
e3_wa = wa(
    "Hudace builds full-stack digital programs for construction and real estate firms.\n\nSocial media, SEO, website, and AI cinematic videos — managed as one program.\n\nClients averaged 28% more qualified inquiries within one quarter.\n\nAudit is free. Ready to start?",
    img3
)
e3_li = li(
    "Construction and real estate firms that win enterprise contracts have one thing in common: their digital presence communicates capability before a brief is issued.\n\nThat means a project portfolio site that ranks, social content that demonstrates expertise, and project films that show what the firm actually builds.\n\nHudace delivers all four capabilities — social media, SEO, website design, and AI cinematic videos — as a single managed program.\n\nFull-stack clients averaged 28% more qualified project inquiries within their first quarter.\n\nThe audit is the starting point. No commitment required.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e3_outreach = outreach(
    "Subject: Digital program for [Company Name] — from site to social to AI video\n\nI help construction and real estate firms build digital programs that generate qualified project inquiries.\n\nFor a firm operating at your scale, the four capabilities that drive the most impact are: social media content, SEO and AI search visibility, a conversion-optimized project portfolio site, and cinematic project videos.\n\nHudace delivers all four as a managed program. Full-stack clients averaged 28 percent more qualified inquiries within their first quarter.\n\nWe start with a free audit of your current digital position. No retainer required.\n\nWould this be worth 20 minutes?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] Construction and Real Estate | Industry Program", "type": "email", "body": e3_html, "image_url": img3},
    {"title": f"[{DATE}] Construction and Real Estate | Industry Program (WhatsApp)", "type": "whatsapp", "body": e3_wa, "image_url": img3},
    {"title": f"[{DATE}] Construction and Real Estate | Industry Program (LinkedIn)", "type": "linkedin", "body": e3_li, "image_url": img3},
    {"title": f"[{DATE}] Construction and Real Estate | Industry Program (Outreach)", "type": "outreach", "body": e3_outreach, "image_url": img3},
]
print("  Email 3 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 4: Industry-oriented – Education and Research (multiple services)
# ══════════════════════════════════════════════════════════════════════════════
img4 = make_promo_jpg(
    "education-bg.jpg", "promo-education-industry.jpg",
    "Operational and Digital Transformation for Education",
    "ERP, Social, SEO, Website — one managed program",
    ["School ERP: deployed in 6 weeks", "Social media for admissions and engagement",
     "SEO and AI search coverage", "Enrollment-optimized website platform"],
    "Schedule the Discovery Call"
)

e4_html = email_html(
    label="INDUSTRY PROGRAM — EDUCATION AND RESEARCH",
    headline="Operational and Digital Transformation for Educational Institutions",
    sub="Educational institutions face concurrent pressure on admissions volume, operational efficiency, and digital visibility. Hudace addresses all three through an integrated program spanning ERP deployment, marketing, and search.",
    img_url=img4,
    sections=[
        ("THE FOUR CAPABILITIES WE DEPLOY", [
            "School ERP (SchoolOS) — Student Information, LMS, Admissions, Finance, People Management, and Core School operations on one platform. Nectar AI automates routine administration across all modules. Deployed in 6 weeks.",
            "Social Media Marketing — 12 reels and 20 posts monthly targeting prospective students, parents, and academic partners. Content built around institutional proof points, faculty expertise, and campus life.",
            "SEO and AI Engine Optimization — Technical SEO, 20 keyword targets, and AI answer coverage. Your institution appearing in the first response when prospective students search for programs.",
            "Website Design — An enrollment-optimized platform with structured program pages, clear application pathways, and SEO-native architecture. Built for multi-market audiences.",
        ]),
        ("PROOF IN THIS SECTOR", [
            "An academic institution deployed SchoolOS across 6 operational modules in 6 weeks, reducing administrative overhead by 40 percent. A parallel SEO engagement increased organic admissions inquiries by 40 percent within 90 days.",
        ]),
        ("STARTING POINT", [
            "Hudace begins with a discovery call to identify the two or three highest-value gaps — whether that is operational (ERP), visibility (SEO), or brand (social and web). The program scales from a single service to full stack based on institutional priorities.",
        ]),
    ],
    cta_text="Schedule the Discovery Call"
)
e4_wa = wa(
    "Hudace works with educational institutions on ERP, social media, SEO, and web design.\n\nSchoolOS deploys in 6 weeks. SEO drives 40% more organic admissions inquiries in 90 days.\n\nFull program or single service — your choice.\n\nSchedule a call?",
    img4
)
e4_li = li(
    "Educational institutions face three simultaneous pressures: operational overhead, admissions volume, and digital visibility.\n\nHudace addresses all three.\n\nSchoolOS (our School ERP) handles student information, admissions, finance, LMS, and HR — deployed in 6 weeks, not 2 years.\n\nOur marketing services cover social media, SEO, and website design — built specifically for enrollment and institutional reputation objectives.\n\nAn institution on this combined program reduced administrative overhead by 40% while increasing organic admissions inquiries by 40% within 90 days.\n\nThe discovery call starts the process.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e4_outreach = outreach(
    "Subject: ERP and marketing program for [Institution Name]\n\nI work with educational institutions on the combination that moves the needle most: operational efficiency and admissions visibility.\n\nSchoolOS is our School ERP — student information, admissions, finance, LMS, and HR on one platform. It deploys in 6 weeks.\n\nAlongside that, we run social media, SEO, and website design programs specifically structured for admissions outcomes.\n\nOne institution reduced administrative overhead by 40 percent while increasing organic admissions inquiries by 40 percent.\n\nWould a 20-minute discovery call make sense?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] Education and Research | Industry Program", "type": "email", "body": e4_html, "image_url": img4},
    {"title": f"[{DATE}] Education and Research | Industry Program (WhatsApp)", "type": "whatsapp", "body": e4_wa, "image_url": img4},
    {"title": f"[{DATE}] Education and Research | Industry Program (LinkedIn)", "type": "linkedin", "body": e4_li, "image_url": img4},
    {"title": f"[{DATE}] Education and Research | Industry Program (Outreach)", "type": "outreach", "body": e4_outreach, "image_url": img4},
]
print("  Email 4 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 5: AI Work Studio
# ══════════════════════════════════════════════════════════════════════════════
img5 = make_promo_jpg(
    "cinema-bg.jpg", "promo-ai-work-studio.jpg",
    "AI Cinematic Content. Delivered at Scale.",
    "Videos, photos, ads, and brand films — monthly",
    ["4 AI cinematic videos per month", "20 AI campaign photos per month",
     "2 cinematic ad creatives per month", "1 brand film per quarter"],
    "See the AI Studio Demo"
)

e5_html = email_html(
    label="AI WORK STUDIO — CINEMATIC CONTENT",
    headline="Cinematic AI Content. Enterprise Output. Predictable Monthly Cost.",
    sub="Enterprise marketing teams that deploy AI cinematic content at scale report 3x more marketing qualified leads and 38 percent faster campaign delivery than teams producing traditional creative. Hudace AI Work Studio delivers this output as a managed monthly service.",
    img_url=img5,
    sections=[
        ("WHAT AI WORK STUDIO DELIVERS EACH MONTH", [
            "4 AI Cinematic Videos (30 to 90 seconds) — brand films, product showcases, explainer narratives, and campaign hero content produced to broadcast quality",
            "20 AI Campaign Photos — product imagery, brand lifestyle photography, and visual assets campaign-ready for social, digital, and print",
            "2 Cinematic Ad Creatives (15 to 30 seconds) — conversion-optimized short-form ads for paid social and digital platforms",
            "1 Brand Film per quarter — a full narrative brand story (2 to 5 minutes) capturing company identity, capability, and client outcomes",
        ]),
        ("THE PRODUCTION CAPABILITY", [
            "Hudace AI Work Studio combines AI generation, cinematic direction, and post-production grading into a single managed workflow. Brands receive broadcast-quality visual content without the production overhead of a traditional film crew.",
            "A retail group deployed AI cinematic content across their paid and organic channels and achieved a 3x increase in marketing qualified leads within 90 days. Campaign delivery accelerated by 38 percent compared to their prior production workflow.",
        ]),
        ("USE CASES BY INDUSTRY", [
            "Real estate and construction: project walkthroughs, timelapse builds, and completed-work showcases",
            "Education: campus experience films, program explainers, and admissions campaign content",
            "Professional services: capability proofs, client outcome narratives, and conference content",
            "Consumer brands: product launch films, brand identity content, and seasonal campaign assets",
        ]),
    ],
    cta_text="See the AI Studio Demo"
)
e5_wa = wa(
    "Hudace AI Work Studio delivers cinematic AI content monthly.\n\n4 videos, 20 photos, 2 ad creatives, 1 brand film per quarter.\n\nBroadcast quality. No production crew required.\n\nA retail brand saw 3x more marketing leads in 90 days.\n\nSee the demo?",
    img5
)
e5_li = li(
    "Enterprise marketing teams need broadcast-quality visual content at a volume traditional production cannot support.\n\nHudace AI Work Studio closes that gap.\n\nFour AI cinematic videos. Twenty campaign photos. Two ad creatives. One brand film per quarter.\n\nDelivered monthly. No production crew. No overruns.\n\nA retail group using this output saw 3x more marketing qualified leads within 90 days and cut campaign delivery time by 38 percent.\n\nIf your brand needs content at scale, this is the model.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e5_outreach = outreach(
    "Subject: AI cinematic content for [Brand Name] — 4 videos and 20 photos monthly\n\nI run Hudace AI Work Studio — a managed cinematic content service for enterprise marketing teams.\n\nThe monthly output: 4 AI cinematic videos, 20 campaign photos, 2 ad creatives, and a quarterly brand film. All broadcast quality. No production crew or project management required on your side.\n\nA retail group using this model saw 3x more marketing qualified leads in 90 days.\n\nWould it be worth seeing a demo of the output?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] AI Work Studio | Cinematic Content", "type": "email", "body": e5_html, "image_url": img5},
    {"title": f"[{DATE}] AI Work Studio | Cinematic Content (WhatsApp)", "type": "whatsapp", "body": e5_wa, "image_url": img5},
    {"title": f"[{DATE}] AI Work Studio | Cinematic Content (LinkedIn)", "type": "linkedin", "body": e5_li, "image_url": img5},
    {"title": f"[{DATE}] AI Work Studio | Cinematic Content (Outreach)", "type": "outreach", "body": e5_outreach, "image_url": img5},
]
print("  Email 5 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 6: Market Research
# ══════════════════════════════════════════════════════════════════════════════
img6 = make_promo_jpg(
    "analytics-bg.jpg", "promo-market-research.jpg",
    "The AI Marketing Infrastructure Opportunity",
    "Market signals and the window for early movers",
    ["AI marketing industry at USD 47.32 billion", "AI campaigns deliver 22% higher ROI",
     "88% of enterprise marketers use AI tools daily", "58% cost reduction from marketing automation"],
    "Request the Market Brief"
)

e6_html = email_html(
    label="MARKET INTELLIGENCE — AI-NATIVE MARKETING",
    headline="The Window for AI Marketing Infrastructure Is Narrowing",
    sub="The AI marketing industry has reached USD 47.32 billion. Eighty-eight percent of enterprise marketers now use AI tools daily. The organizations deploying AI marketing infrastructure today are building structural advantages that compound over time. The gap between early movers and late adopters is widening.",
    img_url=img6,
    sections=[
        ("THE MARKET SIGNALS", [
            "AI marketing industry value: USD 47.32 billion, growing at a rate that doubles the broader marketing technology sector",
            "AI-driven campaigns deliver 22 percent higher ROI, 32 percent more conversions, and 29 percent lower acquisition costs than traditional methods",
            "58 percent cost reduction is achievable through full marketing automation — the primary driver of AI marketing adoption at enterprise scale",
            "28 percent year-on-year revenue growth recorded by clients operating on AI-native marketing programs versus 6 percent for non-AI counterparts",
        ]),
        ("THE STRUCTURAL SHIFT UNDERWAY", [
            "Search is the most visible example. AI-generated answers now surface above organic results for the majority of high-intent commercial queries. Organizations optimized only for traditional search are invisible in these new surfaces. The same pattern is emerging in social algorithm prioritization, paid media auction dynamics, and content distribution.",
            "This is not a future trend. It is the current state of the discovery landscape. Brands operating on AI-native infrastructure — AI-optimized content, AI cinematic creative, and AI-powered search coverage — are compounding reach while their competitors remain static.",
        ]),
        ("THE HUDACE POSITION", [
            "Hudace is an AI-native marketing and ERP company. Every service — social media, SEO/AEO/GEO, website design, AI cinematic videos, and performance marketing — is built on AI infrastructure from the ground up.",
            "The market brief documents the specific opportunity by sector and the measurable advantage available to first movers in each.",
        ]),
    ],
    cta_text="Request the Market Brief"
)
e6_wa = wa(
    "AI marketing is at USD 47 billion. Companies using it average 22% higher ROI.\n\nThe window for early movers is open now.\n\nHudace runs AI-native marketing programs: social, SEO, web, AI cinematic video.\n\nWant the market brief?",
    img6
)
e6_li = li(
    "The AI marketing industry is at USD 47.32 billion.\n\n88% of enterprise marketers use AI tools daily.\n\nAI campaigns deliver 22% higher ROI, 32% more conversions, and 29% lower acquisition costs.\n\nThis is the current state — not a projection.\n\nThe structural shift is in discovery. AI-generated answers now appear above organic results for most commercial queries. Brands not in those answers are invisible at the moment of highest intent.\n\nThe organizations deploying AI marketing infrastructure now are building compounding advantages.\n\nHudace delivers that infrastructure: social, SEO/AEO/GEO, website design, and AI cinematic content — AI-native from the ground up.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e6_outreach = outreach(
    "Subject: AI marketing infrastructure — the market brief for [Industry]\n\nThe AI marketing market is at USD 47.32 billion. Enterprise clients deploying AI marketing programs are averaging 22 percent higher campaign ROI and 58 percent lower marketing operations costs.\n\nMore importantly, the discovery landscape is shifting. AI-generated answers now surface above organic results for most commercial queries. Brands not optimized for these surfaces are losing visibility at the moment of highest buyer intent.\n\nHudace builds AI-native marketing programs: social media, SEO/AEO/GEO, website design, and AI cinematic content.\n\nWould the market brief for your sector be useful context for a conversation?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] Market Intelligence | AI Marketing Infrastructure", "type": "email", "body": e6_html, "image_url": img6},
    {"title": f"[{DATE}] Market Intelligence | AI Marketing Infrastructure (WhatsApp)", "type": "whatsapp", "body": e6_wa, "image_url": img6},
    {"title": f"[{DATE}] Market Intelligence | AI Marketing Infrastructure (LinkedIn)", "type": "linkedin", "body": e6_li, "image_url": img6},
    {"title": f"[{DATE}] Market Intelligence | AI Marketing Infrastructure (Outreach)", "type": "outreach", "body": e6_outreach, "image_url": img6},
]
print("  Email 6 done")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL 7: School ERP
# ══════════════════════════════════════════════════════════════════════════════
img7 = make_promo_jpg(
    "schoolerp-bg.jpg", "promo-school-erp.jpg",
    "SchoolOS: One Platform for Every School Operation",
    "6 modules, Nectar AI, deployed in 6 weeks",
    ["Student Information: academics, timetable, library", "Admissions: inquiry to enrollment, AI follow-up",
     "Finance: fee tracking, automated notifications", "LMS: digital classroom for teachers and students"],
    "Book the ERP Demo"
)

e7_html = email_html(
    label="SCHOOL ERP — SCHOOLOS",
    headline="One Platform for Every School Operation. Deployed in 6 Weeks.",
    sub="SchoolOS is Hudace's School ERP — a unified platform covering every administrative and academic function from admissions to graduation. It deploys in 6 weeks, not the 2-year implementations common to legacy ERP vendors.",
    img_url=img7,
    sections=[
        ("THE SIX MODULES AND WHAT EACH DOES", [
            "Student Information Module — Academic calendar management, timetable scheduling, curriculum and examination management, library system, transport coordination, and hostel management. Used by: Academic coordinators, registrars, and administrative staff.",
            "Learning Management System (LMS) — Digital classroom delivery, assignment management, attendance tracking, and learning resource distribution. Used by: Teachers for content delivery, students for coursework access.",
            "Admissions Module — Full admissions funnel management from initial inquiry through enrollment. Nectar AI (the built-in AI assistant) follows up with prospective families automatically, converting more interest into enrollments with less manual intervention. Used by: Admissions office and administrative coordinators.",
            "Finance Module — Fee schedule management, payment tracking, automated overdue notifications, and financial reporting. Nectar AI surfaces outstanding fee alerts and priority cases. Used by: Finance department and school administration.",
            "People Management Module — Staff onboarding, attendance, leave management, payroll coordination, and HR records. Used by: HR department and school leadership.",
            "Core School Module — Central institutional operations, policy management, school calendar, and cross-department coordination. Used by: School principals and senior leadership.",
        ]),
        ("NECTAR AI — ACROSS ALL MODULES", [
            "Nectar is SchoolOS's built-in AI assistant. It runs across every module: following up with admissions inquiries, surfacing overdue finance cases, flagging HR priorities, and maintaining data accuracy without manual auditing. Routine administration that previously required dedicated staff time is handled automatically.",
        ]),
        ("DEPLOYMENT AND PROOF", [
            "SchoolOS deploys in 6 weeks. Competing ERP implementations in the education sector average 18 to 24 months.",
            "Institutions operating on SchoolOS report 40 percent reduction in administrative overhead within the first quarter. Admissions conversion rates increase when Nectar AI is active on the inquiry pipeline.",
        ]),
    ],
    cta_text="Book the ERP Demo"
)
e7_wa = wa(
    "SchoolOS by Hudace — School ERP that deploys in 6 weeks.\n\nStudent info, LMS, admissions, finance, HR, and core school on one platform.\n\nNectar AI automates the routine work across every module.\n\n40% less administrative overhead in the first quarter.\n\nBook the demo?",
    img7
)
e7_li = li(
    "Most school ERP implementations take 18 to 24 months.\n\nSchoolOS deploys in 6 weeks.\n\nSix modules: Student Information, LMS, Admissions, Finance, People Management, and Core School. All connected. All managed from one platform.\n\nNectar AI runs across every module — following up admissions inquiries, flagging overdue fees, surfacing HR priorities — without requiring staff to monitor each system manually.\n\nInstitutions on SchoolOS report 40% less administrative overhead within their first quarter.\n\nIf your school is running operations across disconnected tools, SchoolOS is the consolidation.\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)
e7_outreach = outreach(
    "Subject: School ERP for [School Name] — 6-week deployment\n\nI work with schools to replace disconnected administrative tools with SchoolOS — Hudace's School ERP that covers admissions, student information, finance, LMS, HR, and institutional operations on one platform.\n\nIt deploys in 6 weeks. Most ERP implementations in education take 18 to 24 months.\n\nNectar AI, our built-in AI assistant, handles routine follow-up and administration across every module — so your staff focuses on students rather than systems.\n\nSchools on SchoolOS report 40 percent less administrative overhead within their first quarter.\n\nWould a demo be worthwhile?\n\nhudace.com | contact@hudace.com | +91 82189 29990"
)

batch += [
    {"title": f"[{DATE}] School ERP | SchoolOS Platform", "type": "email", "body": e7_html, "image_url": img7},
    {"title": f"[{DATE}] School ERP | SchoolOS Platform (WhatsApp)", "type": "whatsapp", "body": e7_wa, "image_url": img7},
    {"title": f"[{DATE}] School ERP | SchoolOS Platform (LinkedIn)", "type": "linkedin", "body": e7_li, "image_url": img7},
    {"title": f"[{DATE}] School ERP | SchoolOS Platform (Outreach)", "type": "outreach", "body": e7_outreach, "image_url": img7},
]
print("  Email 7 done")


# ══════════════════════════════════════════════════════════════════════════════
# Write batch.json
# ══════════════════════════════════════════════════════════════════════════════
with open("batch.json", "w") as f:
    json.dump(batch, f, indent=2, ensure_ascii=False)
print(f"\nDone. {len(batch)} items written to batch.json")
