# DAILY ROUTINE - ViaKashmir content engine

## GOAL
Each run, produce ONE day of image-forward Kashmir travel content for ViaKashmir,
commit it to branch main, and seed it into the Content Hub business folder
"via-kashmir" via the database. Sell by SHOWING Kashmir: big photos first, short
confident copy, one clear call to action. NO prices anywhere. Convertible, playful,
never dull. Every day is new and different. Tone for B2C mirrors MakeMyTrip and
Goibibo (beauty, season, gentle urgency); B2B is operator-focused and uses
loss-aversion, not brochure copy.

## WHAT TO PRODUCE - three sets per day (one market)
A "set" = one complete content bundle for one track:
  email.html  +  email.amp.html  +  whatsapp.txt  +  linkedin.txt  +  meta.json
  +  img/whatsapp.jpg  (the Alpine card poster for that set).
Produce THREE sets per day = 1 B2C + 2 B2B, where the 2 B2B tracks rotate by date so
all three B2B types get covered over the week:
  - date%3==0 -> b2b-hotels + b2b-cabs-shikaras
  - date%3==1 -> b2b-cabs-shikaras + b2b-houseboats
  - date%3==2 -> b2b-houseboats + b2b-hotels
Tracks:
  b2c                - travellers. Promote visiting Kashmir (MakeMyTrip tone).
  b2b-hotels         - onboard hotels to list on viakashmir.in.
  b2b-cabs-shikaras  - onboard cab + shikara operators.
  b2b-houseboats     - onboard houseboat owners.
ONE market, ONE language (English, India). No multi-currency, no AED/USD/SAR/QAR/OMR
splits - a single set of three is enough. Vary the lead photo and headline daily so it
never looks templated; keep the shell.

## FIXED VALUES
- WHATSAPP_NUMBER = 9186051499
  CTA link: https://wa.me/919186051499?text=<url-encoded one-line request>
- CONTACT_EMAIL = contact@viakashmir.in   CONTACT_PHONE = +91 91860 51499
- A FIXED green contact banner showing CONTACT_EMAIL and CONTACT_PHONE appears in
  every email and on every card.
- HUB_WORKSPACE = 2faa195e-5817-4d32-8e6c-350b70ce32c3  (workspace "acemedia").
- HUB_BUSINESS_SLUG = via-kashmir   (business id 88a4fcf7-45cf-459e-a6dd-139430f76a0c).
- Logo (SVG): https://viakashmir.in/logo-colour.svg?v=3
- Repo raw base (for committed card images):
  https://raw.githubusercontent.com/aribanigar/Leadloftexporter/main/
- CTA URLs (use EXACTLY these; every button in every mail points to viakashmir.in):
    b2c                -> https://viakashmir.in/                      (+ WhatsApp)
    b2b-hotels         -> https://viakashmir.in/sign-up?role=vendor   (list your hotel)
    b2b-cabs-shikaras  -> https://viakashmir.in/sign-up?role=vendor   (list your service)
    b2b-houseboats     -> https://viakashmir.in/sign-up?role=vendor   (list your houseboat)
  Rule: every CTA/button href in ANY email (B2C and B2B) is https://viakashmir.in/,
  EXCEPT the B2B "list / sign up" button, which is https://viakashmir.in/sign-up?role=vendor.
  The only non-viakashmir.in link allowed is the WhatsApp pill (wa.me/919186051499).
  Footer/legal links also point to https://viakashmir.in/ (B2B footer "sign up" ->
  https://viakashmir.in/sign-up?role=vendor).

## NO PRICES (hard rule)
Never print a price, currency amount, "from", per-night/per-seat figure, discount %,
or tax line in any email, WhatsApp, or LinkedIn output. Region (India / GCC) only
changes the audience framing and language, never a number.

## DAILY RESEARCH (do this first, briefly, with web access)
Research TODAY's Kashmir travel reality and pick angles:
- Season + weather now: spring bloom / tulip garden window / summer meadows /
  autumn chinar / winter ski (Gulmarg) / Amarnath season. Be seasonally accurate.
