"""Claude-powered AI email writer + reply classifier.

Uses prompt caching on the static system+style sections so each per-lead
generation only pays for the dynamic part.
"""
from __future__ import annotations

import json
from typing import Optional

from anthropic import Anthropic

from app.core.config import get_settings
from app.models import Lead, Workspace

_settings = get_settings()
_client: Optional[Anthropic] = None


def _client_or_none() -> Optional[Anthropic]:
    global _client
    if not _settings.anthropic_api_key:
        return None
    if _client is None:
        _client = Anthropic(api_key=_settings.anthropic_api_key)
    return _client


SYSTEM_PROMPT = """You are an elite B2B sales copywriter writing on behalf of a salesperson.
Write short, human, specific outreach emails — never marketing-speak.

Rules:
- Greet by first name only.
- Open with a single specific observation from the prospect's profile (role, company, location, recent move).
- One concrete value statement tied to their world.
- One light-touch CTA — a question, not a demand.
- 80-130 words max. No emojis. No "Hope you're doing well." No "I came across your profile."
- Return JSON: {"subject": "...", "body_text": "...", "body_html": "<p>...</p>"}.
"""


def _lead_context(lead: Optional[Lead]) -> str:
    if not lead:
        return "No specific lead — write a generic but human cold email."
    parts = [
        f"Name: {lead.full_name or lead.first_name or 'there'}",
        f"Title: {lead.title or '-'}",
        f"Headline: {lead.headline or '-'}",
        f"Location: {lead.location or '-'}",
        f"Company: {lead.company.name if lead.company else '-'}",
    ]
    if lead.company and lead.company.description:
        parts.append(f"Company desc: {lead.company.description[:300]}")
    return "\n".join(parts)


def generate_email_for_lead(
    lead: Optional[Lead],
    *,
    instruction: str,
    tone: str = "professional",
    workspace: Optional[Workspace] = None,
) -> dict:
    client = _client_or_none()
    if not client:
        # Local fallback so the UI keeps working without an API key.
        name = (lead.first_name or (lead.full_name or "there").split(" ")[0]) if lead else "there"
        company = lead.company.name if (lead and lead.company) else "your team"
        subject = f"Quick idea for {company}"
        body = (
            f"Hi {name},\n\n"
            f"Saw you're {lead.title or 'leading work'} at {company}. {instruction}\n\n"
            f"Worth a quick 15-minute chat next week?\n\nBest,"
        )
        return {
            "subject": subject,
            "body_text": body,
            "body_html": "<p>" + body.replace("\n\n", "</p><p>").replace("\n", "<br/>") + "</p>",
        }

    style = ""
    if workspace:
        style = (workspace.settings or {}).get("ai_style", "")

    response = client.messages.create(
        model=_settings.anthropic_model,
        max_tokens=600,
        system=[
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            {
                "type": "text",
                "text": f"Workspace voice/style notes:\n{style or '(none)'}",
                "cache_control": {"type": "ephemeral"},
            },
        ],
        messages=[
            {
                "role": "user",
                "content": (
                    f"Tone: {tone}\nGoal: {instruction}\n\nLead context:\n{_lead_context(lead)}\n\n"
                    "Return ONLY the JSON object."
                ),
            }
        ],
    )
    text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        data = json.loads(text[start : end + 1]) if start >= 0 and end > start else {}
    return {
        "subject": data.get("subject", ""),
        "body_text": data.get("body_text", ""),
        "body_html": data.get("body_html") or "<p>" + (data.get("body_text") or "").replace("\n", "<br/>") + "</p>",
    }


