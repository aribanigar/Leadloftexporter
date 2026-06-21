#!/usr/bin/env python3
"""
publish_to_hub.py — push a day's per-business content into the Content Hub DB.

Backend is auto-selected so the same script works whether the hub lives on
Supabase or Neon, and whether the runner allows only HTTPS egress (443) or also
the Postgres wire protocol (5432):

  1. Supabase REST  — used when SUPABASE_URL + a service key are set. Talks to
     PostgREST over HTTPS only. No psycopg, no pip install. Preferred, because
     sandboxes and routine runners usually allow HTTPS but block 5432.
  2. Neon HTTP SQL  — used when DATABASE_URL points at *.neon.tech. HTTPS only.
  3. Postgres wire  — used for any other DATABASE_URL (e.g. a Supabase pooler
     URL with no service key). Needs psycopg and outbound 5432.

Business-agnostic: nothing is hardcoded. The routine that owns each business
supplies the slug, name, and branding via environment variables. The script
reads files under `content/<slug>/<date>/<CUR>/set-<n>/` (the <CUR> level is
optional) and inserts rows into `content_businesses` + `content_assets`.

Env:
  HUB_WORKSPACE       required. Workspace UUID the business folder lives under.
  HUB_BUSINESS_SLUG   required. Folder name under content/ (e.g. "acme-co").
  HUB_BUSINESS_NAME   optional. Display name (default: slug → title case).
  HUB_BRAND_COLOR     optional. Hex (default "#0e6b53").
  HUB_ACCENT_COLOR    optional. Hex (default "#008138").
  HUB_LOGO_URL        optional. Public logo URL.
  HUB_TONE            optional. AI-writer tone (default "vibrant").

  One of these connection sets is required:
  SUPABASE_URL          Supabase project URL, e.g. https://<ref>.supabase.co
  SUPABASE_SERVICE_KEY  (or SUPABASE_KEY)  Supabase service-role key.
    — or —
  DATABASE_URL        Neon URL (HTTPS SQL) or any Postgres URL (wire protocol).
                      A Supabase pooler URL works if SUPABASE_* is also set
                      (REST is preferred) or if outbound 5432 is open.

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
    """Strip a +driver suffix (postgresql+psycopg://… → postgresql://…)."""
    return re.sub(r"^(postgres(?:ql)?)\+[a-z0-9]+://", r"\1://", url.strip())


# --------------------------------------------------------------------------- #
# Backends. Each exposes the same small set of high-level operations.
# --------------------------------------------------------------------------- #
class SupabaseREST:
    """PostgREST over HTTPS. Stdlib only."""

    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/") + "/rest/v1"
        self.key = key

    def _req(self, method, path, body=None, prefer=None):
        headers = {"apikey": self.key, "Authorization": "Bearer " + self.key}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=45) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else []
        except HTTPError as e:
            raise RuntimeError("DB %s: %s" % (e.code, e.read().decode()[:300]))
        except URLError as e:
            raise RuntimeError("DB unreachable: %s" % e)

    @staticmethod
    def _eq(value) -> str:
        # percent-encode so commas/parentheses/dashes are not read as operators
        return "eq." + quote(str(value), safe="")

    def workspace_exists(self, ws):
        return bool(self._req("GET", "/workspaces?select=id&limit=1&id=%s" % self._eq(ws)))

    def get_business(self, ws, slug):
        rows = self._req("GET", "/content_businesses?select=id&workspace_id=%s&slug=%s"
                         % (self._eq(ws), self._eq(slug)))
        return rows[0]["id"] if rows else None

    def create_business(self, row):
        self._req("POST", "/content_businesses", [row], prefer="return=minimal")

    def asset_exists(self, biz, title):
        return bool(self._req("GET", "/content_assets?select=id&limit=1&business_id=%s&title=%s"
                              % (self._eq(biz), self._eq(title))))

    def insert_asset(self, row):
        self._req("POST", "/content_assets", [row], prefer="return=minimal")


