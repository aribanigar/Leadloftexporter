#!/usr/bin/env python3
"""
content_daily_routine.py — INTERNET-BASED daily Content Hub refresh.

Runs once per day (via GitHub Actions cron at 06:00 UTC). For each
configured business, fetches today's news/topic items from FREE internet
sources (Google News RSS, Pixabay public listing pages), composes
per-channel assets in the SAME visual archetype the business already
uses in the live Content Hub, and inserts them via the Supabase REST API.

CRITICAL DESIGN RULES:
  1. ZERO LLM dependency. No OpenAI / Anthropic / model APIs touched.
     Content is fetched-from-source + template-substituted only.
  2. Every asset has an image_url (mandatory per user brief).
     Image strategy per business is baked into its profile.
  3. Idempotent: skip insert if (business_id, title) already exists.
     Same script can be re-run within the day safely.
  4. Stdlib only — urllib.request, xml.etree, json — so the GitHub
     Actions runner needs nothing pre-installed.

Run as:
  python3 scripts/content_daily_routine.py --all
  python3 scripts/content_daily_routine.py --business gifts-gulf
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
    """Read the Supabase service key. In production this comes from env;
    locally it's also baked into go_live.py for parity with the existing
    Date Khaas / QckServe publishers."""
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


# ─── HTTP helpers (stdlib only) ────────────────────────────────────────────
UA = "Mozilla/5.0 (LeadCaptura ContentRoutine/1.0)"


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


def rest(method: str, path: str, body=None, key: str | None = None) -> tuple[int, object]:
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


# ─── Google News RSS (FREE, no API key) ────────────────────────────────────
def google_news_rss(query: str, limit: int = 12) -> list[dict]:
    q = urllib.parse.quote_plus(query)
    body = _http_get(
        f"https://news.google.com/rss/search?q={q}&hl=en&gl=US&ceid=US:en"
    )
    if not body:
        return []
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return []
    out = []
    for item in root.findall(".//item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        desc = (item.findtext("description") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        # Strip embedded HTML tags from description.
        desc_text = re.sub(r"<[^>]+>", " ", desc)
        desc_text = re.sub(r"\s+", " ", _html.unescape(desc_text)).strip()
        out.append({"title": title, "url": link, "summary": desc_text[:400], "pub": pub})
    return out


# ─── Pixabay public-listing image scraper (FREE, no API key) ───────────────
# Pixabay's /images/search/<query>/ HTML page exposes the first few photo URLs
# inline; we parse them out. No API quota — same trick the existing Date
# Khaas content uses (Pixabay URLs are checked into the live assets).
_PIXABAY_IMG = re.compile(
    r'https?://[^\s"\']*pixabay\.com/get/[^\s"\']+?_1280\.(?:jpg|png|webp)',
    re.I,
)


def pixabay_images(query: str, limit: int = 6) -> list[str]:
    q = urllib.parse.quote_plus(query)
    body = _http_get(f"https://pixabay.com/images/search/{q}/")
    if not body:
        return []
    found, seen = [], set()
    for m in _PIXABAY_IMG.finditer(body):
        u = m.group(0)
        if u in seen:
            continue
        seen.add(u)
        found.append(u)
        if len(found) >= limit:
            break
    return found


# Fallback image source — Unsplash public Source endpoint, redirects to a
# random photo matching the keyword. Used when Pixabay returns nothing.
def unsplash_image(query: str) -> str:
    return f"https://source.unsplash.com/featured/1200x630/?{urllib.parse.quote_plus(query)}"


def pick_image(keywords: list[str]) -> str:
    """Try Pixabay first (matches the proven existing pattern in live
    assets — Date Khaas uses Pixabay URLs); fall back to Unsplash Source."""
    for kw in keywords:
        imgs = pixabay_images(kw, limit=3)
        if imgs:
            return imgs[0]
    return unsplash_image(keywords[0] if keywords else "business")


# ─── HTML escape helper for safe template substitution ─────────────────────
def esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ─── Per-business profiles ─────────────────────────────────────────────────
#
# Each profile defines:
#   id:          live content_businesses.id
#   workspace:   live workspaces.id
#   keywords:    list of Google News RSS query terms (rotates day-by-day)
#   image_kws:   image-search keywords for the daily hero photo
#   tags:        tags applied to every asset (vertical/identity tags)
#   channels:    list of channel kinds to publish each day
#   palette:     {primary, ink, paper} hex for the email template
#   wordmark:    visible brand wordmark inside the email
#   cta_url:     "Read more" link target
#   cta_label:   button label
#
# Profiles are tuned to MATCH each business's existing visual archetype as
# seen in the live Content Hub. Adding a new business = appending a profile.


BUSINESSES = {
    "gifts-gulf": {
        "id": "aa0f0f0f-a1a7-4f24-bfc4-7fcffe26341f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "keywords": [
            "corporate gifting Gulf 2026",
            "branded merchandise UAE",
            "promotional products GCC",
            "eco corporate gifts Middle East",
        ],
        "image_kws": ["corporate gift box premium", "branded merchandise"],
        "tags_base": ["gifts-gulf", "daily-drop"],
        "channels": ["html_email", "whatsapp", "caption"],
        "palette": {"primary": "#00a544", "ink": "#0c2417", "paper": "#f4faf6"},
        "wordmark": "giftsgulf.com",
        "cta_url": "https://giftsgulf.com",
        "cta_label": "Browse the catalogue",
        "audience": "procurement teams across the GCC",
        "voice": "polished, B2B",
    },
    "hudace": {
        "id": "7ab57d94-9f43-40e4-b6a0-1ca6575ce24c",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "keywords": [
            "SaaS for small business India",
            "ERP school management India",
            "fintech tools India 2026",
            "vertical SaaS India",
        ],
        "image_kws": ["business team office india", "saas product dashboard"],
        "tags_base": ["hudace", "daily-drop"],
        "channels": ["html_email", "whatsapp", "caption"],
        "palette": {"primary": "#00361a", "ink": "#0c2417", "paper": "#f4f7f5"},
        "wordmark": "hudace.com",
        "cta_url": "https://hudace.com",
        "cta_label": "See the products",
        "audience": "founders and operators",
        "voice": "confident, plain-English",
    },
    "via-kashmir-itinerary": {
        "id": "09cd7aef-81c3-4440-854f-5861d3cdca3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "keywords": [
            "travel itinerary builder",
            "Kashmir tourism 2026",
            "India travel agents B2B",
            "Saudi Arabia tourism boom",
            "Dubai travel agents",
        ],
        "image_kws": ["kashmir mountains tourism", "travel agent itinerary", "saudi arabia tourism", "dubai skyline"],
        "tags_base": ["via-kashmir-itinerary", "daily-drop"],
        "channels": ["html_email", "whatsapp", "caption"],
        "palette": {"primary": "#0e3d2f", "ink": "#0b2920", "paper": "#f1f6f3"},
        "wordmark": "viakashmir.com",
        "cta_url": "https://viakashmir.com",
        "cta_label": "Try the itinerary builder",
        "audience": "travel agents and tour operators",
        "voice": "warm, market-aware",
    },
    "collab-market": {
        "id": "bb716234-9b5d-4a97-81d0-d501bd1b6a3d",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "keywords": [
            "creator economy 2026",
            "influencer marketing India",
            "brand collaboration creators",
            "UGC creator pay",
        ],
        "image_kws": ["content creator phone studio", "influencer ring light"],
        "tags_base": ["collab-market", "daily-drop", "creator-recruitment"],
        "channels": ["html_email", "whatsapp", "caption"],
        "palette": {"primary": "#0891b2", "ink": "#0b2c34", "paper": "#f3f8fa"},
        "wordmark": "collabmarket.in",
        "cta_url": "https://collabmarket.in",
        "cta_label": "Get booked & paid",
        "audience": "creators and brands",
        "voice": "casual, peer-to-peer",
    },
    "date-khaas": {
        "id": "40d54b93-ac56-4441-bf23-4803153c551f",
        "workspace": "1a716353-9472-4c1d-ae89-f95052e8f015",
        "keywords": [
            "Muslim matrimony app 2026",
            "halal dating platform",
            "Muslim singles marriage trust",
            "Shaadi NikahForever review",
            "Islamic marriage app safety",
        ],
        "image_kws": ["muslim wedding couple", "nikah ceremony", "muslim family portrait"],
        "tags_base": ["date-khaas", "daily-drop"],
        "channels": ["html_email", "whatsapp", "caption"],
        "palette": {"primary": "#00361a", "ink": "#0b2417", "paper": "#f6f3ee"},
        "wordmark": "datekhaas.com",
        "cta_url": "https://datekhaas.com/join",
        "cta_label": "Find your match safely",
        "audience": "Muslim singles and their families",
        "voice": "warm, dignified, trust-first",
    },
}


# ─── Per-channel template builders ─────────────────────────────────────────
def build_html_email(item: dict, image_url: str, profile: dict) -> str:
    """Branded HTML email. Inline styles for max client compat. Hero image
    rendered with <img> so Outlook + Apple Mail show it; AMP body (separate
    field) is what Gmail renders for amp-img."""
    p = profile["palette"]
    title = esc(item["title"])
    summary = esc(item["summary"] or item["title"])
    url = esc(item["url"])
    img = esc(image_url)
    return (
        f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{title}</title></head>'
        f'<body style="margin:0;padding:0;background-color:{p["paper"]};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:{p["paper"]};">'
        f'<tr><td align="center" style="padding:24px 12px;">'
        f'<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">'
        f'<tr><td style="padding:24px 36px 8px 36px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.4px;color:{p["ink"]};">{esc(profile["wordmark"])}</td></tr>'
        f'<tr><td style="font-size:0;line-height:0;"><img src="{img}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>'
        f'<tr><td style="padding:32px 36px 6px 36px;font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.6px;color:{p["primary"]};text-transform:uppercase;">{esc(profile.get("audience", ""))}</td></tr>'
        f'<tr><td style="padding:6px 36px 16px 36px;font-family:Inter,Arial,sans-serif;font-size:30px;line-height:1.14;font-weight:800;color:{p["ink"]};letter-spacing:-0.6px;">{title}</td></tr>'
        f'<tr><td style="padding:0 36px 26px 36px;font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.6;color:#333;">{summary}</td></tr>'
        f'<tr><td align="left" style="padding:0 36px 36px 36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="{p["primary"]}" style="border-radius:12px;"><a href="{url}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;">{esc(profile["cta_label"])} →</a></td></tr></table></td></tr>'
        f'<tr><td style="background-color:{p["paper"]};padding:18px 36px;border-top:1px solid #e5e7eb;font-family:Inter,Arial,sans-serif;font-size:11.5px;line-height:1.55;color:#94a3b8;">Curated daily by {esc(profile["wordmark"])}. You\'re receiving this because you opted in.</td></tr>'
        f'</table></td></tr></table></body></html>'
    )


def build_amp_email(item: dict, image_url: str, profile: dict) -> str:
    """Valid AMP-for-Email body with <amp-img> + amp4email-boilerplate."""
    p = profile["palette"]
    title = esc(item["title"])
    summary = esc(item["summary"] or item["title"])
    url = esc(item["url"])
    img = esc(image_url)
    css = (
        f"body{{margin:0;padding:0;font-family:Inter,Arial,sans-serif;background:{p['paper']};color:{p['ink']}}}"
        ".wrap{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden}"
        ".bar{padding:24px 36px 8px;font-weight:700;letter-spacing:0.4px}"
        f".pill{{padding:32px 36px 6px;font-size:13px;font-weight:700;letter-spacing:1.6px;color:{p['primary']};text-transform:uppercase}}"
        "h1{padding:6px 36px 16px;font-size:30px;line-height:1.14;font-weight:800;letter-spacing:-0.6px;margin:0}"
        ".copy{padding:0 36px 26px;font-size:16px;line-height:1.6;color:#333}"
        f".cta{{display:inline-block;margin:0 36px 36px;padding:14px 26px;background:{p['primary']};color:#fff;border-radius:12px;text-decoration:none;font-weight:700}}"
        ".foot{padding:18px 36px;border-top:1px solid #e5e7eb;font-size:11.5px;color:#94a3b8}"
    )
    return (
        '<!doctype html><html ⚡4email lang="en"><head><meta charset="utf-8">'
        '<script async src="https://cdn.ampproject.org/v0.js"></script>'
        '<style amp4email-boilerplate>body{visibility:hidden}</style>'
        f'<style amp-custom>{css}</style></head><body>'
        f'<div class="wrap">'
        f'<div class="bar">{esc(profile["wordmark"])}</div>'
        f'<amp-img src="{img}" width="600" height="320" layout="responsive" alt=""></amp-img>'
        f'<div class="pill">{esc(profile.get("audience", ""))}</div>'
        f'<h1>{title}</h1>'
        f'<div class="copy">{summary}</div>'
        f'<a class="cta" href="{url}">{esc(profile["cta_label"])} →</a>'
        f'<div class="foot">Curated daily by {esc(profile["wordmark"])}.</div>'
        f'</div></body></html>'
    )


def build_whatsapp(item: dict, image_url: str, profile: dict) -> str:
    first = re.split(r"(?<=[.!?])\s+", item["summary"], maxsplit=1)
    snippet = first[0] if first else item["summary"]
    return (
        f"*{item['title']}*\n\n"
        f"{snippet}\n\n"
        f"Full story → {item['url']}\n\n"
        f"— {profile['wordmark']}"
    ).strip()


def build_caption(item: dict, image_url: str, profile: dict) -> str:
    tags_str = " ".join(f"#{t.replace('-', '')}" for t in profile["tags_base"])
    return (
        f"{item['title']}\n\n"
        f"{item['summary'][:240]}\n\n"
        f"More → {profile['cta_url']}\n\n"
        f"{tags_str}"
    ).strip()


# ─── One-business orchestrator ─────────────────────────────────────────────
def run_business(slug: str, *, date_s: str, dry_run: bool = False) -> dict:
    profile = BUSINESSES[slug]
    biz_id = profile["id"]
    ws_id = profile["workspace"]

    # 1. Rotate keyword for today so reruns within a day don't double-fetch
    #    the same Google News result. Use the date's day-of-year mod len.
    day_n = dt.date.fromisoformat(date_s).timetuple().tm_yday
    kw_idx = day_n % len(profile["keywords"])
    keyword = profile["keywords"][kw_idx]
    img_kw_idx = day_n % len(profile["image_kws"])
    image_kw = profile["image_kws"][img_kw_idx]

    print(f"[{slug}] keyword: {keyword!r}   image-kw: {image_kw!r}")

    # 2. Fetch internet items via Google News RSS.
    items = google_news_rss(keyword, limit=8)
    if not items:
        return {"slug": slug, "inserted": 0, "error": "no_news_items"}

    # 3. Pick best item (first non-empty title with a real URL).
    chosen = next((i for i in items if i["title"] and i["url"]), None)
    if not chosen:
        return {"slug": slug, "inserted": 0, "error": "no_usable_item"}

    # 4. Fetch hero image — Pixabay first (matches Date Khaas live pattern),
    #    Unsplash fallback. ALWAYS sets image_url per user brief.
    image_url = pick_image([image_kw, keyword])
    print(f"[{slug}] item: {chosen['title'][:70]!r}")
    print(f"[{slug}] image: {image_url[:90]}")

    # 5. Build channel-specific assets.
    today = date_s
    today_human = dt.date.fromisoformat(date_s).strftime("%-d %b %Y")
    base_tags = list(profile["tags_base"]) + [today]
    research = [{"source": chosen["url"], "insight": chosen["summary"]}]

    inserted, skipped = [], []
    for channel in profile["channels"]:
        title = f"[{today}] {profile.get('wordmark', slug)} · {channel} · {chosen['title'][:80]}"
        # Idempotency: skip if (business_id, title) exists.
        status, existing = rest(
            "GET",
            f"/content_assets?business_id=eq.{biz_id}&title=eq.{urllib.parse.quote(title)}&select=id",
        )
        if isinstance(existing, list) and existing:
            skipped.append(title)
            continue

        if channel == "html_email":
            content = build_html_email(chosen, image_url, profile)
            amp_content = build_amp_email(chosen, image_url, profile)
            subject = chosen["title"][:200]
            platform = None
        elif channel == "whatsapp":
            content = build_whatsapp(chosen, image_url, profile)
            amp_content = None
            subject = None
            platform = None
        elif channel == "caption":
            content = build_caption(chosen, image_url, profile)
            amp_content = None
            subject = None
            platform = "instagram"
        else:
            continue

        payload = {
            "id": str(uuid.uuid4()),
            "workspace_id": ws_id,
            "business_id": biz_id,
            "title": title,
            "type": channel,
            "content": content,
            "subject": subject,
            "platform": platform,
            "tags": base_tags + [channel, "auto-generated"],
            "amp_content": amp_content,
            "image_url": image_url,
            "notes": json.dumps({
                "generated_by": "content_daily_routine",
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "keyword": keyword,
                "image_keyword": image_kw,
                "research_sources": research,
            })[:8000],
        }

        if dry_run:
            inserted.append(title)
            print(f"  [DRY] would insert {title}")
            continue

        status, body = rest("POST", "/content_assets", payload)
        if status in (200, 201):
            inserted.append(title)
            print(f"  ✓ {title}")
        else:
            print(f"  ✗ {title} → {status} {str(body)[:160]}", file=sys.stderr)

    return {
        "slug": slug,
        "keyword": keyword,
        "image_kw": image_kw,
        "chosen_url": chosen["url"],
        "image_url": image_url,
        "inserted": len(inserted),
        "skipped": len(skipped),
    }


# ─── CLI ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="Run for every configured business")
    ap.add_argument("--business", help="Single business slug to run (e.g. gifts-gulf)")
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--dry-run", action="store_true", help="Don't insert; print what would happen")
    args = ap.parse_args()

    if not args.all and not args.business:
        ap.error("Pass --all or --business <slug>")

    targets = sorted(BUSINESSES.keys()) if args.all else [args.business]
    bad = [s for s in targets if s not in BUSINESSES]
    if bad:
        ap.error(f"Unknown business slug(s): {bad}. Known: {sorted(BUSINESSES.keys())}")

    report = {"date": args.date, "results": []}
    for slug in targets:
        try:
            r = run_business(slug, date_s=args.date, dry_run=args.dry_run)
        except Exception as e:  # noqa: BLE001
            r = {"slug": slug, "error": str(e)[:300]}
        report["results"].append(r)
        # Tiny politeness gap between businesses.
        time.sleep(1.5)

    print(json.dumps(report, indent=2))
    failures = sum(1 for r in report["results"] if "error" in r)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
