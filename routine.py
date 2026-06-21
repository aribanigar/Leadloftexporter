#!/usr/bin/env python3
"""
routine.py  — CollabMarket content-hub publishing routine
==========================================================
One command that runs the whole flow:

    fetch Pixabay images  ->  build the HTML email  ->  publish to the content hub

It is safe by default: it INSPECTS the schema and does a DRY RUN unless you
explicitly pass --commit.

--------------------------------------------------------------------------
SETUP (env vars — never hardcode secrets):

    export DATABASE_URL="postgresql://...:5432/postgres"   # ROTATED password
    export HUB_WORKSPACE="1a716353-9472-4c1d-ae89-f95052e8f015"
    export PIXABAY_API_KEY="..."

USAGE:

    python routine.py                 # inspect schema + dry-run build (no writes)
    python routine.py --commit        # actually insert the row
    python routine.py --commit --embed --type html_email --slug collab-market

Content-hub type enum: html_email | whatsapp | caption | sms | other
--------------------------------------------------------------------------
"""

import os
import sys
import argparse

from build_email import build_email
import publish as pub   # reuse the inspect/insert helpers we already wrote


def step(n, msg):
    print(f"\n\033[1m[{n}]\033[0m {msg}")


def main():
    ap = argparse.ArgumentParser(description="CollabMarket publish routine")
    ap.add_argument("--commit", action="store_true",
                    help="Actually write to the DB (default is dry-run)")
    ap.add_argument("--embed", action="store_true",
                    help="Inline images as base64 (heavier; Gmail clips >102KB)")
    ap.add_argument("--type", default="html_email")
    ap.add_argument("--slug", default="collab-market")
    ap.add_argument("--status", default="draft")
    ap.add_argument("--skip-inspect", action="store_true",
                    help="Skip the schema print (use once you've confirmed columns)")
    args = ap.parse_args()

    # --- preflight: required env vars ---
    missing = [k for k in ("DATABASE_URL", "HUB_WORKSPACE", "PIXABAY_API_KEY")
               if not os.environ.get(k)]
    if missing:
        sys.exit(f"ERROR: missing env vars: {', '.join(missing)}")

    if args.type not in pub.VALID_TYPES:
        sys.exit(f"ERROR: --type must be one of {sorted(pub.VALID_TYPES)}")

    # --- 1. inspect schema (so we never insert blind) ---
    if not args.skip_inspect:
        step(1, "Inspecting content-hub schema")
        try:
            pub.inspect()
        except Exception as e:
            print(f"  (inspect skipped: {e})")

    # --- 2. build the email ---
    step(2, f"Building email  (embed={args.embed})")
    html = build_email(embed=args.embed)
    with open("collabmarket_email.html", "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  built {len(html):,} bytes -> collabmarket_email.html")
    if args.embed and len(html) > 102_000:
        print("  ⚠ over ~102KB: Gmail may clip this. Consider dropping --embed.")

    # --- 3. publish (dry-run unless --commit) ---
    step(3, "Publishing" if args.commit else "Dry-run (no DB write)")
    pub.publish(
        slug=args.slug,
        ctype=args.type,
        embed=args.embed,
        status=args.status,
        dry_run=not args.commit,
    )

    print("\n\033[1mDone.\033[0m" + ("" if args.commit
          else "  Re-run with --commit to insert for real."))


if __name__ == "__main__":
    main()
