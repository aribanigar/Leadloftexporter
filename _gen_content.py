#!/usr/bin/env python3
"""Generates content.json for Date Khaas daily drop — 2026-06-21."""
import json, pathlib

DATE = "2026-06-21"
ANGLE = "Your photos, your timeline — seen only when you choose"

RESEARCH = [
    {
        "insight": "Photo blur by default and Wali-friendly defaults are now expected table-stakes features for Muslim matrimony apps in 2026, not premium upsells — platforms that hide them behind paywalls are losing trust-conscious users.",
        "source": "https://zawjni.com/en/blog/%D9%85%D9%88%D9%82%D8%B9-%D9%85%D8%B3%D9%84%D9%85%D8%A9-%D9%84%D9%84%D8%B2%D9%88%D8%A7%D8%AC-%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%86%D9%8A"
    },
    {
        "insight": "Muslim women cite photo privacy and family-involvement options as their two primary concerns when evaluating matrimony apps — these are conversion drivers, not just features.",
        "source": "https://purematrimony.com/muslim-marriage-apps-safety-faq"
    },
    {
        "insight": "NikahForever leads with stats ('4M+ active verified members, 70K+ marriages') but communicates no warmth or feeling — the emotional gap is a clear opportunity for a brand-first competitor.",
        "source": "https://www.nikahforever.com/"
    },
    {
        "insight": "Summer 2026 is peak Nikah season — Friday evenings after Maghrib are the most-planned ceremony time. Couples and families are actively searching and comparing platforms right now.",
        "source": "https://symphonyevents.com.au/islamic-wedding-dates-2026-for-nikah/"
    },
    {
        "insight": "Salaam Soulmate research shows that modesty through design — monitored communication, photo controls, family intermediaries — must be a built-in principle, not a settings checkbox.",
        "source": "https://salaamsoulmate.com/blog/respecting-modesty-and-privacy-in-muslim-matrimony-platforms"
    },
    {
        "insight": "Shaadi.com anchors its brand on '80 Lakh success stories' — a volume-first, transactional position that leaves the entire emotional lane open for a brand rooted in love, barakah, and care.",
        "source": "https://www.shaadi.com/"
    }
]

# ── PIECE 1: Marketing email ──────────────────────────────────────────────────

