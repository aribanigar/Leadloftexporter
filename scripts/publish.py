#!/usr/bin/env python3
"""
publish.py - seed daily content into the Content Hub DB (via Neon HTTP API).
Walks content/<slug>/<date>/<market>/ folders and upserts html_email, whatsapp, linkedin.
Idempotent: skips rows whose title already exists.

Usage:
  python3 scripts/publish.py --date 2026-06-17 --slug via-kashmir-itinerary
  python3 scripts/publish.py --date 2026-06-17 --slug via-kashmir-itinerary --fix-phone
"""
import argparse, json, os, sys
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent.parent

HOST = "ep-sparkling-grass-ah1zobz0-pooler.c-3.us-east-1.aws.neon.tech"
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"postgresql://neondb_owner:npg_Dfar3YXQ9AFK@{HOST}/neondb?sslmode=require"
)
WORKSPACE_ID = os.environ.get("HUB_WORKSPACE", "b2236a00-faa2-41d5-8ee7-b6e24d0c4904")

def sql(q, params=None):
    r = requests.post(f"https://{HOST}/sql",
        headers={"Content-Type": "application/json", "Neon-Connection-String": DATABASE_URL},
        json={"query": q, "params": params or []},
        timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"SQL error {r.status_code}: {r.text[:300]}")
    return r.json()

def upsert_business(slug):
    """Ensure the content_business row exists; return its id."""
    res = sql("SELECT id FROM content_businesses WHERE slug=$1 AND workspace_id=$2",
              [slug, WORKSPACE_ID])
    if res["rows"]:
        return res["rows"][0]["id"]
    # create it
    name_map = {
        "via-kashmir-itinerary": "VIa Kashmir Itinerary",
        "via-kashmir": "Via Kashmir",
    }
    name = name_map.get(slug, slug)
    res2 = sql("""
        INSERT INTO content_businesses (id, workspace_id, name, slug, brand_color, accent_color, created_at, updated_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, '#00361a', '#9dd3aa', now(), now())
        RETURNING id
    """, [WORKSPACE_ID, name, slug])
    return res2["rows"][0]["id"]

def title_exists(title, business_id):
    res = sql("SELECT 1 FROM content_assets WHERE title=$1 AND business_id=$2", [title, business_id])
    return len(res["rows"]) > 0

def insert_asset(business_id, title, asset_type, content, subject=None, platform=None, amp_content=None):
    sql("""
        INSERT INTO content_assets
          (id, workspace_id, business_id, title, type, content, amp_content, subject, platform, created_at, updated_at)
        VALUES
          (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    """, [WORKSPACE_ID, business_id, title, asset_type, content, amp_content, subject, platform])

def fix_phone_in_existing(business_id, date):
    """Replace +91 918 605 1499 with +919186051499 in html_email rows for the given date."""
    pattern = f"VK Itinerary - % - {date}"
    res = sql("""
        SELECT id, content FROM content_assets
        WHERE business_id=$1 AND title LIKE $2 AND type='html_email'
          AND (content LIKE '%918 605 1499%' OR content LIKE '%91 918%')
    """, [business_id, pattern])
    count = 0
    for row in res["rows"]:
        fixed = (row["content"]
                 .replace("+91 918 605 1499", "+919186051499")
                 .replace("+91-918-605-1499", "+919186051499"))
        sql("UPDATE content_assets SET content=$1, updated_at=now() WHERE id=$2",
            [fixed, row["id"]])
        count += 1
    return count

def seed_market(date, market, slug, business_id, dry_run=False):
    leaf = ROOT / "content" / slug / date / market
    if not leaf.exists():
        print(f"  {market}: directory missing ({leaf}) — skipped")
        return {"inserted": 0, "skipped": 0}

    meta_path = leaf / "meta.json"
    if not meta_path.exists():
        print(f"  {market}: meta.json missing — skipped")
        return {"inserted": 0, "skipped": 0}
    meta = json.loads(meta_path.read_text())

    results = {"inserted": 0, "skipped": 0}

    # html_email
    email_path = leaf / "email.html"
    amp_path = leaf / "email.amp.html"
    email_title = meta["campaign_name"]
    if email_path.exists():
        amp_content = amp_path.read_text() if amp_path.exists() else None
        if title_exists(email_title, business_id):
            print(f"  {market}/email: already exists — skipped")
            results["skipped"] += 1
        elif not dry_run:
            insert_asset(business_id, email_title, "html_email",
                         email_path.read_text(), subject=meta.get("subject"),
                         amp_content=amp_content)
            print(f"  {market}/email: inserted '{email_title}'")
            results["inserted"] += 1
        else:
            print(f"  {market}/email: would insert '{email_title}'")

    # whatsapp
    wa_path = leaf / "whatsapp.txt"
    wa_title = f"{meta['campaign_name']} — WhatsApp"
    if wa_path.exists():
        if title_exists(wa_title, business_id):
            print(f"  {market}/whatsapp: already exists — skipped")
            results["skipped"] += 1
        elif not dry_run:
            insert_asset(business_id, wa_title, "whatsapp", wa_path.read_text())
            print(f"  {market}/whatsapp: inserted")
            results["inserted"] += 1

    # linkedin
    li_path = leaf / "linkedin.txt"
    li_title = f"{meta['campaign_name']} — LinkedIn"
    if li_path.exists():
        if title_exists(li_title, business_id):
            print(f"  {market}/linkedin: already exists — skipped")
            results["skipped"] += 1
        elif not dry_run:
            insert_asset(business_id, li_title, "caption", li_path.read_text(), platform="linkedin")
            print(f"  {market}/linkedin: inserted")
            results["inserted"] += 1

    return results

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--slug", default="via-kashmir-itinerary")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fix-phone", action="store_true",
                    help="Also fix +91 918 605 1499 -> +919186051499 in existing rows for this date")
    a = ap.parse_args()

    print(f"Seeding {a.slug} / {a.date}")
    business_id = upsert_business(a.slug)
    print(f"  business_id: {business_id}")

    if a.fix_phone:
        fixed = fix_phone_in_existing(business_id, a.date)
        print(f"  phone fix: updated {fixed} html_email rows")

    markets = ["india", "kashmir", "saudi", "dubai"]
    total_inserted = total_skipped = 0
    for m in markets:
        r = seed_market(a.date, m, a.slug, business_id, a.dry_run)
        total_inserted += r["inserted"]
        total_skipped += r["skipped"]

    print(f"\nDone: {total_inserted} inserted, {total_skipped} skipped")

if __name__ == "__main__":
    sys.exit(main())