MARKETING_HTML_SYSTEM = """You are an elite email-marketing creative director AND production
engineer. You design campaigns that win awards AND render pixel-perfect in
Gmail (desktop + iOS + Android), Apple Mail, Outlook 2016/2019/365, Yahoo,
ProtonMail, and Spark.

CRITICAL — do NOT echo the user's brief as the subject, preview, or body. Read
the brief, extract intent + value prop + audience, then CREATE a polished
campaign from scratch. The brief is your input, not your output.

CREATIVE DIRECTION:
- Subject lines: punchy, curiosity-driven, ≤ 60 chars, NO ALL-CAPS, NO spammy
  words ("FREE", "Act now", multiple !!!). Lead with a specific benefit, a
  surprising stat, or a one-line story.
- Preview text: extends the subject, doesn't repeat it. 35-90 chars.
- Body copy: short paragraphs (≤ 2 sentences each). One core promise per email.
  Use {first_name} once near the top. End with a single, unambiguous CTA.
- The email MUST feel graphical, not text-heavy. Every email contains:
    1) A full-bleed HERO IMAGE at the top — pick a relevant photo from Unsplash
       using https://images.unsplash.com/photo-XXXXX?w=1200&q=80 (use real,
       known photo IDs — popular SaaS/marketing photos include
       1531403009284-440f080d1e12, 1551434678-e076c223a692,
       1556761175-5973dc0f32e7, 1551836022-d5d88e9218df,
       1517048676732-d65bc937f952). Overlay the headline ON the hero on
       brand-color gradient.
    2) A 2-3 column ICON or EMOJI feature row showing benefits (📈 ⚡ ✨ ✅ 🎯 🚀).
    3) An optional SOCIAL PROOF strip — logos (use text logos in styled <td>s
       or short quotes with portrait <img>s from Unsplash).
    4) A bold CTA BUTTON in brand color with rounded corners.
    5) A 1-2 line P.S. below the CTA for engagement.
- Sections: hero image + headline → 1-paragraph hook → 3 benefit columns →
  social proof / stat strip → CTA → P.S. → footer.
- Tone: match the requested tone exactly. "Friendly" = warm, contractions, no
  jargon. "Professional" = authoritative, no slang. "Witty" = playful asides,
  one allowed pun. "Urgent" = scarcity + deadline, never desperate.

PRODUCTION RULES (the email HTML field):
- 600-px max-width table-based layout. NO flexbox, NO grid, NO position:absolute.
- INLINE every style on each element. ONE <style> block in <head> is permitted
  only for @media (max-width:620px) mobile rules that clients ignore safely.
- Outlook bullet-proof <!--[if mso]> conditional comments around the CTA so it
  renders as a VML rectangle for the Outlook desktop client.
- System font stack: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI',
  Helvetica, Arial, sans-serif.
- Every <img> needs `width="…"`, `height="…"`, `alt="…"`, `style="display:block"`,
  and a max-width via the parent <td>. Use real (Unsplash) URLs when you choose
  an image, never `<img src="">` placeholders.
- Layout tables get `role="presentation"`.
- Honour the supplied brand_color for hero gradient + CTA fill + accents.
- Merge tags: `{first_name}`, `{full_name}`, `{company}`, `{title}`, `{email}`.

AMP FOR EMAIL (only when the user asks):
The amp_html field must be a COMPLETE, valid AMP4Email document that the AMP
validator accepts. Structure:

<!doctype html>
<html ⚡4email lang="en"><head><meta charset="utf-8">
<script async src="https://cdn.ampproject.org/v0.js"></script>
<!-- IMPORT only the components you actually use, e.g.: -->
<script async custom-element="amp-anim" src="https://cdn.ampproject.org/v0/amp-anim-0.1.js"></script>
<script async custom-element="amp-carousel" src="https://cdn.ampproject.org/v0/amp-carousel-0.1.js"></script>
<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>/* all visual styles here — inline NOT allowed */</style>
</head><body>...</body></html>

AMP rules:
- Allowed tags only: <amp-img>, <amp-anim>, <amp-carousel>, <amp-list>,
  <amp-form>, <amp-bind>, <amp-selector>, <amp-accordion>, <amp-timeago>.
- NO <img>, NO <video>, NO inline JS, NO inline style="…", NO external CSS.
- Every <amp-img> / <amp-anim> needs explicit width + height + layout="responsive".
- The AMP version MUST be visibly more interactive than the HTML — at MINIMUM
  one of these blocks (ideally two stacked):
    a) <amp-anim> animated-GIF hero (use a tenor.com or media.giphy.com URL).
    b) <amp-carousel type="slides" autoplay delay="3500" loop> of 3 product
       slides, each an <amp-img> + caption + per-slide CTA href.
    c) <amp-form method="post" action-xhr="https://yourapi.example/rsvp"> with
       radio buttons (Yes/No/Maybe) and an inline confirmation via amp-mustache.
    d) <amp-accordion> FAQ with 3 expandable items.
- Use real Unsplash photo URLs in <amp-img> just like the HTML version
  (https://images.unsplash.com/photo-...?w=1200&q=80).
- The non-AMP "html" field is the fallback for clients that don't render AMP —
  keep them visually consistent (same hero photo, same CTA, same brand color).

Return STRICT JSON ONLY (no preamble, no code fences):
{
  "subject": "<= 60-char compelling subject — never the user's brief verbatim>",
  "preview_text": "35-90 char inbox preheader — extends the subject",
  "html": "<complete responsive HTML email — full doctype to closing </html>>",
  "amp_html": "<complete AMP4Email document, or empty string if not requested>"
}
"""


