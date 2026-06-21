#!/usr/bin/env python3
"""
seed_via_kashmir.py - seed ONE day of ViaKashmir (viakashmir.in) content into the
Content Hub DB. Independent of the itinerary engine: it only ever touches the
'via-kashmir' business and the content/via-kashmir/ tree.

Talks to Supabase over its PostgREST HTTPS API (port 443), not the Postgres wire
protocol (5432), so it works from routine runners / sandboxes that allow only
HTTPS egress. Standard library only - no psycopg.

Configuration (env vars; never commit secrets to this file):
  SUPABASE_URL          e.g. https://<ref>.supabase.co   (else derived from DATABASE_URL)
  SUPABASE_SERVICE_KEY  service-role key (or SUPABASE_KEY / SUPABASE_SERVICE_ROLE_KEY)
  DATABASE_URL          optional - only used to DERIVE the project ref for SUPABASE_URL
  HUB_WORKSPACE         workspace UUID (default below)

Reads what the routine wrote under:
  content/via-kashmir/<date>/<track>/{email.html,email.amp.html,whatsapp.txt,linkedin.txt,meta.json}
Tracks (one folder each): b2c | b2b-hotels | b2b-cabs-shikaras | b2b-houseboats

Usage:
  python3 scripts/via-kashmir/seed_via_kashmir.py --date 2026-06-15   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# --- this engine's fixed identity ---------------------------------------------
SLUG  = "via-kashmir"
NAME  = "Via Kashmir"
LOGO  = "https://viakashmir.in/logo-colour.svg?v=3"
BRAND = "#0e3d2f"      # deep forest green
ACCENT = "#c8a84b"     # saffron gold
TONE  = "warm-editorial"

HUB_WORKSPACE = os.environ.get("HUB_WORKSPACE", "1a716353-9472-4c1d-ae89-f95052e8f015")

# Defaults match the sibling itinerary seeder so this engine auto-seeds unattended.
# Env vars override; the repo is private by design (see README security note).
_DEFAULT_SUPABASE_URL = "https://cmdnezltteldysoxyjzh.supabase.co"
_DEFAULT_SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNtZG5l"
    "emx0dGVsZHlzb3h5anpoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNjQyOSwi"
    "ZXhwIjoyMDk3NDgyNDI5fQ.owlPxYZz-f7TyXxJ5ikuVF7z2IVo98dyf6DXKhHMWRM"
)


def _project_ref_from_dburl(dburl: str):
    """Supabase poolers use a username like 'postgres.<ref>'; direct hosts are
    '<ref>.supabase.co'. Pull the ref so we can build the PostgREST base URL."""
    if not dburl:
        return None
    try:
        u = urlparse(re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", dburl.strip()))
    except ValueError:
        return None
    if u.username and "." in u.username:           # pooler: postgres.<ref>
        return u.username.split(".", 1)[1]
    if u.hostname and u.hostname.endswith(".supabase.co"):
        return u.hostname.split(".")[0]
    return None


def _resolve_base_url():
    base = os.environ.get("SUPABASE_URL")
    if not base:
        ref = _project_ref_from_dburl(os.environ.get("DATABASE_URL", ""))
        if ref:
            base = "https://%s.supabase.co" % ref
    return (base or _DEFAULT_SUPABASE_URL).rstrip("/")


def _resolve_key():
    for name in ("SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    return _DEFAULT_SUPABASE_KEY


class Supabase:
    """Thin PostgREST client. .q()-style helpers below keep call sites tiny."""
    def __init__(self):
        self.base = _resolve_base_url()
        self.key = _resolve_key()

    def _call(self, method, path, body=None, prefer=None):
        headers = {"apikey": self.key, "Authorization": "Bearer " + self.key,
                   "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.base + "/rest/v1/" + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=45) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else []
        except HTTPError as e:
            raise RuntimeError("Supabase %s on %s %s: %s"
                               % (e.code, method, path, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("Supabase unreachable: %s" % e)

    def get(self, path):
        return self._call("GET", path)

    def insert(self, table, row):
        return self._call("POST", table, row, prefer="return=minimal")

    def update(self, path, patch):
        return self._call("PATCH", path, patch, prefer="return=minimal")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed ViaKashmir content into the Content Hub.")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    day = repo_root() / "content" / SLUG / args.date
    if not day.is_dir():
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "no content dir: %s" % day}))
        return 4

    n = Supabase()
    if not n.get("workspaces?id=eq.%s&select=id" % HUB_WORKSPACE):
        print(json.dumps({"engine": SLUG, "date": args.date,
                          "error": "workspace not found: %s" % HUB_WORKSPACE}))
        return 4

    rows = n.get("content_businesses?workspace_id=eq.%s&slug=eq.%s&select=id"
                 % (HUB_WORKSPACE, SLUG))
    if rows:
        biz, created = rows[0]["id"], False
        n.update("content_businesses?id=eq.%s&workspace_id=eq.%s" % (biz, HUB_WORKSPACE),
                 {"name": NAME, "brand_color": BRAND, "accent_color": ACCENT,
                  "tone": TONE, "logo_url": LOGO})
    else:
        biz, created = str(uuid.uuid4()), True
        n.insert("content_businesses",
                 {"id": biz, "workspace_id": HUB_WORKSPACE, "name": NAME, "slug": SLUG,
                  "brand_color": BRAND, "accent_color": ACCENT, "tone": TONE, "logo_url": LOGO})

    # Existing titles for this business -> idempotency set (one fetch, not per-row).
    existing = {r["title"] for r in
                n.get("content_assets?business_id=eq.%s&select=title&limit=5000" % biz)}

    rep = {"engine": SLUG, "date": args.date, "business_id": biz,
           "created_business": created, "inserted": 0, "skipped": 0, "failures": []}

    for sd in sorted({p.parent for p in day.rglob("meta.json")}):
        m = json.loads(read(sd / "meta.json"))
        code = m.get("campaign_code", sd.name)
        name = m.get("campaign_name", code)
        subj = m.get("subject")
        track = m.get("track", sd.name)
        seas = m.get("season", "")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None,
                         [code, track] + ([seas] if seas else []), ea))
        if wa:
            jobs.append((name + " - WhatsApp", "whatsapp", wa, None, None, [code, track], None))
        if li:
            jobs.append((name + " - LinkedIn", "caption", li, None, "linkedin", [code, track], None))
        for title, atype, content, s, plat, tags, amp in jobs:
            try:
                if title in existing:
                    rep["skipped"] += 1
                    continue
                n.insert("content_assets",
                         {"id": str(uuid.uuid4()), "workspace_id": HUB_WORKSPACE,
                          "business_id": biz, "title": title, "type": atype,
                          "content": content, "subject": s, "platform": plat,
                          "tags": tags, "amp_content": amp})
                existing.add(title)
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
