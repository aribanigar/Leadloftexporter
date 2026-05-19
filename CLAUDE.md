# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

The **LeadCaptura monorepo** — a LinkedIn lead-generation SaaS in three independent deployables:

```
/api         FastAPI backend (Postgres + Redis + Celery)  → Render
(root)       Next.js 15 frontend (App Router + TanStack)  → Vercel
/extension   Chrome MV3 extension (LinkedIn capture)      → unpacked / zipped
```

Each can be modified independently. The extension talks to the API; the frontend talks to the API; nothing talks to the extension.

## Commands

### Backend (`/api`)

```bash
# Local dev (Docker Compose also brings up Postgres + Redis + worker + beat)
docker compose up --build

# Local dev (without Docker — needs Postgres + Redis running)
cd api
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# New migration after editing models in app/models/base.py
cd api && alembic revision --autogenerate -m "describe change"

# Run Celery worker / beat against local Redis
celery -A app.workers.celery_app worker --loglevel=info
celery -A app.workers.celery_app beat --loglevel=info
```

The Dockerfile `CMD` runs `alembic upgrade head && uvicorn …`, so migrations run on every boot in production.

### Frontend (repo root)

```bash
npm install
npm run dev           # http://localhost:3000
npm run build         # validates types + builds; always run before pushing
npm run type-check    # tsc --noEmit only
npm run lint
```

`NEXT_PUBLIC_API_URL` must point at the running backend (defaults to `http://localhost:8000` in `src/lib/api.ts`).

### Extension (`/extension`)

```bash
# Load locally
# chrome://extensions → Developer mode → Load unpacked → select extension/

# Syntax-check before commit (no build step, raw JS)
for f in $(find extension -name '*.js'); do node --check "$f" || break; done
python3 -c "import json; json.load(open('extension/manifest.json'))"

# Package
zip -r leadcaptura-extension.zip extension
```

After editing content scripts, also reload the LinkedIn tab — Chrome only re-injects on tab reload.

## Backend architecture (`/api`)

### Two auth paths share one app

`app/core/deps.py` defines:
- **`get_workspace_context`** — JWT Bearer for the web app. Workspace is selected via `X-Workspace-Id` header (a user can belong to multiple).
- **`get_extension_context`** — `X-API-Key` for the Chrome extension. Keys are SHA-256 hashed at rest and prefix-indexed for fast lookup. Generated in **Settings → API Keys** of the web app.

Every endpoint depends on one or the other — never both. `app/api/v1/extension.py` is the only router using the extension auth path.

### CRM data model

All SQLAlchemy models live in **one file**: `app/models/base.py`. This is intentional — relationships are dense (Lead ↔ Stage ↔ Workspace ↔ Enrollment ↔ Playbook ↔ Step ↔ Job) and a single file avoids circular-import gymnastics.

The `Lead.custom` column is **JSONB with a GIN index** so users can add arbitrary fields without migrations. Filters against it use Postgres `@>` containment. Default lead/pipeline schema is seeded by `app/services/bootstrap.py` on workspace creation (7 stages, 14 system fields, 5 saved views).

### Outreach engine

`app/services/outreach.py` enrolls leads into playbooks and produces work items:
- **Email steps** → `app/services/email_sender.py` sends via Gmail OAuth or SMTP.
- **LinkedIn steps** (`connect`, `message`) → enqueued as **ExtensionJob** rows. The extension polls `/extension/jobs/next` and reports back via `/extension/jobs/{id}/result`.

Daily quotas (`email_limit`, `linkedin_connect_limit`, `linkedin_message_limit`) live on the workspace and are enforced **server-side** in `outreach.py` — the extension never schedules anything itself. Step scheduling jitter goes through `humanise_run_at()` which respects the workspace's outreach time window ±15 min.

### Celery topology

`app/workers/celery_app.py` defines a beat schedule with a single recurring task: `tick_outreach_scheduler` (every minute). That task is what creates queued jobs from active enrollments. On Render's free tier the workers are skipped — the API still serves all sync endpoints but no outreach fires.

## Frontend architecture (repo root)

Next.js 15 App Router. Route groups:

- `src/app/login`, `src/app/register` — public, unauthenticated.
- `src/app/(app)/*` — authenticated shell. The `(app)` group's `layout.tsx` enforces a workspace context and renders the sidebar/topbar. Routes here mirror LeadLoft's UX: `prospecting`, `pipeline`, `inbox`, `tasks`, `playbooks/[id]`, and a fully populated `settings/*` tree.