def generate_marketing_html(
    *,
    brief: str,
    brand_color: str = "#0a66c2",
    tone: str = "professional",
    include_amp: bool = False,
    workspace: Optional[Workspace] = None,
) -> dict:
    """Generate a polished, marketing-grade HTML email from a brief.

    Falls back to a clean hand-built template when no Anthropic key is set so the
    UI keeps working in local/dev environments.
    """
    client = _client_or_none()
    if not client:
        return _fallback_marketing_html(brief=brief, brand_color=brand_color, include_amp=include_amp)

    style_notes = ""
    if workspace:
        style_notes = (workspace.settings or {}).get("ai_style", "")

    user_prompt = (
        f"Tone: {tone}\n"
        f"Brand color: {brand_color}\n"
        f"Include AMP for Email version: {'yes' if include_amp else 'no'}\n"
        f"Workspace style notes: {style_notes or '(none)'}\n\n"
        f"Brief from the marketer:\n{brief.strip()}\n\n"
        "Return ONLY the JSON object as specified."
    )

    response = client.messages.create(
        model=_settings.anthropic_model,
        # HTML + AMP combined can easily exceed 4k. 8k keeps both versions
        # complete; Opus generally returns 3-6k for a polished campaign.
        max_tokens=8000,
        system=[
            {"type": "text", "text": MARKETING_HTML_SYSTEM, "cache_control": {"type": "ephemeral"}},
        ],
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        data = json.loads(text[start : end + 1]) if start >= 0 and end > start else {}
    return {
        "subject": data.get("subject") or "",
        "preview_text": data.get("preview_text") or "",
        "html": data.get("html") or _fallback_marketing_html(brief=brief, brand_color=brand_color, include_amp=False)["html"],
        "amp_html": data.get("amp_html") or "",
    }


def _fallback_marketing_html(*, brief: str, brand_color: str, include_amp: bool) -> dict:
    """Render a hand-built responsive email when no AI key is present.

    Still gives the user a real, polished starting point — Unsplash hero image,
    3-column benefit grid, gradient CTA, P.S. line — that they can edit.
    """
    safe_brief = (brief or "Your message here.")[:300].replace("<", "&lt;").replace(">", "&gt;")
    title = safe_brief.split("\n")[0][:80] or "A quick note"
    # Stable Unsplash hero (rotates across a small curated set so previews
    # don't all look identical when used as starter content).
    hero_ids = [
        "1531403009284-440f080d1e12",
        "1551434678-e076c223a692",
        "1556761175-5973dc0f32e7",
        "1551836022-d5d88e9218df",
        "1517048676732-d65bc937f952",
    ]
    hero_id = hero_ids[abs(hash(brief)) % len(hero_ids)]
    hero = f"https://images.unsplash.com/photo-{hero_id}?w=1200&q=80&auto=format&fit=crop"
    html = f"""<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>{title}</title>
<style>@media (max-width:620px){{.lc-c{{width:100%!important}}.lc-p{{padding:24px!important}}.lc-h{{font-size:26px!important}}.lc-col{{display:block!important;width:100%!important;padding:12px 0!important}}}}</style>
</head>
<body style=\"margin:0;padding:0;background:#f5f5f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;\">
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f5f5f7;padding:32px 16px;\">
  <tr><td align=\"center\">
    <table role=\"presentation\" width=\"600\" class=\"lc-c\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(16,24,40,.08);\">
      <!-- Hero image with gradient overlay + headline -->
      <tr><td style=\"position:relative;padding:0;\">
        <img src=\"{hero}\" alt=\"\" width=\"600\" height=\"240\" style=\"display:block;width:100%;height:auto;\" />
      </td></tr>
      <tr><td style=\"background:linear-gradient(135deg,{brand_color},{brand_color}cc);padding:32px 40px;color:#fff;\">
        <p style=\"margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;\">Hi {{first_name}},</p>
        <h1 class=\"lc-h\" style=\"margin:0;color:#fff;font-size:30px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;\">{title}</h1>
      </td></tr>
      <tr><td class=\"lc-p\" style=\"padding:32px 40px 8px;color:#1f2937;font-size:16px;line-height:1.65;\">
        <p style=\"margin:0 0 20px;\">{safe_brief}</p>
      </td></tr>
      <!-- 3-column benefit grid -->
      <tr><td class=\"lc-p\" style=\"padding:16px 32px 8px;\">
        <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr>
          <td class=\"lc-col\" width=\"33%\" valign=\"top\" style=\"padding:10px;text-align:center;\">
            <div style=\"font-size:26px;line-height:1;margin-bottom:6px;\">⚡</div>
            <div style=\"font-weight:700;color:#0f172a;font-size:13px;margin-bottom:4px;\">Fast setup</div>
            <div style=\"color:#64748b;font-size:12.5px;line-height:1.5;\">Live in under 5 minutes</div>
          </td>
          <td class=\"lc-col\" width=\"33%\" valign=\"top\" style=\"padding:10px;text-align:center;\">
            <div style=\"font-size:26px;line-height:1;margin-bottom:6px;\">📈</div>
            <div style=\"font-weight:700;color:#0f172a;font-size:13px;margin-bottom:4px;\">Real results</div>
            <div style=\"color:#64748b;font-size:12.5px;line-height:1.5;\">Measurable lift in week one</div>
          </td>
          <td class=\"lc-col\" width=\"33%\" valign=\"top\" style=\"padding:10px;text-align:center;\">
            <div style=\"font-size:26px;line-height:1;margin-bottom:6px;\">✨</div>
            <div style=\"font-weight:700;color:#0f172a;font-size:13px;margin-bottom:4px;\">Loved by teams</div>
            <div style=\"color:#64748b;font-size:12.5px;line-height:1.5;\">4.9 / 5 across 800+ reviews</div>
          </td>
        </tr></table>
      </td></tr>
      <!-- CTA -->
      <tr><td class=\"lc-p\" style=\"padding:28px 40px 12px;text-align:center;\">
        <a href=\"https://\" style=\"display:inline-block;background:linear-gradient(135deg,{brand_color},{brand_color}dd);color:#fff;text-decoration:none;font-weight:700;padding:16px 36px;border-radius:12px;font-size:15px;letter-spacing:0.01em;box-shadow:0 6px 18px {brand_color}55;\">Take a look →</a>
      </td></tr>
      <tr><td class=\"lc-p\" style=\"padding:8px 40px 32px;color:#64748b;font-size:13px;text-align:center;line-height:1.55;\">
        P.S. Reply with any question — we read every email.
      </td></tr>
      <tr><td style=\"padding:18px 40px;background:#f8fafc;color:#94a3b8;font-size:12px;text-align:center;\">
        © {{company}} · You're receiving this because you opted in.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""
    amp_html = ""
    if include_amp:
        # Three Unsplash slides for the carousel — same curated pool.
        slide_ids = [hero_ids[(abs(hash(brief)) + i) % len(hero_ids)] for i in range(1, 4)]
        slides = "\n      ".join(
            f'<amp-img src="https://images.unsplash.com/photo-{sid}?w=1200&q=80&auto=format&fit=crop" width="1200" height="720" layout="responsive" alt="slide {i+1}"></amp-img>'
            for i, sid in enumerate(slide_ids)
        )
        amp_html = f"""<!doctype html>
<html ⚡4email lang=\"en\"><head><meta charset=\"utf-8\">
<script async src=\"https://cdn.ampproject.org/v0.js\"></script>
<script async custom-element=\"amp-anim\" src=\"https://cdn.ampproject.org/v0/amp-anim-0.1.js\"></script>
<script async custom-element=\"amp-carousel\" src=\"https://cdn.ampproject.org/v0/amp-carousel-0.1.js\"></script>
<script async custom-element=\"amp-img\" src=\"https://cdn.ampproject.org/v0/amp-img-0.1.js\"></script>
<style amp4email-boilerplate>body{{visibility:hidden}}</style>
<style amp-custom>
  body{{margin:0;padding:0;background:#f5f5f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;}}
  .card{{max-width:600px;margin:32px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(16,24,40,.08);}}
  .hero-img{{display:block;width:100%;}}
  .hero{{background:linear-gradient(135deg,{brand_color},{brand_color}cc);padding:32px 40px;color:#fff;}}
  .hero .eyebrow{{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;}}
  .hero h1{{margin:0;font-size:30px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;}}
  .body{{padding:32px 40px;color:#1f2937;font-size:16px;line-height:1.65;}}
  .features{{display:flex;gap:16px;padding:8px 32px 8px;text-align:center;color:#0f172a;}}
  .feature{{flex:1;padding:10px;font-size:13px;}}
  .feature .icon{{font-size:26px;line-height:1;margin-bottom:6px;}}
  .feature .label{{font-weight:700;margin-bottom:4px;}}
  .feature .detail{{color:#64748b;font-size:12.5px;line-height:1.5;}}
  .carousel-wrap{{padding:8px 32px 0;}}
  .cta-wrap{{padding:28px 40px 12px;text-align:center;}}
  .cta{{display:inline-block;background:linear-gradient(135deg,{brand_color},{brand_color}dd);color:#fff;text-decoration:none;padding:16px 36px;border-radius:12px;font-weight:700;font-size:15px;box-shadow:0 6px 18px {brand_color}55;}}
  .ps{{padding:8px 40px 28px;text-align:center;color:#64748b;font-size:13px;line-height:1.55;}}
  .footer{{padding:18px 40px;background:#f8fafc;color:#94a3b8;font-size:12px;text-align:center;}}
</style></head>
<body>
<div class=\"card\">
  <amp-anim width=\"1200\" height=\"720\" layout=\"responsive\" src=\"https://images.unsplash.com/photo-{hero_id}?w=1200&q=80&auto=format&fit=crop\" alt=\"hero\"></amp-anim>
  <div class=\"hero\">
    <p class=\"eyebrow\">Hi {{first_name}},</p>
    <h1>{title}</h1>
  </div>
  <div class=\"body\"><p>{safe_brief}</p></div>
  <div class=\"features\">
    <div class=\"feature\"><div class=\"icon\">⚡</div><div class=\"label\">Fast setup</div><div class=\"detail\">Live in under 5 min</div></div>
    <div class=\"feature\"><div class=\"icon\">📈</div><div class=\"label\">Real results</div><div class=\"detail\">Lift in week one</div></div>
    <div class=\"feature\"><div class=\"icon\">✨</div><div class=\"label\">Loved by teams</div><div class=\"detail\">4.9 / 5 across 800+</div></div>
  </div>
  <div class=\"carousel-wrap\">
    <amp-carousel width=\"1200\" height=\"720\" layout=\"responsive\" type=\"slides\" autoplay delay=\"3500\" loop>
      {slides}
    </amp-carousel>
  </div>
  <div class=\"cta-wrap\"><a class=\"cta\" href=\"https://\">Take a look →</a></div>
  <div class=\"ps\">P.S. Reply with any question — we read every email.</div>
  <div class=\"footer\">© {{company}} · You're receiving this because you opted in.</div>
</div>
</body></html>"""
    return {
        "subject": (brief[:75] or "A quick note from your team"),
        "preview_text": (brief[:90] or "We thought you'd want to see this."),
        "html": html,
        "amp_html": amp_html,
    }


def classify_reply_sentiment(text: str) -> dict:
    client = _client_or_none()
    if not client:
        lowered = text.lower()
        if any(w in lowered for w in ("yes", "interested", "sure", "happy to", "let's", "sounds good")):
            return {"sentiment": "positive", "confidence": 0.6}
        if any(w in lowered for w in ("not interested", "no thanks", "remove", "unsubscribe", "stop")):
            return {"sentiment": "negative", "confidence": 0.6}
        return {"sentiment": "neutral", "confidence": 0.4}
    response = client.messages.create(
        model=_settings.anthropic_fast_model,
        max_tokens=50,
        system="Classify the reply as one of: positive, neutral, negative, ooo (out of office). Respond JSON: {\"sentiment\": \"...\", \"confidence\": 0.0-1.0}.",
        messages=[{"role": "user", "content": text[:4000]}],
    )
    text_out = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
    try:
        return json.loads(text_out)
    except Exception:
        return {"sentiment": "neutral", "confidence": 0.4}
