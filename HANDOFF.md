# LeadCaptura — Developer Handoff

This zip contains the **entire LeadCaptura system** ready for a fresh deployment. Below is what's inside and how to bring it up in a new environment.

---

## What's inside

| Path | What it is | Where it runs in production |
|---|---|---|
| `/` (root) | Next.js 15 frontend (App Router + TanStack Query) | Vercel |
| `/api` | FastAPI backend (Postgres + Redis + Celery) | Render (Docker) |
| `/extension` | Chrome MV3 extension (LinkedIn capture, Connect All, Mass Apply) | User's browser (unpacked or packaged zip) |
| `/whatsapp` | Node/Baileys WhatsApp sidecar (Express) | Render (Docker, free tier OK) |
| `/scripts` | Standalone Python helpers (Content Hub seeder, etc.) | Routine system / cron-job.org |
| `/content` | Daily marketing content (Gifts Gulf etc.) committed per-day | Source-controlled in repo |
| `/public` | Frontend static assets (logos, favicons) | Vercel CDN |
| `CLAUDE.md` | **Comprehensive architecture doc — read this first** | Project root |
| `DEPLOY.md` | Original deploy instructions | Project root |
| `README.md` | Original README | Project root |
| `render.yaml` | Render Blueprint config (API + worker + WhatsApp sidecar) | Render |
| `vercel.json` | Vercel config (root deploy, no rootDir override) | Vercel |
| `docker-compose.yml` | Local-dev all-in-one (Postgres + Redis + API + worker) | Local dev only |
| `.vercelignore` | Excludes `/api`, `/extension`, `/whatsapp` from Vercel builds | Frontend deploys |

## What's NOT in the zip (regenerate / configure on receiving side)

- `node_modules/` — run `npm install` at the root
- `__pycache__/`, `*.pyc` — auto-generated on first import
- `.git/` history — fresh repo; receiver can `git init`
- `.env` / `.env.production` / `.env.local` — **all secrets**. Use the env-var docs below to populate them per environment.
- Built extension zips (older versions) — receiver can `cd extension && zip -r ../leadcaptura-extension.zip .` for any version
- `.next/` build cache — auto-generates on `npm run build`

---

## Bootstrap in a new environment

### 1. Pre-requisites on receiving side

