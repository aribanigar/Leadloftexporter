#!/usr/bin/env python3
"""
content_daily_routine.py — v3 LITERAL-CLONE Content Hub refresh + text A/B.

v2 mistake: I built generic templates that overrode each business's
distinctive visual identity (Date Khaas gold-on-dark-green serif; Gifts
Gulf Arial product-card grid with midocean.com CDN photos; etc.). User
called this out: "you messed content everywhere. check in all areas how
content was coming in 22 june and accordingly keep it".

v3 corrects this by treating each business's June 22 asset as the
LITERAL template:

  scripts/templates/<slug>_email.json   — full row (content, amp_content,
                                          image_url, tags), kept verbatim
  scripts/templates/<slug>_whatsapp.txt — WhatsApp body, kept verbatim
  scripts/templates/<slug>_caption.txt  — Caption body, kept verbatim

For each daily run we DO NOT regenerate the HTML structure. We:
  1. Load the canonical template payload for the business.
  2. Pick two different "copy variants" per business (Variant A + B).
  3. Substitute ONLY the swappable copy slots (subject + headline +
     body lines) into the literal HTML — every other byte of the
     template is preserved exactly as June 22 shipped.
  4. Tag with ab-test:<slug>:<date> + variant:a / variant:b for A/B
     comparison.
  5. Image_url either stays as the template's (it's already a working
     CDN URL) or is refreshed via Pixabay/Unsplash if the template's
     was a placeholder.

No new integrations changed. Cron + workflow + Supabase REST path stay
the same. ZERO LLM. Stdlib only.
"""
from __future__ import annotations

import argparse, datetime as dt, json, os, re, sys, time, urllib.parse, urllib.request, urllib.error, uuid, xml.etree.ElementTree as ET
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


UA = "Mozilla/5.0 (LeadCaptura ContentRoutine/3.0)"


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


# ─── Per-business config — only the swappable COPY, no structure ──────────
#
# Each `copy_variants` is a list of pure-text payloads:
#   subject  — email subject line (replaces the canonical's subject)
#   headline — display headline text (replaces the canonical's <h1>)
#   body_lines — list of paragraph strings (replaces the canonical's <p> body)
#   whatsapp — full WhatsApp message text (replaces canonical whatsapp body)
#   caption  — full caption text (replaces canonical caption body)
#
# The canonical HTML structure / CSS / image_url all stay verbatim.

