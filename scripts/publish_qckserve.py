#!/usr/bin/env python3
"""
publish_qckserve.py — push one day's QckServe multi-vertical content into
the Content Hub DB.

The QckServe content drop is a single flat JSON per day at
``content/qckserve/qckserve-<YYYY-MM-DD>.json``. Each day's file carries
several ``items``, one per (vertical × channel) combination. This script
walks ``items`` and inserts one ``content_assets`` row per item.

Pattern mirrors ``publish_to_hub.py``:
  - Neon HTTPS SQL endpoint (port 443) — no psycopg / no pip install
  - Resolve the QckServe business by (workspace_id, slug="qckserve");
    create it on first run with QckServe brand colours
  - Idempotent: skip inserts whose (business_id, title) tuple already exists

Title format: ``[YYYY-MM-DD] <vertical> · <channel>``. Deterministic and
unique per (date, vertical, channel) so reruns are no-ops.

Env vars:
  DATABASE_URL    required.  Neon URL (postgresql+psycopg://... accepted).
  HUB_WORKSPACE   required.  Workspace UUID that owns the QckServe business.

Usage:
  python3 scripts/publish_qckserve.py --date 2026-06-25
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


SLUG = "qckserve"
BIZ_NAME = "QckServe"
BIZ_DESC = "India's Free Local Marketplace — Properties · Vehicles · Jobs · Classifieds · Freelancing"
BRAND = "#ef6723"
ACCENT = "#1A1A1A"
TONE = "punchy"


def normalize(url: str) -> str:
    """Strip SQLAlchemy `+driver` suffix so the Neon HTTPS endpoint is happy."""
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


class Neon:
    def __init__(self, dsn: str):
        self.conn = normalize(dsn)
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
            with urlopen(req, timeout=45) as r:
                return json.loads(r.read())["rows"]
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def channel_to_type(channel: str) -> str:
    """Map the QckServe ``channel`` field onto the ``content_assets.type``
    enum. The DB only knows 5 types; QckServe uses the same 5."""
    if channel in ("html_email", "whatsapp", "caption", "sms", "other"):
        return channel
    return "other"


def title_for(item: dict, date_s: str) -> str:
    vert = (item.get("vertical") or "").strip() or "general"
    chan = (item.get("channel") or "other").strip()
    # Allow per-item title override (the image-prompt items already set one).
    if item.get("title"):
        return str(item["title"])[:200]
    return f"[{date_s}] {vert.capitalize()} · {chan}"[:200]


def tags_for(item: dict) -> list:
    raw = item.get("tags") or []
    out = []
    for t in raw:
        t = str(t).strip().lower()
        if t and t not in out:
            out.append(t)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()
    date_s = args.date

    db = os.environ.get("DATABASE_URL")
    ws = os.environ.get("HUB_WORKSPACE")
    if not db or not ws:
        print(json.dumps({"date": date_s, "hub_publish": "skipped (no_secrets — set DATABASE_URL + HUB_WORKSPACE)"}))
        return 0

    src = repo_root() / "content" / SLUG / f"{SLUG}-{date_s}.json"
    if not src.is_file():
        print(json.dumps({"date": date_s, "error": f"no source file: {src}"}))
        return 4

    try:
        payload = json.loads(src.read_text(encoding="utf-8"))
    except Exception as e:
        print(json.dumps({"date": date_s, "error": f"bad JSON in {src}: {e}"}))
        return 4

    items = payload.get("items") or []
    if not items:
        print(json.dumps({"date": date_s, "error": "no items in source file"}))
        return 4

    n = Neon(db)
    if not n.q("select id from workspaces where id=$1", [ws]):
        print(json.dumps({"date": date_s, "error": f"workspace not found: {ws}"}))
        return 4

    # Resolve / create QckServe business.
    rows = n.q("select id from content_businesses where workspace_id=$1 and slug=$2", [ws, SLUG])
    if rows:
        biz, created = rows[0]["id"], False
    else:
        biz, created = str(uuid.uuid4()), True
        n.q(
            """insert into content_businesses
                 (id,workspace_id,name,slug,description,brand_color,accent_color,tone,logo_url)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
            [biz, ws, BIZ_NAME, SLUG, BIZ_DESC, BRAND, ACCENT, TONE, ""],
        )

    rep = {
        "date": date_s,
        "business_id": biz,
        "business_slug": SLUG,
        "created_business": created,
        "inserted": 0,
        "skipped": 0,
        "by_vertical": {},
        "failures": [],
    }

    for item in items:
        try:
            title = title_for(item, date_s)
            atype = channel_to_type(item.get("channel", "other"))
            content = item.get("content", "")
            subject = item.get("subject")
            platform = item.get("platform")
            tags = tags_for(item)
            image_url = item.get("image_url") or None
            notes = item.get("notes") or None
            # html_email items can carry an amp_content body too; in this
            # JSON shape we don't have a separate amp_content field per
            # item (the existing 06-22 file doesn't), so leave it null —
            # the regular `content` is the email body.
            amp = item.get("amp_content")

            # Idempotency check.
            if n.q(
                "select 1 from content_assets where business_id=$1 and title=$2 limit 1",
                [biz, title],
            ):
                rep["skipped"] += 1
                rep["by_vertical"].setdefault(item.get("vertical") or "?", {"i": 0, "s": 0})["s"] += 1
                continue

            n.q(
                """insert into content_assets
                     (id,workspace_id,business_id,title,type,content,
                      subject,platform,tags,amp_content,notes,image_url)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)""",
                [
                    str(uuid.uuid4()),
                    ws,
                    biz,
                    title,
                    atype,
                    content,
                    subject,
                    platform,
                    json.dumps(tags),
                    amp,
                    notes,
                    image_url,
                ],
            )
            rep["inserted"] += 1
            rep["by_vertical"].setdefault(item.get("vertical") or "?", {"i": 0, "s": 0})["i"] += 1
        except Exception as e:  # noqa: BLE001
            rep["failures"].append([title_for(item, date_s), str(e)[:300]])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
