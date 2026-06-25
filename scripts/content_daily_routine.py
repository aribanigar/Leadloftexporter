#!/usr/bin/env python3
"""
content_daily_routine.py — daily brand-voice Content Hub refresh + text A/B testing.

CHANGES vs the v1 news-headline routine:
  - Headlines come from BRAND-VOICE TEMPLATES per business, not from
    raw news titles (which drift the brand badly: e.g. Date Khaas
    inheriting a "85m rubles for halal dating in Tatarstan" headline).
  - Each business has 6-10 evergreen templates that capture its tone,
    distilled from the existing live content in the Content Hub.
  - Every daily run picks TWO different templates (day-of-year rotated)
    and inserts them as Variant A + Variant B for text A/B testing.
    Both variants share an `ab-test:<slug>:<date>` tag plus individual
    `variant:a` / `variant:b` tags so the live UI can pair them.
  - News from Google News RSS is still fetched but used only as a small
    "industry signal" footer line — it cannot hijack the headline.
  - Image strategy unchanged — Pixabay listing scrape → Unsplash Source
    fallback. image_url is GUARANTEED set on every asset.

CRITICAL DESIGN RULES (unchanged):
  1. ZERO LLM dependency. Stdlib + httpx-free urllib only.
  2. image_url mandatory on every asset.
  3. Idempotent: skip insert if (business_id, title) already exists.

Run:
  python3 scripts/content_daily_routine.py --all
  python3 scripts/content_daily_routine.py --business date-khaas --dry-run
"""
import argparse, datetime as dt, html as _html, json, os, re, sys, time, uuid
import urllib.parse, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path


# ─── Supabase config ───────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get(
    "SUPABASE_URL",
    "https://cmdnezltteldysoxyjzh.supabase.co",
)


def _service_key() -> str:
    k = os.environ.get("SUPABASE_SERVICE_KEY")
    if k:
        return k
    try:
        m = re.search(r'SERVICE_KEY\s*=\s*"([^"]+)"', Path("go_live.py").read_text())
        if m:
            return m.group(1)
    except FileNotFoundError:
        pass
    raise SystemExit("SUPABASE_SERVICE_KEY env var not set and go_live.py not found")


# ─── HTTP helpers ──────────────────────────────────────────────────────────
UA = "Mozilla/5.0 (LeadCaptura ContentRoutine/2.0)"


def _http_get(url: str, timeout: float = 20.0) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            try:
                return data.decode("utf-8")
            except UnicodeDecodeError:
                return data.decode("utf-8", errors="ignore")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        print(f"  ! http {url[:80]} → {e}", file=sys.stderr)
        return None


def rest(method: str, path: str, body=None, key: str | None = None):
    key = key or _service_key()
    url = f"{SUPABASE_URL}/rest/v1{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="ignore")[:400]


# ─── Internet sources (free, no API key) ───────────────────────────────────
def google_news_one(query: str) -> dict | None:
    """Pull a single fresh news item — used ONLY as an industry-signal
    footer in the email, never as the headline."""
    q = urllib.parse.quote_plus(query)
    body = _http_get(f"https://news.google.com/rss/search?q={q}&hl=en&gl=US&ceid=US:en")
    if not body:
        return None
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    for item in root.findall(".//item")[:5]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if title and link:
            return {"title": title, "url": link}
    return None


_PIXABAY_IMG = re.compile(
    r'https?://[^\s"\']*pixabay\.com/get/[^\s"\']+?_1280\.(?:jpg|png|webp)',
    re.I,
)


def pixabay_one(query: str) -> str | None:
    q = urllib.parse.quote_plus(query)
    body = _http_get(f"https://pixabay.com/images/search/{q}/")
    if not body:
        return None
    for m in _PIXABAY_IMG.finditer(body):
        return m.group(0)
    return None


def unsplash_image(query: str) -> str:
    return f"https://source.unsplash.com/featured/1200x630/?{urllib.parse.quote_plus(query)}"


def pick_image(keywords: list[str]) -> str:
    for kw in keywords:
        u = pixabay_one(kw)
        if u:
            return u
    return unsplash_image(keywords[0] if keywords else "business")


def esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ─── Per-business config ───────────────────────────────────────────────────
#
# `templates` = evergreen brand-voice angles. Each template defines:
#   subject       — email subject line (the actual headline going out)
#   headline      — display H1 used in the email body
#   kicker        — small uppercase pill above the headline
#   body          — body copy (HTML allowed, kept short)
#   whatsapp      — WhatsApp message version of the same angle
#   caption       — Instagram caption version
#   image_kw      — image-search keyword for THIS angle's hero photo
#
# Templates are rotated by day-of-year. Each daily run picks two different
# templates → Variant A + Variant B for A/B testing.


