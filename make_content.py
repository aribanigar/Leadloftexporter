#!/usr/bin/env python3
"""Generates content.json for the Date Khaas 2026-06-22 daily drop."""
import json

RESEARCH_SOURCES = [
    {"insight": "Islamic New Year 1448 AH (1 Muharram) confirmed June 16, 2026 globally — Saudi Arabia, UAE, UK, US all aligned. Today (June 22) is 6 Muharram: the Islamic month of reflection and new beginnings. Muharram is traditionally avoided for weddings but is ideal for 'begin your search with intention' messaging ahead of Safar/Rabi al-Awwal wedding season.", "source": "https://www.arabianbusiness.com/abnews/saudi-arabia-islamic-new-year-1448"},
    {"insight": "Photo blur as a default (not a premium feature) is now the key differentiator users want in 2026. Zawjni defaults blur for all users; Salams restricts it to $19.99/month Premium. Muslim women specifically want photos visible only after mutual consent — this is a primary trust signal and conversion driver.", "source": "https://zawjni.com/en/blog/%D9%85%D9%88%D9%82%D8%B9-%D9%85%D8%B3%D9%84%D9%85%D8%A9-%D9%84%D9%84%D8%B2%D9%88%D8%A7%D8%AC-%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%86%D9%8A"},
    {"insight": "Wali (guardian) involvement is the most underused trust signal in Muslim matrimony. Salams Premium offers guardian read-only chat access ($19.99/month). Platforms with transparent family-involvement features see stronger trust from both candidates and parents — it directly addresses 'is this halal?' sign-up hesitation.", "source": "https://purematrimony.com/muslim-marriage-apps-safety-faq"},
    {"insight": "NikahForever claims '100% verified profiles' and 'World's No.1 Muslim matrimony site' with 55,000+ matches and 1M+ users. However, user reviews on Trustpilot, SiteJabber, and Google Play report married/fake profiles slipping through, no manual photo moderation confirmed, and Scam Detector gives it a medium-risk trust score of 66/100. Competitor claim to answer: Date Khaas should show HOW verification works rather than claiming perfection.", "source": "https://www.nikahforever.com/faq"},
    {"insight": "Shaadi.com's 30-day 'Match Guarantee' has strict fine print: requires sending 10+ interests with zero accepts, applies only once per profile lifetime, excludes VIP memberships, requires complete profile with photo. Blue tick = government ID + phone verified = claims 40% more matches. A counter-message: quality over quantity — the right match matters more than any refund.", "source": "https://www.shaadi.com/introduction/index/match-guarantee"},
    {"insight": "NRI Muslim diaspora is the fastest-growing matrimony segment: ~4.5M Muslims in the US, major UK concentrations (London, Birmingham, Manchester), Gulf markets (UAE, KSA, Qatar). NRIs specifically seek partners who share faith AND cultural roots — 'someone who carries the same home in their heart' is a resonant message for this audience.", "source": "https://nikahnamah.com/"},
]

ANGLE = "Begin with intention — your match is already written"
DATE = "2026-06-22"

