# Via Kashmir — daily content routine

Generates and publishes **Via Kashmir** travel-marketing content into the Content
Hub folder **`/content-hub/via-kashmir`** every day, and commits the source to git.

- Live folder: https://leadloftexporter.vercel.app/content-hub/via-kashmir
- Repo: https://github.com/aribanigar/Leadloftexporter
- Website (every email/WhatsApp button → here): https://viakashmir.in/
- B2B / vendor sign-up CTA: https://viakashmir.in/sign-up?role=vendor
- Logo: https://viakashmir.in/logo-colour.svg?v=3
- Photos: https://pixabay.com/images/search/kashmir/ (set `PIXABAY_API_KEY`), else Wikimedia Commons.

## What it produces each day

**3 currencies × 3 sets = 9 sets** under `content/via-kashmir/<YYYY-MM-DD>/<CUR>/set-<n>/`:

| Currency | Audience |
|---|---|
| INR | Domestic India (Make My Trip's core) |
| USD | International / NRI |
| AED | Gulf outbound (big Kashmir inbound market) |

Each set contains:
- `email.html` — rich, image-led marketing email (hero photo, product tiles with photos + prices, B2C "Book" + B2B "Become a partner" CTAs).
- `email.amp.html` — **valid AMP-for-Email** version (`<html amp4email>`, boilerplate, `<amp-img>`, no `!important`). Gmail renders it; everything else falls back to the HTML.
- `whatsapp.txt` — WhatsApp broadcast copy (the hero photo is attached on the Hub asset and rides as the caption).
- `linkedin.txt` — LinkedIn outreach DM (B2B), with `{first_name}` merge.
- `meta.json` — `{date, currency, theme, season, subject, image, products[]}`.

Plus `manifest.json` listing the day's 9 sets.

## Tone & strategy (Make My Trip style — sell the *product*, not talk)

- Product-forward: lead with **named packages, photos and prices**, urgency ("books out fast"), deal pills.
- Seasonal: copy + theme selection follow the month —
  spring (tulips), **summer (meadows / houseboats — current)**, autumn (chinar/saffron), winter (Gulmarg snow/ski).
- Convertible for **B2C** (book a trip) **and B2B** (agents, hoteliers, corporate gifting → vendor sign-up).
- Themes rotate daily with no same-day repeat, weighted to the current season
  (`scripts/generate_via_kashmir.py` → `pick_themes`).

## Weekly competitor research (run Mondays; fold findings into copy/offers)

1. Make My Trip — https://www.makemytrip.com/
2. IndiGo — https://www.goindigo.in/
3. Goibibo — https://www.goibibo.com/
4. Booking.com — https://www.booking.com/

Look at: hero offers, price framing, urgency/scarcity, bundle structure, seasonal
pushes, B2B/partner programs. Update package names, price points and deal lines in
`THEMES` inside `scripts/generate_via_kashmir.py`.

## How to run

```bash
# 1) Generate today's 9 sets (fetches real Kashmir photos)
export PIXABAY_API_KEY=...        # optional; falls back to Wikimedia Commons
python3 scripts/generate_via_kashmir.py --date $(date -u +%F)

# 2) Commit the source to main
git add content/via-kashmir && git commit -m "via-kashmir content $(date -u +%F)" && git push origin main

# 3) Seed into the Content Hub DB (idempotent — reruns are no-ops)
export DATABASE_URL='postgresql+psycopg://...neon.../neondb?sslmode=require'
export HUB_WORKSPACE='<workspace uuid>'
export HUB_BUSINESS_SLUG='via-kashmir'
python3 scripts/publish_to_hub.py --date $(date -u +%F)
```

`publish_to_hub.py` talks to Neon over its **HTTPS SQL endpoint** (port 443, no
psycopg) so it works from restricted routine sandboxes. It creates the
`via-kashmir` business on first run with the brand colours + logo, then inserts
`html_email` (with `amp_content`), `whatsapp` (with the hero photo as
`image_url`) and `caption`/LinkedIn assets — skipping any
`(business_id, title)` that already exists.

## Notes on AMP rendering

The generated AMP is structurally valid AMP4Email. For Gmail to *render* the AMP
version (vs. the HTML fallback), the **sending domain must be registered with
Google's "AMP for Email" sender program** — that's a one-time sender
registration, independent of the content. Until then recipients see the (still
rich) HTML email.
