"""Google Places API (New) client — server-side business discovery.

This is the engine behind Company Finder. Instead of asking the user to scrape
Google Maps by hand, the backend queries Google's official Places API directly:
give it a text query like "restaurants in Dubai" and it returns every matching
business with name, address, phone, website and lat/lng — no browser, no
extension, no manual scrolling.

Uses the **Places API (New)** Text Search endpoint
(`POST https://places.googleapis.com/v1/places:searchText`) which returns the
phone number and website in the SAME response (the legacy API needed a separate
Place Details call per result). The caller supplies a Google Maps Platform API
key with "Places API (New)" enabled.

The returned dicts use the same field names `company_finder._normalize`
understands, so results flow straight into `company_finder.ingest()`.
"""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Only request the fields we store — a tight field mask keeps the response small
# and the per-request cost in the cheapest SKU tier.
FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.websiteUri",
    "places.types",
    "places.primaryTypeDisplayName",
    "places.rating",
    "places.userRatingCount",
    "places.googleMapsUri",
    "places.regularOpeningHours",
    "nextPageToken",
])


class PlacesError(Exception):
    """Raised with a human-readable message when Google rejects the request."""


def _hours_to_dict(opening: Any) -> dict:
    """Convert regularOpeningHours.weekdayDescriptions (list of
    'Monday: 9:00 AM – 5:00 PM' strings) into a {day: hours} dict."""
    out: dict[str, str] = {}
    if not isinstance(opening, dict):
        return out
    for line in opening.get("weekdayDescriptions") or []:
        if not isinstance(line, str) or ":" not in line:
            continue
        day, _, hrs = line.partition(":")
        out[day.strip()] = hrs.strip()
    return out


def _to_business(p: dict) -> Optional[dict]:
    """Map one Places API result to the company_finder ingest shape."""
    if not isinstance(p, dict):
        return None
    name = ((p.get("displayName") or {}).get("text") or "").strip()
    if not name:
        return None
    loc = p.get("location") or {}
    primary = (p.get("primaryTypeDisplayName") or {}).get("text") or ""
    types = p.get("types") or []
    category = primary or (", ".join(t.replace("_", " ") for t in types[:3]) if types else "")
    return {
        "name": name,
        # Prefer the local number; fall back to the international format.
        "phone": p.get("nationalPhoneNumber") or p.get("internationalPhoneNumber") or "",
        "website": p.get("websiteUri") or "",
        "address": p.get("formattedAddress") or "",
        "category": category,
        "latitude": loc.get("latitude"),
        "longitude": loc.get("longitude"),
        "place_id": p.get("id") or "",
        "rating": p.get("rating") or "",
        "rating_count": p.get("userRatingCount") or "",
        "profile_url": p.get("googleMapsUri") or "",
        "hours": _hours_to_dict(p.get("regularOpeningHours")),
    }


def search_text(
    api_key: str,
    query: str,
    *,
    max_pages: int = 3,
    region_code: str = "",
    language_code: str = "en",
) -> list[dict]:
    """Run a Places Text Search and return up to ``max_pages`` × 20 businesses.

    Google caps text-search pagination at ~60 results (3 pages of 20); to pull
    more, narrow the query by area (e.g. "restaurants in Deira" then
    "restaurants in Marina"). Raises PlacesError with a clear message on failure.
    """
    query = (query or "").strip()
    if not api_key:
        raise PlacesError("No Google API key configured.")
    if not query:
        raise PlacesError("Enter a search like 'restaurants in Dubai'.")

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": FIELD_MASK,
    }
    results: list[dict] = []
    page_token = ""
    pages = max(1, min(int(max_pages or 1), 5))

    for i in range(pages):
        body: dict[str, Any] = {"textQuery": query, "pageSize": 20, "languageCode": language_code}
        if region_code:
            body["regionCode"] = region_code
        if page_token:
            body["pageToken"] = page_token
        try:
            resp = httpx.post(SEARCH_URL, json=body, headers=headers, timeout=30)
        except httpx.HTTPError as e:
            raise PlacesError(f"Couldn't reach Google Places: {e}") from e

        if resp.status_code != 200:
            msg = ""
            try:
                msg = (resp.json().get("error") or {}).get("message") or ""
            except Exception:
                msg = resp.text[:300]
            if resp.status_code in (401, 403):
                raise PlacesError(
                    "Google rejected the API key (403). Make sure 'Places API (New)' "
                    "is enabled for this key and billing is on. Details: " + msg
                )
            raise PlacesError(f"Google Places error {resp.status_code}: {msg}")

        data = resp.json()
        for p in data.get("places") or []:
            b = _to_business(p)
            if b:
                results.append(b)
        page_token = data.get("nextPageToken") or ""
        if not page_token:
            break
        # The freshly-minted token needs a moment before it's valid.
        if i < pages - 1:
            time.sleep(2)

    return results