class NeonSQL:
    """Neon HTTPS SQL endpoint. Stdlib only."""

    def __init__(self, dsn: str):
        self.conn = normalize(dsn)
        host = urlparse(self.conn).hostname
        if not host:
            raise SystemExit("DATABASE_URL has no host")
        self.url = "https://%s/sql" % host

    def q(self, sql, params=None):
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

    def get_business(self, ws, slug):
        rows = self.q("select id from content_businesses where workspace_id=$1 and slug=$2", [ws, slug])
        return rows[0]["id"] if rows else None

    def create_business(self, row):
        self.q("""insert into content_businesses
                    (id,workspace_id,name,slug,brand_color,accent_color,tone,logo_url)
                  values ($1,$2,$3,$4,$5,$6,$7,$8)""",
               [row["id"], row["workspace_id"], row["name"], row["slug"],
                row["brand_color"], row["accent_color"], row["tone"], row["logo_url"]])

    def asset_exists(self, biz, title):
        return bool(self.q("select 1 from content_assets where business_id=$1 and title=$2 limit 1",
                           [biz, title]))

    def insert_asset(self, row):
        self.q("""insert into content_assets
                    (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content,image_url)
                  values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)""",
               [row["id"], row["workspace_id"], row["business_id"], row["title"], row["type"],
                row["content"], row["subject"], row["platform"], json.dumps(row["tags"]),
                row["amp_content"], row["image_url"]])


class PgDirect:
    """Postgres wire protocol via psycopg. Needs outbound 5432 and psycopg installed."""

    def __init__(self, dsn: str):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError:
            raise SystemExit("psycopg not installed for direct Postgres. "
                             "Either set SUPABASE_URL + SUPABASE_SERVICE_KEY to use REST, "
                             "or run: pip3 install 'psycopg[binary]' --break-system-packages")
        self.conn = psycopg.connect(normalize(dsn), connect_timeout=20, autocommit=True)
        self._dict_row = dict_row

    def _q(self, sql, params=None):
        with self.conn.cursor(row_factory=self._dict_row) as cur:
            cur.execute(sql, params or [])
            return cur.fetchall() if cur.description else []

    def workspace_exists(self, ws):
        return bool(self._q("select id from workspaces where id=%s", [ws]))

    def get_business(self, ws, slug):
        rows = self._q("select id from content_businesses where workspace_id=%s and slug=%s", [ws, slug])
        return rows[0]["id"] if rows else None

    def create_business(self, row):
        self._q("""insert into content_businesses
                     (id,workspace_id,name,slug,brand_color,accent_color,tone,logo_url)
                   values (%s,%s,%s,%s,%s,%s,%s,%s)""",
                [row["id"], row["workspace_id"], row["name"], row["slug"],
                 row["brand_color"], row["accent_color"], row["tone"], row["logo_url"]])

    def asset_exists(self, biz, title):
        return bool(self._q("select 1 from content_assets where business_id=%s and title=%s limit 1",
                            [biz, title]))

    def insert_asset(self, row):
        self._q("""insert into content_assets
                     (id,workspace_id,business_id,title,type,content,subject,platform,tags,amp_content,image_url)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)""",
                [row["id"], row["workspace_id"], row["business_id"], row["title"], row["type"],
                 row["content"], row["subject"], row["platform"], json.dumps(row["tags"]),
                 row["amp_content"], row["image_url"]])


def derive_supabase_url(db):
    """Best-effort https://<ref>.supabase.co from a Supabase pooler DATABASE_URL."""
    if not db:
        return None
    u = urlparse(normalize(db))
    if "supabase" not in (u.hostname or ""):
        return None
    m = re.match(r"^postgres\.([a-z0-9]+)$", u.username or "")  # pooler user is postgres.<ref>
    return "https://%s.supabase.co" % m.group(1) if m else None