def _channels_for(profile, template, image_url, news, variant_letter):
    """Build the three channels (html_email, whatsapp, caption) for one
    template. `news` is the small industry-signal footer (may be None)."""
    p = profile["palette"]
    brand = profile["wordmark"]
    audience = profile.get("audience", "")
    cta_label = profile.get("cta_label", "Learn more")
    cta_url = profile.get("cta_url", "#")

    subject = template["subject"]
    headline = template["headline"]
    kicker = template.get("kicker", audience)
    body_html = template["body"]
    news_footer = ""
    if news:
        news_footer = (
            f'<div style="margin-top:24px;padding:14px 18px;background:#f4faf6;'
            f'border-left:3px solid {p["primary"]};font-family:Inter,Arial,sans-serif;'
            f'font-size:12.5px;line-height:1.55;color:#64748b;">'
            f'<b style="color:#334155;">From the industry today:</b> '
            f'<a href="{esc(news["url"])}" style="color:{p["primary"]};text-decoration:none;">'
            f'{esc(news["title"][:160])}</a></div>'
        )

    html_email = (
        f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{esc(subject)}</title></head>'
        f'<body style="margin:0;padding:0;background-color:{p["paper"]};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:{p["paper"]};">'
        f'<tr><td align="center" style="padding:24px 12px;">'
        f'<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">'
        f'<tr><td style="padding:24px 36px 8px 36px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.4px;color:{p["ink"]};">{esc(brand)}</td></tr>'
        f'<tr><td style="font-size:0;line-height:0;"><img src="{esc(image_url)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>'
        f'<tr><td style="padding:32px 36px 6px 36px;font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.6px;color:{p["primary"]};text-transform:uppercase;">{esc(kicker)}</td></tr>'
        f'<tr><td style="padding:6px 36px 16px 36px;font-family:Inter,Arial,sans-serif;font-size:30px;line-height:1.14;font-weight:800;color:{p["ink"]};letter-spacing:-0.6px;">{esc(headline)}</td></tr>'
        f'<tr><td style="padding:0 36px 26px 36px;font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.6;color:#333;">{body_html}</td></tr>'
        f'<tr><td align="left" style="padding:0 36px 36px 36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="{p["primary"]}" style="border-radius:12px;"><a href="{esc(cta_url)}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;">{esc(cta_label)} →</a></td></tr></table>'
        f'{news_footer}</td></tr>'
        f'<tr><td style="background-color:{p["paper"]};padding:18px 36px;border-top:1px solid #e5e7eb;font-family:Inter,Arial,sans-serif;font-size:11.5px;line-height:1.55;color:#94a3b8;">Curated daily by {esc(brand)} · Variant {variant_letter.upper()}</td></tr>'
        f'</table></td></tr></table></body></html>'
    )

    # AMP-for-Email body (Gmail renders this; other clients fall back to HTML).
    p_dict = profile["palette"]
    css = (
        f"body{{margin:0;padding:0;font-family:Inter,Arial,sans-serif;background:{p_dict['paper']};color:{p_dict['ink']}}}"
        ".wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden}"
        ".bar{padding:24px 36px 8px;font-weight:700;letter-spacing:0.4px}"
        f".pill{{padding:32px 36px 6px;font-size:13px;font-weight:700;letter-spacing:1.6px;color:{p_dict['primary']};text-transform:uppercase}}"
        "h1{padding:6px 36px 16px;font-size:30px;line-height:1.14;font-weight:800;letter-spacing:-0.6px;margin:0}"
        ".copy{padding:0 36px 26px;font-size:16px;line-height:1.6;color:#333}"
        f".cta{{display:inline-block;margin:0 36px 36px;padding:14px 26px;background:{p_dict['primary']};color:#fff;border-radius:12px;text-decoration:none;font-weight:700}}"
        ".foot{padding:18px 36px;border-top:1px solid #e5e7eb;font-size:11.5px;color:#94a3b8}"
    )
    amp = (
        '<!doctype html><html ⚡4email lang="en"><head><meta charset="utf-8">'
        '<script async src="https://cdn.ampproject.org/v0.js"></script>'
        '<style amp4email-boilerplate>body{visibility:hidden}</style>'
        f'<style amp-custom>{css}</style></head><body>'
        f'<div class="wrap">'
        f'<div class="bar">{esc(brand)}</div>'
        f'<amp-img src="{esc(image_url)}" width="600" height="320" layout="responsive" alt=""></amp-img>'
        f'<div class="pill">{esc(kicker)}</div>'
        f'<h1>{esc(headline)}</h1>'
        f'<div class="copy">{body_html}</div>'
        f'<a class="cta" href="{esc(cta_url)}">{esc(cta_label)} →</a>'
        f'<div class="foot">Curated daily by {esc(brand)} · Variant {variant_letter.upper()}</div>'
        f'</div></body></html>'
    )

    return {
        "html_email": {
            "content": html_email,
            "amp_content": amp,
            "subject": subject,
        },
        "whatsapp": {
            "content": template["whatsapp"],
            "subject": None,
        },
        "caption": {
            "content": template["caption"],
            "subject": None,
            "platform": "instagram",
        },
    }


