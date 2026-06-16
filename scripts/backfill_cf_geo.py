#!/usr/bin/env python3
"""Backfill Company Finder country + area (city) from lat/lng.

OSM POIs rarely carry a clean addr:country, so the address-derived hierarchy is
noisy. Coordinates are reliable, so we classify each business's country from GCC
bounding boxes and assign the nearest major city as the area. Updates the DB in
batches over Neon's HTTPS SQL endpoint, keyed on (workspace_id, dedup_key).

Usage:
    DATABASE_URL='…neon.tech/neondb?sslmode=require' CF_WORKSPACE='<uuid>' \
    python3 scripts/backfill_cf_geo.py /tmp/gcc-all.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Country bounding boxes, checked tightest-first so overlaps resolve correctly.
# (name, lat_min, lat_max, lng_min, lng_max)
COUNTRY_BOXES = [
    ("Bahrain", 25.50, 26.45, 50.20, 50.90),
    ("Qatar", 24.40, 26.25, 50.60, 51.70),
    ("Kuwait", 28.40, 30.15, 46.50, 48.60),
    ("United Arab Emirates", 22.60, 26.20, 51.00, 56.60),
    ("Oman", 16.40, 26.60, 51.90, 59.90),
    ("Saudi Arabia", 15.60, 32.20, 34.40, 55.80),  # catch-all last
]

# Major cities (name, country, lat, lng) → nearest one becomes the "area".
CITIES = [
    ("Dubai", "United Arab Emirates", 25.20, 55.27),
    ("Abu Dhabi", "United Arab Emirates", 24.45, 54.38),
    ("Sharjah", "United Arab Emirates", 25.35, 55.39),
    ("Ajman", "United Arab Emirates", 25.41, 55.44),
    ("Ras Al Khaimah", "United Arab Emirates", 25.79, 55.94),
    ("Fujairah", "United Arab Emirates", 25.13, 56.33),
    ("Umm Al Quwain", "United Arab Emirates", 25.56, 55.55),
    ("Al Ain", "United Arab Emirates", 24.21, 55.74),
    ("Riyadh", "Saudi Arabia", 24.71, 46.68),
    ("Jeddah", "Saudi Arabia", 21.49, 39.19),
    ("Mecca", "Saudi Arabia", 21.39, 39.86),
    ("Medina", "Saudi Arabia", 24.47, 39.61),
    ("Dammam", "Saudi Arabia", 26.43, 50.10),
    ("Al Khobar", "Saudi Arabia", 26.28, 50.21),
    ("Dhahran", "Saudi Arabia", 26.29, 50.12),
    ("Taif", "Saudi Arabia", 21.27, 40.42),
    ("Tabuk", "Saudi Arabia", 28.38, 36.57),
    ("Buraidah", "Saudi Arabia", 26.36, 43.98),
    ("Hail", "Saudi Arabia", 27.52, 41.69),
    ("Abha", "Saudi Arabia", 18.22, 42.50),
    ("Jubail", "Saudi Arabia", 27.01, 49.66),
    ("Al Hofuf", "Saudi Arabia", 25.36, 49.59),
    ("Najran", "Saudi Arabia", 17.49, 44.13),
    ("Yanbu", "Saudi Arabia", 24.09, 38.06),
    ("Khamis Mushait", "Saudi Arabia", 18.31, 42.73),
    ("Doha", "Qatar", 25.29, 51.53),
    ("Al Rayyan", "Qatar", 25.29, 51.42),
    ("Al Wakrah", "Qatar", 25.17, 51.60),
    ("Al Khor", "Qatar", 25.68, 51.50),
    ("Kuwait City", "Kuwait", 29.38, 47.99),
    ("Al Ahmadi", "Kuwait", 29.08, 48.08),
    ("Hawalli", "Kuwait", 29.33, 48.03),
    ("Al Jahra", "Kuwait", 29.34, 47.66),
    ("Manama", "Bahrain", 26.22, 50.58),
    ("Riffa", "Bahrain", 26.13, 50.55),
    ("Muharraq", "Bahrain", 26.26, 50.61),
    ("Muscat", "Oman", 23.59, 58.41),
    ("Salalah", "Oman", 17.02, 54.09),
    ("Sohar", "Oman", 24.34, 56.71),
    ("Nizwa", "Oman", 22.93, 57.53),
    ("Sur", "Oman", 22.57, 59.53),
]
MAX_CITY_KM = 90.0  # assign a city as "area" only within this radius


def country_for(lat: float, lng: float):
    for name, la0, la1, lo0, lo1 in COUNTRY_BOXES:
        if la0 <= lat <= la1 and lo0 <= lng <= lo1:
            return name
    return ""


def _km(lat1, lng1, lat2, lng2):
    # Equirectangular approximation — plenty accurate at city scale.
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6371.0


def area_for(lat: float, lng: float, country: str):
    best, best_d = "", 1e9
    for name, ccountry, clat, clng in CITIES:
        if country and ccountry != country:
            continue
        d = _km(lat, lng, clat, clng)
        if d < best_d:
            best, best_d = name, d
    return best if best_d <= MAX_CITY_KM else ""


def normalize_dsn(url: str) -> str:
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


class Neon:
    def __init__(self, dsn: str):
        self.conn = normalize_dsn(dsn)
        self.url = "https://%s/sql" % urlparse(self.conn).hostname

    def q(self, sql: str, params=None):
        body = json.dumps({"query": sql, "params": params or []}).encode()
        req = Request(self.url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Neon-Connection-String": self.conn,
            "Neon-Raw-Text-Output": "true",
        })
        try:
            with urlopen(req, timeout=60) as r:
                return json.loads(r.read()).get("rows", [])
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--workspace", default=os.environ.get("CF_WORKSPACE"))
    args = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn or not args.workspace:
        raise SystemExit("Set DATABASE_URL and CF_WORKSPACE.")

    n = Neon(dsn)
    ws = args.workspace

    text = Path(args.csv).read_text(encoding="utf-8", errors="replace")
    updates = []  # (dedup_key, country, area)
    for row in csv.DictReader(text.splitlines()):
        pid = (row.get("place_id") or "").strip()  # == dedup_key for OSM rows
        lat, lng = _f(row.get("latitude")), _f(row.get("longitude"))
        if not pid or lat is None or lng is None:
            continue
        c = country_for(lat, lng)
        a = area_for(lat, lng, c)
        updates.append((pid, c, a))

    BATCH = 300
    done = 0
    for i in range(0, len(updates), BATCH):
        chunk = updates[i:i + BATCH]
        vals, params, p = [], [], 1
        for dk, c, a in chunk:
            vals.append(f"(${p},${p+1},${p+2})")
            params += [dk, c, a]
            p += 3
        params.append(ws)
        sql = (
            "update company_finder_businesses as t set country=v.country, area=v.area "
            f"from (values {','.join(vals)}) as v(dedup_key,country,area) "
            f"where t.dedup_key=v.dedup_key and t.workspace_id=${p}"
        )
        n.q(sql, params)
        done += len(chunk)
        print(f"  …{done:,}/{len(updates):,}", flush=True)

    # Report the cleaned distribution.
    dist = n.q("select country, count(*) c from company_finder_businesses "
               "where workspace_id=$1 group by country order by c desc", [ws])
    print(json.dumps({"updated": len(updates),
                      "countries": {(r["country"] or "(blank)"): int(r["c"]) for r in dist}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
