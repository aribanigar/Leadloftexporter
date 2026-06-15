"""Company Finder — ingest Google-Maps-scraped businesses and derive a
country → area → zone → street → building hierarchy from the address + lat/lng.

No external geocoding API: the hierarchy is parsed from the address string and
"same building" grouping keys off the rounded lat/lng (businesses in one
building share coordinates), falling back to a street+area slug.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import CompanyFinderBusiness

_LEADING_NUM = re.compile(r"^[\d/\-\s,#\.]+")


def _clean(v: Any) -> str:
    return ("" if v is None else str(v)).strip()


def _derive_hierarchy(address: str, lat: Optional[float], lng: Optional[float]) -> dict:
    parts = [p.strip() for p in (address or "").split(",") if p.strip()]
    country = parts[-1] if len(parts) >= 1 else ""
    area = parts[-2] if len(parts) >= 2 else ""        # city
    zone = parts[-3] if len(parts) >= 3 else ""        # neighbourhood / district
    street_line = parts[0] if parts else ""
    building = street_line
    street = _LEADING_NUM.sub("", street_line).strip() or street_line
    # If the first line is just a number, the real street name is the next part.
    if street_line and street_line.replace(" ", "").isdigit() and len(parts) >= 2:
        street = parts[1]
    if lat is not None and lng is not None:
        building_key = f"{round(float(lat), 5)},{round(float(lng), 5)}"
    else:
        slug = re.sub(r"[^a-z0-9]+", "-", (street_line + "|" + area).lower()).strip("-")
        building_key = slug[:120] or "unknown"
    return {
        "country": country[:120], "area": area[:200], "zone": zone[:200],
        "street": street[:300], "building": building[:300], "building_key": building_key,
    }


def _to_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if -90 <= f <= 180 else None
    except (TypeError, ValueError):
        return None


# Map the many possible keys (extension parser, CSV headers, scraper export).
_KEYS = {
    "name": ["name", "business_name", "title"],
    "phone": ["phone", "phone_number", "tel", "contact"],
    "email": ["email", "emails", "email_address"],
    "website": ["website", "site", "url", "web"],
    "address": ["address", "full_address", "location", "addr"],
    "category": ["category", "niche", "type", "business_type", "categories"],
    "latitude": ["latitude", "lat"],
    "longitude": ["longitude", "lng", "lon", "long"],
    "place_id": ["place_id", "placeid", "fid"],
    "cid": ["cid"],
    "rating": ["rating", "averageRating", "average_rating", "stars"],
    "rating_count": ["rating_count", "ratingCount", "reviews", "review_count"],
    "profile_url": ["profile_url", "profileURL", "maps_url", "google_url"],
}
_SOCIAL_KEYS = ["instagram", "facebook", "linkedin", "twitter", "youtube", "tiktok"]


def _pick(raw: dict, keys: list[str]) -> str:
    for k in keys:
        if k in raw and _clean(raw[k]):
            return _clean(raw[k])
        # case-insensitive
        for rk in raw:
            if rk.lower() == k.lower() and _clean(raw[rk]):
                return _clean(raw[rk])
    return ""


def _normalize(raw: dict) -> Optional[dict]:
    name = _pick(raw, _KEYS["name"])
    if not name:
        return None
    lat = _to_float(_pick(raw, _KEYS["latitude"]) or None)
    lng = _to_float(_pick(raw, _KEYS["longitude"]) or None)
    address = _pick(raw, _KEYS["address"])
    place_id = _pick(raw, _KEYS["place_id"])
    cid = _pick(raw, _KEYS["cid"])
    socials: dict[str, list[str]] = {}
    for sk in _SOCIAL_KEYS:
        val = raw.get(sk)
        if val:
            socials[sk] = [v for v in re.split(r"[,\s;]+", _clean(val)) if v] if isinstance(val, str) else list(val)
    # hours: pass through any day_* keys or an "hours" dict
    hours = raw.get("hours") if isinstance(raw.get("hours"), dict) else {}
    item = {
        "name": name[:400],
        "phone": _pick(raw, _KEYS["phone"])[:60],
        "email": _pick(raw, _KEYS["email"])[:400],
        "website": _pick(raw, _KEYS["website"])[:600],
        "address": address,
        "category": _pick(raw, _KEYS["category"])[:300],
        "latitude": lat, "longitude": lng,
        "place_id": place_id[:120], "cid": cid[:120],
        "rating": _pick(raw, _KEYS["rating"])[:20],
        "rating_count": _pick(raw, _KEYS["rating_count"])[:40],
        "profile_url": (_pick(raw, _KEYS["profile_url"]) or (f"https://www.google.com/maps?cid={cid}" if cid else ""))[:600],
        "socials": socials, "hours": hours,
    }
    item.update(_derive_hierarchy(address, lat, lng))
    # dedup key: prefer google ids, else a hash of name+address
    item["dedup_key"] = (place_id or cid or hashlib.sha1(f"{name}|{address}".lower().encode()).hexdigest())[:200]
    return item


def ingest(db: Session, workspace_id: str, raw_items: list[dict], source: str = "extension") -> dict:
    """Upsert businesses. Existing rows (by workspace_id + dedup_key) are updated
    with any newly-found fields (e.g. an email discovered on a later pass)."""
    seen: dict[str, CompanyFinderBusiness] = {}
    inserted = updated = skipped = 0
    for raw in raw_items or []:
        if not isinstance(raw, dict):
            continue
        item = _normalize(raw)
        if not item:
            skipped += 1
            continue
        key = item["dedup_key"]
        existing = seen.get(key)
        if existing is None:
            existing = (
                db.query(CompanyFinderBusiness)
                .filter(CompanyFinderBusiness.workspace_id == workspace_id,
                        CompanyFinderBusiness.dedup_key == key)
                .first()
            )
        if existing:
            # Fill only empty/missing fields; never blank an existing value.
            for f in ("phone", "email", "website", "address", "category", "rating",
                      "rating_count", "profile_url", "country", "area", "zone",
                      "street", "building", "building_key", "latitude", "longitude"):
                if not getattr(existing, f) and item.get(f):
                    setattr(existing, f, item[f])
            if item["socials"]:
                merged = dict(existing.socials or {})
                for k, v in item["socials"].items():
                    merged[k] = sorted(set((merged.get(k) or []) + v))
                existing.socials = merged
            if item["hours"] and not existing.hours:
                existing.hours = item["hours"]
            seen[key] = existing
            updated += 1
        else:
            row = CompanyFinderBusiness(workspace_id=workspace_id, source=source, **item)
            db.add(row)
            seen[key] = row
            inserted += 1
    db.commit()
    return {"inserted": inserted, "updated": updated, "skipped": skipped,
            "total": inserted + updated}