- Live travel updates: flight/road access to Srinagar, any advisory, festival or
  event (Tulip Festival, Saffron, shikara races), what is at its best this week.
- B2C tone study: skim MakeMyTrip and Goibibo email/landing style - large imagery,
  short punchy headline, season hook, one filled CTA. Mirror the FEEL, not prices.
- B2B angle: travellers are searching and booking right now; the operator's risk is
  being invisible while a rival gets the booking. Build today's loss-aversion hook.
Output per track: {angle, season, 3 photo themes}. If web is unavailable, fall back
deterministically by date so themes rotate and never repeat two days running.
Theme pool (B2C): Dal sunrise | Gulmarg gondola | Pahalgam meadows | Tulip garden |
Sonamarg glaciers | Chinar autumn | Houseboat night | Saffron fields | Betaab valley.

## WEEKLY COMPETITOR RESEARCH (every Monday, store under _state)
Study how these market PRODUCTS (not how they talk): makemytrip.com, goindigo.in,
goibibo.com, booking.com. Extract: hero image treatment, headline length, how many
products per screen, CTA wording and colour, urgency devices, B2B/partner onboarding
pitch. Write content/via-kashmir/_state/competitor-notes-<YYYY-MM-DD>.md with
{what they show, what we should copy this week, one thing to avoid}. Feed these into
the week's designs. Never name a competitor in any ViaKashmir output.