EMAIL_STANDARD_BODY = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Date Khaas — A New Year Begins</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f3ee;font-family:Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f3ee;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">

        <!-- Logo bar -->
        <tr>
          <td style="background-color:#003527;padding:20px 32px;text-align:center;">
            <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#e9c176;letter-spacing:3px;font-weight:normal;">Date Khaas</span>
          </td>
        </tr>

        <!-- Hero image -->
        <tr>
          <td style="padding:0;line-height:0;">
            <img src="https://datekhaas.com/images/hero-nikah.jpg" alt="A blessed nikah ceremony" width="600" style="width:100%;max-width:600px;display:block;height:auto;" />
          </td>
        </tr>

        <!-- Hero headline -->
        <tr>
          <td style="background-color:#003527;padding:32px 40px 28px;text-align:center;">
            <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:normal;color:#e9c176;line-height:1.35;">This year, may you find<br>the one written for you.</h1>
            <p style="margin:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#a8c8a8;font-style:italic;line-height:1.5;">1448 AH &mdash; a new Islamic year. A new intention.</p>
          </td>
        </tr>

        <!-- Opening body -->
        <tr>
          <td style="padding:36px 40px 24px;">
            <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#2d2d2d;line-height:1.75;">A new Islamic year has quietly arrived. Muharram &mdash; the month of reflection, of fresh beginnings, of turning the heart back to what matters most.</p>
            <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#2d2d2d;line-height:1.75;">And what matters, perhaps more than anything, is the longing that lives quietly in so many hearts: to find a partner in faith. Someone whose calm steadies you. Whose du'a echoes yours. A home within a person.</p>
            <p style="margin:0 0 28px;font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#2d2d2d;line-height:1.75;">If that longing is yours, this is the moment to act on it &mdash; gently, deliberately, with barakah.</p>

            <!-- Gold divider -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="border-top:1px solid #e9c176;padding-bottom:28px;"></td></tr>
            </table>

            <!-- Trust heading -->
            <h2 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:#003527;line-height:1.3;">A search you can trust &mdash;<br>and so can your family.</h2>

            <!-- Trust points -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0 12px;border-bottom:1px solid #f0ece6;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#2d2d2d;line-height:1.65;">
                  <span style="color:#003527;font-weight:bold;">&#10022; Reviewed profiles.</span>&nbsp; Every profile is manually checked &mdash; not just registered. So when you browse, you know the person on the other side is real, single, and sincere.
                </td>
              </tr>
              <tr>
                <td style="padding:12px 0;border-bottom:1px solid #f0ece6;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#2d2d2d;line-height:1.65;">
                  <span style="color:#003527;font-weight:bold;">&#10022; Your photos, your control.</span>&nbsp; Photos are blurred by default for every member &mdash; not a premium feature, not a paywall. You decide who sees you, when.
                </td>
              </tr>
              <tr>
                <td style="padding:12px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#2d2d2d;line-height:1.65;">
                  <span style="color:#003527;font-weight:bold;">&#10022; Your wali, by your side.</span>&nbsp; Family involvement is built in from the start. Your guardian can walk alongside you through every conversation &mdash; just as they should.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA block -->
        <tr>
          <td style="padding:12px 40px 40px;text-align:center;">
            <a href="https://datekhaas.com/start" style="display:inline-block;background-color:#003527;color:#e9c176;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 40px;border-radius:4px;letter-spacing:1px;">Begin Your Search</a>
            <p style="margin:16px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#888888;font-style:italic;">Everything begins with a single intention.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#f0ece6;padding:20px 40px;text-align:center;border-top:1px solid #e0dbd3;">
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#999999;line-height:1.6;">
              Date Khaas &middot; Muslim Matrimony &middot;
              <a href="https://datekhaas.com/unsubscribe" style="color:#003527;text-decoration:none;">Unsubscribe</a>
            </p>
            <p style="margin:6px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#bbbbbb;">All profiles reviewed &middot; Photos private by default &middot; Family involvement welcome</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>"""

AMP_BODY = """<!doctype html>
<html ⚡4email data-css-strict>
<head>
  <meta charset="UTF-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-carousel" src="https://cdn.ampproject.org/v0/amp-carousel-0.1.js"></script>
  <style amp4email-boilerplate>body{visibility:hidden}</style>
  <style amp-custom>
    body{margin:0;padding:0;background:#f7f3ee;font-family:Helvetica,Arial,sans-serif;}
    .wrap{max-width:600px;margin:0 auto;background:#fff;}
    .logo-bar{background:#003527;padding:20px;text-align:center;}
    .logo{font-family:Georgia,serif;font-size:22px;color:#e9c176;letter-spacing:3px;}
    .slide{position:relative;background:#111;}
    .slide-img{display:block;width:100%;}
    .overlay{background:rgba(0,53,39,0.80);padding:20px 24px;}
    .slide-title{font-family:Georgia,serif;font-size:21px;color:#e9c176;margin:0 0 6px;font-weight:normal;line-height:1.3;}
    .slide-sub{font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#c8d8c8;margin:0;line-height:1.5;}
    .cta-block{background:#003527;padding:28px;text-align:center;}
    .cta-head{font-family:Georgia,serif;font-size:18px;color:#e9c176;margin:0 0 16px;font-weight:normal;}
    .cta-btn{display:inline-block;background:#e9c176;color:#003527;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 32px;border-radius:4px;}
    .footer{background:#f0ece6;padding:16px;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#999;}
    .footer a{color:#003527;text-decoration:none;}
  </style>
</head>
<body>
<div class="wrap">
  <div class="logo-bar"><span class="logo">Date Khaas</span></div>

  <amp-carousel width="600" height="380" layout="responsive" type="slides" autoplay delay="3800" loop>

    <div class="slide">
      <amp-img src="https://cdn.pixabay.com/photo/placeholder-nikah.jpg" width="600" height="340" layout="responsive" alt="A blessed nikah"></amp-img>
      <div class="overlay">
        <p class="slide-title">Your match is already written.</p>
        <p class="slide-sub">This Muharram, begin your search with barakah and intention.</p>
      </div>
    </div>

    <div class="slide">
      <amp-img src="https://cdn.pixabay.com/photo/placeholder-wedding.jpg" width="600" height="340" layout="responsive" alt="Verified profiles"></amp-img>
      <div class="overlay">
        <p class="slide-title">&#10022; Every profile reviewed.</p>
        <p class="slide-sub">Not just registered. Not just an OTP. Actually checked &mdash; so you can browse with trust.</p>
      </div>
    </div>

    <div class="slide">
      <amp-img src="https://cdn.pixabay.com/photo/placeholder-couple.jpg" width="600" height="340" layout="responsive" alt="Your photos your control"></amp-img>
      <div class="overlay">
        <p class="slide-title">&#10022; Your photos, your say.</p>
        <p class="slide-sub">Blurred by default for every member. Visible only when you choose &mdash; not locked behind a subscription.</p>
      </div>
    </div>

  </amp-carousel>

  <div class="cta-block">
    <p class="cta-head">Begin your search with intention.</p>
    <a href="https://datekhaas.com/start" class="cta-btn">Start Now</a>
  </div>

  <div class="footer">
    Date Khaas &middot; Muslim Matrimony &middot; <a href="https://datekhaas.com/unsubscribe">Unsubscribe</a>
  </div>
</div>
</body>
</html>"""

AMP_FALLBACK = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Date Khaas — Begin with Intention</title>
</head>
<body style="margin:0;padding:0;background:#f7f3ee;font-family:Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#003527;padding:20px;text-align:center;"><span style="font-family:Georgia,serif;font-size:22px;color:#e9c176;letter-spacing:3px;">Date Khaas</span></td></tr>
      <tr><td style="line-height:0;"><img src="https://datekhaas.com/images/hero-nikah.jpg" alt="A blessed nikah" width="600" style="width:100%;display:block;" /></td></tr>
      <tr><td style="padding:32px 40px 24px;">
        <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#003527;line-height:1.35;">Your match is already written.</h1>
        <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#2d2d2d;line-height:1.7;">This Muharram &mdash; the first month of Islamic year 1448 &mdash; begin your search with intention and barakah.</p>
        <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#2d2d2d;line-height:1.7;"><strong style="color:#003527;">Reviewed profiles. Photos blurred by default. Your wali by your side.</strong></p>
        <a href="https://datekhaas.com/start" style="display:inline-block;background:#003527;color:#e9c176;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 32px;border-radius:4px;">Begin Your Search</a>
      </td></tr>
      <tr><td style="background:#f0ece6;padding:16px;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#999;">Date Khaas &middot; <a href="https://datekhaas.com/unsubscribe" style="color:#003527;text-decoration:none;">Unsubscribe</a></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""

WHATSAPP_BODY = """Assalamu alaikum ☀️

A new Islamic year has begun — 1448 AH. Muharram: a time for reflection, renewal, and perhaps the most beautiful intention of all.

If your heart holds a du’a for a righteous spouse, Date Khaas is where that search begins — with dignity, privacy, and your family by your side.

✓ Every profile reviewed (not just registered)
✓ Photos blurred by default — you choose who sees you
✓ Your wali walks with you through every step

Begin your search with barakah 👇
datekhaas.com/start

Reply STOP to unsubscribe."""

LINKEDIN_BODY = """The Muslim matrimony space has a trust problem — and it’s not what you think.

It’s not that people are dishonest. It’s that platforms make promises they can’t keep.

“100% verified” — yet users report married and fake profiles slipping through, no manual moderation confirmed, medium-risk trust scores from independent reviewers.

“30-day money back” — if you’ve sent 10+ interests with zero accepts, one-time per lifetime, fine print everywhere.

We built Date Khaas for a different standard. Not because trust is a marketing hook, but because the nikah deserves it.

Three things every halal platform should offer by default — not as a premium tier:

→ Photo privacy from day one: blurred until mutual consent, for every member
→ Wali involvement built in: guardian access, not an afterthought or upsell
→ Transparent verification: show how profiles are checked, not just claim they are

The families trusting us are placing something sacred in our hands — a daughter’s safety, a son’s sincerity, a marriage that should last a lifetime.

That trust isn’t a feature. It’s the floor.

This Muharram — Islamic New Year 1448 — we’re building something worthy of it.

#MuslimMatrimony #Nikah #HalalTech #IslamicMarriage #TrustAndSafety"""

bundle = {
    "date": DATE,
    "angle": ANGLE,
    "research": RESEARCH_SOURCES,
    "items": [
        {
            "type": "html_email",
            "format": "standard",
            "channel": "email",
            "title": "Muharram 1448 — Begin with Intention",
            "subject": "A new Islamic year begins — start your search with intention",
            "preheader": "1448 AH. The year your du’a finds its answer.",
            "cta_url": "https://datekhaas.com/start",
            "image_query": "muslim wedding ceremony",
            "body": EMAIL_STANDARD_BODY,
            "metadata": {
                "research_sources": RESEARCH_SOURCES,
                "angle": ANGLE,
                "note_on_images": "Hero image src is a placeholder; publish.py replaces with Pixabay URL in metadata.images. Update src in body for production send.",
            },
        },
        {
            "type": "html_email",
            "format": "amp",
            "channel": "email",
            "title": "Muharram 1448 — AMP Carousel",
            "subject": "Your match is already written — begin this Muharram",
            "preheader": "Verified profiles. Photo privacy. Your wali by your side.",
            "cta_url": "https://datekhaas.com/start",
            "image_query": "nikah ceremony",
            "body": AMP_BODY,
            "body_fallback": AMP_FALLBACK,
            "metadata": {
                "research_sources": RESEARCH_SOURCES,
                "angle": ANGLE,
                "note_on_images": "AMP carousel amp-img srcs are placeholders; swap in Pixabay CDN URLs from metadata.images before sending.",
            },
        },
        {
            "type": "whatsapp",
            "format": "text",
            "channel": "whatsapp",
            "title": "Muharram 1448 — WhatsApp Drop",
            "image_query": "muslim bride groom",
            "cta_url": "https://datekhaas.com/start",
            "body": WHATSAPP_BODY,
            "metadata": {
                "research_sources": RESEARCH_SOURCES,
                "angle": ANGLE,
                "char_count": len(WHATSAPP_BODY),
            },
        },
        {
            "type": "other",
            "format": "linkedin",
            "channel": "linkedin",
            "title": "Trust & Safety — LinkedIn Thought Leadership",
            "image_query": "muslim wedding celebration",
            "body": LINKEDIN_BODY,
            "metadata": {
                "research_sources": RESEARCH_SOURCES,
                "angle": ANGLE,
                "hashtags": ["#MuslimMatrimony", "#Nikah", "#HalalTech", "#IslamicMarriage", "#TrustAndSafety"],
            },
        },
    ],
}

import pathlib, sys
out = pathlib.Path(__file__).parent / "content.json"
out.write_text(json.dumps(bundle, indent=2, ensure_ascii=False))
print(f"Wrote {out} ({out.stat().st_size:,} bytes)")
print(f"WhatsApp char count: {len(WHATSAPP_BODY)}")
