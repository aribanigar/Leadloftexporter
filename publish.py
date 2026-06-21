#!/usr/bin/env python3
"""
publish.py — Date Khaas content-hub publisher.

Pipeline:
  1. Read a content bundle (content.json) produced by the daily routine.
  2. Fetch Muslim-wedding images from the Pixabay API.
  3. Write each item to disk under content-hub/date-khaas/<date>/ (for git history).
  4. Seed each item into the Supabase content_assets table via REST API.
  5. Optionally git add/commit/push.

Uses the Supabase REST API (HTTPS/443) — no direct Postgres connection needed.

Env (put in .env or export):
  SUPABASE_URL          e.g. https://cmdnezltteldysoxyjzh.supabase.co  (required)
  SUPABASE_SERVICE_KEY  service-role JWT or sb_secret_… key             (required)
  HUB_WORKSPACE         workspace UUID                                   (required)
  PIXABAY_API_KEY       free key from https://pixabay.com/api/docs/      (for images)
  CONTENT_SLUG          project slug, default "date-khaas"
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("requests not installed. Run: pip install requests")

# ----------------------------------------------------------------------------- #
# config
# ----------------------------------------------------------------------------- #

DEFAULT_SLUG      = os.environ.get("CONTENT_SLUG", "date-khaas")
DEFAULT_WORKSPACE = "1a716353-9472-4c1d-ae89-f95052e8f015"
ROOT              = Path(__file__).resolve().parent
CONTENT_DIR       = ROOT / "content-hub" / "date-khaas"

# content_assets column names (discovered via probe; keep in sync if schema changes)
CONTENT_TABLE = "content_assets"

# ----------------------------------------------------------------------------- #
# .env loader
# ----------------------------------------------------------------------------- #

def load_dotenv(path=".env"):
    p = ROOT / path
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ----------------------------------------------------------------------------- #
# REST helpers
# ----------------------------------------------------------------------------- #

def rest_headers(key):
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def rest_get(base, path, key, params=None):
    r = requests.get(f"{base}/rest/v1{path}", headers=rest_headers(key),
                     params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def rest_post(base, path, key, body):
    r = requests.post(f"{base}/rest/v1{path}", headers=rest_headers(key),
                      json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def rest_patch(base, path, key, body):
    r = requests.patch(f"{base}/rest/v1{path}", headers=rest_headers(key),
                       json=body, timeout=20)
    r.raise_for_status()
    return r.json()


# ----------------------------------------------------------------------------- #
# schema probe
# ----------------------------------------------------------------------------- #

def probe_schema(base, key):
    """Return (columns dict, openapi path entry) for content_assets."""
    spec = requests.get(f"{base}/rest/v1/", headers=rest_headers(key), timeout=20)
    spec.raise_for_status()
    data = spec.json()
    defn = data.get("definitions", {}).get(CONTENT_TABLE, {})
    return defn.get("properties", {})


def lookup_business_id(base, key, workspace_id, slug):
    """Return business_id for the given slug in this workspace, or None."""
    rows = rest_get(base, f"/content_businesses",  key,
                    params={"workspace_id": f"eq.{workspace_id}",
                            "slug": f"eq.{slug}",
                            "select": "id,name,slug"})
    return rows[0]["id"] if rows else None


# ----------------------------------------------------------------------------- #
# pixabay
# ----------------------------------------------------------------------------- #

def fetch_pixabay(query, count, out_dir):
    """Download up to `count` images for `query`. Returns list of metadata dicts."""
    key = os.environ.get("PIXABAY_API_KEY")
    if not key:
        print("  ! PIXABAY_API_KEY not set — skipping image fetch", file=sys.stderr)
        return []

    out_dir.mkdir(parents=True, exist_ok=True)
    params = {
        "key": key, "q": query, "image_type": "photo",
        "orientation": "horizontal", "safesearch": "true",
        "order": "popular", "per_page": max(3, min(count * 3, 50)),
    }
    r = requests.get("https://pixabay.com/api/", params=params, timeout=30)
    r.raise_for_status()
    hits = r.json().get("hits", [])[:count]

    results = []
    for i, h in enumerate(hits):
        url = h.get("largeImageURL") or h.get("webformatURL")
        if not url:
            continue
        ext = os.path.splitext(url.split("?")[0])[1] or ".jpg"
        slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
        fname = f"{slug}-{h.get('id', i)}{ext}"
        fpath = out_dir / fname
        try:
            img = requests.get(url, timeout=60)
            img.raise_for_status()
            fpath.write_bytes(img.content)
        except Exception as e:
            print(f"  ! failed to download {url}: {e}", file=sys.stderr)
            continue
        results.append({
            "local_path": str(fpath.relative_to(ROOT)),
            "remote_url": h.get("largeImageURL"),
            "page_url":   h.get("pageURL"),
            "author":     h.get("user"),
            "pixabay_id": h.get("id"),
            "tags":       h.get("tags"),
            "has_faces":  any(t.strip() in ("people","person","woman","man","bride","groom")
                              for t in (h.get("tags") or "").split(",")),
            "license":    "Pixabay Content License (free commercial use, no attribution required)",
        })
    print(f"  ↳ pixabay '{query}': {len(results)} image(s)")
    return results


# ----------------------------------------------------------------------------- #
# row builder
# ----------------------------------------------------------------------------- #

def build_row(item, workspace_id, business_id, status, now):
    """Build the dict to POST to content_assets."""
    tags = dict(item.get("metadata") or {})
    for k in ("subject", "preheader", "channel", "format", "images", "cta_url"):
        if item.get(k) is not None:
            tags.setdefault(k, item[k])
    tags.setdefault("status", status)
    tags.setdefault("generated_by", "datekhaas-daily-routine")

    # For AMP emails: content = AMP HTML, amp_content = plain-HTML fallback
    if item.get("format") == "amp":
        content     = item.get("body", "")
        amp_content = item.get("body_fallback")
    else:
        content     = item.get("body", "")
        amp_content = None

    first_image = (item.get("images") or [{}])[0].get("remote_url") if item.get("images") else None

    row = {
        "id":           str(uuid.uuid4()),
        "workspace_id": workspace_id,
        "business_id":  business_id,
        "title":        item.get("title"),
        "type":         item["type"],
        "content":      content,
        "subject":      item.get("subject"),
        "platform":     item.get("channel"),
        "tags":         tags,
        "notes":        item.get("preheader") or item.get("format"),
        "image_url":    first_image,
        "created_at":   now,
        "updated_at":   now,
    }
    if amp_content:
        row["amp_content"] = amp_content
    # strip None values so Postgres uses column defaults
    return {k: v for k, v in row.items() if v is not None}


# ----------------------------------------------------------------------------- #
# git
# ----------------------------------------------------------------------------- #

def git(*args, check=True):
    return subprocess.run(["git", *args], cwd=ROOT, check=check,
                          capture_output=True, text=True)


def git_commit(message):
    try:
        git("rev-parse", "--is-inside-work-tree")
    except subprocess.CalledProcessError:
        print("  ! not a git repo — skipping commit", file=sys.stderr)
        return None
    git("add", "content-hub/date-khaas")
    status = git("status", "--porcelain", "content-hub/date-khaas").stdout.strip()
    if not status:
        print("  ↳ git: nothing new to commit")
        return None
    git("commit", "-m", message)
    sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"  ↳ git commit {sha}")
    try:
        git("push", "-u", "origin", git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip())
        print("  ↳ git push ok")
    except subprocess.CalledProcessError as e:
        print(f"  ! git push failed (commit is local): {e.stderr.strip()}", file=sys.stderr)
    return sha


# ----------------------------------------------------------------------------- #
# main
# ----------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Date Khaas content-hub publisher (REST API)")
    ap.add_argument("--bundle",            default="content.json")
    ap.add_argument("--probe",             action="store_true",
                    help="print discovered schema and business list, then exit")
    ap.add_argument("--dry-run",           action="store_true",
                    help="build rows + print them, skip DB insert and git")
    ap.add_argument("--no-images",         action="store_true")
    ap.add_argument("--no-git",            action="store_true")
    ap.add_argument("--images-per-item",   type=int, default=3)
    ap.add_argument("--status",            default="draft")
    ap.add_argument("--commit-message",    default=None)
    ap.add_argument("--slug",              default=None,
                    help="override content slug (default: CONTENT_SLUG env or 'date-khaas')")
    args = ap.parse_args()

    load_dotenv()

    base      = os.environ.get("SUPABASE_URL", "").rstrip("/")
    svc_key   = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("ANON_KEY")
    workspace = os.environ.get("HUB_WORKSPACE", DEFAULT_WORKSPACE)
    slug      = args.slug or DEFAULT_SLUG

    if not base:
        sys.exit("SUPABASE_URL not set")
    if not svc_key:
        sys.exit("SUPABASE_SERVICE_KEY (or ANON_KEY) not set")

    # ---- probe -------------------------------------------------------------- #
    if args.probe:
        cols = probe_schema(base, svc_key)
        print(f"content table : {CONTENT_TABLE}")
        print(f"columns       :")
        for col, info in cols.items():
            print(f"  {col:<22} {info.get('format') or info.get('type','?')}")
        print()
        biz = rest_get(base, "/content_businesses", svc_key,
                       params={"workspace_id": f"eq.{workspace}", "select": "id,name,slug"})
        print(f"businesses in workspace {workspace[:8]}…:")
        for b in biz:
            marker = " ← active" if b["slug"] == slug else ""
            print(f"  {b['id']}  {b['slug']:<28} {b['name']}{marker}")
        return

    # ---- load bundle -------------------------------------------------------- #
    bundle_path = ROOT / args.bundle
    if not bundle_path.exists():
        sys.exit(f"bundle not found: {bundle_path}")
    bundle = json.loads(bundle_path.read_text())
    items  = bundle["items"] if isinstance(bundle, dict) else bundle
    today  = dt.date.today().isoformat()
    day_dir = CONTENT_DIR / today
    day_dir.mkdir(parents=True, exist_ok=True)

    # ---- look up business --------------------------------------------------- #
    business_id = lookup_business_id(base, svc_key, workspace, slug)
    if not business_id:
        sys.exit(f"No content_business with slug='{slug}' in workspace {workspace}. "
                 f"Run --probe to list available businesses.")
    print(f"  ↳ business: {slug} → {business_id}")

    # ---- images ------------------------------------------------------------- #
    if not args.no_images:
        img_dir = day_dir / "images"
        cache = {}
        for it in items:
            q = it.get("image_query")
            if not q:
                continue
            if q not in cache:
                cache[q] = fetch_pixabay(q, args.images_per_item, img_dir)
            it["images"] = cache[q]

    # ---- write files -------------------------------------------------------- #
    for i, it in enumerate(items, 1):
        stem = (f"{i:02d}-{it['type']}-"
                f"{re.sub(r'[^a-z0-9]+', '-', (it.get('title') or 'untitled').lower()).strip('-')}")
        (day_dir / f"{stem}.json").write_text(json.dumps(it, indent=2, ensure_ascii=False))
        if it.get("body"):
            ext = "html" if "html" in it.get("type","") or it.get("format") == "amp" else "txt"
            (day_dir / f"{stem}.{ext}").write_text(it["body"])
    print(f"  ↳ wrote {len(items)} item file(s) to {day_dir.relative_to(ROOT)}")

    # ---- insert ------------------------------------------------------------- #
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    inserted = []
    for it in items:
        row = build_row(it, workspace, business_id, args.status, now)
        if args.dry_run:
            print(f"\nDRY RUN row ({it['type']}):")
            for k, v in row.items():
                print(f"  {k}: {str(v)[:80]}")
            continue
        try:
            data = rest_post(base, f"/{CONTENT_TABLE}", svc_key, row)
            rid  = data[0]["id"] if isinstance(data, list) else data.get("id")
            print(f"  ↳ inserted {it['type']:<12} platform={it.get('channel'):<10} id={rid}")
            inserted.append(rid)
        except requests.HTTPError as e:
            print(f"  ! FAILED {it['type']}: {e.response.status_code} {e.response.text[:200]}",
                  file=sys.stderr)

    # ---- git ---------------------------------------------------------------- #
    if not args.no_git and not args.dry_run:
        msg = (args.commit_message
               or f"content(date-khaas): daily drop {today} ({len(items)} items)")
        git_commit(msg)

    if inserted:
        print(f"\nDone. Seeded {len(inserted)}/{len(items)} rows into {CONTENT_TABLE}.")
        print("Row IDs:", inserted)


if __name__ == "__main__":
    main()