def pick_backend(db, sb_url, sb_key):
    """Return (backend, name). Prefers Supabase REST (HTTPS) when a key is present."""
    if sb_key and not sb_url:
        sb_url = derive_supabase_url(db)
    if sb_url and sb_key:
        return SupabaseREST(sb_url, sb_key), "supabase-rest"
    if db:
        host = urlparse(normalize(db)).hostname or ""
        if host.endswith("neon.tech"):
            return NeonSQL(db), "neon-http"
        return PgDirect(db), "pg-wire"
    return None, "no_secrets"


# --------------------------------------------------------------------------- #
def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read(p: Path):
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


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

    db = os.environ.get("DATABASE_URL")
    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
    have_db = bool(db) or bool(sb_key and (sb_url or derive_supabase_url(db)))
    if not ws or not have_db:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no_secrets)"}))
        return 0

    day = repo_root() / "content" / slug / args.date
    if not day.is_dir():
        print(json.dumps({"date": args.date, "error": "no content dir: %s" % day}))
        return 4

    backend, name = pick_backend(db, sb_url, sb_key)
    if backend is None:
        print(json.dumps({"date": args.date, "hub_publish": "skipped (no_secrets)"}))
        return 0

    try:
        if not backend.workspace_exists(ws):
            print(json.dumps({"date": args.date, "backend": name,
                              "error": "workspace not found: %s" % ws}))
            return 4
        biz = backend.get_business(ws, slug)
        created = biz is None
        if created:
            biz = str(uuid.uuid4())
            backend.create_business({
                "id": biz, "workspace_id": ws, "name": biz_name, "slug": slug,
                "brand_color": brand, "accent_color": accent, "tone": tone, "logo_url": logo})
    except RuntimeError as e:
        print(json.dumps({"date": args.date, "backend": name, "error": str(e),
                          "hint": "REST needs HTTPS egress; pg-wire needs outbound 5432"}))
        return 5

    rep = {"date": args.date, "backend": name, "business_id": biz,
           "created_business": created, "inserted": 0, "skipped": 0, "failures": []}

    for sd in sorted({p.parent for p in day.rglob("meta.json")}):
        m = json.loads(read(sd / "meta.json"))
        cur = m.get("currency", sd.parent.name)
        theme = m.get("theme", sd.name)
        date_s = m.get("date", args.date)
        seas = m.get("season", "")
        image = m.get("image") or None  # hero photo → rides on the WhatsApp asset
        # Stable, unique title per (date, currency, theme) so reruns are no-ops.
        camp = m.get("campaign_name") or f"{date_s} · {cur} · {theme}"
        code = m.get("campaign_code", f"{date_s}-{cur}-{theme}")
        subj = m.get("subject")
        eh, ea = read(sd / "email.html"), read(sd / "email.amp.html")
        wa, li = read(sd / "whatsapp.txt"), read(sd / "linkedin.txt")
        # (title, type, content, subject, platform, tags, amp, image_url)
        jobs = []
        if eh:
            jobs.append((camp, "html_email", eh, subj, None, [code, cur] + ([seas] if seas else []), ea, None))
        if wa:
            jobs.append((camp + " — WhatsApp", "whatsapp", wa, None, None, [code, cur], None, image))
        if li:
            jobs.append((camp + " — LinkedIn", "caption", li, None, "linkedin", [code, cur], None, None))
        for title, atype, content, s, plat, tags, amp, image_url in jobs:
            try:
                if backend.asset_exists(biz, title):
                    rep["skipped"] += 1
                    continue
                backend.insert_asset({
                    "id": str(uuid.uuid4()), "workspace_id": ws, "business_id": biz,
                    "title": title, "type": atype, "content": content, "subject": s,
                    "platform": plat, "tags": tags, "amp_content": amp, "image_url": image_url})
                rep["inserted"] += 1
            except Exception as e:  # noqa: BLE001
                rep["failures"].append([title, str(e)])

    print(json.dumps(rep, indent=2))
    return 1 if rep["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