- **Postgres** (we use [Neon](https://neon.tech/) — free tier works, but the API process keeps it warm via a daemon thread; see `api/app/main.py`)
- **Redis** (Render's managed Redis is fine; only used by Celery worker, optional on free tier)
- **Vercel** account + project linked to the repo root
- **Render** account (Blueprint mode reads `render.yaml`)
- **GitHub** repo (any provider works, but auto-deploy hooks are wired for GitHub)

### 2. Environment variables

#### Backend (`/api` on Render)

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon URL with `postgresql+psycopg://` scheme (SQLAlchemy picks driver from scheme) |
| `JWT_SECRET` | ✅ | Any long random string |
| `FRONTEND_ORIGINS` | optional | CORS allow-list (defaults to `*`; CORS also has a regex for `chrome-extension://*`) |
| `PUBLIC_API_URL` | ✅ | e.g. `https://your-api.onrender.com` — used for tracking-pixel + reset-link URLs |
| `CRON_SECRET` | recommended | Shared secret for the external-cron `/cron/run` endpoint |
| `ANTHROPIC_API_KEY` | optional | Enables AI marketing-email generation (Claude). Falls back to a deterministic template if unset |
| `OPENAI_API_KEY` | optional | Enables Whisper transcription for the Notetaker |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | Google Calendar OAuth |
| `WA_SIDECAR_URL` | optional | URL of the WhatsApp sidecar (e.g. `https://your-wa.onrender.com`) |
| `WA_SIDECAR_TOKEN` | optional | Shared secret with the WhatsApp sidecar (matches `WA_BACKEND_TOKEN` on the sidecar) |
| `SENTRY_DSN` | optional | Sentry error reporting |

#### WhatsApp sidecar (`/whatsapp` on Render — free plan OK)

| Var | Required | Notes |
|---|---|---|
| `WA_DB_URL` | ✅ | Same Neon URL as the API — Baileys sessions live in `wa_auth`/`wa_kv` tables |
| `WA_SIDECAR_TOKEN` | ✅ | Must match the API's `WA_SIDECAR_TOKEN` |
| `WA_BACKEND_URL` | optional | API origin for inbound message webhook (`/whatsapp-web/webhook/inbound`); if unset, CRM-timeline sync is disabled but inbox still works |

#### Frontend (`/` on Vercel)

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | ✅ | URL of the deployed FastAPI backend (e.g. `https://your-api.onrender.com`) |

### 3. Deploy order

1. **Provision Neon Postgres** → copy the connection string (use the `postgresql+psycopg://` scheme variant).
2. **Push this code to a fresh GitHub repo.**
3. **Render → New Blueprint → connect the repo.** The `render.yaml` provisions: API web service (Docker), Celery worker, Celery beat, optional WhatsApp sidecar. Set the env vars listed above on the API service.
4. **First boot**: the API Dockerfile `CMD` runs `alembic upgrade head && uvicorn …`, so migrations run automatically on every container start. Initial schema is built fresh on an empty DB.
5. **Vercel → New Project → connect the same repo, root directory = repo root.** Set `NEXT_PUBLIC_API_URL` to the Render API URL.
6. **External cron**: configure cron-job.org (or similar) to GET `https://<api>/api/v1/cron/run?token=<CRON_SECRET>` every 60 seconds. This drives campaigns, reminders, agenda generation, and the WhatsApp tick drain.
7. **Extension**: `cd extension && zip -r ../leadcaptura-extension.zip .` — distribute the zip to users; they install via `chrome://extensions` → Developer mode → Load unpacked.

### 4. Local development (`docker-compose up --build` at repo root)

Brings up Postgres + Redis + API + Celery worker + beat all wired together. Frontend separately:

```bash
npm install
npm run dev              # http://localhost:3000
# (in another shell) point NEXT_PUBLIC_API_URL=http://localhost:8000
```

Extension: `chrome://extensions` → Developer mode → Load unpacked → select `/extension`.

---

## Architecture cheat-sheet

**The full architecture is in `CLAUDE.md` (~500 lines). Read it before making changes.** Key high-level points the developer should internalise:

- **Two auth paths share one app**: JWT bearer for the web app (`get_workspace_context`) and `X-API-Key` for the Chrome extension (`get_extension_context`). Every endpoint depends on one or the other — never both.
- **All SQLAlchemy models live in one file**: `api/app/models/base.py`. Intentional — relationships are dense.
- **`Lead.custom` is JSONB with a GIN index** for arbitrary user-defined fields without migrations.
- **Email send pipeline**: campaign tick (cron-driven OR browser-poll-driven via `src/app/api/campaigns/[id]/tick/route.ts`) → SMTP via Vercel relay (Render blocks SMTP ports) → IMAP append to Sent folder via `imapflow`.
- **WhatsApp sidecar is internal-only**: FastAPI router `whatsapp_web.py` proxies frontend calls to it using `WA_SIDECAR_URL` + `WA_SIDECAR_TOKEN`. Sidecar pushes captured messages back to API via webhook (`/whatsapp-web/webhook/inbound`).
- **Neon DB keep-alive thread** in `api/app/main.py` runs `SELECT 1` every 240 seconds to prevent Neon's free-tier auto-suspend (which caused "login hangs" historically).

## Key invariants — don't break these

Documented in detail in `CLAUDE.md` under the appropriate sections; here are the headline rules:

1. **Campaign sending is decoupled from warmup.** `_eligible_senders` must NEVER skip a sender because of its warmup ceiling. Warmup row is attached for counter accuracy only.
2. **`_process_tick` is a simple single-batch loop.** Don't add multi-batch, PER_TICK_CAP, per-sender pacing cursors, or "drain backlog" logic.
3. **bcrypt is pinned to 4.0.1**. `passlib==1.7.4` reads `bcrypt.__about__.__version__` which 4.1+ removed → login 500s. Don't bump bcrypt without moving off passlib.
4. **The extension uses raw JS — no build step.** Don't introduce npm or bundlers inside `/extension`.
5. **The Neon keep-alive thread stays running.** It's the difference between sub-second login and 2-5s cold starts.
6. **Cron runs in a background thread + re-entrancy guard.** `/cron/run` returns immediately. Don't make the cron path synchronous — it starves login.

## Production URLs (current)

- Frontend: `https://leadloftexporter.vercel.app`
- Backend: `https://leadcaptura-api.onrender.com`
- WhatsApp sidecar: `https://leadcaptura-whatsapp.onrender.com` (private — only API talks to it)

Receiver replaces all three with their own URLs and updates `NEXT_PUBLIC_API_URL` + `PUBLIC_API_URL` + `WA_SIDECAR_URL` + `WA_BACKEND_URL` accordingly.

---

## Support / questions

The full architecture, all gotchas, every load-bearing detail, and the reasoning behind every design choice is in `CLAUDE.md`. The original `README.md` and `DEPLOY.md` are also included for the high-level overview and deploy steps.