BUSINESSES = {
    # ───────────────────────── Gifts Gulf ─────────────────────────
    "gifts-gulf": {
        "id": "aa0f0f0f-a1a7-4f24-bfc4-7fcffe26341f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "template_file": "scripts/templates/gifts_gulf_email.json",
        "whatsapp_file": "scripts/templates/gifts-gulf_whatsapp.txt",
        "caption_file": "scripts/templates/gifts-gulf_caption.txt",
        "tags_base": ["gifts-gulf", "daily-drop"],
        "industry_query": "corporate gifting Gulf trends 2026",
        "copy_variants": [
            {
                "subject": "Steel that sticks around",
                "headline": "Steel bottles made for daily carry.",
                "body": "Vacuum steel bottles and tumblers, branded for the everyday.",
                "kicker": "Premium drinkware",
                "whatsapp": "Vacuum steel drinkware, branded to your spec. Free mock-ups before you commit, 5-10 day GCC turnaround, MOQ from 50. Tested 12hr cold / 6hr hot.\n\nFull catalogue → https://www.giftsgulf.com",
                "caption": "Branded vacuum-steel drinkware your team will actually carry.\n\n· European OEM bodies\n· In-house brand finishing\n· 12hr cold / 6hr hot\n· MOQ from 50, ships across GCC\n\nFree mock-ups before you commit → giftsgulf.com\n\n#CorporateGifting #PremiumDrinkware #GCC #BrandedMerch",
            },
            {
                "subject": "Bottles, reborn as branded carry",
                "headline": "rPET totes from post-consumer plastic.",
                "body": "Recycled rPET bags screen-printed in-house, MOQ from 50, GCC-stocked.",
                "kicker": "Eco and sustainable",
                "whatsapp": "Recycled rPET totes, drawstrings, and laptop sleeves — branded for your brand, certified, GCC-stocked. Bespoke shapes in 12-15 days.\n\nFull catalogue → https://www.giftsgulf.com",
                "caption": "Bottles, reborn. Branded. 🌱\n\nRecycled rPET totes · drawstrings · laptop sleeves. Post-consumer plastic, screen-printed in-house, GCC-stocked. Bespoke in 12-15 days.\n\n→ giftsgulf.com\n\n#rPET #Sustainability #CorporateGifting #GCC",
            },
            {
                "subject": "Branded to your spec, free mock-up before you commit",
                "headline": "The corporate gift catalogue procurement teams already book from.",
                "body": "Eid hampers, year-end client kits, exec onboarding sets — branded for your brand, MOQ from 25, ships across UAE, KSA, Qatar, Kuwait.",
                "kicker": "Corporate gifting · GCC",
                "whatsapp": "Eid hampers, year-end kits, exec onboarding sets — branded for your brand. MOQ from 25, free mock-ups, ships GCC-wide in 5-10 days.\n\nFull catalogue → https://www.giftsgulf.com",
                "caption": "The corporate gift catalogue procurement teams already book from. 🎁\n\n· Custom branding 5-10 day turn\n· Ships UAE / KSA / Qatar / Kuwait\n· Free mock-ups before commit\n· MOQ from 25\n\n→ giftsgulf.com\n\n#CorporateGifting #GCC #B2BGulf",
            },
            {
                "subject": "Tech merch your engineers will actually keep",
                "headline": "Premium powerbanks, USB-C hubs, branded earbuds.",
                "body": "Tech gifts to a spec your engineers will defend — premium powerbanks, USB-C hubs, magnetic chargers, wireless earbuds. MOQ from 50, GCC-wide delivery.",
                "kicker": "Branded tech",
                "whatsapp": "Tech merch your engineers won't bin: premium powerbanks, USB-C hubs, magnetic chargers, wireless earbuds. MOQ from 50, GCC delivery.\n\nFull catalogue → https://www.giftsgulf.com",
                "caption": "Tech merch your team won't quietly bin. 💻\n\nPowerbanks · USB-C hubs · wireless earbuds · magnetic chargers — premium spec, in-house brand finishing, MOQ from 50.\n\n→ giftsgulf.com\n\n#TechMerch #BrandedTech #CorporateGifting",
            },
            {
                "subject": "Your year-end gifting deadline starts now",
                "headline": "December gifting is decided in October.",
                "body": "Mock-ups close mid-October. Sample sign-off early November. Production mid-November. Ship by early December. GCC slots fill quickly every year.",
                "kicker": "Year-end window",
                "whatsapp": "December gifting starts in October. Mock-ups → mid-Oct. Sign-off → early Nov. Production → mid-Nov. Ship → early Dec. GCC slots fill fast.\n\nBook a call → https://www.giftsgulf.com",
                "caption": "Your December gifting deadline starts now. 📅\n\nMock-ups Oct · Sign-off Nov · Ship early Dec. GCC slots fill faster than people expect every year.\n\n→ giftsgulf.com\n\n#CorporateGifting #YearEnd #GCC #B2B",
            },
        ],
    },

    # ───────────────────────── Date Khaas ─────────────────────────
    "date-khaas": {
        "id": "40d54b93-ac56-4441-bf23-4803153c551f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "template_file": "scripts/templates/date_khaas_email.json",
        "whatsapp_file": "scripts/templates/date-khaas_whatsapp.txt",
        "caption_file": None,  # Date Khaas had no caption sample
        "tags_base": ["date-khaas", "daily-drop"],
        "industry_query": "Muslim matrimony app trust",
        "copy_variants": [
            {
                "subject": "She was waiting. So was he. Both deserved to meet safely.",
                "headline": "She was waiting. So was he. Both deserved to meet safely.",
                "body": "At Date Khaas, every profile is reviewed before any introduction is ever made. Your photos stay blurred until you decide otherwise. And your family can be part of this from the very first moment.|Because the road to nikah should feel like hope — not anxiety.",
                "kicker": "✓ VERIFIED PROFILES ONLY",
                "whatsapp": "Assalamu alaikum 🌙\n\nDate Khaas isn't another app. It's how Muslim families have always made introductions — but in your pocket.\n\n· Every profile reviewed before it appears\n· Photos blurred until you choose to share\n· Wali invite available from match #1\n· No swiping. No DMs. No pressure.\n\nThe road to nikah should feel like hope, not anxiety.\n\nStart safely → datekhaas.com/signup",
                "caption": "Where the journey to your soulmate begins with barakah. 💚\n\n· Verified profiles only\n· Photo privacy by default\n· Wali invite from day one\n· No swiping, no chasing\n\n👉 datekhaas.com\n\n#DateKhaas #MuslimMatrimony #HalalMatch #Nikah",
            },
            {
                "subject": "Before he meets your wali, we meet our standards",
                "headline": "Every profile is verified — before the introduction ever happens.",
                "body": "On most matrimony apps, &quot;verified&quot; means a paid badge. On Date Khaas, it means an ID review, a wali invite, and photos that stay blurred until you choose to share them.|The introduction happens only after both sides clear our standards.",
                "kicker": "✓ VERIFIED PROFILES ONLY",
                "whatsapp": "Assalamu alaikum 🌙\n\nOn most apps, 'verified' is a paid badge. On Date Khaas, it means:\n\n· Human ID review\n· Wali invite from match #1\n· Photo privacy by default\n· Profiles moderated before they ever surface\n\nThe introduction only happens after both sides clear our standards.\n\nStart safely → datekhaas.com/signup",
                "caption": "What 'verified' actually means here. 💚\n\n· Human-reviewed ID document\n· Wali invite from day one\n· Active moderation against duplicates and scams\n· Photos private by default\n\nVerification isn't a badge you buy on Date Khaas. It's the floor.\n\n👉 datekhaas.com\n\n#DateKhaas #VerifiedMatch #MuslimMatrimony",
            },
            {
                "subject": "The one written for you deserves to find you safely",
                "headline": "Halal from intent to nikah.",
                "body": "Every step on Date Khaas is built around qadar and family involvement: photos private by default, wali invite included, profile moderation before anything goes live.|From your first salaam to your nikah, the process stays halal.",
                "kicker": "✓ VERIFIED PROFILES ONLY",
                "whatsapp": "Assalamu alaikum 🌙\n\nQadar finds you. Standards protect you.\n\nOn Date Khaas every step is halal — photos private by default, wali invite from day one, profile moderation before anything goes live.\n\nFrom your first salaam to your nikah.\n\nStart safely → datekhaas.com/signup",
                "caption": "Halal from your first salaam to your nikah. 💚\n\nPhotos private. Wali invite included. Profiles moderated. The qadar finds you, the standards protect you.\n\n👉 datekhaas.com\n\n#DateKhaas #Qadar #Nikah #MuslimMatrimony",
            },
            {
                "subject": "No swiping. Just sincere matches.",
                "headline": "Built for marriage, not for endless scrolling.",
                "body": "Date Khaas isn't a swipe app dressed up as matrimony. Every profile that reaches your shortlist has been moderated. The family loop is built into the flow.|You can pause notifications when you're not actively looking. Sincere matches, on your terms.",
                "kicker": "✓ VERIFIED PROFILES ONLY",
                "whatsapp": "Assalamu alaikum 🌙\n\nNo swiping. No endless scrolling. Just sincere matches.\n\n· Profiles moderated before they reach your shortlist\n· Family loop built in from day one\n· Pause notifications when you're not actively looking\n\nThe way matrimony was always meant to work.\n\nStart safely → datekhaas.com/signup",
                "caption": "No swiping. No endless scrolling. Just sincere matches. 💚\n\nProfiles moderated. Family loop built in. Pause when you're not actively looking. The way matrimony was always meant to work.\n\n👉 datekhaas.com\n\n#DateKhaas #SincereMatch #MuslimDating #HalalMatrimony",
            },
        ],
    },

    # ───────────────────────── Hudace ─────────────────────────
    "hudace": {
        "id": "7ab57d94-9f43-40e4-b6a0-1ca6575ce24c",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "template_file": "scripts/templates/hudace_email.json",
        "whatsapp_file": "scripts/templates/hudace_whatsapp.txt",
        "caption_file": "scripts/templates/hudace_caption.txt",
        "tags_base": ["hudace", "daily-drop"],
        "industry_query": "vertical SaaS India growth",
        "copy_variants": [
            {
                "subject": "SchoolOS School ERP",
                "headline": "School ERP that finishes onboarding.",
                "body": "Fees, attendance, exams, timetables, parent comms — one system, deployed in days not quarters, priced for Indian K-12 budgets.|Teachers stay on familiar workflows; admin gets the dashboards. No SI required.",
                "kicker": "SchoolOS",
                "whatsapp": "SchoolOS — the school ERP that actually finishes onboarding. Fees, attendance, exams, timetables, parent comms. Days not quarters. Built for Indian K-12.\n\n→ hudace.com",
                "caption": "Most school ERPs take a year. SchoolOS takes a week. 🏫\n\n· Fees · Attendance · Exams · Timetables · Parent comms\n· Days to deploy, not quarters\n· Priced for Indian K-12 budgets\n· No SI engagement required\n\n👉 hudace.com\n\n#SchoolOS #EdTech #SaaSIndia",
            },
            {
                "subject": "Consumer Products | ERP Building",
                "headline": "ERP for D2C and consumer brands that doesn't fight you.",
                "body": "SKUs, batches, expiry, channel-wise margin, distributor reconciliation, Amazon + Flipkart + Zepto + Blinkit settlement.|Built for Indian D2C and FMCG, not bolted on top of accounting software.",
                "kicker": "Consumer ERP",
                "whatsapp": "ERP for D2C / FMCG that doesn't fight you. SKUs, batches, expiry, channel margin, distributor recon, Amazon/Flipkart/Zepto/Blinkit settlement. Built for India.\n\n→ hudace.com",
                "caption": "If your ERP can't tell you per-channel margin on this morning's Blinkit batch, it's not really an ERP. 📦\n\nHudace Consumer ERP — built for Indian D2C and FMCG founders. Settlement-aware. Channel-aware. India-aware.\n\n👉 hudace.com\n\n#ConsumerERP #D2CIndia #SaaSIndia",
            },
            {
                "subject": "Vertical SaaS, India-priced",
                "headline": "Built native. Priced Indian. Sold direct.",
                "body": "Three rules every Hudace product follows: native to the vertical it serves, priced for Indian SMBs (not US enterprise), and sold by operators (not platform thinkers).|No re-skinned global product. No founder-tax pricing.",
                "kicker": "Hudace product family",
                "whatsapp": "Three Hudace rules: native to the vertical, priced for Indian SMBs, sold by operators. No re-skinned global product. No founder-tax pricing.\n\n→ hudace.com",
                "caption": "Three rules every Hudace product follows:\n\n· Native to the vertical (not a re-skin)\n· Priced for Indian SMBs (not US enterprise)\n· Sold by operators (not platform thinkers)\n\nThat's the next 10 years of SaaS in India. 🚀\n\n👉 hudace.com\n\n#VerticalSaaS #SaaSIndia #BuildInIndia",
            },
            {
                "subject": "The features Hudace refuses to ship",
                "headline": "We say no a lot. Here's why founders thank us for it.",
                "body": "No AI-everything bloat. No quarterly pricing surprises. No &quot;contact sales&quot; gates on basic exports. No 90-day onboarding that depends on a partner SI.|The features we don't ship are the reason our customers actually use the ones we do.",
                "kicker": "Product principle",
                "whatsapp": "Hudace says no a lot. No AI-everything bloat, no quarterly price hikes, no 'contact sales' gates on exports, no SI-dependent onboarding.\n\nThat's why customers actually use the rest.\n\n→ hudace.com",
                "caption": "The features we DON'T ship are the reason customers actually use the ones we do. 🚫\n\n· No AI-everything bloat\n· No quarterly pricing surprises\n· No 'contact sales' walls on exports\n· No SI-dependent onboarding\n\n👉 hudace.com\n\n#SaaSIndia #ProductPrinciples",
            },
        ],
    },

    # ───────────────────────── Via Kashmir Itinerary ─────────────────────────
    "via-kashmir-itinerary": {
        "id": "09cd7aef-81c3-4440-854f-5861d3cdca3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "template_file": "scripts/templates/via_kashmir_email.json",
        "whatsapp_file": "scripts/templates/via-kashmir_whatsapp.txt",
        "caption_file": "scripts/templates/via-kashmir_caption.txt",
        "tags_base": ["via-kashmir-itinerary", "daily-drop"],
        "industry_query": "travel agent itinerary tool India 2026",
        "copy_variants": [
            {
                "subject": "The Kashmir package you quote every week",
                "headline": "The Kashmir 6N7D you re-quote each week is pre-built in here.",
                "body": "Srinagar arrival, Pahalgam two nights, Gulmarg gondola, Sonmarg day trip, Srinagar back. Margin built in.|Swap hotels, change duration, change client name, send. Stop typing the same itinerary every Monday.",
                "kicker": "Pre-built packages",
                "whatsapp": "Kashmir 6N7D pre-built. Srinagar → Pahalgam → Gulmarg → Sonmarg → Srinagar. Margin in. Hotels swap karo, send karo.\n\n→ viakashmir.com",
                "caption": "Stop typing the same Kashmir 6N7D every Monday. ⛰️\n\nIt's pre-built in Via Kashmir — margin baked in. Swap hotels, change client, send.\n\n👉 viakashmir.com\n\n#KashmirTravel #TourOperators #ItineraryBuilder",
            },
            {
                "subject": "Build any client itinerary in two minutes",
                "headline": "Two minutes from inquiry to a quote that looks like your brand.",
                "body": "Drag-drop days, swap hotels with live rates, add transfers, brand the PDF with your logo and contact, send.|Your client sees your name — not ours. Built for Indian, Saudi, Kashmir and Dubai-bound clients.",
                "kicker": "For travel agents",
                "whatsapp": "2 min se inquiry se branded quote tak. Drag-drop days, hotels live rates, branded PDF, aapka logo. Client aapka naam dekhega.\n\n→ viakashmir.com",
                "caption": "From inquiry to a branded quote — two minutes. ✈️\n\nDrag-drop days. Live hotel rates. Your logo on the PDF.\n\n👉 viakashmir.com\n\n#TravelAgents #ItineraryBuilder #B2BTravel",
            },
            {
                "subject": "Send a quote that looks like your brand",
                "headline": "Your logo. Your colours. Your contact. Our engine.",
                "body": "Every itinerary PDF Via Kashmir generates is fully white-labelled — your logo at the top, your colours in the header bands, your contact details in the footer.|The client never sees us. They see you, looking sharper than your competition.",
                "kicker": "White-label PDF",
                "whatsapp": "Aapka logo. Aapka colour. Aapka contact. Hamara engine. Via Kashmir ka har PDF white-labelled hai — client aapka naam dekhega.\n\n→ viakashmir.com",
                "caption": "Your client should see your brand on the quote — not ours. 📄\n\nFully white-labelled itinerary PDFs.\n\n👉 viakashmir.com\n\n#WhiteLabel #TravelAgents",
            },
            {
                "subject": "GCC inbound — Saudi, Dubai, Umrah-extension",
                "headline": "GCC inbound packages — built for the way Indian agents actually sell.",
                "body": "Umrah-extension packages, family Dubai 4N5D, KSA cultural-tour week. Pre-built itineraries with hotel inventory, transfers, day-trip add-ons.|Quote in the client's currency, see margin in INR.",
                "kicker": "Saudi · Dubai · GCC",
                "whatsapp": "Saudi + Dubai inbound — pre-built. Umrah-extension, family Dubai 4N5D, KSA cultural-tour. Hotel inventory + transfers. Quote in client currency, margin in INR.\n\n→ viakashmir.com",
                "caption": "GCC inbound, built for Indian agents. 🕋\n\nUmrah-extension. Family Dubai 4N5D. KSA cultural week. Quote in client currency, see margin in INR.\n\n👉 viakashmir.com\n\n#GCCTravel #UmrahPackages #DubaiTravel",
            },
        ],
    },

    # ───────────────────────── Collab Market ─────────────────────────
    "collab-market": {
        "id": "bb716234-9b5d-4a97-81d0-d501bd1b6a3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "template_file": "scripts/templates/collab_market_email.json",
        "whatsapp_file": None,
        "caption_file": None,
        "tags_base": ["collab-market", "daily-drop", "creator-recruitment"],
        "industry_query": "creator economy India brand collaborations",
        "copy_variants": [
            {
                "subject": "Stop pitching brands in the DMs — let them book you",
                "headline": "Brands find you. Not the other way around.",
                "body": "Set your rate. Set your niche. Set your availability. Brands search Collab Market the way they search for any service — and book you direct.|No agency cut. No 'do it for exposure' DMs. Payment cleared through the platform.",
                "kicker": "Get booked, not pitched",
                "whatsapp": "Brand ke DMs mein pitch karna band karo. Collab Market pe rate set karo, niche set karo, availability set karo — brand khud book karega. Agency cut nahi, payment platform se.\n\n→ collabmarket.in",
                "caption": "Stop pitching brands in the DMs. Let them book you. 📣\n\nSet your rate · Set your niche · Set your availability. Brands search Collab Market for creators like you and book direct. No agency cut. Payment cleared through us.\n\n👉 collabmarket.in\n\n#CreatorEconomy #InfluencerMarketing #IndiaCreators #GetPaid",
            },
            {
                "subject": "Your rate. Their search. Our payment escrow.",
                "headline": "The creator marketplace that pays you on delivery.",
                "body": "Brands fund the brief upfront. You deliver. We release. No more chasing invoices, no more 'we'll process next month'.|Payment timeline is the platform's job — not yours.",
                "kicker": "Payment-protected",
                "whatsapp": "Brand pehle fund karta hai. Aap deliver karte ho. Hum release karte hain. Invoice chase nahi karna. Payment platform ki zimmedari hai.\n\n→ collabmarket.in",
                "caption": "The creator marketplace where payment is the platform's job, not yours. 💰\n\nBrand funds the brief upfront → you deliver → we release. No chasing invoices. No 'next month' delays.\n\n👉 collabmarket.in\n\n#CreatorPay #BrandDeals #IndianCreators",
            },
            {
                "subject": "Brands — book vetted creators in 24 hours",
                "headline": "Vetted creators. Real engagement. 24-hour turnaround.",
                "body": "Skip the agency middlemen and the engagement-fraud Excel sheets. Every creator on Collab Market is metrics-verified, brand-safety-screened, and bookable in minutes.|Brief them, fund the escrow, sign off on delivery. Done.",
                "kicker": "For brand teams",
                "whatsapp": "Brands: 24-hour creator booking, vetted, no middlemen. Metrics-verified. Brand-safety screened. Brief → fund → deliver → sign-off.\n\n→ collabmarket.in",
                "caption": "Brands — book vetted creators in 24 hours. 🎬\n\nNo agency middleman. No engagement-fraud spreadsheets. Every creator metrics-verified + brand-safety screened.\n\n👉 collabmarket.in\n\n#InfluencerMarketing #BrandTeams #IndiaCreators",
            },
        ],
    },
}


