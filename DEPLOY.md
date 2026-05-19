# Deploying LeadCaptura

The stack splits into three independent deployables:

| Component | Hosting | Cost on free/starter |
|---|---|---|
| Next.js frontend (repo root) | Vercel | $0 |
| FastAPI API + Celery worker + beat (`/api`) | Render (or Railway/Fly) | $7/mo each on starter |
| Postgres | Neon | $0 |
| Redis | Render's managed Redis (or Upstash) | $0–$10 |

## 1. Provision Postgres (Neon)

1. Create a free project at <https://neon.tech>.
2. Copy the **connection string** with the `postgresql+psycopg://` driver — Neon shows it as `postgresql://`, just replace the scheme:
   ```
   postgresql+psycopg://user:pw@ep-xxx.neon.tech/neondb?sslmode=require
   ```

## 2. Deploy the backend on Render

1. Push this repo to GitHub (already done on branch `claude/linkedin-lead-generation-saas-u7GDc`).
2. Go to <https://dashboard.render.com> → **New +** → **Blueprint** → connect this repo.
3. Render reads `render.yaml`, which provisions:
   - `leadcaptura-api` (Docker web service on `/api`)
   - `leadcaptura-worker` (Celery worker)
   - `leadcaptura-beat` (Celery beat)
   - `leadcaptura-redis` (managed Redis)
4. Fill the `sync: false` env vars in the dashboard:
   - `DATABASE_URL` — Neon connection string from step 1
   - `FRONTEND_ORIGINS` — `https://your-app.vercel.app`
   - `ANTHROPIC_API_KEY` — from <https://console.anthropic.com>
   - `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` — optional, only needed for Gmail send
   - `SENTRY_DSN` — optional
5. Deploy. Migrations run on boot via the Dockerfile `CMD`.
6. Note your API URL: `https://leadcaptura-api.onrender.com`.

### Alternative: Railway

1. <https://railway.app> → **New** → **Deploy from GitHub** → pick this repo.
2. Railway reads `railway.json` and uses `api/Dockerfile`.
3. Add Postgres + Redis plugins from Railway's marketplace (or use Neon + Upstash).
4. Set the env vars listed above.
5. Add a second service for the Celery worker pointing to the same Dockerfile with start command `celery -A app.workers.celery_app worker --loglevel=info`. Add a third for `celery beat`.

## 3. Deploy the frontend on Vercel

1. <https://vercel.com/new> → import this repo.
2. Set **Root Directory** to `web` (or leave at root — `vercel.json` handles both).
3. Environment variables:
   - `NEXT_PUBLIC_API_URL` = your backend URL (`https://leadcaptura-api.onrender.com`)
   - `NEXT_PUBLIC_APP_NAME` = `LeadCaptura`
4. Deploy. Vercel returns `https://your-app.vercel.app`.
5. Go back to Render and update `FRONTEND_ORIGINS` to this URL, then redeploy the API.

## 4. Wire the Chrome extension

1. Open the LeadCaptura web app → sign up → **Settings → API Keys** → generate.
2. Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder in this repo.
3. Open the extension Options → paste:
   - Backend URL: `https://leadcaptura-api.onrender.com`
   - API key: `lcx_…` from step 1
4. Visit a LinkedIn profile → the floating panel appears → click **Save Lead**.

## 5. Local dev with Docker Compose

```bash
docker compose up --build
```

That starts Postgres, Redis, the API, worker, and beat. Frontend runs separately:

```bash
npm install && npm run dev
```

## Health check & smoke test

```bash
curl https://leadcaptura-api.onrender.com/health
# {"ok": true, "service": "leadcaptura-api"}

curl https://leadcaptura-api.onrender.com/api/v1/extension/health
# {"ok": true, "ts": "..."}
```