EMAIL_STANDARD = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Your heart first. Your photo when you’re ready.</title>
</head>
<body style="margin:0;padding:0;background-color:#f4ede3;-webkit-text-size-adjust:100%;mso-line-height-rule:exactly;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4ede3;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">

        <!-- Logo bar -->
        <tr>
          <td style="background-color:#003527;padding:28px 40px;text-align:center;">
            <p style="margin:0;font-family:Georgia,‘Times New Roman’,serif;font-size:28px;font-weight:400;color:#e9c176;letter-spacing:3px;mso-line-height-rule:exactly;">Date Khaas</p>
            <p style="margin:6px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9ebfb8;letter-spacing:4px;text-transform:uppercase;">Muslim Matrimony</p>
          </td>
        </tr>

        <!-- Hero image -->
        <tr>
          <td style="padding:0;line-height:0;font-size:0;">
            <img src="https://datekhaas.com/assets/email/hero-nikah.jpg" alt="A serene nikah moment" width="600" style="width:100%;max-width:600px;display:block;border:0;" />
          </td>
        </tr>

        <!-- Hero copy -->
        <tr>
          <td style="padding:48px 48px 24px;text-align:center;">
            <p style="margin:0 0 20px;font-family:Georgia,‘Times New Roman’,serif;font-size:34px;font-weight:400;line-height:1.3;color:#003527;mso-line-height-rule:exactly;">There is a calm<br>that comes with finding<br>the one written for you.</p>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4a4a;">The Quran calls it <em>sukoon</em> — the tranquillity Allah places between two hearts. That peace doesn’t begin at the nikah. It begins the moment you feel truly seen, respected, and safe.</p>
          </td>
        </tr>

        <!-- Gold rule -->
        <tr>
          <td style="padding:4px 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:1px;background-color:#e9c176;font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>

        <!-- Trust heading -->
        <tr>
          <td style="padding:32px 48px 16px;text-align:center;">
            <p style="margin:0 0 12px;font-family:Georgia,‘Times New Roman’,serif;font-size:22px;font-weight:400;color:#003527;">At Date Khaas, you set the pace.</p>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.75;color:#4a4a4a;">Your photo stays blurred until <strong>you</strong> decide to share it. Every profile is verified before a single introduction is made. Your wali can walk alongside you from the very first message — because a marriage blessed with family is a marriage rooted in barakah.</p>
          </td>
        </tr>

        <!-- Trust pillars (3-col table layout) -->
        <tr>
          <td style="padding:24px 40px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="33%" valign="top" style="text-align:center;padding:0 8px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 10px;">
                    <tr><td style="width:44px;height:44px;background-color:#003527;border-radius:22px;text-align:center;vertical-align:middle;font-family:Arial,sans-serif;font-size:20px;color:#e9c176;line-height:44px;">✓</td></tr>
                  </table>
                  <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#003527;">Verified Profiles</p>
                  <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#777;line-height:1.6;">Every member confirmed before the first introduction</p>
                </td>
                <td width="33%" valign="top" style="text-align:center;padding:0 8px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 10px;">
                    <tr><td style="width:44px;height:44px;background-color:#003527;border-radius:22px;text-align:center;vertical-align:middle;font-family:Arial,sans-serif;font-size:18px;line-height:44px;">\U0001f512</td></tr>
                  </table>
                  <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#003527;">Photo Privacy</p>
                  <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#777;line-height:1.6;">Blurred by default — visible only on your terms</p>
                </td>
                <td width="33%" valign="top" style="text-align:center;padding:0 8px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 10px;">
                    <tr><td style="width:44px;height:44px;background-color:#003527;border-radius:22px;text-align:center;vertical-align:middle;font-family:Arial,sans-serif;font-size:18px;line-height:44px;">\U0001f91d</td></tr>
                  </table>
                  <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#003527;">Wali Welcome</p>
                  <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#777;line-height:1.6;">Invite your guardian from the very first message</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA button -->
        <tr>
          <td style="padding:8px 48px 40px;text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="background-color:#003527;border-radius:6px;">
                  <a href="https://datekhaas.com/join" style="display:inline-block;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#e9c176;text-decoration:none;padding:16px 40px;letter-spacing:1px;border-radius:6px;">Find Your Match, At Your Pace</a>
                </td>
              </tr>
            </table>
            <p style="margin:18px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#999;line-height:1.6;">Free to join &nbsp;&middot;&nbsp; All profiles reviewed before going live &nbsp;&middot;&nbsp; No dating-app energy</p>
          </td>
        </tr>

        <!-- Quranic quote -->
        <tr>
          <td style="padding:0 48px 36px;text-align:center;">
            <p style="margin:0;font-family:Georgia,‘Times New Roman’,serif;font-size:15px;font-style:italic;color:#003527;line-height:1.75;">“And of His signs is that He created for you from yourselves mates that you may find tranquillity in them.”<br><span style="font-family:Helvetica,Arial,sans-serif;font-style:normal;font-size:12px;color:#aaa;">— Quran 30:21</span></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#003527;padding:24px 40px;text-align:center;">
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#9ebfb8;line-height:1.7;">Date Khaas &nbsp;&middot;&nbsp; Muslim Matrimony &nbsp;&middot;&nbsp; <a href="https://datekhaas.com/unsubscribe" style="color:#e9c176;text-decoration:none;">Unsubscribe</a></p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>"""

# ── PIECE 2: AMP email ────────────────────────────────────────────────────────

