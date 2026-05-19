# LeadCaptura

Full-stack LinkedIn lead-generation SaaS — LeadLoft-style CRM + outreach engine + Chrome capture extension, all in one monorepo.

## Layout

```
/api         FastAPI backend (Postgres + Redis + Celery)
/web         Next.js 15 frontend (App Router, Tailwind, TanStack Query)
/extension   Chrome MV3 extension (LinkedIn capture + human-paced outreach)
```

## What it does

- **Capture LinkedIn leads** without bot detection: the extension only reads the DOM the user has already loaded in their own authenticated Chrome — no LinkedIn API calls, no headless browsers, no fetch overrides.
- **Run multi-step outreach playbooks** across email (Gmail OAuth / SMTP), LinkedIn connect, LinkedIn message, calls, tasks. Daily caps enforced server-side with humanised timing inside the user's configured time window.
- **Manage everything in a CRM**: customisable columns, saved views (All List / New / Go Follow Up / 90 Day Follow Up / My Deals), kanban + list pipeline, inbox with reply tracking, AI writer (Claude Opus 4.7 + Haiku 4.5 reply classifier).

## Quick start

### Local with Docker Compose

```bash
docker compose up --build
```

That starts Postgres + Redis + the FastAPI API + a Celery worker + Celery beat. The frontend runs separately:

```bash
cd web && npm install && npm run dev
```

Open <http://localhost:3000>, register, then go to **Settings → API Keys** and generate an extension key.

### Load the Chrome extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
2. The Options page opens automatically — paste the backend URL and API key.
3. Visit any `linkedin.com/in/<handle>` page → the floating LeadCaptura panel appears → **Save Lead**.

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for the full recipe. One-paragraph version:

- `/web` → **Vercel** (zero-config; `vercel.json` is in the repo root, root directory = `web`)
- `/api` + Celery worker + Celery beat + Redis → **Render** (uses `render.yaml` blueprint) or **Railway** (`railway.json`)
- Postgres → **Neon** (free tier)

After deploying, update `FRONTEND_ORIGINS` on the API to your Vercel URL, and `NEXT_PUBLIC_API_URL` on Vercel to your API URL. Generate an API key in the web app and load it into the extension Options page.

## Why the extension can't be bot-detected

It uses the **user's own logged-in browser session**. There are no headless flags, no fetch overrides on LinkedIn's URLs, no fake user-agent. The extension reads only the rendered DOM the user has already loaded and dispatches real DOM events at human pace. Daily caps live server-side. See [`CLAUDE.md`](./CLAUDE.md) for the design rules.
