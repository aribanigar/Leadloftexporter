#!/usr/bin/env python3
"""Publish a day's Gifts Gulf assets straight to Postgres.

Used by the daily routine after ``content/gifts-gulf/<YYYY-MM-DD>/`` has been
generated. Bypasses the HTTP API (no JWT, no CORS, no network egress quirks)
and writes rows directly into ``content_businesses`` / ``content_assets``.

Reads:
    content/gifts-gulf/<YYYY-MM-DD>/
    ├── manifest.json
    └── <CUR>/set-<n>/{email.html, email.amp.html, whatsapp.txt, linkedin.txt, meta.json}

For each set, inserts 3 ContentAsset rows:
    - title=<campaign_name>             type=html_email   + amp_content
    - title=<campaign_name> · WhatsApp  type=whatsapp
    - title=<campaign_name> · LinkedIn  type=caption, platform=linkedin

Idempotent: an asset whose title + campaign_code tag already exists is skipped,
so re-running today is a no-op.

Environment:
    DATABASE_URL          Neon Postgres URL. Accepts the SQLAlchemy
                          ``postgresql+psycopg://`` prefix; stripped before
                          handing to psycopg.
    HUB_WORKSPACE         Workspace UUID. Required.
    HUB_BUSINESS_SLUG     Defaults to "gifts-gulf".
    HUB_BUSINESS_NAME     Used only on first-run create. Defaults to "Gifts Gulf".

Usage:
    python scripts/publish_to_hub.py --date 2026-06-13
    python scripts/publish_to_hub.py --date 2026-06-13 --root content/gifts-gulf
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb


def _conn_str() -> str:
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        raise SystemExit("DATABASE_URL is required")
    # Strip the SQLAlchemy driver prefix if present; psycopg only wants
    # the standard postgresql:// scheme.
    return raw.replace("postgresql+psycopg://", "postgresql://", 1)


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""


def _resolve_or_create_business(cur, workspace_id: str, slug: str, name: str) -> str:
    cur.execute(
        "SELECT id FROM content_businesses WHERE workspace_id=%s AND slug=%s",
        (workspace_id, slug),
    )
    row = cur.fetchone()
    if row:
        return row[0]
    business_id = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO content_businesses (
            id, workspace_id, name, slug, brand_color, accent_color,
            tone, logo_url, description
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            business_id, workspace_id, name, slug,
            "#00a544", "#008138", "minimal",
            "https://www.giftsgulf.com/gglogo.svg",
            "Corporate gifting in the Gulf - by QCKSERVE, part of the Jasani group.",
        ),
    )
    return business_id


def _asset_exists(cur, workspace_id: str, business_id: str, campaign_code: str, title: str) -> bool:
    """Skip if a row with this (workspace, business, title) and campaign_code
    tag already exists. Means re-running the same day is safe + cheap."""
    cur.execute(
        """
        SELECT 1 FROM content_assets
        WHERE workspace_id = %s
          AND business_id  = %s
          AND title        = %s
          AND tags @> %s::jsonb
        LIMIT 1
        """,
        (workspace_id, business_id, title, json.dumps([campaign_code])),
    )
    return cur.fetchone() is not None


def _insert_asset(
    cur, *,
    workspace_id: str,
    business_id: str,
    title: str,
    type: str,
    content: str,
    amp_content: str | None = None,
    subject: str | None = None,
    platform: str | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
) -> None:
    cur.execute(
        """
        INSERT INTO content_assets (
            id, workspace_id, business_id,
            title, type, content, amp_content,
            subject, platform, tags, notes
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()), workspace_id, business_id,
            title, type, content,
            amp_content or None,
            subject or None,
            platform or None,
            Jsonb(tags or []),
            notes or None,
        ),
    )


def publish_day(date: str, root: Path) -> dict:
    day_dir = root / date
    if not day_dir.is_dir():
        raise SystemExit(f"no such day directory: {day_dir}")

    workspace_id = os.environ.get("HUB_WORKSPACE")
    if not workspace_id:
        raise SystemExit("HUB_WORKSPACE is required")
    biz_slug = os.environ.get("HUB_BUSINESS_SLUG", "gifts-gulf")
    biz_name = os.environ.get("HUB_BUSINESS_NAME", "Gifts Gulf")

    inserted = 0
    skipped = 0
    failures: list[tuple[str, str]] = []
    created_business = False

    with psycopg.connect(_conn_str()) as conn:
        with conn.cursor() as cur:
            # Probe first so we can flag whether we created the business.
            cur.execute(
                "SELECT id FROM content_businesses WHERE workspace_id=%s AND slug=%s",
                (workspace_id, biz_slug),
            )
            biz_row = cur.fetchone()
            if biz_row:
                biz_id = biz_row[0]
            else:
                created_business = True
                biz_id = _resolve_or_create_business(cur, workspace_id, biz_slug, biz_name)

            # Iterate the currency directories, each holding 3 set-<n> dirs.
            for cur_dir in sorted(day_dir.iterdir()):
                if not cur_dir.is_dir() or cur_dir.name.startswith("_"):
                    continue
                for set_dir in sorted(cur_dir.glob("set-*")):
                    meta_path = set_dir / "meta.json"
                    if not meta_path.exists():
                        failures.append((str(set_dir), "missing_meta.json"))
                        continue
                    try:
                        meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    except json.JSONDecodeError as e:
                        failures.append((str(meta_path), f"bad_meta_json: {e}"))
                        continue

                    code = meta.get("campaign_code") or ""
                    name = meta.get("campaign_name") or ""
                    subj = meta.get("subject") or ""
                    currency = meta.get("currency") or cur_dir.name
                    season = meta.get("season") or ""
                    if not (code and name):
                        failures.append((str(meta_path), "missing_campaign_code_or_name"))
                        continue

                    html = _read(set_dir / "email.html")
                    amp = _read(set_dir / "email.amp.html")
                    wa = _read(set_dir / "whatsapp.txt")
                    li = _read(set_dir / "linkedin.txt")

                    specs = [
                        {
                            "title": name,
                            "type": "html_email",
                            "content": html,
                            "amp_content": amp or None,
                            "subject": subj,
                            "tags": [t for t in (code, currency, season) if t],
                        },
                        {
                            "title": f"{name} - WhatsApp",
                            "type": "whatsapp",
                            "content": wa,
                            "tags": [code, currency],
                        },
                        {
                            "title": f"{name} - LinkedIn",
                            "type": "caption",
                            "platform": "linkedin",
                            "content": li,
                            "tags": [code, currency],
                        },
                    ]

                    for spec in specs:
                        if not (spec.get("content") or "").strip():
                            failures.append((spec["title"], "empty_content"))
                            continue
                        if _asset_exists(cur, workspace_id, biz_id, code, spec["title"]):
                            skipped += 1
                            continue
                        try:
                            _insert_asset(
                                cur,
                                workspace_id=workspace_id,
                                business_id=biz_id,
                                **spec,
                            )
                            inserted += 1
                        except Exception as e:
                            failures.append((spec["title"], f"{type(e).__name__}: {e}"))

        conn.commit()

    return {
        "date": date,
        "business_id": biz_id,
        "business_slug": biz_slug,
        "created_business": created_business,
        "inserted": inserted,
        "skipped": skipped,
        "failures": failures,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Publish a Gifts Gulf day to Postgres.")
    ap.add_argument("--date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--root", default="content/gifts-gulf", type=Path)
    args = ap.parse_args()

    report = publish_day(args.date, args.root)
    print(json.dumps(report, indent=2))
    if report["failures"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
