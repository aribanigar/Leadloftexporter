# LeadCaptura — Turnkey Deploy Checklist

Follow top to bottom. Nothing here needs code changes — it's all "create service,
set env, deploy." Dependencies install automatically on each platform (Vercel
runs `npm install`, Render builds the Docker image). Times assume accounts exist.

> The ONE thing NOT in this archive: the **secret VALUES** (DB URL, API keys,
> JWT secret). Those are never committed for security. Either the current owner
> shares them privately, or you provision your own (a new Postgres + fresh keys).
> Every required var is listed below and in `.env.api.example` / `.env.local.example`.

---

## 0) Accounts / prerequisites
- **GitHub** (host the code so Vercel + Render can auto-deploy from it)
- **Render** (backend, Docker) — https://render.com
- **Vercel** (frontend) — https://vercel.com
- **Postgres** — Supabase, Neon, or Render Postgres (any Postgres 14+)
- Optional: **Redis** (only if you run Celery workers), a domain, Gmail/Google
  OAuth creds, Anthropic key.

## 1) Put the code on GitHub
```bash
unzip leadcaptura-source.zip && cd Leadloftexporter
git init && git add -A && git commit -m "LeadCaptura"
git branch -M main
git remote add origin https://github.com/<you>/leadcaptura.git
git push -u origin main
```

## 2) Provision Postgres → get DATABASE_URL
Create a Postgres DB. Copy its connection string and convert the scheme to:
```
postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME
```
(The `+psycopg` part is required — SQLAlchemy picks the driver from it.)
No manual schema step: the backend runs `alembic upgrade head` on every boot.

## 3) Deploy the BACKEND → Render (Docker)
- New **Web Service** → connect the GitHub repo.
- **Root Directory:** `api`  ·  **Runtime:** Docker (uses `api/Dockerfile`).
- **Environment variables** (minimum):
  ```
  DATABASE_URL=postgresql+psycopg://...        (from step 2)
  SECRET_KEY=<long random string>
  FRONTEND_ORIGINS=https://<your-vercel-domain>   (fill after step 4; can update later)
  PUBLIC_API_URL=https://<this-render-service>.onrender.com
  ```
  Optional (features degrade gracefully if unset): `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GMAIL_*`, `GOOGLE_*`, `GOOGLE_PLACES_API_KEY`, `CRON_SECRET`,
  `CONTENT_INGEST_TOKEN`, `SMTP_RELAY_SECRET`, `WA_SIDECAR_URL`, `WA_SIDECAR_TOKEN`.
- Deploy. When live, hit `https://<service>.onrender.com/health` → `{"ok":true}`.
- (Full stack with workers + Redis: deploy via the included `render.yaml` blueprint
  instead. Free tier can skip workers — the API still serves every sync endpoint.)

## 4) Deploy the FRONTEND → Vercel
- **Import Project** → the same GitHub repo. Framework auto-detects Next.js.
  Leave root as the repo root (no override; `.vercelignore` already skips `api/`
  and `extension/`).
- **Environment variable:**
  ```
  NEXT_PUBLIC_API_URL=https://<your-render-backend>.onrender.com
  ```
- Deploy. Then go back to Render and set `FRONTEND_ORIGINS` to the Vercel URL
  (comma-separate multiple), and redeploy the backend so CORS allows it.

## 5) First login
Open the Vercel URL → **Register**. That creates the first user + workspace and
seeds the default pipeline. You're live.

## 6) Optional add-ons
- **Keep the free-tier backend warm:** the repo ships
  `.github/workflows/keep-alive.yml` (pings every 10 min). In GitHub → repo
  **Settings → Secrets and variables → Actions → Variables**, set `API_URL` to
  your backend URL so it warms the right host. (Or upgrade Render off free tier.)
- **Cron tasks without a paid worker:** set `CRON_SECRET` on the backend and hit
  `/api/v1/cron/run` on a schedule (cron-job.org) to fire reminders/agendas/drains.
- **WhatsApp sidecar:** deploy `whatsapp/` as a second Render Docker service; set
  `WA_SIDECAR_URL` + `WA_SIDECAR_TOKEN` on both it and the backend.
- **Content routine → Content Hub:** set the SAME `CONTENT_INGEST_TOKEN` on the
  backend and in the routine env; the routine then publishes via
  `POST /content-hub/ingest` (see HANDOFF.md §"Content Hub routine ingest").

## 7) Chrome extension (not a hosted deploy)
`extension/` is loaded unpacked: `chrome://extensions` → Developer mode → Load
unpacked → select the `extension/` folder. Its default backend URL is baked into
`extension/background/service-worker.js` and `extension/options/options.js` —
update those to your backend before zipping/distributing.

---

### Required-vs-optional at a glance
| Service | Must set | Everything else |
|---|---|---|
| Backend (Render) | `DATABASE_URL`, `SECRET_KEY`, `FRONTEND_ORIGINS`, `PUBLIC_API_URL` | optional / feature-gated |
| Frontend (Vercel) | `NEXT_PUBLIC_API_URL` | — |

That's it — with those four backend vars + one frontend var + a Postgres, the
app deploys and runs.
