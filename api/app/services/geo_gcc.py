"""Lightweight GCC geo classification from lat/lng.

OSM/Google results often lack a clean country/city in the address, so we
classify from coordinates instead: country from bounding boxes, area from the
nearest major city. Pure-Python, no network, no DB — safe to call per result.
Outside the GCC it returns ("", "") and callers fall back to address parsing.
"""
from __future__ import annotations

import math
from typing import Optional

# (name, lat_min, lat_max, lng_min, lng_max) — tightest boxes first so overlaps resolve.
_COUNTRY_BOXES = [
    ("Bahrain", 25.50, 26.45, 50.20, 50.90),
    ("Qatar", 24.40, 26.25, 50.60, 51.70),
    ("Kuwait", 28.40, 30.15, 46.50, 48.60),
    ("United Arab Emirates", 22.60, 26.20, 51.00, 56.60),
    ("Oman", 16.40, 26.60, 51.90, 59.90),
    ("Saudi Arabia", 15.60, 32.20, 34.40, 55.80),  # catch-all last
]

# (name, country, lat, lng)
_CITIES = [
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
_MAX_CITY_KM = 90.0


def _country(lat: float, lng: float) -> str:
    for name, la0, la1, lo0, lo1 in _COUNTRY_BOXES:
        if la0 <= lat <= la1 and lo0 <= lng <= lo1:
            return name
    return ""


def _km(lat1, lng1, lat2, lng2) -> float:
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6371.0


def classify(lat: Optional[float], lng: Optional[float]) -> tuple[str, str]:
    """Return (country, area) for a coordinate, or ("", "") outside the GCC."""
    if lat is None or lng is None:
        return "", ""
    country = _country(lat, lng)
    if not country:
        return "", ""
    best, best_d = "", 1e9
    for name, ccountry, clat, clng in _CITIES:
        if ccountry != country:
            continue
        d = _km(lat, lng, clat, clng)
        if d < best_d:
            best, best_d = name, d
    return country, (best if best_d <= _MAX_CITY_KM else "")
