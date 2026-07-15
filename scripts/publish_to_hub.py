#!/usr/bin/env python3
"""
publish_to_hub.py — push a day's per-business content into the Content Hub DB.

Two HTTPS backends, auto-selected so the publisher works from sandboxes that
allow ONLY HTTPS egress (no Postgres wire port 5432/6543):

  * Supabase REST (PostgREST) — used when SUPABASE_URL + SUPABASE_SERVICE_KEY
    are set. Talks to https://<ref>.supabase.co/rest/v1 over 443. This is the
    correct backend for a Supabase-hosted Hub.
  * Neon HTTP SQL — used otherwise, when DATABASE_URL points at a Neon host
    that exposes the https://<host>/sql endpoint.

Neither backend needs psycopg or a pip install: standard library only.

Business-agnostic: nothing is hardcoded. The routine that owns each business
supplies the slug, name, and branding via environment variables. The script
reads files under `content/<slug>/<date>/set-<n>/` (currency subfolders also
supported) and inserts rows into `content_businesses` + `content_assets`.

Env:
  HUB_WORKSPACE       required. Workspace UUID the business folder lives under.
  HUB_BUSINESS_SLUG   required. Folder name under content/ (e.g. "gifts-gulf").
  HUB_BUSINESS_NAME   optional. Display name (default: slug -> title case).
  HUB_BRAND_COLOR     optional. Hex (default "#0e6b53").
  HUB_ACCENT_COLOR    optional. Hex (default "#008138").
  HUB_LOGO_URL        optional. Public logo URL.
  HUB_TONE            optional. AI-writer tone (default "vibrant").

  CRM ingest backend (PREFERRED — works when the DB is only reachable by the
  backend, e.g. Supabase egress-restricted / Postgres ports blocked):
    CONTENT_INGEST_TOKEN  shared secret; MUST match the backend's CONTENT_INGEST_TOKEN.
    CONTENT_INGEST_URL    backend base URL (default https://leadloftexporter.onrender.com).
  Supabase backend (used if no ingest token):
    SUPABASE_URL          e.g. https://abcd.supabase.co
    SUPABASE_SERVICE_KEY  service_role key (bypasses RLS)
  Neon / direct-Postgres backend (last fallback):
    DATABASE_URL          Neon/Postgres URL (postgresql+psycopg://... accepted; +driver stripped).

Usage:
  python3 scripts/publish_to_hub.py --date 2026-06-13   # default: today UTC

Idempotent: an asset whose (business_id, title) already exists is skipped.
Prints one JSON object. Exits non-zero only on real DB errors.
"""
import argparse, datetime as dt, json, os, re, sys, uuid
from pathlib import Path
from urllib.parse import urlparse, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def normalize(url: str) -> str:
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


# --------------------------------------------------------------------------
# Backends. Each exposes the same small interface used by seed():
#   workspace_exists(ws) -> bool
#   business_id(ws, slug) -> str | None
#   create_business(fields: dict) -> str            (returns new id)
#   asset_exists(biz, title) -> bool
#   insert_asset(fields: dict) -> None
# --------------------------------------------------------------------------
class Neon:
    """Neon serverless driver over its HTTPS SQL endpoint (port 443)."""

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

    def workspace_exists(self, ws):
        return bool(self.q("select id from workspaces where id=$1", [ws]))

    def business_id(self, ws, slug):
        rows = self.q("select id from content_businesses where workspace_id=$1 and slug=$2", [ws, slug])
        return rows[0]["id"] if rows else None

    def create_business(self, f):
        biz = str(uuid.uuid4())
        self.q("""insert into content_businesses
                    (id,workspace_id,name,slug,brand_color,accent_color,tone,logo_url)
                  values ($1,$2,$3,$4,$5,$6,$7,$8)""",
               [biz, f["workspace_id"], f["name"], f["slug"], f["brand_color"],
                f["accent_color"], f["tone"], f["logo_url"]])
        return biz

    def asset_exists(self, biz, title):
        return bool(self.q("select 1 from content_assets where business_id=$1 and title=$2 limit 1",
                           [biz, title]))

    def insert_asset(self, f):
        self.q("""insert into content_assets
                    (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content,image_url)
                  values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)""",
               [str(uuid.uuid4()), f["workspace_id"], f["business_id"], f["title"], f["type"],
                f["content"], f["subject"], f["platform"], json.dumps(f["tags"]),
                f["amp_content"], f["image_url"]])


