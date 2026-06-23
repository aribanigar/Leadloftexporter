#!/usr/bin/env python3
"""
publish.py — seed the Content Hub DB for a daily content set.

Usage:
  python3 scripts/publish.py --date 2026-06-15 --slug via-kashmir-itinerary

Sets sensible defaults for known slugs, then delegates to publish_to_hub.py logic.
"""
import argparse, os, sys
from pathlib import Path

SLUG_DEFAULTS = {
    "via-kashmir-itinerary": {
        "HUB_BUSINESS_NAME": "ViaKashmir Itinerary",
        "HUB_BRAND_COLOR": "#00361a",
        "HUB_ACCENT_COLOR": "#9dd3aa",
        "HUB_LOGO_URL": "https://wsrv.nl/?url=viakashmir.in/logo-colour.svg&w=400&output=png",
        "HUB_WORKSPACE": "b2236a00-faa2-41d5-8ee7-b6e24d0c4904",
        "HUB_TONE": "confident",
    },
    "via-kashmir": {
        "HUB_BUSINESS_NAME": "ViaKashmir",
        "HUB_BRAND_COLOR": "#0e6b53",
        "HUB_ACCENT_COLOR": "#008138",
        "HUB_WORKSPACE": "b2236a00-faa2-41d5-8ee7-b6e24d0c4904",
        "HUB_TONE": "vibrant",
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--slug", required=True)
    args = ap.parse_args()

    os.environ["HUB_BUSINESS_SLUG"] = args.slug
    for k, v in SLUG_DEFAULTS.get(args.slug, {}).items():
        os.environ.setdefault(k, v)

    hub_script = Path(__file__).resolve().parent / "publish_to_hub.py"
    sys.argv = ["publish_to_hub.py", "--date", args.date]
    code = compile(hub_script.read_text(), str(hub_script), "exec")
    g = {"__name__": "__main__", "__file__": str(hub_script)}
    exec(code, g)


if __name__ == "__main__":
    main()
