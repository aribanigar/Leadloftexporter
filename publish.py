"""
publish.py — CollabMarket content-hub publisher (Supabase REST API)
===================================================================
Writes the recruitment email into `content_assets` for the `collab-market`
business. Uses the Supabase REST API over HTTPS (the direct 5432 Postgres
port is firewalled in many environments; REST is reliable).

Secrets come from environment variables — never hardcoded:
    SUPABASE_URL, SUPABASE_SERVICE_KEY, HUB_WORKSPACE, PIXABAY_API_KEY

Real schema (content_assets):
    id, workspace_id, business_id, title, type, content, amp_content,
    subject, platform, tags, notes, image_url, created_at, updated_at

type enum: html_email | whatsapp | caption | sms | other
"""

import os
import sys
import json
import uuid
import datetime
import requests

from build_email import build_email

VALID_TYPES = {"html_email", "whatsapp", "caption", "sms", "other"}
BUSINESS_SLUG = "collab-market"

# type -> the companion `platform` value used in this hub
PLATFORM_FOR = {
    "html_email": "email",
    "whatsapp":   "whatsapp",
    "caption":    "linkedin",
    "sms":        "sms",
    "other":      "outreach",
}


def _env(key, required=True):
    v = os.environ.get(key)
    if required and not v:
        sys.exit(f"ERROR: {key} not set in environment.")
    return v


def _headers():
    key = _env("SUPABASE_SERVICE_KEY")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _base():
    return _env("SUPABASE_URL").rstrip("/") + "/rest/v1"


def resolve_business_id():
    """Look up the content_businesses row for collab-market."""
    url = f"{_base()}/content_businesses"
    params = {"slug": f"eq.{BUSINESS_SLUG}", "select": "id,workspace_id,name,slug"}
    r = requests.get(url, headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        sys.exit(f"ERROR: no content_businesses row with slug={BUSINESS_SLUG!r}")
    return rows[0]


def find_existing(business_id, title):
    url = f"{_base()}/content_assets"
    params = {
        "business_id": f"eq.{business_id}",
        "title": f"eq.{title}",
        "select": "id,title,type",
    }
    r = requests.get(url, headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def publish(ctype="html_email", embed=False, dry_run=True,
            title=None, subject=None, image_url=None, update=False):
    if ctype not in VALID_TYPES:
        sys.exit(f"ERROR: type must be one of {sorted(VALID_TYPES)}")

    biz = resolve_business_id()
    business_id = biz["id"]
    workspace_id = biz["workspace_id"]

    today = datetime.date.today().isoformat()
    title = title or f"[{today}] Creator Recruitment — Get Booked & Paid"
    subject = subject or "Stop pitching brands in the DMs — let them book you"

    html = build_email(embed=embed)

    record = {
        "id":           str(uuid.uuid4()),
        "workspace_id": workspace_id,
        "business_id":  business_id,
        "title":        title,
        "type":         ctype,
        "content":      html,
        "subject":      subject,
        "platform":     PLATFORM_FOR[ctype],
        "tags":         ["creator-recruitment", "signup", "collabstr-tone"],
        "notes":        "Influencer recruitment email. Creator-first tone. "
                        "Images from Pixabay. Wire {{unsubscribe_url}} before sending.",
        "image_url":    image_url or "",
    }

    print(f"business: {biz['name']} ({business_id})")
    print(f"record  : type={ctype} platform={record['platform']} "
          f"embed={embed} content={len(html):,} bytes")
    print(f"title   : {title}")

    if dry_run:
        with open("collabmarket_email.html", "w", encoding="utf-8") as f:
            f.write(html)
        print("DRY RUN — nothing written. Preview: collabmarket_email.html")
        return None

    existing = find_existing(business_id, title)
    headers = _headers() | {"Prefer": "return=representation"}

    if existing and update:
        rid = existing[0]["id"]
        record["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        url = f"{_base()}/content_assets?id=eq.{rid}"
        r = requests.patch(url, headers=headers, data=json.dumps(record), timeout=60)
        r.raise_for_status()
        print(f"UPDATED existing asset id={rid}")
        return r.json()
    else:
        if existing and not update:
            print(f"NOTE: {len(existing)} asset(s) already share this title. "
                  f"Inserting a new row anyway (pass update=True to overwrite).")
        url = f"{_base()}/content_assets"
        r = requests.post(url, headers=headers, data=json.dumps(record), timeout=60)
        r.raise_for_status()
        out = r.json()
        new_id = out[0]["id"] if isinstance(out, list) and out else "(unknown)"
        print(f"INSERTED new asset id={new_id}")
        return out


if __name__ == "__main__":
    # Minimal manual entrypoint; routine.py is the orchestrator.
    publish(dry_run=True)