EMAIL_AMP = """\
<!doctype html>
<html ⚡4email>
<head>
  <meta charset="utf-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-carousel" src="https://cdn.ampproject.org/v0/amp-carousel-0.1.js"></script>
  <style amp4email-boilerplate>body{visibility:hidden}</style>
  <style amp-custom>
    body{margin:0;padding:16px;background:#f4ede3;font-family:Helvetica,Arial,sans-serif;}
    .wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;}
    .hdr{background:#003527;padding:28px 40px;text-align:center;}
    .hdr-t{margin:0;font-family:Georgia,serif;font-size:26px;color:#e9c176;letter-spacing:3px;}
    .hdr-s{margin:6px 0 0;font-size:11px;color:#9ebfb8;letter-spacing:4px;text-transform:uppercase;}
    .slide{position:relative;}
    .badge{position:absolute;top:14px;right:14px;background:#003527;color:#e9c176;font-size:11px;font-weight:700;padding:6px 14px;border-radius:20px;letter-spacing:1px;}
    .body-copy{padding:40px 40px 20px;text-align:center;}
    .hero-h{margin:0 0 16px;font-family:Georgia,serif;font-size:26px;color:#003527;line-height:1.35;}
    .body-p{margin:0;font-size:14px;line-height:1.75;color:#4a4a4a;}
    .divider{height:1px;background:#e9c176;margin:4px 40px 4px;}
    .trust-row{padding:24px 40px 28px;text-align:center;}
    .t-item{display:inline-block;width:28%;vertical-align:top;padding:0 4px;}
    .t-icon{width:40px;height:40px;background:#003527;border-radius:50%;margin:0 auto 8px;line-height:40px;text-align:center;color:#e9c176;font-size:16px;}
    .t-title{font-size:12px;font-weight:700;color:#003527;margin:0 0 4px;}
    .t-desc{font-size:11px;color:#777;line-height:1.5;margin:0;}
    .cta-wrap{padding:8px 40px 40px;text-align:center;}
    .cta{display:inline-block;background:#003527;color:#e9c176;font-size:14px;font-weight:700;text-decoration:none;padding:16px 36px;border-radius:6px;letter-spacing:1px;}
    .ftr{background:#003527;padding:20px 40px;text-align:center;font-size:11px;color:#9ebfb8;}
    .ftr a{color:#e9c176;text-decoration:none;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <p class="hdr-t">Date Khaas</p>
      <p class="hdr-s">Muslim Matrimony</p>
    </div>

    <amp-carousel width="600" height="380" layout="responsive" type="slides" autoplay delay="4000" loop>
      <div class="slide">
        <amp-img src="https://datekhaas.com/assets/email/nikah-1.jpg" width="600" height="380" layout="responsive" alt="Nikah ceremony moment"></amp-img>
        <div class="badge">✓ Verified Profiles</div>
      </div>
      <div class="slide">
        <amp-img src="https://datekhaas.com/assets/email/nikah-2.jpg" width="600" height="380" layout="responsive" alt="Muslim wedding celebration"></amp-img>
        <div class="badge">\U0001f512 Photos Private</div>
      </div>
      <div class="slide">
        <amp-img src="https://datekhaas.com/assets/email/nikah-3.jpg" width="600" height="380" layout="responsive" alt="Family nikah blessing"></amp-img>
        <div class="badge">\U0001f91d Wali Welcome</div>
      </div>
    </amp-carousel>

    <div class="body-copy">
      <p class="hero-h">Every match here is real.<br>Every introduction, intentional.</p>
      <p class="body-p">Date Khaas is built for people who take marriage seriously — and families who want the best for their loved ones. Before anyone meets on this platform, they’re verified. Your photos are yours, blurred until you choose otherwise. And your wali is always welcome.</p>
    </div>

    <div class="divider"></div>

    <div class="trust-row">
      <div class="t-item">
        <div class="t-icon">✓</div>
        <p class="t-title">Verified</p>
        <p class="t-desc">Every member confirmed before introduction</p>
      </div>
      <div class="t-item">
        <div class="t-icon">\U0001f512</div>
        <p class="t-title">Private Photos</p>
        <p class="t-desc">Blurred until you choose to share</p>
      </div>
      <div class="t-item">
        <div class="t-icon">\U0001f91d</div>
        <p class="t-title">Wali Welcome</p>
        <p class="t-desc">Guardian invited from day one</p>
      </div>
    </div>

    <div class="cta-wrap">
      <a href="https://datekhaas.com/join" class="cta">Begin Your Journey</a>
    </div>

    <div class="ftr">
      Date Khaas &nbsp;&middot;&nbsp; Muslim Matrimony &nbsp;&middot;&nbsp; <a href="https://datekhaas.com/unsubscribe">Unsubscribe</a>
    </div>
  </div>
</body>
</html>"""

EMAIL_AMP_FALLBACK = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Every match here is real. Every introduction, intentional.</title>
</head>
<body style="margin:0;padding:16px;background:#f4ede3;font-family:Helvetica,Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="background:#003527;padding:28px 40px;text-align:center;">
    <p style="margin:0;font-family:Georgia,serif;font-size:26px;color:#e9c176;letter-spacing:3px;">Date Khaas</p>
    <p style="margin:6px 0 0;font-size:11px;color:#9ebfb8;letter-spacing:4px;text-transform:uppercase;">Muslim Matrimony</p>
  </td></tr>
  <tr><td style="padding:0;font-size:0;line-height:0;">
    <img src="https://datekhaas.com/assets/email/nikah-1.jpg" alt="Nikah ceremony" width="600" style="width:100%;display:block;border:0;" />
  </td></tr>
  <tr><td style="padding:40px 40px 24px;text-align:center;">
    <p style="margin:0 0 16px;font-family:Georgia,serif;font-size:26px;color:#003527;line-height:1.35;">Every match here is real.<br>Every introduction, intentional.</p>
    <p style="margin:0;font-size:14px;line-height:1.75;color:#4a4a4a;">Before anyone meets on Date Khaas, they’re verified. Your photos stay blurred until you choose to share them. And your wali is welcome from the very first message.</p>
  </td></tr>
  <tr><td style="padding:4px 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background:#e9c176;font-size:0;">&nbsp;</td></tr></table></td></tr>
  <tr><td style="padding:24px 40px 36px;text-align:center;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr><td style="background:#003527;border-radius:6px;">
        <a href="https://datekhaas.com/join" style="display:inline-block;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#e9c176;text-decoration:none;padding:16px 36px;border-radius:6px;letter-spacing:1px;">Begin Your Journey</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#003527;padding:20px 40px;text-align:center;font-size:11px;color:#9ebfb8;">
    Date Khaas &nbsp;&middot;&nbsp; <a href="https://datekhaas.com/unsubscribe" style="color:#e9c176;text-decoration:none;">Unsubscribe</a>
  </td></tr>