BUSINESSES = {
    # ───────────────────────────────────────────────────────────────────────
    # Date Khaas — Muslim matrimony. Voice: dignified, trust-first, family-aware.
    # Templates capture the existing live "Verified before introduction",
    # "She was waiting, so was he", "Before he meets your wali" patterns.
    # ───────────────────────────────────────────────────────────────────────
    "date-khaas": {
        "id": "40d54b93-ac56-4441-bf23-4803153c551f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "tags_base": ["date-khaas", "daily-drop"],
        "palette": {"primary": "#00361a", "ink": "#0b2417", "paper": "#f6f3ee"},
        "wordmark": "datekhaas.com",
        "cta_url": "https://datekhaas.com/join",
        "cta_label": "Find your match safely",
        "audience": "Muslim singles and their families",
        "voice": "warm, dignified, trust-first",
        "industry_query": "Muslim matrimony app trust",
        "templates": [
            {
                "subject": "Before he meets your wali, we meet our standards",
                "headline": "Every profile is verified — before the introduction ever happens.",
                "kicker": "Verified profiles only",
                "body": "<p>On most matrimony apps, &quot;verified&quot; means a paid badge. On Date Khaas, it means an ID review, a wali invite, and photos that stay blurred until you choose to share them. The introduction happens only after both sides clear our standards.</p>",
                "whatsapp": "Aapke wali se milne se pehle, hum apne standards se milte hain. 💚\n\nDate Khaas pe har profile ID-verified hai, photos blurred-by-default, aur wali invite shuru se support karta hai. Tab introduction hota hai.\n\n→ datekhaas.com",
                "caption": "Verified before you're ever introduced. 💚\n\nID review, wali invite, photo privacy by default. The introduction happens only after both sides clear our standards. That's the difference.\n\n👉 datekhaas.com\n\n#DateKhaas #MuslimMatrimony #VerifiedProfiles #HalalDating",
                "image_kw": "muslim couple wedding portrait",
            },
            {
                "subject": "She was waiting. So was he. Both deserved to meet safely.",
                "headline": "Your photos stay blurred until you choose to share them.",
                "kicker": "Photo privacy by default",
                "body": "<p>Photos blurred by default. Wali invite from day one. Profiles ID-verified before they ever surface in your shortlist. The platform is built around how Muslim families actually decide — not around swipe count.</p>",
                "whatsapp": "Aapki photos blurred rehti hain jab tak aap khud share na karein. 💚\n\nDate Khaas pe wali invite, ID verification, aur profile privacy default settings hain — paid feature nahi.\n\n→ datekhaas.com",
                "caption": "Photo blur by default. Wali invite by default. ID-verified by default. 💚\n\nBecause your privacy and your family's involvement aren't premium features here — they're the foundation.\n\n👉 datekhaas.com\n\n#DateKhaas #HalalMatch #MuslimSingles #FamilyFirst",
                "image_kw": "muslim woman portrait modest",
            },
            {
                "subject": "The one written for you deserves to find you safely",
                "headline": "Halal from intent to nikah.",
                "kicker": "Process you can trust",
                "body": "<p>Every step on Date Khaas is built around qadar and family involvement: photos private by default, wali invite included, profile moderation before anything goes live. From your first hello to your nikah, the process stays halal.</p>",
                "whatsapp": "Jo aapke liye likha gaya hai, woh aap tak surakshit pahunche. 💚\n\nDate Khaas pe har step halal hai — photos private, wali invite, profile moderation. Pehle salaam se nikah tak.\n\n→ datekhaas.com",
                "caption": "Halal from your first salaam to your nikah. 💚\n\nPhotos private by default. Wali invite from day one. Profiles moderated before they ever appear. The qadar finds you, the standards protect you.\n\n👉 datekhaas.com\n\n#DateKhaas #Qadar #Nikah #MuslimMatrimony",
                "image_kw": "muslim family elder daughter",
            },
            {
                "subject": "No swiping. Just sincere matches.",
                "headline": "Built for marriage, not for endless scrolling.",
                "kicker": "Anti-swipe, by design",
                "body": "<p>Date Khaas isn't a swipe app dressed up as matrimony. Every profile that reaches your shortlist has been moderated, the family loop is built into the flow, and you can pause notifications when you're not actively looking. Sincere matches, on your terms.</p>",
                "whatsapp": "Yahan swipe nahi hai — sirf sincere matches hain. 💚\n\nProfile pehle moderate hoti hai, family loop shuru se built-in hai, aur jab aap active nahi ho tab notifications pause kar sakte ho.\n\n→ datekhaas.com",
                "caption": "No swiping. No endless scrolling. Just sincere matches. 💚\n\nProfiles moderated before they reach your shortlist. Family loop built in. Pause when you're not actively looking. The way matrimony was always meant to work.\n\n👉 datekhaas.com\n\n#DateKhaas #SincereMatch #MuslimDating #HalalMatrimony",
                "image_kw": "muslim man portrait beard prayer",
            },
            {
                "subject": "Why families trust Date Khaas before they trust the apps",
                "headline": "Wali-aware from day one.",
                "kicker": "Family-built process",
                "body": "<p>On Date Khaas a wali can be looped in from your very first match. Profiles are reviewed before they surface. Photo sharing is consensual, never automatic. Most matrimony apps bolted on these features after launch — we built around them.</p>",
                "whatsapp": "Family aapke decision mein shuru se shaamil hai. 💚\n\nDate Khaas pe wali invite first match se available hai. Profile moderation first. Photo sharing aap ke control mein.\n\n→ datekhaas.com",
                "caption": "The platform Muslim families wished existed — and now does. 💚\n\nWali invite from match #1. Profile moderation by humans, not just code. Photo sharing only when you choose. This isn't a tweak; it's the foundation.\n\n👉 datekhaas.com\n\n#DateKhaas #Wali #MuslimFamily #Matrimony",
                "image_kw": "muslim family generations home",
            },
            {
                "subject": "What 'verified' actually means here",
                "headline": "ID-verified. Wali-aware. Profile-moderated.",
                "kicker": "Real verification",
                "body": "<p>&quot;Verified&quot; on most apps is a paid badge. On Date Khaas it means a human-reviewed ID document, a wali invite available from day one, and active profile moderation that pulls duplicates, scams, and already-married accounts. The badge isn't sold — it's earned.</p>",
                "whatsapp": "&quot;Verified&quot; ka actual matlab? 💚\n\nID document review, wali invite, active profile moderation. Date Khaas pe verification badge buy nahi hota — earn hota hai.\n\n→ datekhaas.com",
                "caption": "What 'verified' actually means here:\n\n· Human-reviewed ID document\n· Wali invite from day one\n· Active moderation against duplicates and scams\n· Photos private by default\n\nVerification isn't a badge you buy on Date Khaas. It's the floor.\n\n👉 datekhaas.com\n\n#DateKhaas #VerifiedMatch #MuslimMatrimony",
                "image_kw": "muslim couple engagement henna",
            },
        ],
    },

    # ───────────────────────────────────────────────────────────────────────
    # Gifts Gulf — B2B corporate gifting (GCC). Voice: polished, procurement.
    # ───────────────────────────────────────────────────────────────────────
    "gifts-gulf": {
        "id": "aa0f0f0f-a1a7-4f24-bfc4-7fcffe26341f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "tags_base": ["gifts-gulf", "daily-drop"],
        "palette": {"primary": "#00a544", "ink": "#0c2417", "paper": "#f4faf6"},
        "wordmark": "giftsgulf.com",
        "cta_url": "https://giftsgulf.com",
        "cta_label": "Browse the catalogue",
        "audience": "Procurement & marketing teams across the GCC",
        "voice": "polished, B2B",
        "industry_query": "corporate gifting Gulf trends 2026",
        "templates": [
            {
                "subject": "Branded, never generic — the gift catalogue used by 200+ GCC procurement teams",
                "headline": "Corporate gifts that look procured, not picked up.",
                "kicker": "Gulf-region procurement",
                "body": "<p>From Eid hampers to year-end client kits, our catalogue ships to UAE, KSA, Qatar and Kuwait with custom branding turnaround in 5-10 working days. Free mock-ups before you commit. MOQ from 50.</p>",
                "whatsapp": "Corporate gifts that look procured, not picked up. 🎁\n\nUAE, KSA, Qatar, Kuwait — 5-10 day turnaround. Free mock-ups, MOQ from 50. Eid hampers, year-end kits, branded merch.\n\n→ giftsgulf.com",
                "caption": "Branded gifts your procurement team will actually approve. 🎁\n\n· Custom branding, 5-10 day turn\n· Ships across UAE, KSA, Qatar, Kuwait\n· Free mock-ups before commit\n· MOQ from 50\n\n👉 giftsgulf.com\n\n#CorporateGifting #GCC #BrandedMerch #B2BGulf",
                "image_kw": "corporate gift box premium branded",
            },
            {
                "subject": "Recycled rPET bags — bottles, reborn as branded carry",
                "headline": "Sustainability that prints clean on your logo.",
                "kicker": "Eco-rated, GCC-stocked",
                "body": "<p>Our rPET line is made from post-consumer plastic, screen-printed in-house, and certified by independent auditors. The standard tote, drawstring and laptop sleeves are stock-ready; bespoke shapes ship in 12-15 days.</p>",
                "whatsapp": "Recycled rPET bags — bottles, reborn. 🌱\n\nPost-consumer plastic + clean logo print + GCC stock. Totes, drawstrings, laptop sleeves ready. Bespoke in 12-15 days.\n\n→ giftsgulf.com",
                "caption": "Bottles, reborn. Branded. 🌱\n\nRecycled rPET totes, drawstrings, laptop sleeves — post-consumer plastic, certified, screen-printed in-house. GCC-stocked. Bespoke shapes in 12-15 days.\n\n👉 giftsgulf.com\n\n#rPET #Sustainability #CorporateGifting #GCC",
                "image_kw": "recycled bag rPET branded sustainable",
            },
            {
                "subject": "Drinkware that survives Gulf summers — and on-camera shoots",
                "headline": "Premium drinkware your team will actually use.",
                "kicker": "Heat-tested, brand-finished",
                "body": "<p>Vacuum bottles, tumblers and travel mugs from leading European OEMs, custom-laser or screen-branded in-house, drop-shipped to your events team or your office. Tested to hold 12+ hours of cold and 6+ hours of hot.</p>",
                "whatsapp": "Premium drinkware — Gulf-summer tested. ☕\n\nVacuum bottles, tumblers, travel mugs. European OEM bodies + in-house laser or screen branding. 12hr cold / 6hr hot.\n\n→ giftsgulf.com",
                "caption": "The drinkware your team will actually carry. ☕\n\nVacuum bottles, tumblers, travel mugs — European OEM, in-house brand finishing, tested 12hr cold / 6hr hot. Survives Dubai summers and corporate film shoots.\n\n👉 giftsgulf.com\n\n#PremiumDrinkware #CorporateGifts #BrandedMerch",
                "image_kw": "premium vacuum bottle branded gift",
            },
            {
                "subject": "Year-end gifting — what your procurement deadline looks like",
                "headline": "December gifting is decided in October. Start now.",
                "kicker": "Plan-ahead window",
                "body": "<p>For December delivery across the GCC, mock-ups close mid-October, sample sign-off in early November, production in mid-November, ship by early December. Slots fill quickly — secure yours with a discovery call.</p>",
                "whatsapp": "December gifting starts in October. 📅\n\nMock-ups → mid-Oct. Sign-off → early Nov. Production → mid-Nov. Ship → early Dec. Slots fill fast across the GCC.\n\n→ giftsgulf.com",
                "caption": "Your December gifting deadline starts now. 📅\n\nMock-ups Oct · Sign-off Nov · Ship early Dec. The GCC slots fill faster than people expect every year. Book your discovery call.\n\n👉 giftsgulf.com\n\n#CorporateGifting #YearEnd #GCC #B2B",
                "image_kw": "corporate gift box ribbon premium",
            },
            {
                "subject": "Tech merch your engineers will actually keep",
                "headline": "Branded tech that doesn't end up in a drawer.",
                "kicker": "Tested by real users",
                "body": "<p>Premium-grade powerbanks, USB-C hubs, magnetic chargers, and wireless earbuds — branded in-house, MOQ from 50, ships to UAE/KSA/Qatar/Kuwait. Built to a spec your tech team will actually defend.</p>",
                "whatsapp": "Branded tech your engineers will actually keep. 💻\n\nPremium powerbanks, USB-C hubs, magnetic chargers, wireless earbuds. MOQ from 50, ships across GCC.\n\n→ giftsgulf.com",
                "caption": "Tech merch your team won't quietly bin. 💻\n\nPowerbanks, USB-C hubs, wireless earbuds, magnetic chargers — premium spec, in-house brand finishing, MOQ from 50.\n\n👉 giftsgulf.com\n\n#TechMerch #BrandedTech #CorporateGifting",
                "image_kw": "branded powerbank tech gift premium",
            },
            {
                "subject": "Eid corporate gifting — the catalogue procurement teams already book",
                "headline": "Eid gifting, done with the dignity your brand asks for.",
                "kicker": "Eid hamper catalogue",
                "body": "<p>Dates, attar, ma'amoul and signature kit hampers — designed to be opened in a procurement boardroom or a family home with equal grace. Custom branding on the outer kit and inner cards, MOQ from 25, GCC-wide delivery.</p>",
                "whatsapp": "Eid gifting with the dignity your brand asks for. 🌙\n\nDates, attar, ma'amoul, signature hampers. Brand the outer kit + inner cards. MOQ 25, GCC delivery.\n\n→ giftsgulf.com",
                "caption": "Eid hampers your procurement team approves and your clients actually treasure. 🌙\n\nDates, attar, ma'amoul, signature kits — branded outer + inner, MOQ 25, GCC-wide delivery.\n\n👉 giftsgulf.com\n\n#EidGifting #CorporateEid #GCC #BrandedHampers",
                "image_kw": "eid corporate hamper dates premium",
            },
        ],
    },

    # ───────────────────────────────────────────────────────────────────────
    # Hudace — multi-product SaaS holding. Voice: confident, plain-English.
    # ───────────────────────────────────────────────────────────────────────
    "hudace": {
        "id": "7ab57d94-9f43-40e4-b6a0-1ca6575ce24c",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "tags_base": ["hudace", "daily-drop"],
        "palette": {"primary": "#00361a", "ink": "#0c2417", "paper": "#f4f7f5"},
        "wordmark": "hudace.com",
        "cta_url": "https://hudace.com",
        "cta_label": "See the products",
        "audience": "Founders & operators",
        "voice": "confident, plain-English",
        "industry_query": "vertical SaaS India growth",
        "templates": [
            {
                "subject": "SchoolOS — the school ERP your office staff will actually finish onboarding",
                "headline": "School ERP that doesn't take a year to roll out.",
                "kicker": "SchoolOS by Hudace",
                "body": "<p>Fees, attendance, exams, timetables, parent comms — one system, deployed in days not quarters, priced for Indian K-12 budgets. Teachers stay on familiar workflows; admin gets the dashboards. No SI required.</p>",
                "whatsapp": "School ERP that finishes onboarding. 🏫\n\nFees, attendance, exams, timetables, parent comms. Days not quarters. Indian K-12 pricing. No SI needed.\n\n→ hudace.com",
                "caption": "Most school ERPs take a year. SchoolOS takes a week. 🏫\n\nFees · Attendance · Exams · Timetables · Parent comms. One system, days to deploy, priced for Indian K-12.\n\n👉 hudace.com\n\n#SchoolOS #EdTech #SaaSIndia",
                "image_kw": "indian school classroom students",
            },
            {
                "subject": "Consumer-products ERP — built by people who've shipped consumer brands",
                "headline": "ERP for D2C and consumer brands that doesn't fight you.",
                "kicker": "Consumer ERP",
                "body": "<p>SKUs, batches, expiry, channel-wise margin, distributor reconciliation, Amazon + Flipkart + Zepto + Blinkit settlement — built for Indian D2C and FMCG, not bolted on top of accounting software.</p>",
                "whatsapp": "ERP for D2C/FMCG that doesn't fight you. 📦\n\nSKUs, batches, expiry, channel margin, distributor recon, Amazon/Flipkart/Zepto/Blinkit settlement. Built for India.\n\n→ hudace.com",
                "caption": "If your ERP can't tell you the per-channel margin on this morning's Blinkit batch, it's not really an ERP. 📦\n\nHudace Consumer ERP — built for Indian D2C and FMCG founders. Settlement-aware. Channel-aware. India-aware.\n\n👉 hudace.com\n\n#ConsumerERP #D2CIndia #SaaSIndia",
                "image_kw": "warehouse inventory consumer products india",
            },
            {
                "subject": "Vertical SaaS, India-priced — the playbook for the next 10 years",
                "headline": "Built native. Priced Indian. Sold direct.",
                "kicker": "Hudace product family",
                "body": "<p>Hudace's products share three rules: native to the vertical they serve, priced for Indian SMBs (not US enterprise), and sold by people who've operated the businesses they're selling into. No re-skinned global product. No founder-tax pricing.</p>",
                "whatsapp": "Vertical SaaS, Indian-priced, sold direct. 🚀\n\nNative to the vertical. Priced for Indian SMBs. Built by operators, not platform thinkers.\n\n→ hudace.com",
                "caption": "Three rules every Hudace product follows:\n\n· Native to the vertical (not a re-skin)\n· Priced for Indian SMBs (not US enterprise)\n· Sold by operators (not platform thinkers)\n\nThat's the next 10 years of SaaS in India. 🚀\n\n👉 hudace.com\n\n#VerticalSaaS #SaaSIndia #BuildInIndia",
                "image_kw": "indian saas startup team office",
            },
            {
                "subject": "Why your last ERP rollout failed — and what to do instead",
                "headline": "Most ERP rollouts fail at month 3. Here's why.",
                "kicker": "Operator playbook",
                "body": "<p>ERPs fail when they ask the business to bend to the software. Hudace ships short workflows that match how Indian SMBs actually work — and refuses to ship features that need a 6-month consulting engagement to enable. Software should fit the operator, not the other way around.</p>",
                "whatsapp": "ERP rollouts fail when the software refuses to bend. 🛠️\n\nHudace ships short workflows + refuses 6-month consulting features. Software fits the operator.\n\n→ hudace.com",
                "caption": "Most ERP rollouts fail at month 3 — when the business is asked to bend to the software instead of the other way around. 🛠️\n\nHudace ships short workflows that match how Indian SMBs already work. Software fits the operator.\n\n👉 hudace.com\n\n#ERP #SaaSIndia #OperatorTools",
                "image_kw": "indian sme office team computer",
            },
            {
                "subject": "The features Hudace refuses to ship",
                "headline": "We say no a lot. Here's why founders thank us for it.",
                "kicker": "Product principle",
                "body": "<p>No AI-everything bloat. No quarterly pricing surprises. No &quot;contact sales&quot; gates on basic exports. No 90-day onboarding that depends on a partner SI. The features we don't ship are the reason our customers actually use the ones we do.</p>",
                "whatsapp": "The features Hudace refuses to ship. 🚫\n\nNo AI-everything bloat. No quarterly price hikes. No &quot;contact sales&quot; gates on exports. No SI-dependent onboarding.\n\n→ hudace.com",
                "caption": "The features we DON'T ship are the reason customers actually use the ones we do. 🚫\n\n· No AI-everything bloat\n· No quarterly pricing surprises\n· No 'contact sales' walls on exports\n· No SI-dependent onboarding\n\n👉 hudace.com\n\n#SaaSIndia #ProductPrinciples",
                "image_kw": "minimal saas dashboard product",
            },
        ],
    },

    # ───────────────────────────────────────────────────────────────────────
    # Via Kashmir Itinerary — B2B travel-agent SaaS. Voice: warm, market-aware.
    # ───────────────────────────────────────────────────────────────────────
    "via-kashmir-itinerary": {
        "id": "09cd7aef-81c3-4440-854f-5861d3cdca3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "tags_base": ["via-kashmir-itinerary", "daily-drop"],
        "palette": {"primary": "#0e3d2f", "ink": "#0b2920", "paper": "#f1f6f3"},
        "wordmark": "viakashmir.com",
        "cta_url": "https://viakashmir.com",
        "cta_label": "Try the itinerary builder",
        "audience": "Travel agents & tour operators",
        "voice": "warm, market-aware",
        "industry_query": "travel agent itinerary tool India 2026",
        "templates": [
            {
                "subject": "Build any client itinerary in two minutes — branded as yours",
                "headline": "Two minutes from inquiry to a quote that looks like your brand.",
                "kicker": "For travel agents",
                "body": "<p>Drag-drop days, swap hotels with live rates, add transfers, brand the PDF with your logo and contact, send. Your client sees your name — not ours. Built for Indian, Saudi, Kashmir and Dubai-bound clients.</p>",
                "whatsapp": "2 min se inquiry se branded quote tak. ✈️\n\nDays drag-drop, hotels live rates, branded PDF, aapka logo, aapka contact. Client aapka naam dekhega.\n\n→ viakashmir.com",
                "caption": "From inquiry to a quote that looks like your brand — two minutes. ✈️\n\nDrag-drop days. Live hotel rates. Your logo on the PDF. Built for the Indian, Saudi, Kashmir, and Dubai markets.\n\n👉 viakashmir.com\n\n#TravelAgents #ItineraryBuilder #B2BTravel",
                "image_kw": "kashmir mountains tourism scenic",
            },
            {
                "subject": "The Kashmir package you quote every week — already built",
                "headline": "The Kashmir 6N7D you re-quote each week is pre-built in here.",
                "kicker": "Pre-built packages",
                "body": "<p>Srinagar arrival, Pahalgam two nights, Gulmarg gondola, Sonmarg day trip, Srinagar back. Pre-built with margin built in. Swap hotels, change duration, change client name, send. Stop typing the same itinerary every Monday.</p>",
                "whatsapp": "Kashmir 6N7D jo aap har hafte type karte ho — pre-built hai. ⛰️\n\nSrinagar → Pahalgam → Gulmarg → Sonmarg → Srinagar. Margin built-in. Hotels swap karo, send karo.\n\n→ viakashmir.com",
                "caption": "Stop typing the same Kashmir 6N7D every Monday. ⛰️\n\nIt's pre-built in Via Kashmir — Srinagar → Pahalgam → Gulmarg → Sonmarg, margin baked in. Swap hotels, change client, send.\n\n👉 viakashmir.com\n\n#KashmirTravel #TourOperators #ItineraryBuilder",
                "image_kw": "pahalgam gulmarg snow kashmir",
            },
            {
                "subject": "Send a quote that looks like your brand, not ours",
                "headline": "Your logo. Your colours. Your contact. Our engine.",
                "kicker": "White-label PDF",
                "body": "<p>Every itinerary PDF Via Kashmir generates is fully white-labelled — your logo at the top, your colours in the header bands, your contact details in the footer. The client never sees us. They see you, looking sharper than your competition.</p>",
                "whatsapp": "Aapka logo. Aapka colour. Aapka contact. Hamara engine. 📄\n\nVia Kashmir ka har PDF white-labelled hai — client aapka naam dekhega, hamara nahi.\n\n→ viakashmir.com",
                "caption": "Your client should see your brand on the quote — not ours. 📄\n\nFully white-labelled itinerary PDFs. Your logo, your colours, your contact info. Our engine. Their experience? You, looking like a premium operator.\n\n👉 viakashmir.com\n\n#WhiteLabel #TravelAgents #B2BTravel",
                "image_kw": "travel agent office laptop quote",
            },
            {
                "subject": "Saudi and Dubai inbound — the itineraries Indian agents quote most",
                "headline": "GCC inbound packages — built for the way Indian agents actually sell.",
                "kicker": "Saudi · Dubai · GCC",
                "body": "<p>Umrah-extension packages, family Dubai 4N5D, KSA cultural-tour week. Pre-built itineraries with hotel inventory, transfers, day-trip add-ons. Quote in the client's currency, see margin in INR.</p>",
                "whatsapp": "Saudi + Dubai inbound — pre-built. 🕋\n\nUmrah-extension, family Dubai 4N5D, KSA cultural-tour. Hotel inventory + transfers. Quote in client currency, margin in INR.\n\n→ viakashmir.com",
                "caption": "GCC inbound, built for Indian agents. 🕋\n\nUmrah-extension packages. Family Dubai 4N5D. KSA cultural week. Pre-built itineraries, hotel inventory, quote in client currency, see your margin in INR.\n\n👉 viakashmir.com\n\n#GCCTravel #UmrahPackages #DubaiTravel #IndianAgents",
                "image_kw": "dubai skyline marina tourism",
            },
            {
                "subject": "Why your inquiry-to-quote ratio drops in season",
                "headline": "Slow quotes lose 30% of inquiries in season. Speed wins.",
                "kicker": "Agent playbook",
                "body": "<p>In peak season, the agent who sends a polished branded quote in the first hour wins the booking. Via Kashmir cuts your inquiry-to-quote time from 40 min to under 5 — without compromising on the polish your clients pay for.</p>",
                "whatsapp": "Slow quote = lost booking in season. ⏱️\n\nVia Kashmir = 40 min → 5 min. Polish intact, client wins.\n\n→ viakashmir.com",
                "caption": "Peak season truth: the agent who sends the polished quote first wins. ⏱️\n\nVia Kashmir cuts inquiry-to-quote from 40 minutes to under 5 — without dropping the polish your clients pay for.\n\n👉 viakashmir.com\n\n#TravelAgents #PeakSeason #B2BTravel",
                "image_kw": "travel agent phone laptop busy",
            },
        ],
    },

    # ───────────────────────────────────────────────────────────────────────
    # Collab Market — creator/influencer recruitment. Voice: peer-to-peer casual.
    # ───────────────────────────────────────────────────────────────────────
    "collab-market": {
        "id": "bb716234-9b5d-4a97-81d0-d501bd1b6a3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "tags_base": ["collab-market", "daily-drop", "creator-recruitment"],
        "palette": {"primary": "#0891b2", "ink": "#0b2c34", "paper": "#f3f8fa"},
        "wordmark": "collabmarket.in",
        "cta_url": "https://collabmarket.in",
        "cta_label": "Get booked & paid",
        "audience": "Creators & brands",
        "voice": "casual, peer-to-peer",
        "industry_query": "creator economy India brand collaborations",
        "templates": [
            {
                "subject": "Stop pitching brands in the DMs — let them book you",
                "headline": "Brands find you. Not the other way around.",
                "kicker": "Get booked, not pitched",
                "body": "<p>Set your rate. Set your niche. Set your availability. Brands search Collab Market the way they search for any service — and book you direct. No agency cut. No 'do it for exposure' DMs. Payment cleared through the platform.</p>",
                "whatsapp": "Brand ke DMs mein pitch karna band karo. 📣\n\nCollab Market pe rate set karo, niche set karo, availability set karo — brand khud book karega. Agency cut nahi, payment platform se.\n\n→ collabmarket.in",
                "caption": "Stop pitching brands in the DMs. Let them book you. 📣\n\nSet your rate. Set your niche. Set your availability. Brands search Collab Market for creators like you and book direct. No agency cut. Payment cleared through us.\n\n👉 collabmarket.in\n\n#CreatorEconomy #InfluencerMarketing #IndiaCreators #GetPaid",
                "image_kw": "content creator phone studio ring light",
            },
            {
                "subject": "Your rate. Their search. Our payment escrow.",
                "headline": "The creator marketplace that pays you on delivery.",
                "kicker": "Payment-protected",
                "body": "<p>Brands fund the brief upfront. You deliver. We release. No more chasing invoices, no more 'we'll process next month'. Payment timeline is the platform's job — not yours.</p>",
                "whatsapp": "Brand pehle fund karta hai. Aap deliver karte ho. Hum release karte hain. 💰\n\nInvoice chase nahi karna. Payment platform ki zimmedari hai, aapki nahi.\n\n→ collabmarket.in",
                "caption": "The creator marketplace where payment is the platform's job, not yours. 💰\n\nBrand funds the brief upfront → you deliver → we release. No chasing invoices. No 'next month' delays.\n\n👉 collabmarket.in\n\n#CreatorPay #BrandDeals #IndianCreators",
                "image_kw": "creator phone money payment laptop",
            },
            {
                "subject": "Brands — book vetted creators in 24 hours, not 2 weeks",
                "headline": "Vetted creators. Real engagement. 24-hour turnaround.",
                "kicker": "For brand teams",
                "body": "<p>Skip the agency middlemen and the engagement-fraud Excel sheets. Every creator on Collab Market is metrics-verified, brand-safety-screened, and bookable in minutes. Brief them, fund the escrow, sign off on delivery. Done.</p>",
                "whatsapp": "Brands: 24-hour creator booking, vetted, no middlemen. 🎬\n\nMetrics-verified. Brand-safety screened. Brief → fund → deliver → sign-off.\n\n→ collabmarket.in",
                "caption": "Brands — book vetted creators in 24 hours. 🎬\n\nNo agency middleman. No engagement-fraud spreadsheets. Every creator metrics-verified + brand-safety screened. Brief, fund escrow, sign off delivery.\n\n👉 collabmarket.in\n\n#InfluencerMarketing #BrandTeams #IndiaCreators",
                "image_kw": "brand marketing team laptop creators",
            },
            {
                "subject": "What 'verified' means for a creator on Collab Market",
                "headline": "Real reach, not bot followers.",
                "kicker": "Engagement-verified",
                "body": "<p>Follower counts lie. We verify engagement rate, audience geography, and audience age band — for every creator, before they ever appear in a brand's search. Brands book confidence. Creators get fair rates.</p>",
                "whatsapp": "Follower counts jhoot bolte hain. Engagement, audience geography, age band — sab verified. 📊\n\nBrand confidence book karte hain. Creator fair rate paate hain.\n\n→ collabmarket.in",
                "caption": "Follower counts lie. We verify engagement — every creator, every time. 📊\n\n· Engagement rate audit\n· Audience geography check\n· Age-band breakdown\n· Bot-follower screening\n\nBrands book confidence. Creators get fair rates.\n\n👉 collabmarket.in\n\n#CreatorEconomy #VerifiedCreators #FairPay",
                "image_kw": "social media analytics creator dashboard",
            },
            {
                "subject": "The brief format brands wish creators would send",
                "headline": "Your portfolio, your rate card, in one share-link.",
                "kicker": "Creator profile = pitch deck",
                "body": "<p>Your Collab Market profile IS your pitch deck — reel samples, engagement metrics, rate card, brand-safety badges, all in one share-link. Send it once. Brands keep coming back. Pitching individually becomes optional.</p>",
                "whatsapp": "Aapki profile hi aapki pitch deck hai. 🎯\n\nReels + metrics + rate card + brand-safety badges — sab ek share-link mein.\n\n→ collabmarket.in",
                "caption": "Your Collab Market profile IS your pitch deck. 🎯\n\nReel samples · Engagement metrics · Rate card · Brand-safety badges — all in one share-link. Send once. Brands keep coming back.\n\n👉 collabmarket.in\n\n#CreatorTools #InfluencerMarketing #PitchDeck",
                "image_kw": "creator phone reels portfolio video",
            },
        ],
    },
}


