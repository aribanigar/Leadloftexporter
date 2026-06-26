# Hosting & Migration Reference

This repo is **platform-portable**. The same `api/Dockerfile` runs on
Render, Fly.io, Railway, DigitalOcean App Platform, or a self-hosted VPS
without code changes. This doc captures the deployment configs and
migration paths so you can pick — or switch — any time.

## Current production layout

| Layer | Host today | Why |
|---|---|---|
| FastAPI backend (`/api`) | Render | Existing `render.yaml`. Free tier spins down; mitigated by `.github/workflows/keep-alive.yml` (cron ping every 10 min) |
| Frontend (Next.js root) | Vercel | Auto-deploys from main |
| Postgres | Supabase (`cmdnezltteldysoxyjzh.supabase.co`) | Free 500 MB. **Bottleneck** — fills with `content_assets` HTML bodies. |
| Redis | Render (when paid) / not running on free tier | Required for Celery; missing on free |
| Celery worker + beat | Skipped on Render free | No background workers on Render free tier |
| Chrome extension keep-alive ping | GitHub Actions (`*/10 * * * *`) | Keeps Render web warm so login is never cold |
| Content Hub daily routine | GitHub Actions (`0 6 * * *`) | 5-business brand-voice + A/B variants |

## Migration target options, ranked by fit

### 1. Fly.io (best long-term, free tier covers your stack)

- **Web** + **Celery worker** + **Celery beat** all run on the free tier
  (3 shared-cpu-1x machines)
- **No spin-down** — login is always instant
- **Multi-region** (pick `bom` for Indian users)
- **Postgres 3 GB free** (or keep your existing Neon / migrate Supabase)

Files in this repo:
- `api/fly.toml` — drop-in Fly config matching the existing Dockerfile
- `scripts/migrate_postgres.sh` — bidirectional Postgres data migration

Setup (from your laptop, not this sandbox):
```bash
# One-time
curl -L https://fly.io/install.sh | sh
fly auth login

# Deploy
cd api
fly launch --copy-config --no-deploy   # picks up fly.toml
fly secrets set DATABASE_URL='...' REDIS_URL='...' [every var from Render env]
fly deploy

# Add a Celery worker as a separate machine
fly machine clone <web-machine-id> --process worker

# Open
fly open
```

Cost when you outgrow free: ~$11/mo for web + worker + Postgres + Upstash Redis.

### 2. Stay on Render Starter ($7/mo per service)

Cheapest no-migration fix. Just upgrade the API service in the Render
dashboard. Solves cold-start permanently. If you also need Celery:
+ $7/mo for the worker service.

Same `render.yaml`, no code changes, no new accounts.

### 3. Hetzner CX11 (€3.79/mo, self-managed)

Cheapest paid option. One small VM running Docker for FastAPI + Postgres
+ Redis + Celery + nginx. Requires DevOps comfort.

```bash
ssh root@<vps-ip>
# install docker, docker-compose
git clone <repo>
cd Leadloftexporter
docker compose up -d
# add nginx + Let's Encrypt for HTTPS
```

### 4. Railway ($5/mo of free credit)

Click-deploy from GitHub. Picks up the `api/Dockerfile` automatically.
Best for prototypes; credit covers ~half a month of light traffic, then
stops the service until next month or you upgrade.

## Postgres migration: any → any

See `scripts/migrate_postgres.sh` for the bidirectional helper.

Common moves:

```bash
# Render → Fly Postgres
export SOURCE_DATABASE_URL='<Render Postgres URL>'
export DEST_DATABASE_URL='<Fly Postgres URL from `fly postgres connect`>'
bash scripts/migrate_postgres.sh

# Rollback Fly → Render
export SOURCE_DATABASE_URL='<Fly URL>'
export DEST_DATABASE_URL='<Render URL>'
bash scripts/migrate_postgres.sh

# Supabase → CockroachDB Serverless (free 10 GB)
export SOURCE_DATABASE_URL='postgres://...supabase.co/postgres'
export DEST_DATABASE_URL='postgres://...cockroachlabs.cloud:26257/defaultdb'
bash scripts/migrate_postgres.sh
```

Migration is reversible — script keeps the dump file locally until you
delete it, and never touches the source DB.

## Login-lockout root cause and fix

Render free-tier web services spin down after 15 minutes of inactivity.
The next request takes 30-60 seconds to cold-start the container, which
exceeds the frontend's HTTP timeout — the user sees "can't log in".

**Active fix**: `.github/workflows/keep-alive.yml` pings the API every
10 minutes. There is always a request within the last 10 minutes, so
the container never sleeps.

**Permanent fix**: Move to a host that doesn't spin down (Fly.io free,
Render Starter $7/mo, Hetzner €3.79/mo).

## What is NOT touched by any of this

- `extension/content/connect_all_on_page.js` and its `manifest.json`
  content_scripts entry are **locked** per CLAUDE.md. Hosting migration
  doesn't change the extension at all — it just calls a different
  backend URL via the existing runtime config.
- The Chrome extension talks to whatever `apiUrl` is set in
  `chrome.storage.local`, which is a one-line update after migration.
- Vercel frontend reads `NEXT_PUBLIC_API_URL` env var; update once on
  Vercel dashboard.

## Going further: storage offload (optional)

If Postgres storage itself is the bottleneck, see the
`api/app/services/content_refresh.py` cleanup TODOs. The big rows are:

- `EmailMessage.body_html` — can be archived to Cloudflare R2 after 90
  days (10 GB free, no egress fees)
- `Lead.avatar_url` — can be R2-hosted instead of inlined
- `content_assets.content` + `amp_content` — already on Supabase; move
  the whole `content_assets` table to CockroachDB Serverless (10 GB
  free) for the cheapest immediate relief

`scripts/migrate_postgres.sh` handles the table-move side; the R2
upload script is not in the repo yet — ask if you want it built.
