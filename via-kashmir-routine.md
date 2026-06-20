# DAILY ROUTINE — ViaKashmir content engine (B2C + B2B tracks)

> Operational spec for the `content/via-kashmir/` engine. Separate from the
> `via-kashmir-itinerary` engine and from `gifts-gulf`. This file reflects the scripts
> actually committed under `scripts/via-kashmir/` and the shared `scripts/publish.py`.

## GOAL
Each run, produce ONE day of image-forward Kashmir travel content for ViaKashmir, commit
it to `main`, and seed it into the Content Hub business `via-kashmir` via the DB. Sell by
SHOWING Kashmir: big photos first, short confident copy, one clear call to action.
**No prices anywhere.** Tone: B2C mirrors MakeMyTrip/Goibibo (beauty, season, gentle
urgency); B2B is operator-focused loss-aversion.

## WHAT TO PRODUCE — three sets per day (one market: India, English)
A set = `email.html` + `email.amp.html` + `whatsapp.txt` + `linkedin.txt` + `meta.json`
+ `img/whatsapp.jpg`. Three sets = 1 B2C + 2 rotating B2B:
- `date.day % 3 == 0` → b2b-hotels + b2b-cabs-shikaras
- `date.day % 3 == 1` → b2b-cabs-shikaras + b2b-houseboats
- `date.day % 3 == 2` → b2b-houseboats + b2b-hotels

Tracks: `b2c` (travellers), `b2b-hotels`, `b2b-cabs-shikaras`, `b2b-houseboats` (onboard
operators to list on viakashmir.in). Vary the lead photo + headline daily; keep the shell.

## FIXED VALUES
- WHATSAPP_NUMBER = `919186051499` → `https://wa.me/919186051499`
- CONTACT_EMAIL = `contact@viakashmir.in`  CONTACT_PHONE = `+91 91860 51499`
- Green contact banner with both appears in every email and on every card.
- HUB_WORKSPACE = `b2236a00-faa2-41d5-8ee7-b6e24d0c4904`; HUB_BUSINESS_SLUG = `via-kashmir`.
- Logo (live SVG via wsrv): `https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png`
- CTA rule: every button → `https://viakashmir.in/`, EXCEPT the B2B list/sign-up button →
  `https://viakashmir.in/sign-up?role=vendor`. Only non-viakashmir.in link allowed is the
  WhatsApp pill.

## NO PRICES (hard rule)
Never print a price, currency amount, "from", per-night/seat figure, discount %, or tax.

## IMAGES — every image through the wsrv proxy, sourced ONLY from two places
1. The committed pool: `content/via-kashmir/_assets/photos/*.jpg`
2. The Pixabay API (watermark-free, free for commercial use) via
   `scripts/via-kashmir/fetch_photos.py`.
NEVER Wikimedia/Google/scraped/hot-linked stock (that is where watermarks come from).
Reference each photo as:
`https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main/content/via-kashmir/_assets/photos/<file>.jpg&w=1200&output=jpg&q=82`
(`&` → `&amp;` in HTML/AMP). **email.html uses `<img>`** (renders everywhere);
email.amp.html uses `<amp-img>` (renders nothing unless the sender is AMP-registered, so
paste email.html — NOT the .amp file — when testing in GMass).

## SCRIPTS (what makes what)
- `scripts/via-kashmir/fetch_photos.py --query "<theme>" --tag <tag>` → refresh the pool
  (Pixabay key from `PIXABAY_API_KEY`, falls back to the committed pool).
- `scripts/via-kashmir/build_amp.py --track <t> --html <set>/email.html --amp <set>/email.amp.html [--hero <tag> --feat <tag>]`
  → both the HTML email and the valid amp4email file (Alpine Editorial shell).
- `scripts/via-kashmir/make_cards.py --track <t> --photo <pool>.jpg --out <set>/img/whatsapp.jpg`
  → the 1080×1350 poster (Pillow only, no browser). Override copy with
  `--label/--promo/--accent/--body/--cta/--reassure`.
- `scripts/via-kashmir/build_eml.py` → optional self-contained .eml with CID-embedded
  photos (bulletproof "images always show" fallback).
- `scripts/publish.py --date <YYYY-MM-DD> --slug via-kashmir` → seed the Content Hub DB
  (shared, business-agnostic publisher; via-kashmir branding defaults are built in).

## DAILY RESEARCH (briefly, web)
Season + weather now, live access/advisories, one B2C tone hook, one B2B loss-aversion
hook. Mondays: write `content/via-kashmir/_state/competitor-notes-<date>.md` (study
product patterns of major marketplaces; never name them in output). If web is down, fall
back deterministically by date so themes rotate.

## EMAIL & CARD DESIGN — Alpine Editorial house style
#f3f4f5 page, 600px wrapper, rounded cards. Shell: white logo card → photo hero (rounded
top) on a green-gradient hook (mint badge, bold headline with one mint accent line, body,
dark-green/white pill CTA, reassurance) → accent strip → feature photo + caption →
green-gradient CTA card (+ WhatsApp link) → green contact banner → footer. Palette:
#00361a/#1a4d2e/#004e5f greens, #9dd3aa mint, #ffdcc4 saffron, #f3f4f5 page. Always pair
gradients with a bgcolor fallback for Outlook; logo on white, never on green; never a
black hero.

## COPY RULES (absolute)
No explicit religious slogans (devotional framing OK). Never mention commission. No "free"
in a CTA. Never name a competitor. No exclamation marks in subjects. No prices. Subjects
never reused (`_state/used-subjects.json`); no repeating a lead photo two days running per
track (`_state/used-photos.json`). The houseboats track MAY use "Karew Sa Join Kashrew".

## META / MANIFEST / STATE
`meta.json`: date, track, audience, theme, season, design, currency(INR), campaign_code
(`VK-INR-<TRACK>-<YYYYMMDD>`), campaign_name (UNIQUE per track/day — the publisher's
idempotency key), subject, items, promo_image (jsDelivr URL of the card), image (same),
cta_url, whatsapp_cta. Also write per-day `manifest.json` and update the two `_state`
files. Card public URL:
`https://cdn.jsdelivr.net/gh/aribanigar/Leadloftexporter@main/content/via-kashmir/<date>/<track>/img/whatsapp.jpg`

## ORDER OF OPERATIONS
1. Research + pick angles/photos. 2. fetch/keep photos. 3. Build the 3 sets + cards.
4. **COMMIT and PUSH to `main` FIRST** (wsrv/jsDelivr read the repo via main).
5. HEAD-verify every wsrv/jsDelivr image URL → 200 + image/* (retry; warms cache).
6. `python3 scripts/publish.py --date <date> --slug via-kashmir` → seed the DB.
7. Report: date, commit, push, seed (inserted/skipped/failed), and the 3 tracks.

## SECRETS (routine env only, never committed)
`DATABASE_URL` (required), `HUB_WORKSPACE`, `PIXABAY_API_KEY` (optional — without it the
routine reuses the committed pool).
