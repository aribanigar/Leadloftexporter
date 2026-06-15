#!/usr/bin/env python3
"""
publish.py - seed the Content Hub DB for a given date and slug.

Usage:
  python3 scripts/publish.py --date 2026-06-15 --slug via-kashmir-itinerary

Walks content/<slug>/<date>/<market>/ for each market, reads meta.json + email.html
+ whatsapp.txt + linkedin.txt, and upserts rows into the acemedia Content Hub.

Idempotent: uses campaign_name as the dedup key (INSERT ... ON CONFLICT DO NOTHING).
Skips sample- prefixed date folders.
Requires: DATABASE_URL env var.
"""
import argparse, json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def get_db():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL not set")
    # strip SQLAlchemy driver prefix (postgresql+psycopg:// -> postgresql://)
    import re as _re
    url = _re.sub(r"^postgresql\+\w+://", "postgresql://", url)
    try:
        import psycopg
        return psycopg.connect(url)
    except ImportError:
        pass
    try:
        import psycopg2
        return psycopg2.connect(url)
    except ImportError:
        raise SystemExit("install psycopg or psycopg2: pip install psycopg[binary]")

def upsert_business(conn, slug, workspace_id):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO businesses (slug, workspace_id, name)
            VALUES (%s, %s, %s)
            ON CONFLICT (slug) DO NOTHING
        """, (slug, workspace_id, slug.replace("-", " ").title()))
        conn.commit()
        cur.execute("SELECT id FROM businesses WHERE slug = %s", (slug,))
        row = cur.fetchone()
        return row[0] if row else None

def seed_market(conn, business_id, date, market_dir):
    meta_f = market_dir / "meta.json"
    if not meta_f.exists():
        print(f"  skip {market_dir.name}: no meta.json")
        return "skipped"
    meta = json.loads(meta_f.read_text())
    campaign = meta["campaign_name"]

    html_f = market_dir / "email.html"
    amp_f = market_dir / "email.amp.html"
    wa_f = market_dir / "whatsapp.txt"
    li_f = market_dir / "linkedin.txt"

    html_content = html_f.read_text() if html_f.exists() else ""
    amp_content = amp_f.read_text() if amp_f.exists() else ""
    wa_content = wa_f.read_text().strip() if wa_f.exists() else ""
    li_content = li_f.read_text().strip() if li_f.exists() else ""

    inserted = 0
    with conn.cursor() as cur:
        for channel, content, content_type in [
            ("html_email", html_content, "text/html"),
            ("amp_email", amp_content, "text/html"),
            ("whatsapp", wa_content, "text/plain"),
            ("linkedin", li_content, "text/plain"),
        ]:
            if not content:
                continue
            title = f"{campaign} [{channel}]"
            cur.execute("""
                INSERT INTO content_items
                  (business_id, title, channel, content, content_type, meta, published_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (title) DO NOTHING
            """, (business_id, title, channel, content, content_type,
                  json.dumps(meta), date))
            inserted += cur.rowcount
        conn.commit()
    return f"inserted {inserted}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--workspace", default=os.environ.get("HUB_WORKSPACE",
                    "2faa195e-5817-4d32-8e6c-350b70ce32c3"))
    a = ap.parse_args()

    if a.date.startswith("sample"):
        raise SystemExit("will not seed sample- date folders")

    base = ROOT / "content" / a.slug / a.date
    if not base.exists():
        raise SystemExit(f"no content at {base}")

    conn = get_db()
    business_id = upsert_business(conn, a.slug, a.workspace)
    if not business_id:
        raise SystemExit(f"could not upsert business '{a.slug}'")

    results = []
    for market_dir in sorted(base.iterdir()):
        if not market_dir.is_dir() or market_dir.name.startswith("_"):
            continue
        status = seed_market(conn, business_id, a.date, market_dir)
        results.append((market_dir.name, status))
        print(f"  {market_dir.name}: {status}")

    conn.close()
    print(f"\nDone. slug={a.slug} date={a.date} business_id={business_id}")
    for name, status in results:
        print(f"  {name}: {status}")

if __name__ == "__main__":
    main()
