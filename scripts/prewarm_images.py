#!/usr/bin/env python3
"""Validate + pre-warm every product image for a Gifts Gulf day.

Why this exists
---------------
Email images point at giftsgulf.com's Next.js image optimizer:

    https://www.giftsgulf.com/_next/image?url=<encoded midocean original>&w=640&q=75

On a COLD cache the optimizer must download the ~4.5MB midocean original,
resize it, and return it. That can take several seconds. Gmail's image proxy
(googleusercontent.com) has a short timeout: if the first fetch is slow OR the
midocean code 404s, Gmail caches the FAILURE and shows a broken tile forever
for that message. The working emails only rendered because their variants were
already warm.

This script, run right after content generation and BEFORE publish/send:
  1. Reads every meta.json under content/gifts-gulf/<DATE>/.
  2. GETs each product's optimized image URL (warming Vercel's edge cache) with
     retries.
  3. Flags any image that does not return HTTP 200 + an image/* content-type so
     the routine can swap or drop that product instead of shipping a blank tile.

Exit code is 0 when every image is good, 1 when any image failed (so the
routine's STEP can treat a bad day as a hard error and re-pick products).

Usage:
    python scripts/prewarm_images.py --date 2026-06-13
    python scripts/prewarm_images.py --date 2026-06-13 --retries 4 --timeout 20
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def _check(url: str, timeout: int, retries: int) -> tuple[bool, str]:
    """GET the URL (warming the CDN). Return (ok, detail). A 200 with an
    image/* content-type is a pass; anything else after all retries fails."""
    last = ""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                method="GET",
                headers={
                    # Mimic a real client so the optimizer + any WAF behave the
                    # same way Gmail's proxy will.
                    "User-Agent": "Mozilla/5.0 (compatible; GiftsGulfWarm/1.0)",
                    "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                ctype = r.headers.get("Content-Type", "")
                # Read a little to ensure the body is real, then discard.
                chunk = r.read(2048)
                if r.status == 200 and ctype.startswith("image/") and chunk:
                    return True, f"200 {ctype}"
                last = f"status={r.status} type={ctype} bytes={len(chunk)}"
        except urllib.error.HTTPError as e:
            last = f"http_{e.code}"
        except Exception as e:  # noqa: BLE001 - report any transport error
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(2 ** attempt, 8))
    return False, last


def warm_day(date: str, root: Path, timeout: int, retries: int) -> dict:
    day_dir = root / date
    if not day_dir.is_dir():
        raise SystemExit(f"no such day directory: {day_dir}")

    seen: dict[str, tuple[bool, str]] = {}   # url -> result (dedup across sets)
    checked = warmed = 0
    failures: list[dict] = []

    for meta_path in sorted(day_dir.glob("*/set-*/meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            failures.append({"meta": str(meta_path), "error": f"bad_meta_json: {e}"})
            continue
        for prod in meta.get("products", []):
            url = (prod.get("image") or "").strip()
            if not url:
                failures.append({
                    "set": str(meta_path.parent),
                    "sku": prod.get("sku"),
                    "error": "no_image_url",
                })
                continue
            if url in seen:
                ok, _ = seen[url]
            else:
                ok, detail = _check(url, timeout, retries)
                seen[url] = (ok, detail)
                checked += 1
                if ok:
                    warmed += 1
                else:
                    failures.append({
                        "set": str(meta_path.parent),
                        "sku": prod.get("sku"),
                        "name": prod.get("name"),
                        "image": url,
                        "error": detail,
                    })

    return {
        "date": date,
        "unique_images": checked,
        "warmed_ok": warmed,
        "failed": len(failures),
        "failures": failures,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate + pre-warm Gifts Gulf images.")
    ap.add_argument("--date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--root", default="content/gifts-gulf", type=Path)
    ap.add_argument("--timeout", type=int, default=20)
    ap.add_argument("--retries", type=int, default=4)
    args = ap.parse_args()

    report = warm_day(args.date, args.root, args.timeout, args.retries)
    print(json.dumps(report, indent=2))
    # Non-zero exit when any image is bad, so the routine can react.
    sys.exit(1 if report["failed"] else 0)


if __name__ == "__main__":
    main()