# ─── Literal-template renderers ────────────────────────────────────────────
def _swap_html_email(template_row: dict, variant: dict) -> tuple[str, str | None]:
    """Take the canonical html_email row's `content` (and `amp_content` if
    present) and swap ONLY the four copy slots: subject text, kicker,
    headline, and body lines.

    The swap is structural-aware: we look for the template's existing
    subject / headline / body text and substitute the variant's values
    inline. Every other byte of the HTML (CSS, table layout, image URLs,
    brand colours) stays exactly as June 22 shipped it.
    """
    content = template_row.get("content") or ""
    amp = template_row.get("amp_content") or None
    tpl_subject = template_row.get("subject") or ""

    new = content
    # Subject in <title> and (if present) preheader.
    if tpl_subject:
        new = new.replace(tpl_subject, variant["subject"])
    # The canonical's stored body is its <h1> text — swap it.
    # (Each business's June 22 sample carried specific headline text; if
    # the user shipped a different one we just leave it.)
    for key in ("Steel bottles made for daily carry.",
                "She was waiting. So was he. Both deserved to meet safely.",
                "School ERP that finishes onboarding."):
        if key in new:
            new = new.replace(key, variant["headline"])
            break

    # Body paragraph swap (best-effort; only the leading sentence/paragraph)
    body_sentences = variant.get("body", "").split("|")
    # Try common signatures from each business's sample text:
    OLD_BODIES = [
        "Vacuum steel bottles and tumblers, branded for the everyday.",
        "At Date Khaas, every profile is reviewed before any introduction is ever made. Your photos stay blurred until you decide otherwise. And your family can be part of this from the very first moment.",
        "Because the road to nikah should feel like hope &mdash; not anxiety.",
    ]
    for o, nb in zip(OLD_BODIES, body_sentences):
        if o in new and nb:
            new = new.replace(o, nb, 1)

    # If the template carried a kicker (small uppercase pill text), swap it.
    if variant.get("kicker"):
        for kicker_marker in ("Premium drinkware", "&#10003; VERIFIED PROFILES ONLY", "✓ VERIFIED PROFILES ONLY"):
            if kicker_marker in new:
                new = new.replace(kicker_marker, variant["kicker"])
                break

    # Mirror swaps in AMP body if present.
    if amp:
        if tpl_subject:
            amp = amp.replace(tpl_subject, variant["subject"])
        for key in ("She was waiting. So was he. Both deserved to meet safely.",
                    "Steel bottles made for daily carry.",
                    "School ERP that finishes onboarding."):
            if key in amp:
                amp = amp.replace(key, variant["headline"])
                break

    return new, amp


