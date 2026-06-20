#!/usr/bin/env python3
"""
publish.py - seed Hudace content into the LeadLoft content hub (Neon Postgres).

The hub schema is not hard-coded. Run --discover first to confirm the real
table/column names, then set the few env overrides if the guesses are wrong.
"""
import os, sys, json, argparse
import psycopg2
import psycopg2.extras as extras

DB  = os.environ["DATABASE_URL"]
WS  = os.environ["HUB_WORKSPACE"]

# content-hub type enum: html_email | whatsapp | caption | sms | other
TYPE_MAP = {
    "email":"html_email","html_email":"html_email","html":"html_email",
    "whatsapp":"whatsapp","wa":"whatsapp",
    "linkedin":"caption","caption":"caption","post":"caption","social":"caption",
    "sms":"sms","text":"sms",
    "outreach":"other","other":"other","dm":"other","cold":"other","email_outreach":"other",
}
def _norm_type(t):
    return TYPE_MAP.get(str(t).strip().lower(), "other")

ITEM_CANDIDATES   = [os.getenv("HUB_ITEM_TABLE")] if os.getenv("HUB_ITEM_TABLE") else \
                    ["content_items","contents","hub_items","content","items","posts","assets"]
FOLDER_CANDIDATES = [os.getenv("HUB_FOLDER_TABLE")] if os.getenv("HUB_FOLDER_TABLE") else \
                    ["folders","collections","content_folders","hub_folders","groups"]

MAP = {
    "workspace": os.getenv("COL_WORKSPACE","workspace_id"),
    "folder":    os.getenv("COL_FOLDER","folder_id"),
    "title":     os.getenv("COL_TITLE","title"),
    "type":      os.getenv("COL_TYPE","type"),
    "body":      os.getenv("COL_BODY","body"),
    "image":     os.getenv("COL_IMAGE","image_url"),
    "status":    os.getenv("COL_STATUS","status"),
}
STATUS_VALUE = os.getenv("STATUS_VALUE","draft")


def cols(cur, table):
    cur.execute("""select column_name, data_type, is_nullable, column_default
                   from information_schema.columns
                   where table_schema='public' and table_name=%s order by ordinal_position""", (table,))
    return cur.fetchall()


def all_tables(cur):
    cur.execute("select table_name from information_schema.tables where table_schema='public' order by table_name")
    return [r[0] for r in cur.fetchall()]


def pick_table(cur, candidates, need):
    """Return the first existing table that contains all 'need' columns (by suffix match)."""
    existing = set(all_tables(cur))
    for t in candidates:
        if t and t in existing:
            names = {c[0] for c in cols(cur, t)}
            if all(any(n == k or n.endswith(k) for n in names) for k in need):
                return t
    # fallback: any table that has title + workspace-ish columns
    for t in existing:
        names = {c[0] for c in cols(cur, t)}
        if MAP["title"] in names and any("workspace" in n for n in names):
            return t
    return None


def resolve(cur, table, logical):
    """Map a logical key to the real column name present in the table (exact or suffix)."""
    names = {c[0] for c in cols(cur, table)}
    want = MAP[logical]
    if want in names:
        return want
    for n in names:
        if n.endswith(want) or n == logical:
            return n
    return None


def discover():
    con = psycopg2.connect(DB); cur = con.cursor()
    print("TABLES:", all_tables(cur))
    it = pick_table(cur, ITEM_CANDIDATES, [MAP["title"]])
    ft = pick_table(cur, FOLDER_CANDIDATES, ["name"])
    print("\nLIKELY ITEM TABLE:", it)
    if it:
        for c in cols(cur, it): print("   ", c)
    print("\nLIKELY FOLDER TABLE:", ft)
    if ft:
        for c in cols(cur, ft): print("   ", c)
    con.close()


def ensure_folder(cur, ftable, name):
    fcols = {c[0] for c in cols(cur, ftable)}
    ws_col = next((c for c in fcols if c.endswith("workspace_id") or c == "workspace_id"), None)
    name_col = "name" if "name" in fcols else ("slug" if "slug" in fcols else None)
    slug_col = "slug" if "slug" in fcols else None
    if not name_col:
        raise SystemExit(f"folder table {ftable} has no name/slug column: {fcols}")
    q = f"select id from {ftable} where {name_col}=%s"
    params = [name]
    if ws_col:
        q += f" and {ws_col}=%s"; params.append(WS)
    cur.execute(q, params)
    row = cur.fetchone()
    if row:
        return row[0]
    ins_cols = [name_col]; ins_vals = [name]
    if slug_col and slug_col != name_col:
        ins_cols.append(slug_col); ins_vals.append(name)
    if ws_col:
        ins_cols.append(ws_col); ins_vals.append(WS)
    ph = ",".join(["%s"]*len(ins_vals))
    cur.execute(f"insert into {ftable} ({','.join(ins_cols)}) values ({ph}) returning id", ins_vals)
    return cur.fetchone()[0]


def publish(folder_name, items):
    con = psycopg2.connect(DB); con.autocommit = False; cur = con.cursor()
    try:
        itable = pick_table(cur, ITEM_CANDIDATES, [MAP["title"]])
        ftable = pick_table(cur, FOLDER_CANDIDATES, ["name"])
        if not itable:
            raise SystemExit("Could not find the content-item table. Run --discover and set HUB_ITEM_TABLE / COL_* envs.")
        icols = {c[0] for c in cols(cur, itable)}
        c_ws    = resolve(cur, itable, "workspace")
        c_fold  = resolve(cur, itable, "folder") if ftable else None
        c_title = resolve(cur, itable, "title")
        c_type  = resolve(cur, itable, "type")
        c_body  = resolve(cur, itable, "body")
        c_img   = resolve(cur, itable, "image")
        c_stat  = resolve(cur, itable, "status")

        folder_id = ensure_folder(cur, ftable, folder_name) if ftable else None
        created, skipped = 0, 0
        for it in items:
            # idempotency: same title in same folder/workspace already present -> skip
            chk = f"select 1 from {itable} where {c_title}=%s"
            cp = [it["title"]]
            if c_fold and folder_id is not None:
                chk += f" and {c_fold}=%s"; cp.append(folder_id)
            elif c_ws:
                chk += f" and {c_ws}=%s"; cp.append(WS)
            cur.execute(chk, cp)
            if cur.fetchone():
                skipped += 1; continue

            row = {}
            if c_ws:    row[c_ws]    = WS
            if c_fold and folder_id is not None: row[c_fold] = folder_id
            if c_title: row[c_title] = it["title"]
            if c_type:  row[c_type]  = _norm_type(it.get("type","other"))
            if c_body:  row[c_body]  = it.get("body") or it.get("body_html","")
            if c_img and it.get("image_url"): row[c_img] = it["image_url"]
            if c_stat:  row[c_stat]  = STATUS_VALUE
            keys = list(row.keys())
            cur.execute(
                f"insert into {itable} ({','.join(keys)}) values ({','.join(['%s']*len(keys))})",
                [row[k] for k in keys])
            created += 1
        con.commit()
        print(f"OK folder='{folder_name}' table='{itable}' created={created} skipped={skipped}")
    except Exception as e:
        con.rollback(); print("ROLLBACK:", repr(e)); raise
    finally:
        con.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--folder", default="hudace")
    ap.add_argument("batch", nargs="?", help="path to batch.json")
    a = ap.parse_args()
    if a.discover:
        discover()
    elif a.batch:
        with open(a.batch) as f:
            items = json.load(f)
        publish(a.folder, items)
    else:
        ap.print_help()
