#!/usr/bin/env python3
"""Delete bulk Company Finder rows to keep the free-tier DB small.

The on-demand search model no longer persists search results, but a one-time
bulk seed (e.g. the 123k GCC OSM extract) can still be sitting in the table.
This removes rows by source so the database stays light. Talks to Neon over its
HTTPS SQL endpoint (the sandbox blocks the 5432 wire protocol).

Run once Neon access is restored (quota reset or plan upgrade):
    DATABASE_URL='…neon.tech/neondb?sslmode=require' CF_WORKSPACE='<uuid>' \
    python3 scripts/cleanup_cf_bulk.py --source openstreetmap
    # everything for the workspace:
    python3 scripts/cleanup_cf_bulk.py --all
"""
from __future__ import annotations

import argparse
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="openstreetmap",
                    help="delete rows with this source (default openstreetmap)")
    ap.add_argument("--all", action="store_true", help="delete ALL rows for the workspace")
    ap.add_argument("--workspace", default=os.environ.get("CF_WORKSPACE"))
    args = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn or not args.workspace:
        raise SystemExit("Set DATABASE_URL and CF_WORKSPACE.")

    n = Neon(dsn)
    ws = args.workspace
    before = int(n.q("select count(*) c from company_finder_businesses where workspace_id=$1", [ws])[0]["c"])
    if args.all:
        n.q("delete from company_finder_businesses where workspace_id=$1", [ws])
    else:
        n.q("delete from company_finder_businesses where workspace_id=$1 and source=$2", [ws, args.source])
    after = int(n.q("select count(*) c from company_finder_businesses where workspace_id=$1", [ws])[0]["c"])
    print(json.dumps({"workspace": ws, "before": before, "after": after, "deleted": before - after}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