# ─── Per-business orchestrator with A/B variants ───────────────────────────
def run_business(slug: str, *, date_s: str, dry_run: bool = False) -> dict:
    if slug not in BUSINESSES:
        return {"slug": slug, "error": "unknown_business"}
    profile = BUSINESSES[slug]
    biz_id = profile["id"]
    ws_id = profile["workspace"]
    templates = profile["templates"]
    if len(templates) < 2:
        return {"slug": slug, "error": "need_at_least_2_templates"}

    # Day-of-year rotation. Pick two DIFFERENT template indexes for A vs B.
    day_n = dt.date.fromisoformat(date_s).timetuple().tm_yday
    idx_a = day_n % len(templates)
    idx_b = (day_n + 1) % len(templates)
    if idx_b == idx_a:
        idx_b = (idx_b + 1) % len(templates)
    tpl_a = templates[idx_a]
    tpl_b = templates[idx_b]

    print(f"[{slug}] Variant A → '{tpl_a['subject'][:60]}'")
    print(f"[{slug}] Variant B → '{tpl_b['subject'][:60]}'")

    # Fetch one industry-signal news item (footer only, never the headline).
    news = google_news_one(profile.get("industry_query", slug))
    if news:
        print(f"[{slug}] industry signal: {news['title'][:70]}")

    inserted_titles, skipped_titles = [], []
    ab_test_tag = f"ab-test:{slug}:{date_s}"

    for variant_letter, tpl in [("a", tpl_a), ("b", tpl_b)]:
        image_url = pick_image([tpl["image_kw"]])
        print(f"[{slug}] V{variant_letter.upper()} image: {image_url[:90]}")
        channels = _channels_for(profile, tpl, image_url, news, variant_letter)

        for channel, payload_extra in channels.items():
            title = f"[{date_s}] {profile['wordmark']} · {channel} · V{variant_letter.upper()} · {tpl['subject'][:80]}"
            # Idempotency: skip if exact title exists.
            status, existing = rest(
                "GET",
                f"/content_assets?business_id=eq.{biz_id}&title=eq.{urllib.parse.quote(title)}&select=id",
            )
            if isinstance(existing, list) and existing:
                skipped_titles.append(title)
                continue

            row = {
                "id": str(uuid.uuid4()),
                "workspace_id": ws_id,
                "business_id": biz_id,
                "title": title,
                "type": channel,
                "content": payload_extra["content"],
                "subject": payload_extra.get("subject"),
                "platform": payload_extra.get("platform"),
                "tags": list(profile["tags_base"]) + [
                    date_s, channel, "auto-generated",
                    f"variant:{variant_letter}", ab_test_tag,
                ],
                "amp_content": payload_extra.get("amp_content"),
                "image_url": image_url,
                "notes": json.dumps({
                    "generated_by": "content_daily_routine_v2",
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "template_idx": idx_a if variant_letter == "a" else idx_b,
                    "template_subject": tpl["subject"],
                    "variant": variant_letter,
                    "ab_test_id": f"{slug}:{date_s}",
                    "industry_signal": news,
                })[:8000],
            }

            if dry_run:
                inserted_titles.append(title)
                print(f"  [DRY] would insert {title}")
                continue

            status, body = rest("POST", "/content_assets", row)
            if status in (200, 201):
                inserted_titles.append(title)
                print(f"  ✓ {title}")
            else:
                print(f"  ✗ {title} → {status} {str(body)[:160]}", file=sys.stderr)

    return {
        "slug": slug,
        "ab_test_id": f"{slug}:{date_s}",
        "variant_a_subject": tpl_a["subject"],
        "variant_b_subject": tpl_b["subject"],
        "industry_signal": news.get("url") if news else None,
        "inserted": len(inserted_titles),
        "skipped": len(skipped_titles),
    }


# ─── CLI ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--business")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.all and not args.business:
        ap.error("Pass --all or --business <slug>")

    targets = sorted(BUSINESSES.keys()) if args.all else [args.business]
    bad = [s for s in targets if s not in BUSINESSES]
    if bad:
        ap.error(f"Unknown: {bad}. Known: {sorted(BUSINESSES.keys())}")

    report = {"date": args.date, "results": []}
    for slug in targets:
        try:
            r = run_business(slug, date_s=args.date, dry_run=args.dry_run)
        except Exception as e:  # noqa: BLE001
            r = {"slug": slug, "error": str(e)[:300]}
        report["results"].append(r)
        time.sleep(1.0)

    print(json.dumps(report, indent=2))
    return 1 if any("error" in r for r in report["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