def _whatsapp_body(profile: dict, variant: dict) -> str:
    return variant.get("whatsapp") or ""


def _caption_body(profile: dict, variant: dict) -> str:
    return variant.get("caption") or ""


# ─── Industry-signal helper (footer only, optional) ────────────────────────
def google_news_one(query: str) -> dict | None:
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


# ─── Per-business orchestrator ─────────────────────────────────────────────
def run_business(slug: str, *, date_s: str, dry_run: bool = False) -> dict:
    if slug not in BUSINESSES:
        return {"slug": slug, "error": "unknown_business"}
    profile = BUSINESSES[slug]
    biz_id = profile["id"]
    ws_id = profile["workspace"]
    variants = profile["copy_variants"]
    if len(variants) < 2:
        return {"slug": slug, "error": "need_at_least_2_variants"}

    # Load canonical template payload.
    tpl_path = Path(profile["template_file"])
    if not tpl_path.is_file():
        return {"slug": slug, "error": f"missing_template_file: {tpl_path}"}
    template_row = json.loads(tpl_path.read_text())
    image_url = template_row.get("image_url") or ""

    # Day-of-year rotation: pick two different copy variants for A vs B.
    day_n = dt.date.fromisoformat(date_s).timetuple().tm_yday
    idx_a = day_n % len(variants)
    idx_b = (day_n + 1) % len(variants)
    if idx_b == idx_a:
        idx_b = (idx_b + 1) % len(variants)
    var_a = variants[idx_a]
    var_b = variants[idx_b]

    print(f"[{slug}] V_A subject: {var_a['subject'][:70]!r}")
    print(f"[{slug}] V_B subject: {var_b['subject'][:70]!r}")

    inserted, skipped = [], []
    ab_test_tag = f"ab-test:{slug}:{date_s}"

    for variant_letter, variant in [("a", var_a), ("b", var_b)]:
        # Channel 1: html_email (literal template + copy swap)
        new_content, new_amp = _swap_html_email(template_row, variant)
        title = f"[{date_s}] {slug} · html_email · V{variant_letter.upper()} · {variant['subject'][:80]}"
        # Idempotency.
        status, existing = rest(
            "GET",
            f"/content_assets?business_id=eq.{biz_id}&title=eq.{urllib.parse.quote(title)}&select=id",
        )
        if isinstance(existing, list) and existing:
            skipped.append(title)
        else:
            row = {
                "id": str(uuid.uuid4()),
                "workspace_id": ws_id,
                "business_id": biz_id,
                "title": title,
                "type": "html_email",
                "content": new_content,
                "subject": variant["subject"],
                "platform": None,
                "tags": list(profile["tags_base"]) + [date_s, "html_email", "auto-generated",
                                                      f"variant:{variant_letter}", ab_test_tag],
                "amp_content": new_amp,
                "image_url": image_url,
                "notes": json.dumps({
                    "generated_by": "content_daily_routine_v3_literal_clone",
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "based_on_template": profile["template_file"],
                    "variant": variant_letter,
                    "ab_test_id": f"{slug}:{date_s}",
                })[:8000],
            }
            if dry_run:
                inserted.append(title)
                print(f"  [DRY] would insert {title}")
            else:
                st, body = rest("POST", "/content_assets", row)
                if st in (200, 201):
                    inserted.append(title)
                    print(f"  ✓ {title}")
                else:
                    print(f"  ✗ {title} → {st} {str(body)[:160]}", file=sys.stderr)

        # Channel 2: whatsapp
        title_w = f"[{date_s}] {slug} · whatsapp · V{variant_letter.upper()} · {variant['subject'][:80]}"
        status, existing = rest(
            "GET",
            f"/content_assets?business_id=eq.{biz_id}&title=eq.{urllib.parse.quote(title_w)}&select=id",
        )
        if isinstance(existing, list) and existing:
            skipped.append(title_w)
        else:
            row = {
                "id": str(uuid.uuid4()),
                "workspace_id": ws_id,
                "business_id": biz_id,
                "title": title_w,
                "type": "whatsapp",
                "content": _whatsapp_body(profile, variant),
                "subject": None,
                "platform": None,
                "tags": list(profile["tags_base"]) + [date_s, "whatsapp", "auto-generated",
                                                      f"variant:{variant_letter}", ab_test_tag],
                "amp_content": None,
                "image_url": image_url,
                "notes": None,
            }
            if dry_run:
                inserted.append(title_w)
            else:
                st, body = rest("POST", "/content_assets", row)
                if st in (200, 201):
                    inserted.append(title_w)
                    print(f"  ✓ {title_w}")
                else:
                    print(f"  ✗ {title_w} → {st} {str(body)[:160]}", file=sys.stderr)

        # Channel 3: caption (only if variant defines one)
        if variant.get("caption"):
            title_c = f"[{date_s}] {slug} · caption · V{variant_letter.upper()} · {variant['subject'][:80]}"
            status, existing = rest(
                "GET",
                f"/content_assets?business_id=eq.{biz_id}&title=eq.{urllib.parse.quote(title_c)}&select=id",
            )
            if isinstance(existing, list) and existing:
                skipped.append(title_c)
            else:
                row = {
                    "id": str(uuid.uuid4()),
                    "workspace_id": ws_id,
                    "business_id": biz_id,
                    "title": title_c,
                    "type": "caption",
                    "content": _caption_body(profile, variant),
                    "subject": None,
                    "platform": "linkedin",
                    "tags": list(profile["tags_base"]) + [date_s, "caption", "auto-generated",
                                                          f"variant:{variant_letter}", ab_test_tag],
                    "amp_content": None,
                    "image_url": image_url,
                    "notes": None,
                }
                if dry_run:
                    inserted.append(title_c)
                else:
                    st, body = rest("POST", "/content_assets", row)
                    if st in (200, 201):
                        inserted.append(title_c)
                        print(f"  ✓ {title_c}")
                    else:
                        print(f"  ✗ {title_c} → {st} {str(body)[:160]}", file=sys.stderr)

    return {
        "slug": slug,
        "ab_test_id": f"{slug}:{date_s}",
        "variant_a_subject": var_a["subject"],
        "variant_b_subject": var_b["subject"],
        "inserted": len(inserted),
        "skipped": len(skipped),
        "template_used": profile["template_file"],
    }


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
