# Fly.io migration runbook — LeadCaptura API

**Goal**: get login working again, off Render (suspended), on Fly.io free tier.

**Time**: ~30 minutes total. **Cost**: $0 on Fly free tier.

**Prerequisites**:
- A laptop with internet (this won't work from a phone)
- Your Render dashboard login (to copy env vars)
- About 30 free minutes

## Phase 1 — Install flyctl (3 min)

On **macOS**:
```bash
curl -L https://fly.io/install.sh | sh
```

On **Linux** (Ubuntu/Debian):
```bash
curl -L https://fly.io/install.sh | sh
echo 'export PATH="$HOME/.fly/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

On **Windows** (PowerShell as Administrator):
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Verify install:
```bash
fly version
```

## Phase 2 — Sign up + create Fly account (2 min)

```bash
fly auth signup
# Opens a browser. Sign up with GitHub (recommended) or email.
# Adds a payment card — Fly REQUIRES card to prevent abuse, BUT will not
# charge you while you stay within the free allowance (3 shared-cpu-1x
# machines, 3 GB storage). Your first $5/mo of usage is also free.
```

If you already have a Fly account:
```bash
fly auth login
```

## Phase 3 — Launch the app (5 min)

From your laptop's terminal, in the LOCAL CLONE of your repo:

```bash
cd Leadloftexporter/api          # <-- the api/ folder
fly launch --copy-config --no-deploy
```

This reads `api/fly.toml` (already in your repo) and prompts you:
- **App name**: `leadcaptura-api` (press Enter to accept)
- **Region**: `bom` (Mumbai — closest to Indian users). Press Enter.
- **Postgres**: type `y` → pick "Development - Single node" (free 3 GB)
- **Redis**: type `n` (we'll use Upstash free tier — see Phase 5)
- **Deploy now**: type `n` (we're not ready — need to set secrets first)

When this completes you'll see:
```
Your app is ready. Deploy with `fly deploy`.
```

Make a note of the Postgres connection string Fly prints — you'll need it in Phase 4. It looks like:
```
postgres://postgres:<password>@<app>-db.flycast:5432
```

If you missed it, get it later with:
```bash
fly postgres connect -a leadcaptura-api-db
```

## Phase 4 — Migrate Postgres data from Render to Fly (10 min)

You need TWO connection strings:
1. **SOURCE**: Your current Render Postgres URL (from Render dashboard → Database → "External Database URL")
2. **DEST**: The Fly Postgres URL from Phase 3

Run from this repo (your laptop):
```bash
cd Leadloftexporter

# Install Postgres client tools if you don't have them
# macOS:  brew install libpq && brew link --force libpq
# Linux:  sudo apt-get install postgresql-client

export SOURCE_DATABASE_URL='<paste Render URL here>'
export DEST_DATABASE_URL='<paste Fly URL here>'

bash scripts/migrate_postgres.sh
```

The script:
- Verifies both DBs are reachable
- Asks you to confirm with "yes"
- Dumps Render → local file → restores into Fly
- Prints row counts on Fly as a sanity check

If anything fails, the dump file stays on your laptop. Re-run is safe (idempotent).

**Heads up**: if Render has suspended your service, the Postgres might also be suspended. Check the Render dashboard — Postgres is usually a separate plan from the web service. If it IS suspended, you have two choices:
- Wait until the 1st of the month (when the free tier resets) — login won't work until then
- Pay Render $7/mo briefly to unsuspend the Postgres, do the migration, then cancel

Tell me which one is your case and I'll guide you.

## Phase 5 — Set up Upstash Redis free tier (3 min)

Fly Redis isn't on free. Upstash gives you 10 MB free, which is plenty for Celery:

1. https://console.upstash.com → Sign in with GitHub
2. **Create Database** → name `leadcaptura-redis` → Region: `ap-south-1` (Mumbai)
3. After creation, click the DB → **Details** → copy the **Redis URL** (looks like `redis://default:xxxxx@xxx.upstash.io:6379`)

## Phase 6 — Copy env vars from Render to Fly (5 min)

In the Render dashboard, open your suspended service → **Environment** tab. You'll see a list of env vars. Copy each into a `fly secrets set` command.

The variables you almost certainly have (only set the ones that are non-empty in Render):

```bash
cd Leadloftexporter/api    # back into api/ folder where fly.toml lives

fly secrets set \
  SECRET_KEY='<from Render>' \
  DATABASE_URL='<the Fly Postgres URL from Phase 3>' \
  REDIS_URL='<the Upstash URL from Phase 5>' \
  FRONTEND_ORIGINS='https://leadloftexporter.vercel.app,https://leadloftexporter.com' \
  ANTHROPIC_API_KEY='<from Render>' \
  OPENAI_API_KEY='<from Render>' \
  GOOGLE_CLIENT_ID='<from Render>' \
  GOOGLE_CLIENT_SECRET='<from Render>' \
  GMAIL_CLIENT_ID='<from Render>' \
  GMAIL_CLIENT_SECRET='<from Render>' \
  GOOGLE_PLACES_API_KEY='<from Render>' \
  SMTP_RELAY_URL='https://leadloftexporter.vercel.app/api/smtp-relay' \
  SMTP_RELAY_SECRET='<from Render>' \
  PUBLIC_API_URL='https://leadcaptura-api.fly.dev' \
  APP_ENV=production
```

If Render shows other vars (Sentry DSN, Stripe keys, WhatsApp sidecar URL, etc.), include them too. The full reference list is at the bottom of this doc.

## Phase 7 — Deploy (2 min)

```bash
fly deploy
```

This builds your `api/Dockerfile`, ships it to Fly's Mumbai region, runs `python migrate.py` (Alembic upgrade head), and starts uvicorn. Takes 2-4 minutes.

When done you'll see:
```
✓ Machine <id> [app] update succeeded
✓ Machine <id> [app] update finished: success
```

Test the new URL:
```bash
curl -i https://leadcaptura-api.fly.dev/
# Should be HTTP 200 or 404 (both mean the API is alive)
```

## Phase 8 — Update Vercel frontend URL (2 min)

Vercel needs to know the API URL changed:

1. https://vercel.com/dashboard → your project → **Settings** → **Environment Variables**
2. Find `NEXT_PUBLIC_API_URL`
3. Change value to `https://leadcaptura-api.fly.dev`
4. **Redeploy** the frontend: **Deployments** → click latest → **Redeploy**

Wait ~2 min for Vercel to redeploy.

## Phase 9 — Test login (1 min)

Open https://leadloftexporter.vercel.app/login in an incognito window. Try to log in.

**Login should work.**

If it doesn't, run:
```bash
fly logs
```
and paste the output — I'll diagnose from here.

## Phase 10 — Add Celery worker as a second free machine (5 min, optional)

Outreach scheduler, content refresh, warmup engine all need Celery. Render free didn't run these. Fly free does.

```bash
# Spawn a 2nd free machine running the worker process group
fly machine clone <web-machine-id> --process worker

# And a 3rd for celery beat
fly machine clone <web-machine-id> --process beat

# Verify all 3 are running
fly status
```

`fly.toml` already defines the `[processes]` block for `web`, `worker`, and `beat`. The 3 machines share the same image and env vars.

## Phase 11 — Update Chrome extension's backend URL (3 min)

The extension talks to Render today. Update it to Fly:

Option A — edit the manifest's host permissions and the default API URL inside `extension/background/service-worker.js`. I can ship this commit for you the moment you tell me Fly is live.

Option B — leave Render as a free tier "spin-down forever" service that the extension can fall through to, and add Fly as a NEW host permission. Belt-and-braces.

Tell me when you're at Phase 11 and I'll ship the right change.

## Phase 12 — Cancel Render to stop the suspension confusion (1 min)

After login works on Fly for 24-48 hours and you're confident:

1. Render dashboard → suspended service → **Settings** → **Delete Service**
2. Same for the Render Postgres (after confirming Fly Postgres has all your data)

This step is optional — you can keep Render around as a paid-zero archive for a few weeks if you want a rollback path.

---

## Quick reference: full env var list

If Render shows any of these env vars, include in `fly secrets set`:

| Var | Source | Notes |
|---|---|---|
| `SECRET_KEY` | Render | JWT signing — copy exactly or all sessions invalidate |
| `DATABASE_URL` | Fly Postgres (Phase 3) | NEW value — Fly's, not Render's |
| `REDIS_URL` | Upstash (Phase 5) | NEW value |
| `FRONTEND_ORIGINS` | Render | CORS allowlist |
| `PUBLIC_API_URL` | Set to `https://leadcaptura-api.fly.dev` | Used in OAuth redirect URLs |
| `APP_ENV` | Set to `production` | Disables dev-mode behaviors |
| `ANTHROPIC_API_KEY` | Render | AI writer |
| `ANTHROPIC_MODEL` | Render (optional) | Defaults to `claude-opus-4-7` |
| `OPENAI_API_KEY` | Render | Whisper transcription |
| `WHISPER_MODEL` | Render (optional) | Defaults to `whisper-1` |
| `GOOGLE_CLIENT_ID` | Render | Google Calendar OAuth |
| `GOOGLE_CLIENT_SECRET` | Render | Google Calendar OAuth |
| `GOOGLE_REDIRECT_URI` | Set to `https://leadcaptura-api.fly.dev/api/v1/calendar/oauth/google/callback` | Update in Google Console too |
| `GMAIL_CLIENT_ID` | Render | Gmail sender OAuth |
| `GMAIL_CLIENT_SECRET` | Render | Gmail sender OAuth |
| `GMAIL_REDIRECT_URI` | Set to `https://leadcaptura-api.fly.dev/api/integrations/gmail/callback` | Update in Google Console too |
| `GOOGLE_PLACES_API_KEY` | Render | Company finder |
| `SMTP_RELAY_URL` | `https://leadloftexporter.vercel.app/api/smtp-relay` | Vercel SMTP bridge (unchanged) |
| `SMTP_RELAY_SECRET` | Render | Shared secret with Vercel bridge |
| `WA_SIDECAR_URL` | Render | WhatsApp sidecar (if you use it) |
| `WA_SIDECAR_TOKEN` | Render | WhatsApp sidecar auth (if you use it) |
| `CRON_SECRET` | Render | External cron trigger |
| `STRIPE_SECRET_KEY` | Render (if billing live) | — |
| `STRIPE_WEBHOOK_SECRET` | Render (if billing live) | — |
| `SENTRY_DSN` | Render (optional) | Error monitoring |

## Things that DON'T need updating

- The Chrome extension's `host_permissions` already includes
  `https://leadloftexporter.onrender.com/*`. After cutover, we add the
  Fly URL to it (Phase 11).
- The GitHub Actions content-daily routine talks directly to Supabase
  REST — unaffected.
- The keep-alive cron we shipped is now redundant once you're on Fly
  (Fly machines don't spin down) — we'll remove it in Phase 11.

## Rollback if something breaks

If at any point Fly is misbehaving and you want to instantly go back:

1. In Vercel, change `NEXT_PUBLIC_API_URL` back to `https://leadloftexporter.onrender.com`
2. Redeploy Vercel
3. (Render service has to be unsuspended for this to actually work)

Or if Render is permanently dead, the Fly Postgres data can be moved
to ANY other host using the same `migrate_postgres.sh` script in
reverse.

---

## When you're stuck

Reply with:
- The exact `fly` command that failed and its full output
- OR the error you see when trying to log in on the new Fly URL
- OR a screenshot of the Render dashboard banner (if Postgres is also suspended)

I'll fix the actual problem in the next response, not patch around it.
