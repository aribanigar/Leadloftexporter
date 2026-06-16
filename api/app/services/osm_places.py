"""OpenStreetMap business discovery — the FREE Company Finder source.

Unlike Google Places (paid, per-request), OSM data is free and unlimited. We
use two free, key-less OSM services:

  * Nominatim  — geocode an area name ("Dubai") to a bounding box.
  * Overpass   — pull every POI matching a niche inside that box.

Overpass has NO 60-result cap (Google's big limitation): one query returns the
whole city's matches. The trade-off is contact-data coverage — most OSM POIs
have name + category + location but no phone/website/email, especially outside
Western Europe. So OSM is best for free bulk discovery; enrich gaps with Google
only where needed.

Returned dicts use the same field names ``company_finder._normalize`` expects,
so results flow straight into ``company_finder.ingest(source="openstreetmap")``.
"""
from __future__ import annotations

import re
from typing import Any, Optional

import httpx

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# A couple of public Overpass mirrors — we try them in order on failure.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
_UA = {"User-Agent": "LeadCaptura/1.0 (Company Finder; lead-gen)"}

# Cap how many POIs one query returns so a huge city doesn't blow up the response.
_OUT_LIMIT = 3000


class OSMError(Exception):
    """Raised with a human-readable message when an OSM lookup fails."""


# Niche keyword → list of (osm_key, value-regex) filters. Covers the common
# lead-gen verticals; anything unrecognised falls back to a name search.
_NICHE_TAGS: dict[str, list[tuple[str, str]]] = {
    "restaurant": [("amenity", "restaurant|fast_food|food_court")],
    "food": [("amenity", "restaurant|fast_food|cafe|food_court")],
    "cafe": [("amenity", "cafe")], "coffee": [("amenity", "cafe")],
    "hotel": [("tourism", "hotel|guest_house|hostel|motel|apartment")],
    "accommodation": [("tourism", "hotel|guest_house|hostel|motel|apartment")],
    "dentist": [("amenity", "dentist"), ("healthcare", "dentist")],
    "doctor": [("amenity", "doctors|clinic"), ("healthcare", "doctor|clinic")],
    "clinic": [("amenity", "clinic"), ("healthcare", "clinic")],
    "hospital": [("amenity", "hospital")],
    "medical": [("amenity", "clinic|hospital|doctors|pharmacy"), ("healthcare", ".")],
    "pharmacy": [("amenity", "pharmacy")],
    "jewelry": [("shop", "jewelry")], "jewellery": [("shop", "jewelry")],
    "jeweller": [("shop", "jewelry")], "gold": [("shop", "jewelry")],
    "salon": [("shop", "hairdresser|beauty")], "beauty": [("shop", "beauty|hairdresser")],
    "spa": [("leisure", "spa"), ("shop", "beauty")],
    "barber": [("shop", "hairdresser")], "hairdresser": [("shop", "hairdresser")],
    "gym": [("leisure", "fitness_centre|sports_centre")], "fitness": [("leisure", "fitness_centre")],
    "school": [("amenity", "school")], "education": [("amenity", "school|college|university")],
    "nursery": [("amenity", "kindergarten")], "kindergarten": [("amenity", "kindergarten")],
    "real estate": [("office", "estate_agent")], "realtor": [("office", "estate_agent")],
    "property": [("office", "estate_agent")],
    "lawyer": [("office", "lawyer")], "law": [("office", "lawyer")], "legal": [("office", "lawyer")],
    "accountant": [("office", "accountant")], "insurance": [("office", "insurance")],
    "bakery": [("shop", "bakery|pastry")],
    "supermarket": [("shop", "supermarket")], "grocery": [("shop", "supermarket|convenience|greengrocer")],
    "clothing": [("shop", "clothes|boutique|fashion")], "fashion": [("shop", "clothes|boutique|fashion")],
    "boutique": [("shop", "clothes|boutique")],
    "electronics": [("shop", "electronics|mobile_phone|computer")],
    "mobile": [("shop", "mobile_phone")], "computer": [("shop", "computer")],
    "car": [("shop", "car|car_repair"), ("amenity", "car_rental")],
    "automotive": [("shop", "car|car_repair|car_parts")], "garage": [("shop", "car_repair")],
    "furniture": [("shop", "furniture")],
    "travel": [("shop", "travel_agency"), ("office", "travel_agent")],
    "bank": [("amenity", "bank")], "atm": [("amenity", "atm")],
    "gift": [("shop", "gift")], "gifts": [("shop", "gift")],
    "florist": [("shop", "florist")], "flowers": [("shop", "florist")],
    "bar": [("amenity", "bar|pub")], "pub": [("amenity", "pub")], "nightclub": [("amenity", "nightclub")],
    "laundry": [("shop", "laundry"), ("amenity", "laundry")],
    "optician": [("shop", "optician")], "optical": [("shop", "optician")],
    "office": [("office", ".")], "company": [("office", ".")], "business": [("office", ".")],
    "shop": [("shop", ".")], "store": [("shop", ".")], "retail": [("shop", ".")],
}

# Keys we treat as "this OSM element is a business" for the name-search fallback.
_BUSINESS_KEYS = ["shop", "amenity", "office", "craft", "healthcare", "tourism", "leisure"]


def _safe(s: str) -> str:
    """Sanitise free text for use inside an Overpass regex literal."""
    return re.sub(r'[^a-zA-Z0-9 &\-]', "", s or "").strip()


