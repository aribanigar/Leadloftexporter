#!/usr/bin/env python3
"""
routine.py  — CollabMarket content-hub publishing routine
==========================================================
    fetch Pixabay images  ->  build the HTML email  ->  publish to content_assets

Safe by default: inspects schema and dry-runs unless you pass --commit.

SETUP:
    export SUPABASE_URL="https://cmdnezltteldysoxyjzh.supabase.co"
    export SUPABASE_SERVICE_KEY="sb_secret_..."
    export HUB_WORKSPACE="1a716353-9472-4c1d-ae89-f95052e8f015"
    export PIXABAY_API_KEY="..."

USAGE:
    python routine.py                        # inspect + dry-run (no writes)
    python routine.py --commit               # actually insert the row
    python routine.py --commit --embed       # embed images as base64
    python routine.py --commit --type html_email
"""

import os
import sys
import argparse

from build_email import build_email
import publish as pub


def step(n, msg):
    print(f"\n\033[1m[{n}]\033[0m {msg}")


def main():
    ap = argparse.ArgumentParser(description="CollabMarket publish routine")
    ap.add_argument("--commit",       action="store_true", help="Write to DB (default: dry-run)")
    ap.add_argument("--embed",        action="store_true", help="Inline images as base64")
    ap.add_argument("--type",         default="html_email")
    ap.add_argument("--skip-inspect", action="store_true", help="Skip schema print")
    args = ap.parse_args()

    # preflight
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HUB_WORKSPACE", "PIXABAY_API_KEY")
               if not os.environ.get(k)]
    if missing:
        sys.exit(f"ERROR: missing env vars: {', '.join(missing)}")

    if args.type not in pub.VALID_TYPES:
        sys.exit(f"ERROR: --type must be one of {sorted(pub.VALID_TYPES)}")

    # 1. inspect
    if not args.skip_inspect:
        step(1, "Inspecting content-hub schema")
        try:
            pub.inspect()
        except Exception as e:
            print(f"  (inspect skipped: {e})")

    # 2. build
    step(2, f"Building email  (embed={args.embed})")
    html = build_email(embed=args.embed)
    with open("collabmarket_email.html", "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  built {len(html):,} bytes -> collabmarket_email.html")
    if args.embed and len(html) > 102_000:
        print("  WARNING: over ~102KB — Gmail may clip this. Consider dropping --embed.")

    # 3. publish
    step(3, "Publishing" if args.commit else "Dry-run (no DB write)")
    pub.publish(ctype=args.type, embed=args.embed, dry_run=not args.commit)

    print("\n\033[1mDone.\033[0m" + ("" if args.commit
          else "  Re-run with --commit to insert for real."))


if __name__ == "__main__":
    main()