</table>
</body>
</html>"""

# ── PIECE 3: WhatsApp ─────────────────────────────────────────────────────────

WHATSAPP_BODY = (
    "Assalamu alaikum \U0001f33f\n\n"
    "We know how much it means — to find someone who loves you for your deen, your character, the whole of you. Not a profile. You.\n\n"
    "Date Khaas is a Muslim matrimony app built with that feeling at its heart.\n\n"
    "Before any introduction is made:\n"
    "✓ Every profile is verified\n"
    "\U0001f512 Your photos stay blurred until you choose\n"
    "\U0001f91d Your wali can join the conversation from day one\n\n"
    "Summer is Nikah season — and there are people on Date Khaas right now searching for exactly what you’re searching for.\n\n"
    "Join free today ↓\n"
    "https://datekhaas.com/join\n\n"
    "May Allah bless every step of your journey toward your spouse. Ameen."
)

# ── PIECE 4: LinkedIn ─────────────────────────────────────────────────────────

LINKEDIN_BODY = (
    "Trust isn’t a feature. It’s the foundation.\n\n"
    "In Muslim matrimony, families don’t just support the process — they’re part of it. The wali. The parents. The community. They’re not obstacles to work around; they’re the scaffolding that makes a marriage last.\n\n"
    "Yet most matrimony platforms treat trust as an afterthought: a small “verified” badge buried in a profile, a privacy policy no one reads.\n\n"
    "At Date Khaas, we’re building differently:\n\n"
    "→ Photos blurred by default — visible only when the member chooses\n"
    "→ Every profile verified before the first introduction\n"
    "→ Walis invited to conversations from day one\n"
    "→ No swipe culture. No casual DMs. Every interaction intentional.\n\n"
    "Muslim women especially deserve a platform where modesty is a design principle, not a checkbox.\n\n"
    "This summer Nikah season, we keep asking one question: what would it look like if a matrimony app was built the way a trusted family elder would build it?\n\n"
    "Warm. Careful. Unhurried. Rooted in barakah.\n\n"
    "That’s Date Khaas.\n\n"
    "#MuslimMatrimony #Nikah #TrustAndSafety #IslamicMarriage #DateKhaas"
)

# ── Assemble ──────────────────────────────────────────────────────────────────

bundle = {
    "date": DATE,
    "angle": ANGLE,
    "research": RESEARCH,
    "items": [
        {
            "type": "html_email",
            "format": "standard",
            "channel": "email",
            "title": "Heart First, Photo When Ready",
            "subject": "Your heart first. Your photo when you’re ready.",
            "preheader": "At Date Khaas, you set the pace — always.",
            "cta_url": "https://datekhaas.com/join",
            "image_query": "muslim wedding ceremony",
            "body": EMAIL_STANDARD,
            "metadata": {
                "research_sources": RESEARCH
            }
        },
        {
            "type": "html_email",
            "format": "amp",
            "channel": "email",
            "title": "Verified Introduction Gallery",
            "subject": "Every profile here is real. Every match, intentional.",
            "preheader": "Verified profiles. Private photos. Wali welcome.",
            "cta_url": "https://datekhaas.com/join",
            "image_query": "nikah ceremony",
            "body": EMAIL_AMP,
            "body_fallback": EMAIL_AMP_FALLBACK,
            "metadata": {
                "research_sources": RESEARCH
            }
        },
        {
            "type": "whatsapp",
            "format": "text",
            "channel": "whatsapp",
            "title": "Summer Nikah Season WhatsApp",
            "cta_url": "https://datekhaas.com/join",
            "image_query": "muslim bride groom",
            "body": WHATSAPP_BODY,
            "metadata": {
                "research_sources": RESEARCH
            }
        },
        {
            "type": "other",
            "format": "linkedin",
            "channel": "linkedin",
            "title": "Trust Is the Foundation — LinkedIn",
            "image_query": "muslim wedding celebration",
            "body": LINKEDIN_BODY,
            "metadata": {
                "research_sources": RESEARCH
            }
        }
    ]
}

out = pathlib.Path(__file__).parent / "content.json"
out.write_text(json.dumps(bundle, indent=2, ensure_ascii=False))
print(f"Written {out}")
wc = len(bundle["items"][2]["body"])
print(f"WhatsApp body length: {wc} chars (limit ~900)")
