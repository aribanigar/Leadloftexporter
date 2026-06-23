#!/usr/bin/env python3
"""Seed Company Finder businesses straight into the DB from a CSV/JSON file.

Talks to Neon over its HTTPS SQL endpoint (port 443), NOT the Postgres wire
protocol — the routine sandbox blocks 5432 but allows HTTPS egress. Reuses the
app's company_finder._normalize so hierarchy + dedup keys match the live ingest
path exactly. Idempotent via ON CONFLICT (workspace_id, dedup_key) DO NOTHING.

Usage:
    DATABASE_URL='postgresql+psycopg://…neon.tech/neondb?sslmode=require' \
    CF_WORKSPACE='<workspace uuid or name>' \
    python3 scripts/seed_company_finder.py /tmp/gcc-all.csv [--source openstreetmap]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Reuse the live normalizer (hierarchy + dedup_key) from the API package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
from app.services.company_finder import _normalize  # noqa: E402

COLS = ["id", "workspace_id", "source", "name", "phone", "email", "website",
        "address", "category", "latitude", "longitude", "place_id", "cid",
        "profile_url", "country", "area", "zone", "street", "building",
        "building_key", "socials", "hours", "rating", "rating_count", "dedup_key"]
JSONB = {"socials", "hours"}
BATCH = 400  # rows per HTTP insert (≤ 25 cols × 400 = 10k params, well under 65k)


def normalize_dsn(url: str) -> str:
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


class Neon:
    def __init__(self, dsn: str):
        self.conn = normalize_dsn(dsn)
        host = urlparse(self.conn).hostname
        if not host:
            raise SystemExit("DATABASE_URL has no host")
        self.url = "https://%s/sql" % host

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


def resolve_workspace(n: Neon, ref: str) -> str:
    rows = n.q("select id from workspaces where id=$1", [ref])
    if rows:
        return ref
    rows = n.q("select id, name from workspaces where lower(name)=lower($1)", [ref])
    if not rows:
        rows = n.q("select id, name from workspaces where name ilike $1", [ref + "%"])
    if not rows:
        raise SystemExit(f"workspace not found: {ref}")
    return rows[0]["id"]


def read_rows(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".json":
        j = json.loads(text)
        return j if isinstance(j, list) else j.get("businesses") or j.get("rows") or []
    return list(csv.DictReader(text.splitlines()))


def build_insert(batch_norm: list[dict], ws: str, source: str):
    """One multi-row INSERT … ON CONFLICT DO NOTHING for the batch."""
    values_sql, params = [], []
    p = 1
    for item in batch_norm:
        row = {
            "id": str(uuid.uuid4()), "workspace_id": ws, "source": source,
            "name": item["name"], "phone": item["phone"], "email": item["email"],
            "website": item["website"], "address": item["address"], "category": item["category"],
            "latitude": item["latitude"], "longitude": item["longitude"],
            "place_id": item["place_id"], "cid": item["cid"], "profile_url": item["profile_url"],
            "country": item["country"], "area": item["area"], "zone": item["zone"],
            "street": item["street"], "building": item["building"], "building_key": item["building_key"],
            "socials": json.dumps(item["socials"] or {}), "hours": json.dumps(item["hours"] or {}),
            "rating": item["rating"], "rating_count": item["rating_count"], "dedup_key": item["dedup_key"],
        }
        ph = []
        for c in COLS:
            params.append(row[c])
            ph.append(f"${p}::jsonb" if c in JSONB else f"${p}")
            p += 1
        values_sql.append("(" + ",".join(ph) + ")")
    sql = (
        f"insert into company_finder_businesses ({','.join(COLS)}) values "
        + ",".join(values_sql)
        + " on conflict (workspace_id, dedup_key) do nothing"
    )
    return sql, params


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", help="path to CSV/JSON of businesses")
    ap.add_argument("--source", default="openstreetmap")
    ap.add_argument("--workspace", default=os.environ.get("CF_WORKSPACE"))
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn or not args.workspace:
        raise SystemExit("Set DATABASE_URL and CF_WORKSPACE (or --workspace).")

    n = Neon(dsn)
    ws = resolve_workspace(n, args.workspace)

    raw = read_rows(Path(args.csv))
    norm, seen = [], set()
    for r in raw:
        item = _normalize(r)
        if not item or item["dedup_key"] in seen:
            continue
        seen.add(item["dedup_key"])
        norm.append(item)

    inserted = 0
    for i in range(0, len(norm), BATCH):
        sql, params = build_insert(norm[i:i + BATCH], ws, args.source)
        n.q(sql, params)
        inserted += len(norm[i:i + BATCH])
        print(f"  …{inserted:,}/{len(norm):,}", flush=True)

    after = n.q("select count(*) as c from company_finder_businesses where workspace_id=$1", [ws])
    print(json.dumps({
        "workspace": ws, "csv_rows": len(raw), "normalized_unique": len(norm),
        "table_total_now": int(after[0]["c"]),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
