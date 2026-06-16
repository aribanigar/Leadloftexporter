#!/usr/bin/env python3
"""Copy ALL data from one Neon database to another over the HTTPS SQL endpoint.

Used to move the old (quota-blocked, once unblocked) project's data into the new
project. Reads the source schema from information_schema, topologically orders
tables by foreign-key dependencies, and bulk-inserts into the destination with
ON CONFLICT DO NOTHING (so it's safe to re-run and won't clobber a freshly
registered account).

Requires BOTH databases to be reachable. Run only after the old project's quota
is lifted (upgrade or reset).

Usage:
    SRC_DATABASE_URL='postgresql://…old…/neondb?sslmode=require' \
    DST_DATABASE_URL='postgresql://…new…/neondb?sslmode=require' \
    python3 scripts/migrate_db.py [--only users,workspaces,leads] [--skip alembic_version]
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
        })
        try:
            with urlopen(req, timeout=120) as r:
                return json.loads(r.read()).get("rows", [])
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)


def list_tables(db: Neon) -> list[str]:
    rows = db.q("select tablename from pg_tables where schemaname='public'", [])
    return [r["tablename"] for r in rows]


def columns(db: Neon, table: str) -> list[dict]:
    return db.q(
        "select column_name, data_type, udt_name from information_schema.columns "
        "where table_schema='public' and table_name=$1 order by ordinal_position",
        [table],
    )


def primary_key(db: Neon, table: str) -> list[str]:
    rows = db.q(
        "select a.attname from pg_index i "
        "join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) "
        "where i.indrelid=$1::regclass and i.indisprimary", ["public." + table])
    return [r["attname"] for r in rows]


def fk_edges(db: Neon) -> list[tuple[str, str]]:
    rows = db.q(
        "select tc.table_name as child, ccu.table_name as parent "
        "from information_schema.table_constraints tc "
        "join information_schema.constraint_column_usage ccu "
        "  on tc.constraint_name=ccu.constraint_name and tc.table_schema=ccu.table_schema "
        "where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'", [])
    return [(r["child"], r["parent"]) for r in rows]


def topo_order(tables: list[str], edges: list[tuple[str, str]]) -> list[str]:
    """Parents before children. Self-references and cycles are tolerated (the
    affected tables just go last and rely on ON CONFLICT / multi-pass)."""
    deps: dict[str, set] = {t: set() for t in tables}
    for child, parent in edges:
        if child in deps and parent in tables and child != parent:
            deps[child].add(parent)
    ordered, seen = [], set()
    while len(ordered) < len(tables):
        progressed = False
        for t in tables:
            if t in seen:
                continue
            if deps[t] <= seen:
                ordered.append(t); seen.add(t); progressed = True
        if not progressed:  # cycle — append the rest in any order
            for t in tables:
                if t not in seen:
                    ordered.append(t); seen.add(t)
            break
    return ordered


def copy_table(src: Neon, dst: Neon, table: str) -> int:
    cols = columns(src, table)
    if not cols:
        return 0
    names = [c["column_name"] for c in cols]
    casts = {}
    for c in cols:
        dt, udt = c["data_type"], c["udt_name"]
        if dt in ("jsonb", "json"):
            casts[c["column_name"]] = "::" + dt
        elif dt == "ARRAY":
            casts[c["column_name"]] = "::" + udt.lstrip("_") + "[]"
        elif dt == "boolean":
            casts[c["column_name"]] = "::boolean"
        else:
            casts[c["column_name"]] = ""
    collist = ",".join('"%s"' % n for n in names)
    pk = primary_key(dst, table)
    conflict = " on conflict (%s) do nothing" % ",".join('"%s"' % p for p in pk) if pk else " on conflict do nothing"

    total = 0
    offset, PAGE = 0, 500
    order = '"%s"' % pk[0] if pk else names[0]
    while True:
        rows = src.q(f'select {collist} from "{table}" order by {order} limit {PAGE} offset {offset}', [])
        if not rows:
            break
        values_sql, params, p = [], [], 1
        for row in rows:
            ph = []
            for n in names:
                v = row.get(n)
                if isinstance(v, (dict, list)):
                    v = json.dumps(v)
                params.append(v)
                ph.append(f"${p}{casts[n]}")
                p += 1
            values_sql.append("(" + ",".join(ph) + ")")
        dst.q(f'insert into "{table}" ({collist}) values ' + ",".join(values_sql) + conflict, params)
        total += len(rows)
        offset += PAGE
        if len(rows) < PAGE:
            break
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma list of tables to copy (default: all)")
    ap.add_argument("--skip", default="alembic_version", help="comma list of tables to skip")
    args = ap.parse_args()
    src_dsn, dst_dsn = os.environ.get("SRC_DATABASE_URL"), os.environ.get("DST_DATABASE_URL")
    if not src_dsn or not dst_dsn:
        raise SystemExit("Set SRC_DATABASE_URL and DST_DATABASE_URL.")

    src, dst = Neon(src_dsn), Neon(dst_dsn)
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    tables = [t for t in list_tables(src) if t not in skip and (not only or t in only)]
    order = topo_order(tables, fk_edges(src))
    report = {}
    for t in order:
        try:
            report[t] = copy_table(src, dst, t)
            print(f"  {report[t]:>7,}  {t}", flush=True)
        except Exception as e:
            report[t] = f"ERROR: {str(e)[:120]}"
            print(f"  FAILED  {t}: {report[t]}", flush=True)
    print(json.dumps({"copied": report}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
