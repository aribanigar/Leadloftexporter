"""
build_email.py
--------------
Builds the CollabMarket influencer-recruitment email as a single self-contained
HTML string with Pixabay images embedded as base64 data URIs (so they render
inside the email client without external hosting / hotlink blocking).

Tone: creator-first, plain-spoken, benefit-led (Collabstr-style).

Usage:
    from build_email import build_email
    html = build_email()              # uses PIXABAY_API_KEY env var
    html = build_email(embed=False)   # uses remote Pixabay URLs instead of base64

Env:
    PIXABAY_API_KEY   required unless you pass api_key=...
"""

import os
import base64
import requests

PIXABAY_ENDPOINT = "https://pixabay.com/api/"

# Search terms chosen to feel premium + creator-coded, not stocky.
IMAGE_QUERIES = {
    "hero":    "content creator phone ring light",
    "money":   "smartphone payment success",
    "growth":  "social media analytics phone",
}

BRAND = {
    "name":      "CollabMarket",
    "url":       "https://www.collabmarket.in",
    "signup":    "https://www.collabmarket.in/auth/register",
    "ink":       "#0B0B0F",   # near-black
    "paper":     "#FFFFFF",
    "accent":    "#6C5CE7",   # violet (AI-match coded)
    "accent2":   "#00D1B2",   # mint (escrow / paid coded)
    "muted":     "#6B7280",
    "hairline":  "#ECECF1",
}


def _pixabay_image(query, api_key, min_w=1200):
    """Return (url, bytes|None, content_type) for the best landscape hit."""
    params = {
        "key": api_key,
        "q": query,
        "image_type": "photo",
        "orientation": "horizontal",
        "safesearch": "true",
        "per_page": 8,
        "min_width": min_w,
        "order": "popular",
    }
    r = requests.get(PIXABAY_ENDPOINT, params=params, timeout=30)
    r.raise_for_status()
    hits = r.json().get("hits", [])
    if not hits:
        raise RuntimeError(f"No Pixabay results for query: {query!r}")
    # largeImageURL is the highest-res safe field on the free tier
    url = hits[0].get("largeImageURL") or hits[0].get("webformatURL")
    return url


def _fetch_data_uri(url):
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    ctype = resp.headers.get("Content-Type", "image/jpeg").split(";")[0]
    b64 = base64.b64encode(resp.content).decode("ascii")
    return f"data:{ctype};base64,{b64}"


def _resolve_images(api_key, embed):
    out = {}
    for slot, query in IMAGE_QUERIES.items():
        url = _pixabay_image(query, api_key)
        out[slot] = _fetch_data_uri(url) if embed else url
    return out


def build_email(api_key=None, embed=True):
    api_key = api_key or os.environ.get("PIXABAY_API_KEY")
    if not api_key:
        raise RuntimeError("Set PIXABAY_API_KEY env var or pass api_key=...")

    img = _resolve_images(api_key, embed)
    b = BRAND

    # NOTE: email HTML = tables + inline styles. No flexbox, no <style> reliance.
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Get booked by real brands — {b['name']}</title>
</head>
<body style="margin:0;padding:0;background:#F4F4F7;-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<!-- preheader (hidden) -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
  Brands are already searching. Set your rates, get booked, get paid the day your work is approved.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F7;">
