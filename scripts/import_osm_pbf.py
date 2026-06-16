#!/usr/bin/env python3
"""Extract businesses from an OpenStreetMap .osm.pbf extract into a CSV that
imports straight into Company Finder (the "Import CSV/JSON" button).

OSM is free and open (ODbL). Geofabrik publishes per-region extracts, e.g.
the GCC states: https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf

A "business" is any node/way that has a name AND one of the commercial keys
(shop, amenity, office, craft, healthcare, tourism, leisure). We pull name,
category, address, phone, website, email, opening hours, socials and lat/lng.

Usage:
    pip install osmium
    python3 scripts/import_osm_pbf.py /tmp/gcc.osm.pbf --out /tmp/gcc-businesses.csv
    # only businesses that have a phone or website or email (lead-ready subset):
    python3 scripts/import_osm_pbf.py /tmp/gcc.osm.pbf --out /tmp/leads.csv --contactable

Prints a summary (totals + top categories + contact-fill rates) to stdout.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter

import osmium

BUSINESS_KEYS = ("shop", "amenity", "office", "craft", "healthcare", "tourism", "leisure")
# Generic amenity values that aren't really "businesses" — skip the noise.
SKIP_AMENITY = {
    "bench", "waste_basket", "drinking_water", "toilets", "parking", "parking_space",
    "bicycle_parking", "fountain", "fire_hydrant", "shelter", "recycling", "grave_yard",
    "parking_entrance", "bbq", "clock", "vending_machine", "telephone", "post_box",
}

COLUMNS = [
    "name", "category", "phone", "email", "website", "address",
    "latitude", "longitude", "opening_hours", "instagram", "facebook",
    "place_id", "profile_url",
]


def _category(tags: dict) -> str:
    for k in BUSINESS_KEYS:
        v = tags.get(k)
        if v and v != "yes":
            return str(v).replace("_", " ")
    return (tags.get("cuisine") or "").replace(";", ", ")


def _address(tags: dict) -> str:
    parts = [
        " ".join(p for p in (tags.get("addr:housenumber"), tags.get("addr:street")) if p),
        tags.get("addr:district") or tags.get("addr:suburb") or tags.get("addr:neighbourhood"),
        tags.get("addr:city"),
        tags.get("addr:postcode"),
        tags.get("addr:country"),
    ]
    return ", ".join(p for p in parts if p)


def _is_business(tags: dict) -> bool:
    if "name" not in tags and "name:en" not in tags:
        return False
    if tags.get("amenity") in SKIP_AMENITY:
        return False
    return any(k in tags for k in BUSINESS_KEYS)


class BusinessHandler(osmium.SimpleHandler):
    def __init__(self, writer, contactable_only: bool):
        super().__init__()
        self.w = writer
        self.contactable_only = contactable_only
        self.total = 0
        self.with_phone = 0
        self.with_web = 0
        self.with_email = 0
        self.cats = Counter()
        self._seen = set()

    def _emit(self, tags: dict, lat, lon, osm_type: str, osm_id):
        if not _is_business(tags):
            return
        key = f"osm:{osm_type}/{osm_id}"
        if key in self._seen:
            return
        name = tags.get("name") or tags.get("name:en") or ""
        phone = tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile") or ""
        website = tags.get("website") or tags.get("contact:website") or ""
        email = tags.get("email") or tags.get("contact:email") or ""
        if self.contactable_only and not (phone or website or email):
            return
        self._seen.add(key)
        self.w.writerow([
            name, _category(tags), phone, email, website, _address(tags),
            lat if lat is not None else "", lon if lon is not None else "",
            tags.get("opening_hours", ""),
            tags.get("contact:instagram") or tags.get("instagram") or "",
            tags.get("contact:facebook") or tags.get("facebook") or "",
            key, f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
        ])
        self.total += 1
        if phone:
            self.with_phone += 1
        if website:
            self.with_web += 1
        if email:
            self.with_email += 1
        self.cats[_category(tags) or "(uncategorised)"] += 1

    def node(self, n):
        if n.tags and n.location.valid():
            self._emit(dict(n.tags), n.location.lat, n.location.lon, "node", n.id)

    def way(self, w):
        if not w.tags:
            return
        # Centroid of the way's nodes (needs locations=True on apply_file).
        lats, lons = [], []
        try:
            for node in w.nodes:
                if node.location.valid():
                    lats.append(node.location.lat)
                    lons.append(node.location.lon)
        except Exception:
            return
        if not lats:
            return
        self._emit(dict(w.tags), sum(lats) / len(lats), sum(lons) / len(lons), "way", w.id)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf", help="path to the .osm.pbf extract")
    ap.add_argument("--out", required=True, help="output CSV path")
    ap.add_argument("--contactable", action="store_true",
                    help="only emit businesses with a phone, website or email")
    args = ap.parse_args()

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        h = BusinessHandler(writer, args.contactable)
        # locations=True builds a node-location cache so ways get a centroid.
        h.apply_file(args.pbf, locations=True)

    print(f"\n=== {args.out} ===")
    print(f"businesses written : {h.total:,}")
    print(f"  with phone       : {h.with_phone:,} ({100*h.with_phone//max(h.total,1)}%)")
    print(f"  with website     : {h.with_web:,} ({100*h.with_web//max(h.total,1)}%)")
    print(f"  with email       : {h.with_email:,} ({100*h.with_email//max(h.total,1)}%)")
    print("top categories:")
    for cat, n in h.cats.most_common(25):
        print(f"  {n:>7,}  {cat}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