class SupabaseREST:
    """Supabase PostgREST data API over HTTPS (port 443). Uses the service_role
    key so it bypasses row level security."""

    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/") + "/rest/v1"
        self.key = key

    def _req(self, method, path, body=None, prefer=None):
        headers = {
            "apikey": self.key,
            "Authorization": "Bearer " + self.key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=45) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else []
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)

    @staticmethod
    def _eq(v):
        # PostgREST filter value: percent-encode so spaces / punctuation / the
        # em dash in titles survive as a literal equality match.
        return "eq." + quote(str(v), safe="")

    def workspace_exists(self, ws):
        return bool(self._req("GET", "/workspaces?select=id&id=%s&limit=1" % self._eq(ws)))

    def business_id(self, ws, slug):
        rows = self._req("GET", "/content_businesses?select=id&workspace_id=%s&slug=%s&limit=1"
                         % (self._eq(ws), self._eq(slug)))
        return rows[0]["id"] if rows else None

    def create_business(self, f):
        biz = str(uuid.uuid4())
        self._req("POST", "/content_businesses", body={
            "id": biz, "workspace_id": f["workspace_id"], "name": f["name"],
            "slug": f["slug"], "brand_color": f["brand_color"],
            "accent_color": f["accent_color"], "tone": f["tone"],
            "logo_url": f["logo_url"],
        }, prefer="return=minimal")
        return biz

    def asset_exists(self, biz, title):
        return bool(self._req("GET", "/content_assets?select=id&business_id=%s&title=%s&limit=1"
                              % (self._eq(biz), self._eq(title))))

    def insert_asset(self, f):
        self._req("POST", "/content_assets", body={
            "id": str(uuid.uuid4()), "workspace_id": f["workspace_id"],
            "business_id": f["business_id"], "title": f["title"], "type": f["type"],
            "content": f["content"], "subject": f["subject"], "platform": f["platform"],
            "tags": f["tags"], "amp_content": f["amp_content"], "image_url": f["image_url"],
        }, prefer="return=minimal")