<tr><td align="center" style="padding:28px 16px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:{b['paper']};border-radius:18px;overflow:hidden;box-shadow:0 6px 30px rgba(11,11,15,0.06);">

    <!-- brand bar -->
    <tr><td style="padding:22px 32px 18px;">
      <span style="font-size:19px;font-weight:800;letter-spacing:-0.02em;color:{b['ink']};">Collab<span style="color:{b['accent']};">Market</span></span>
    </td></tr>

    <!-- hero image -->
    <tr><td style="padding:0;">
      <img src="{img['hero']}" width="600" alt="Creator filming content"
           style="display:block;width:100%;height:auto;border:0;">
    </td></tr>

    <!-- headline -->
    <tr><td style="padding:34px 32px 0;">
      <h1 style="margin:0;font-size:30px;line-height:1.18;font-weight:800;letter-spacing:-0.02em;color:{b['ink']};">
        Stop pitching brands in the DMs.<br>Let them book <span style="color:{b['accent']};">you</span>.
      </h1>
      <p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:{b['muted']};">
        You make the content. We bring the brands, handle the contract, and make sure
        you actually get paid. No agency cut. No three-month wait. No ghosting.
      </p>
    </td></tr>

    <!-- CTA 1 -->
    <tr><td style="padding:26px 32px 8px;">
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr><td style="border-radius:12px;background:{b['ink']};">
          <a href="{b['signup']}" style="display:inline-block;padding:15px 28px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;border-radius:12px;">
            Claim your creator profile — free →
          </a>
        </td></tr>
      </table>
      <p style="margin:10px 0 0;font-size:13px;color:{b['muted']};">
        Free to join · No credit card · Takes about 4 minutes
      </p>
    </td></tr>

    <!-- divider -->
    <tr><td style="padding:30px 32px 0;"><div style="height:1px;background:{b['hairline']};"></div></td></tr>

    <!-- benefit: get paid -->
    <tr><td style="padding:28px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td valign="top" width="120" style="padding-right:18px;">
            <img src="{img['money']}" width="120" alt="Paid"
                 style="display:block;width:120px;height:90px;object-fit:cover;border-radius:12px;border:0;">
          </td>
          <td valign="top">
            <p style="margin:0;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:{b['accent2']};">Paid on approval</p>
            <p style="margin:6px 0 0;font-size:16px;font-weight:700;color:{b['ink']};">The money's already in escrow before you film.</p>
            <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:{b['muted']};">
              Brands fund the deal up front. The day they approve your content, it's released to you. You never chase an invoice again.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- benefit: get found -->
    <tr><td style="padding:22px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td valign="top" width="120" style="padding-right:18px;">
            <img src="{img['growth']}" width="120" alt="Get found"
                 style="display:block;width:120px;height:90px;object-fit:cover;border-radius:12px;border:0;">
          </td>
          <td valign="top">
            <p style="margin:0;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:{b['accent']};">Get discovered</p>
            <p style="margin:6px 0 0;font-size:16px;font-weight:700;color:{b['ink']};">Brands search by niche, audience and rate — and find you.</p>
            <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:{b['muted']};">
              Set your packages once. Our AI matches you to campaigns that fit your audience, so the right brands land in your inbox instead of the wrong ones.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- proof line -->
    <tr><td style="padding:28px 32px 0;">
      <div style="background:#FAFAFD;border:1px solid {b['hairline']};border-radius:14px;padding:18px 20px;">
        <p style="margin:0;font-size:15px;line-height:1.55;color:{b['ink']};">
          "I used to chase brands in my DMs and wait months to get paid. Now serious brands book me here and I get paid the day my content is approved."
        </p>
        <p style="margin:8px 0 0;font-size:13px;color:{b['muted']};">— Layla H., lifestyle creator</p>
      </div>
    </td></tr>

    <!-- CTA 2 -->
    <tr><td style="padding:28px 32px 4px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" align="center">
        <tr><td style="border-radius:12px;background:{b['accent']};">
          <a href="{b['signup']}" style="display:inline-block;padding:16px 34px;font-size:16px;font-weight:800;color:#fff;text-decoration:none;border-radius:12px;">
            Join CollabMarket — it's free
          </a>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:12px 32px 34px;" align="center">
      <p style="margin:0;font-size:13px;color:{b['muted']};">
        Spots in each niche are limited so brands see quality first. Grab yours today.
      </p>
    </td></tr>

    <!-- footer -->
    <tr><td style="padding:22px 32px;background:#0B0B0F;">
      <p style="margin:0;font-size:13px;color:#A7A7B4;line-height:1.6;">
        CollabMarket — where creators get booked and paid.<br>
        <a href="{b['url']}" style="color:#fff;text-decoration:none;">collabmarket.in</a>
        &nbsp;·&nbsp;
        <a href="{{{{unsubscribe_url}}}}" style="color:#A7A7B4;text-decoration:underline;">Unsubscribe</a>
      </p>
    </td></tr>

  </table>

  <p style="margin:18px 0 0;font-size:11px;color:#9AA0AB;">You're receiving this because you create content brands want to work with.</p>

</td></tr>
</table>
</body>
</html>
"""


if __name__ == "__main__":
    html = build_email()
    with open("collabmarket_email.html", "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote collabmarket_email.html ({len(html):,} bytes)")