`src/lib/api.ts` is the **only** place that calls the backend. It reads `NEXT_PUBLIC_API_URL`, attaches the JWT from `src/lib/auth.ts`, and adds the `X-Workspace-Id` header. All other code goes through TanStack Query hooks that wrap this client.

The TypeScript build is strict — `src/lib/api.ts:errorMessage` was once written as a chained `&& ||` expression that TypeScript widened to `{}`. If you touch error-handling, use an explicit `if` block and assign to a `let message: string` rather than relying on inference.

## Extension architecture (`/extension`)

```
manifest.json                MV3, host: linkedin.com only (backend host requested at runtime)
background/service-worker.js API proxy for content scripts; routes openOptionsPage
content/
  main.js                    SPA-navigation hook, autopilot tick (60s interval)
  overlay.js                 profile panel + bottom toolbar + per-card Save pills
  scraper.js                 /in/, /search/, /sales/* DOM scrapers
  automate.js                human-paced executor for connect/message jobs
  lib/api.js                 sendMessage wrapper around the service worker
popup/                       toolbar popup: status, autopilot toggle
options/                     API key + capture behavior settings
```

### Bot-detection avoidance (design rules — do not break)

1. **Never call LinkedIn's internal APIs.** Read only the rendered DOM the user has already loaded.
2. **Never automate in a hidden tab.** `automate.js` checks `document.visibilityState === "visible"` before each action.
3. **Human-paced everything.** 45–180s between consequential actions (~18% long-tail to 3 min), 40–140ms per-typed-character, eased scrolls with randomised offsets, 1.2–3.5s "reading" pause after navigation.
4. **Real DOM events.** Clicks go through `dispatchHumanClick` which fires `pointerover` → `pointerdown` → `pointerup` → `click` with realistic coordinates.
5. **Abort on challenge.** `detectChallenge()` aborts and reports failure if a captcha/checkpoint surfaces.
6. **Daily caps live server-side.** The extension only runs what `/extension/jobs/next` hands it.

### Cross-context API surface

`chrome.runtime.openOptionsPage` only works in extension pages (popup/options/service worker) — **not** in content scripts. The content overlay calls `chrome.runtime.sendMessage({ type: "lc:openOptions" })` and the service worker proxies it. Apply the same pattern for any other privileged API.

The manifest only grants host permission to `linkedin.com`. When the user pastes a Backend URL in the Options page, `options.js` calls `chrome.permissions.request({ origins: [origin] })` to request that host at runtime — without this, all fetches fail with the generic `Failed to fetch`.

### Selectors drift

LinkedIn rewrites markup often. Prefer multiple selectors via `first(root, [...])`. Sales Navigator uses `data-anonymize` attributes which are stable-ish — `scrapeSalesNavProfile` / `scrapeSalesNavSearch` rely on those. Tests against the live site would be flaky; instead log every selector attempted on failure.

## Deployment topology

| Component | Host | Key file |
|---|---|---|
| Frontend | Vercel (repo root, no rootDir override) | `vercel.json`, `next.config.mjs` |
| Backend + workers + Redis | Render (Blueprint) | `render.yaml`, `api/Dockerfile` |
| Postgres | Neon (external) | — |

`DATABASE_URL` **must** use the `postgresql+psycopg://` scheme (not `postgresql://`) — SQLAlchemy picks the driver from the scheme.

`FRONTEND_ORIGINS` (backend) controls CORS allowed origins. CORS also has a regex permitting any `chrome-extension://*` origin so the extension always works regardless of this value.

`render.yaml` defaults to Starter plan ($21/mo for api + 2 workers). For a free-tier deploy, create the API as a single Web Service manually (Docker, rootDir `api`) and skip the workers — the API still serves all sync endpoints, only the outreach scheduler stops.

## Things to watch for

- **`/api` and `/extension` are excluded from Vercel builds** by `.vercelignore`. If you add another top-level directory that should also be skipped, add it there too.
- **Don't add `web_accessible_resources` to the manifest you don't reference** — Chrome logs a warning.
- **Don't grant `<all_urls>` in the manifest.** Host permissions are restricted to linkedin.com plus runtime-granted backend host.
- **No build step for the extension.** Keep raw JS; do not introduce npm or bundlers.
- **Models in one file.** Resist the urge to split `app/models/base.py` — the import graph relies on it.