class CrmIngest:
    """Publish through the CRM backend's POST /content-hub/ingest endpoint,
    authenticated with a shared secret (CONTENT_INGEST_TOKEN).

    This is the channel that works when the DB isn't directly reachable — e.g.
    Supabase is egress-restricted (REST returns 402) and Postgres ports are
    blocked in the routine sandbox — because the *backend* still has a working
    pooled DB connection. We accumulate the business + all its assets and POST
    them in ONE idempotent call on flush(); the server resolves-or-creates the
    business and dedups assets by (business, title), so reruns are no-ops."""

    def __init__(self, base: str, token: str, workspace_id: str):
        self.url = base.rstrip("/") + "/api/v1/content-hub/ingest"
        self.token = token
        self.ws = workspace_id
        self._biz = None
        self._assets = []
        self.result = None

    # The routine drives the backend per-row; for the HTTP path we just collect.
    def workspace_exists(self, ws):
        return True                      # validated server-side on flush

    def business_id(self, ws, slug):
        return None                      # force create_business (server resolves-or-creates)

    def create_business(self, f):
        self._biz = {
            "slug": f["slug"], "name": f["name"], "brand_color": f["brand_color"],
            "accent_color": f["accent_color"], "tone": f["tone"], "logo_url": f["logo_url"],
        }
        return "__ingest__"              # placeholder id; real id comes back from the server

    def asset_exists(self, biz, title):
        return False                     # server dedups idempotently

    def insert_asset(self, f):
        self._assets.append({
            "title": f["title"], "type": f["type"], "content": f["content"],
            "amp_content": f.get("amp_content"), "subject": f.get("subject"),
            "platform": f.get("platform"), "tags": f.get("tags") or [],
            "image_url": f.get("image_url"),
        })

    def flush(self):
        if self._biz is None:
            return None
        payload = {"workspace_id": self.ws, "business": self._biz, "assets": self._assets}
        req = Request(self.url, data=json.dumps(payload).encode(), method="POST",
                      headers={"Content-Type": "application/json", "X-Content-Token": self.token})
        try:
            with urlopen(req, timeout=120) as r:
                raw = r.read().decode()
                self.result = json.loads(raw) if raw else {}
                return self.result
        except HTTPError as e:
            raise RuntimeError("ingest %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("ingest unreachable: %s" % e)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def seed(backend, args, ws, slug, biz_name, brand, accent, logo, tone):
    day = repo_root() / "content" / slug / args.date
    if not day.is_dir():
        print(json.dumps({"date": args.date, "error": "no content dir: %s" % day}))
        return 4

    if not backend.workspace_exists(ws):
        print(json.dumps({"date": args.date, "error": "workspace not found: %s" % ws}))
        return 4

    biz = backend.business_id(ws, slug)
    created = False
    if not biz:
        biz = backend.create_business({
            "workspace_id": ws, "name": biz_name, "slug": slug,
            "brand_color": brand, "accent_color": accent, "tone": tone, "logo_url": logo,
        })
        created = True

    rep = {"date": args.date, "backend": backend.__class__.__name__,
           "business_id": biz, "created_business": created,
           "inserted": 0, "skipped": 0, "failures": []}

    for sd in sorted({p.parent for p in day.rglob("meta.json")}):
        m = json.loads(read(sd / "meta.json"))
        cur = m.get("currency", sd.parent.name)
        theme = m.get("theme", sd.name)
        date_s = m.get("date", args.date)
        seas = m.get("season", "")
        image = m.get("image") or None  # hero photo -> rides on the WhatsApp asset
        # Stable, unique title per (date, currency, theme) so reruns are no-ops.
        name = m.get("campaign_name") or "%s · %s · %s" % (date_s, cur, theme)
        code = m.get("campaign_code", "%s-%s-%s" % (date_s, cur, theme))
        subj = m.get("subject")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        # (title, type, content, subject, platform, tags, amp, image_url)
        jobs = []
        if eh:
            jobs.append((name, "html_email", eh, subj, None, [code, cur] + ([seas] if seas else []), ea, None))
        if wa:
            jobs.append((name + " — WhatsApp", "whatsapp", wa, None, None, [code, cur], None, image))
        if li:
            jobs.append((name + " — LinkedIn", "caption", li, None, "linkedin", [code, cur], None, None))
        for title, atype, content, s, plat, tags, amp, image_url in jobs:
            try:
                if backend.asset_exists(biz, title):
                    rep["skipped"] += 1
                    continue
                backend.insert_asset({
                    "workspace_id": ws, "business_id": biz, "title": title, "type": atype,
                    "content": content, "subject": s, "platform": plat, "tags": tags,
                    "amp_content": amp, "image_url": image_url,
                })
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    # HTTP-ingest backend batches everything and writes on flush — the server's
    # counts are authoritative (it does the real resolve-or-create + dedup).
    if hasattr(backend, "flush"):
        srv = backend.flush()
        if isinstance(srv, dict):
            rep["business_id"] = srv.get("business_id", rep["business_id"])
            rep["created_business"] = srv.get("created_business", rep["created_business"])
            rep["inserted"] = srv.get("inserted", rep["inserted"])
            rep["skipped"] = srv.get("skipped", rep["skipped"])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    ws = os.environ.get("HUB_WORKSPACE")
    slug = os.environ.get("HUB_BUSINESS_SLUG")
    if not slug:
        print(json.dumps({"date": args.date, "error": "HUB_BUSINESS_SLUG not set"}))
        return 2
    biz_name = os.environ.get("HUB_BUSINESS_NAME", slug.replace("-", " ").title())
    brand = os.environ.get("HUB_BRAND_COLOR", "#0e6b53")
    accent = os.environ.get("HUB_ACCENT_COLOR", "#008138")
    logo = os.environ.get("HUB_LOGO_URL", "")
    tone = os.environ.get("HUB_TONE", "vibrant")

    # Preferred channel: the CRM backend's ingest endpoint (works even when the
    # DB is only reachable by the backend, e.g. Supabase egress-restricted /
    # Postgres ports blocked). Falls back to the direct DB channels.
    ingest_token = os.environ.get("CONTENT_INGEST_TOKEN")
    ingest_url = os.environ.get("CONTENT_INGEST_URL", "https://leadloftexporter.onrender.com")
    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    db = os.environ.get("DATABASE_URL")

    if not ws:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no HUB_WORKSPACE)"}))
        return 0

    if ingest_token and ingest_url:
        backend = CrmIngest(ingest_url, ingest_token, ws)
    elif sb_url and sb_key:
        backend = SupabaseREST(sb_url, sb_key)
    elif db:
        backend = Neon(db)
    else:
        print(json.dumps({"date": args.date,
                          "hub_publish": "skipped (set CONTENT_INGEST_TOKEN, or SUPABASE_URL/SUPABASE_SERVICE_KEY, or DATABASE_URL)"}))
        return 0

    try:
        return seed(backend, args, ws, slug, biz_name, brand, accent, logo, tone)
    except RuntimeError as e:
        print(json.dumps({"date": args.date, "backend": backend.__class__.__name__,
                          "error": str(e)}))
        return 5


if __name__ == "__main__":
    sys.exit(main())