## PHOTOS - route every image through the wsrv proxy (proven in the live emails)
ALLOWED PHOTO SOURCES - ONLY TWO, NO EXCEPTIONS:
  1. The committed curated pool: content/via-kashmir/_assets/photos/*.jpg
     (hand-picked, watermark-free: boats, cablecar, gulmarg, hero_dal, shikara, valley).
  2. The Pixabay API via scripts/fetch_photos.py (Pixabay downloads are watermark-free;
     free for commercial use).
NEVER use Wikimedia/Wikipedia, Google Images, a search-result page, or any scraped or
hot-linked stock URL. That is exactly where a watermarked shot like the "AdilAru" image
comes from. If any fetch returns an image with a watermark, signature, or visible logo,
DISCARD it and fall back to the curated pool. The cards (make_cards.py) are built ONLY
from the curated pool, so every card is clean and on-brand by construction.

What actually makes images SHOW: serve EVERY image - logo, hero, feature, tiles, card -
through the wsrv.nl proxy. wsrv fetches the source server-side, resizes it, and returns a
clean JPG/PNG with the right content-type, which Gmail proxies and displays reliably.
Ampersands in the wsrv query string are FINE. The earlier failures were (a) pointing at
repo files not yet pushed (404) and (b) sending the AMP file, where amp-img shows nothing
without Google AMP registration.

1. Refresh the pool from the Pixabay API (free key) and COMMIT the JPEGs:
     python3 scripts/fetch_photos.py --query "<theme>" --count 8 --tag <theme>
   If PIXABAY_API_KEY is unset it no-ops and you reuse the committed pool.
2. Reference each photo through wsrv, wrapping the committed repo file:
     src = https://wsrv.nl/?url=raw.githubusercontent.com/aribanigar/Leadloftexporter/main/content/via-kashmir/_assets/photos/<file>.jpg&w=1200&output=jpg&q=82
   HTML: <img src="<that, with &amp;>" width="600" alt="<scene>" style="display:block;width:100%;height:300px;object-fit:cover;border:0;border-radius:18px 18px 0 0;">
   AMP:  <amp-img src="<that, with &amp;>" width="600" height="300" layout="responsive" alt="<scene>"></amp-img>
   Logo the same way (see LOGO). wsrv handles the resize, so no other CDN is needed.
3. ORDER OF OPERATIONS: COMMIT and PUSH photos+content to main FIRST (wsrv reads the
   repo via raw.githubusercontent, so the file must be on main), then HEAD each final
   wsrv URL with retry until 200 + image/* (also warms the cache), THEN seed the DB.
   Never seed a track whose images are not yet 200.
4. SAMPLE/preview before any push: wrap an already-live source instead of the repo, e.g.
   https://wsrv.nl/?url=images.unsplash.com/<id>&w=1280&output=jpg&q=82 (HEAD-verified
   200) - renders immediately. Switch to the repo-wrapped wsrv URL once pushed.
Pixabay Content License: free for commercial use, no attribution required.
PIXABAY_API_KEY is required for fresh daily photos; without it the routine reuses the
committed pool (so emails still render, just with repeating scenes).

## LOGO - the real colour logo via the wsrv image proxy (proven to render)
Serve the actual logo through wsrv, which fetches the SVG and returns a PNG that Gmail
displays reliably:
  https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png
- HTML header card (white): <td align="center" style="background-color:#ffffff;border-radius:16px;padding:20px 24px;"><img src="https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&amp;w=400&amp;output=png" width="172" alt="ViaKashmir" style="display:block;width:172px;height:auto;border:0;margin:0 auto;"></td>
- AMP header card: <amp-img src="https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&amp;w=400&amp;output=png" width="172" height="40" layout="fixed" alt="ViaKashmir"></amp-img>
Logo on WHITE only, never on the green hero. The raw .svg stays the hub logo_url only.

## WHATSAPP / CARD IMAGE - one per track (the email hero, as a poster)
Each track produces ONE promotional card (1080x1350 JPG) that IS the email's hero unit
rebuilt as a poster, in the SAME Alpine Editorial design: #f3f4f5 page -> white logo
card -> a big Kashmir photo hero (rounded top) -> a GREEN-GRADIENT hook card (mint badge,
Manrope 900 headline with a mint accent line, Inter body, dark-green pill CTA with white text, reassurance
line) -> green contact banner. Identical look to the email. No price, no timeline, no
commission, no gold listing codes.
make_cards.py renders HTML through Chromium (Playwright), so it matches the email pixel
for pixel. The photo hero auto-sizes to fill, so any headline length stays balanced.
One-time setup in the routine env:
    pip3 install -q --break-system-packages -r scripts/requirements.txt
    python3 -m playwright install chromium
Each track has built-in copy defaults; pass the day's photo and the out path:
    python3 scripts/make_cards.py --track <b2c|b2b-hotels|b2b-cabs-shikaras|b2b-houseboats> \
      --photo content/via-kashmir/_assets/photos/<file>.jpg \
      --out content/via-kashmir/<YYYY-MM-DD>/<track>/img/whatsapp.jpg
Override copy per day to keep it fresh (keep it loss-aversion for B2B, seasonal for B2C):
      --label "<badge>"  --promo "<headline line 1>"  --accent "<mint line 2>" \
      --body "<one or two sentences>"  --cta "<List my hotel | Plan my Kashmir trip>" \
      --reassure "<No cost to list  -  Direct bookings, your guests>"
Pick a strong, well-composed hero photo (the card lives or dies on it). Commit the JPG.
Its public URL is:
  https://cdn.jsdelivr.net/gh/aribanigar/Leadloftexporter@main/content/via-kashmir/<YYYY-MM-DD>/<track>/img/whatsapp.jpg

## EMAIL DESIGN - the ViaKashmir house style (Alpine Editorial, photo-forward)
This is non-negotiable: match the look of viakashmir-b2b-hotel-v2.html and the new
b2c sample. Breathtaking, editorial, image-led. Each section is a ROUNDED CARD on a
#f3f4f5 page, 600px wrapper, generous spacing (spacer rows of 16-34px between cards).

Fixed shell, in this order:
1. LOGO CARD - white, border-radius 16px, logo centred (jsDelivr PNG). Logo is NEVER
   on green.
2. HERO - a full-bleed Kashmir photo (border-radius 20px 20px 0 0, object-fit cover,
   ~300px tall) sitting directly on top of a GREEN-GRADIENT card
   (background:linear-gradient(160deg,#00361a 0%,#1a4d2e 60%,#004e5f 100%); always
   include bgcolor="#00361a" as the Outlook fallback; border-radius 0 0 20px 20px;
   padding ~40px 48px). Inside the gradient: a translucent pill badge
   (bg rgba(161,231,255,0.14), text #b2ebff, uppercase, letter-spacing 0.16em); a
   Manrope 900 headline ~40px, line-height 1.08, letter-spacing -0.03em, white with one
   line in #9dd3aa; a 15px body in rgba(255,255,255,0.7); a PILL CTA - DARK GREEN with
   WHITE text so it is always readable (background:linear-gradient(135deg,#1a4d2e 0%,#0e3d2f 100%);
   bgcolor="#0e3d2f" Outlook fallback; border-radius 99px; Manrope 800 text #ffffff;
   padding 16px 38px); a tiny reassurance line in rgba(255,255,255,0.4).
3. SECTION EYEBROW - Inter 10px 800, letter-spacing 0.18em, uppercase, #717971.
4. FEATURE PHOTO - one full-width photo (radius 18px top, ~300px cover) on a white
   caption card (radius bottom 18px) with a Manrope 900 20px title + #717971 line.
5. TWO PHOTO TILES - 2-up white cards, each a photo (radius top 18px, height 190px
   cover) + Manrope 800 16px name + #717971 line. Equal heights.
6. SAFFRON STRIP - #ffdcc4 card, eyebrow #6f3800, Manrope 900 #2f1400 headline, a small
   dark-green pill CTA with white text on the right.
7. PROOF / REASSURANCE ROW - white card, 3 centred columns, each a 28px gradient bar +
   Manrope 800 title + #717971 line. Lead with reassurance (safety perception is the
   real B2C barrier), e.g. Planned by locals / Everything sorted / On WhatsApp.
8. GREEN-GRADIENT CTA CARD - eyebrow + Manrope 900 ~25px headline (mint accent line) +
   body + the same dark-green/white pill CTA + a WhatsApp link in #9dd3aa.
9. CONTACT BANNER - solid #0e3d2f card, white bold "contact@viakashmir.in | +91 91860
   51499".
10. FOOTER - white card: Manrope 900 #00361a "ViaKashmir", tagline, hairline, links.

Rotate the FEEL day to day by varying which photos lead and the headline, and by
optionally swapping section 4/5 order (Design A = feature+tiles, Design B = big hero
spotlight + 3 small tiles, Design C = alternating lookbook rows). Keep the shell.

Palette: #00361a / #1a4d2e / #004e5f greens, #9dd3aa mint accent, #b8f0c5 CTA light,
#ffdcc4 saffron, #f3f4f5 page, #191c1d ink, #717971 muted, #b2ebff badge text.
Fonts: @import Manrope (900 headlines) + Inter (body), Arial fallback.

Build rules: HTML inline styles, table layout, hidden preheader, gradients on the hero/
CTA cards are fine but ALWAYS pair with a bgcolor fallback for Outlook; images are
clean jsDelivr URLs (no ampersands) and HEAD-verified 200; logo on white; NEVER a
black hero. AMP: amp4email doctype + boilerplate + v0.js, ALL css in <style amp-custom>
as classes, amp-img for every image, under 200 KB, visually matched to the HTML.

## TRACK CONTENT ANGLES (show, don't tell)
- b2c: aspirational + seasonal + gentle urgency. Headline names the season's best
  thing. Tiles = experiences (shikara, gondola, meadows, tulips, houseboat night).
  CTA "Plan my Kashmir trip". Audience India + GCC; keep it warm, playful, no price.
- b2b-hotels: loss-aversion. Lead with "That booking just went to someone else's
  hotel." Show that travellers are searching now and how listing gets them seen.
  CTA "List your hotel". NEVER mention commission. Show the demand, not a sales pitch.
- b2b-cabs-shikaras: steady bookings, fill empty days, travellers who need a ride or
  a shikara right now. CTA "List your service". Loss-aversion hook on missed rides.
- b2b-houseboats: lakeside demand, reach travellers directly, your boat seen first.
  CTA "List your houseboat". You MAY use the Kashmiri mission line
  "Karew Sa Join Kashrew" (Join and let others join too) in houseboat listing emails.

## BRAND AND COPY RULES (absolute)
- NEVER use "Har Har Mahadev", "Jai Bhole", or any explicit religious slogan in any
  channel. Devotional/emotional pilgrimage framing is allowed; explicit slogans are not.
- NEVER mention commission in any hotel/operator-facing copy.
- NEVER use a dark/black background in an email hero - always brand greens.
- NEVER use "free" in a CTA. NEVER name a competitor. No "no agent markup" or
  agent-competitive framing in B2C tour copy.
- ViaKashmir Itinerary (viakashmiritinerary.in) is a SEPARATE product and is NOT part
  of these 4 tracks; do not mix it in. All 4 tracks use viakashmir.in.
- Use the rupee sign only if a number ever appears (it should not here). Never "Rs.".
- No exclamation marks in subject lines. No asterisks. No redundant filler phrases.
- Reassurance-led for B2C (safety perception is the real barrier, not interest):
  lead with "open, easy, planned by locals", not just aspiration.
- Palette: forest green #0e3d2f / #0a2e21, gold #c8a84b / #ffd764, saffron strip
  #ffdcc4, page #f3f4f5, ink #191c1d, body #3f3f46, muted #717971. Manrope headlines
  with Arial fallback, Inter/Arial body.

## WHATSAPP (no price; send the card image)
whatsapp.txt is a SHORT caption, 2 to 4 lines: name the season/use-case for the
track and a CTA line ending https://wa.me/919186051499. Conversational, human, never
AI-sounding (Hinglish is fine for B2B operators; warm plain English for B2C). End with
a line "Image:" then the raw GitHub URL of this track's img/whatsapp.jpg. Vary across
tracks: b2c a season teaser, hotels a single-question opener, cabs a one-line nudge,
houseboats a short pitch.

## LINKEDIN (no price)
linkedin.txt is a 3 to 5 sentence post/DM. B2C = brand-awareness "Kashmir is open this
season". B2B = the operator's missed-booking risk + how listing fixes it + a soft CTA
to viakashmir.in/signup or CONTACT_EMAIL. Vary tone across tracks.

## GENERATE EACH SET (which script makes what)
- email.html      - the approved Alpine Editorial HTML (this repo's house style). Photos
                    are jsDelivr URLs to the committed pool; logo on white; CTAs per the
                    CTA-URLs rule (every button -> viakashmir.in/, B2B list -> /sign-up?role=vendor).
- email.amp.html  - generated by scripts/build_amp.py (valid amp4email: boilerplate +
                    v0.js + all CSS in <style amp-custom>, every photo an <amp-img>, < 200 KB,
                    same images + CTAs as the HTML). This is the AMP part of the message.
- img/whatsapp.jpg- generated by scripts/make_cards.py (the Alpine card poster).
- whatsapp.txt / linkedin.txt - copy per the WhatsApp/LinkedIn rules below.
For Gmail to actually RENDER the AMP part, the SENDER must be registered for AMP for
Email with Google and the send must include the text/x-amp-html MIME part; otherwise
clients fall back to email.html. The routine's job is to produce a VALID amp file and
store it in amp_content - registration/sending is configured in your ESP (e.g. GMass).
IMPORTANT - which file shows images: email.html uses normal <img> and shows photos in
every client. email.amp.html uses <amp-img>, which renders NOTHING unless the sender is
AMP-registered. So if you paste a file into GMass to test, paste email.html, NOT the
.amp file - otherwise the photos look "missing" (that is the blank-hero you saw).

## BULLETPROOF EMBEDDED-IMAGE OPTION (scripts/build_eml.py)
When you want images guaranteed to show regardless of hosting/proxy/AMP, build a
self-contained .eml where each photo is EMBEDDED as a CID part (the image bytes travel
inside the message):
    python3 scripts/build_eml.py --html <set>/email.html --photos content/via-kashmir/_assets/photos \
        --subject "<subject>" --from "ViaKashmir <contact@viakashmir.in>" --to "<to>" --out <set>/email.eml
This produces multipart/related with image/jpeg parts and src="cid:..." - it renders in
Gmail, Apple Mail and Outlook with no external fetch. (data: URIs do NOT work in Gmail;
CID does.) Hosted clean URLs remain the default for bulk GMass sends; .eml is the
fallback that always shows.

## WRITE FILES
content/via-kashmir/<YYYY-MM-DD>/<track>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
content/via-kashmir/<YYYY-MM-DD>/<track>/img/whatsapp.jpg
  <track> in {b2c, b2b-hotels, b2b-cabs-shikaras, b2b-houseboats}.
meta.json keys (the publisher needs these for unique titles):
  {
    "date","track","audience","theme","season","design":"A|B|C",
    "campaign_code":"VK-<CURRENCY>-<TRACK>-<YYYYMMDD>",
    "campaign_name":"<Track> <Theme or angle> [<CUR>] - <DD Mon YYYY>",
    "subject":"<short subject, no exclamation>",
    "items":["VK-CODE-##", ...],
    "promo_image":"<jsDelivr url of img/whatsapp.jpg>",
    "cta_url":"<https://viakashmir.in/  OR  https://viakashmir.in/sign-up?role=vendor>",
    "whatsapp_cta":"https://wa.me/919186051499"
  }
campaign_name MUST be unique per track per day (the publisher's idempotency key is the title). Also write a per-day manifest.json and
update _state/used-subjects.json (subjects NEVER reused) and _state/used-photos.json
(no repeating a lead photo two days running per track).

## COMMIT AND PUSH TO main
    git add content/via-kashmir
    test -n "$(git status --porcelain content/via-kashmir)" || { echo nothing_to_commit; exit 2; }
    git commit -m "content(via-kashmir): <YYYY-MM-DD> 3 sets (b2c + 2 b2b)"
    for d in 0 2 4 8 16; do
      [ "$d" -gt 0 ] && sleep "$d"
      if git push origin HEAD:main; then echo push_ok; break; fi
      git fetch origin main && (git merge-base --is-ancestor origin/main HEAD || git pull --rebase origin main) || { echo rebase_failed; exit 1; }
    done
PUSH HAPPENS BEFORE SEED. After push, HEAD-verify every image URL returns 200 (retry
loop, jsDelivr cold-cache) - only then seed (see PHOTOS step 3).

## SEED INTO THE CONTENT HUB DB
The publisher talks to Neon over HTTPS (port 443), so it works where 5432 is blocked,
and needs no database driver. It walks every <track> leaf for the date.
    python3 scripts/publish.py --date <YYYY-MM-DD>
It reuses the "via-kashmir" business, refreshes its logo/brand, and inserts each set's
html_email (WITH amp_content = email.amp.html), whatsapp, and linkedin caption,
idempotent on title. Required secret: DATABASE_URL. Optional: HUB_WORKSPACE, PIXABAY_API_KEY.
Capture its JSON {inserted, skipped, failures}. Either seeding OR the git push makes the
content appear at the hub; do BOTH so the repo and the hub stay in sync.

## SECRETS (set in the routine env, never in the repo)
  DATABASE_URL      postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require&channel_binding=require
  HUB_WORKSPACE     2faa195e-5817-4d32-8e6c-350b70ce32c3
  PIXABAY_API_KEY   optional, for fresh photos

## REPORT
One screen: date, commit hash, push (ok/failed), seed (inserted/skipped/failed), and
the 4 tracks (track, design A/B/C, theme, subject, codes).
