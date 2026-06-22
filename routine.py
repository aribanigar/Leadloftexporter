#!/usr/bin/env python3
"""
routine.py — CollabMarket end-to-end publishing routine
=======================================================
fetch Pixabay images -> build HTML email -> publish to content_assets (collab-market)

Safe by default: DRY RUN unless you pass --commit.

Setup (.env or exported):
    PIXABAY_API_KEY / PIXABAY_API   (image sourcing)
    SUPABASE_URL                    (https://<ref>.supabase.co)
    SUPABASE_SERVICE_KEY            (service role key)
    HUB_WORKSPACE                   (workspace uuid)

Usage:
    python routine.py                      # dry-run: build + preview, no writes
    python routine.py --commit             # insert a new asset
    python routine.py --commit --update    # overwrite the same-titled asset
    python routine.py --commit --embed     # inline images (Gmail clips >102KB)
    python routine.py --type whatsapp --commit
"""

import os
import sys
import argparse

# load .env if present (no hard dependency on python-dotenv)
def _load_dotenv(path=".env"):
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

_load_dotenv()

# Accept PIXABAY_API as an alias for PIXABAY_API_KEY
if os.environ.get("PIXABAY_API") and not os.environ.get("PIXABAY_API_KEY"):
    os.environ["PIXABAY_API_KEY"] = os.environ["PIXABAY_API"]

from build_email import build_email          # noqa: E402
import publish as pub                          # noqa: E402


def step(n, msg):
    print(f"\n[{n}] {msg}")


def main():
    ap = argparse.ArgumentParser(description="CollabMarket publish routine")
    ap.add_argument("--commit", action="store_true", help="Write to DB (default dry-run)")
    ap.add_argument("--update", action="store_true", help="Overwrite same-titled asset")
    ap.add_argument("--embed",  action="store_true", help="Inline images as base64")
    ap.add_argument("--type",   default="html_email")
    ap.add_argument("--title",  default=None)
    ap.add_argument("--subject", default=None)
    args = ap.parse_args()

    required = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HUB_WORKSPACE", "PIXABAY_API_KEY"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        sys.exit("ERROR: missing env vars: " + ", ".join(missing))

    if args.type not in pub.VALID_TYPES:
        sys.exit(f"ERROR: --type must be one of {sorted(pub.VALID_TYPES)}")

    step(1, "Resolving business + workspace")
    biz = pub.resolve_business_id()
    print(f"  {biz['name']}  business_id={biz['id']}")
    print(f"  workspace_id={biz['workspace_id']}")

    step(2, f"Building email (type={args.type}, embed={args.embed})")
    html = build_email(embed=args.embed)
    with open("collabmarket_email.html", "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  built {len(html):,} bytes -> collabmarket_email.html")
    if args.embed and len(html) > 102_000:
        print("  WARNING over ~102KB: Gmail may clip. Consider dropping --embed.")

    step(3, "Publishing" if args.commit else "Dry-run (no DB write)")
    pub.publish(
        ctype=args.type,
        embed=args.embed,
        dry_run=not args.commit,
        title=args.title,
        subject=args.subject,
        update=args.update,
    )

    print("\nDone." + ("" if args.commit else "  Re-run with --commit to write."))


if __name__ == "__main__":
    main()