def geocode_area(area: str) -> Optional[dict]:
    """Resolve an area name to {south, west, north, east, label} via Nominatim."""
    area = (area or "").strip()
    if not area:
        return None
    try:
        r = httpx.get(
            NOMINATIM_URL,
            params={"q": area, "format": "json", "limit": 1, "addressdetails": 0},
            headers=_UA, timeout=20,
        )
    except httpx.HTTPError as e:
        raise OSMError(f"Couldn't reach OpenStreetMap geocoder: {e}") from e
    if r.status_code != 200:
        return None
    arr = r.json()
    if not arr:
        return None
    bb = arr[0].get("boundingbox")  # [south, north, west, east] as strings
    if not bb or len(bb) != 4:
        return None
    return {
        "south": float(bb[0]), "north": float(bb[1]),
        "west": float(bb[2]), "east": float(bb[3]),
        "label": arr[0].get("display_name") or area,
    }


def _build_query(niche: str, box: dict) -> str:
    s, w, n, e = box["south"], box["west"], box["north"], box["east"]
    bbox = f"({s},{w},{n},{e})"
    key = (niche or "").strip().lower()
    filters = _NICHE_TAGS.get(key)
    # Try a looser keyword match against the mapping (e.g. "gold shop" → "gold").
    if not filters:
        for token in key.split():
            if token in _NICHE_TAGS:
                filters = _NICHE_TAGS[token]
                break

    lines: list[str] = []
    if filters:
        for k, v in filters:
            for typ in ("node", "way", "relation"):
                lines.append(f'{typ}["{k}"~"{v}",i]{bbox};')
    else:
        # Fallback: match the niche against the POI name within business keys.
        rx = _safe(niche).replace(" ", ".*") or "."
        for bk in _BUSINESS_KEYS:
            for typ in ("node", "way", "relation"):
                lines.append(f'{typ}["{bk}"]["name"~"{rx}",i]{bbox};')
    body = "\n  ".join(lines)
    return f"[out:json][timeout:60];\n(\n  {body}\n);\nout center tags {_OUT_LIMIT};"


def _addr(tags: dict) -> str:
    parts = [
        " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")])),
        tags.get("addr:district") or tags.get("addr:suburb") or tags.get("addr:neighbourhood"),
        tags.get("addr:city"),
        tags.get("addr:postcode"),
        tags.get("addr:country"),
    ]
    return ", ".join(p for p in parts if p)


def _category(tags: dict) -> str:
    for k in ("shop", "amenity", "office", "craft", "healthcare", "tourism", "leisure"):
        if tags.get(k) and tags[k] != "yes":
            return str(tags[k]).replace("_", " ")
    return tags.get("cuisine", "").replace(";", ", ")


def _socials(tags: dict) -> dict:
    out: dict[str, list[str]] = {}
    for net in ("instagram", "facebook", "linkedin", "twitter", "youtube", "tiktok"):
        v = tags.get(f"contact:{net}") or tags.get(net)
        if v:
            out[net] = [v]
    return out


def _element_to_business(el: dict, area_label: str) -> Optional[dict]:
    tags = el.get("tags") or {}
    name = (tags.get("name") or tags.get("name:en") or "").strip()
    if not name:
        return None
    lat = el.get("lat") if el.get("lat") is not None else (el.get("center") or {}).get("lat")
    lon = el.get("lon") if el.get("lon") is not None else (el.get("center") or {}).get("lon")
    address = _addr(tags) or area_label
    return {
        "name": name,
        "phone": tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile") or "",
        "website": tags.get("website") or tags.get("contact:website") or "",
        "email": tags.get("email") or tags.get("contact:email") or "",
        "address": address,
        "category": _category(tags),
        "latitude": lat, "longitude": lon,
        # Stable OSM id so reruns are idempotent (dedup keys off place_id).
        "place_id": f"osm:{el.get('type','')}/{el.get('id','')}",
        "rating": "", "rating_count": "",
        "profile_url": (
            f"https://www.openstreetmap.org/{el.get('type','')}/{el.get('id','')}"
            if el.get("id") else ""
        ),
        "hours": {"opening_hours": tags["opening_hours"]} if tags.get("opening_hours") else {},
        **_socials(tags),
    }


def search(query: str) -> list[dict]:
    """Pull every OSM business matching ``query`` (e.g. "restaurants in Dubai").

    Splits on the last " in " into niche + area, geocodes the area, then runs a
    single Overpass query that returns ALL matches in the box (no result cap).
    """
    query = (query or "").strip()
    if not query:
        raise OSMError("Enter a search like 'restaurants in Dubai'.")
    niche, sep, area = query.rpartition(" in ")
    niche = (niche.strip() if sep else query) or query
    area = (area.strip() if sep else query) or query

    box = geocode_area(area)
    if not box:
        raise OSMError(f"Couldn't find the area '{area}' on OpenStreetMap. Try a city name.")

    overpass_q = _build_query(niche, box)
    last_err = ""
    for url in OVERPASS_URLS:
        try:
            r = httpx.post(url, data={"data": overpass_q}, headers=_UA, timeout=90)
        except httpx.HTTPError as e:
            last_err = str(e)
            continue
        if r.status_code == 200:
            elements = r.json().get("elements") or []
            out, seen = [], set()
            for el in elements:
                b = _element_to_business(el, box["label"])
                if not b:
                    continue
                if b["place_id"] in seen:
                    continue
                seen.add(b["place_id"])
                out.append(b)
            return out
        last_err = f"HTTP {r.status_code}"
    raise OSMError(f"OpenStreetMap is busy right now ({last_err}). Try again in a moment.")
