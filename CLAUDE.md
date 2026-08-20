# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

The **LeadCaptura monorepo** — a LinkedIn lead-generation SaaS in four independent deployables plus a content-engine sidecar:

```
/api         FastAPI backend (Postgres + Redis + Celery)  → Render
(root)       Next.js 15 frontend (App Router + TanStack)  → Vercel
/extension   Chrome MV3 extension (LinkedIn capture)      → unpacked / zipped
/whatsapp    Node/Baileys WhatsApp sidecar (Express)      → Render (Docker)
/scripts     Standalone Python helpers (Content Hub DB seeder, etc.)
/content     Generated daily marketing content, committed to main per day
             (e.g. content/gifts-gulf/<YYYY-MM-DD>/<CUR>/set-<n>/email.html …)
```

Each can be modified independently. The extension talks to the API; the frontend talks to the API; nothing talks to the extension. The WhatsApp sidecar is **internal only** — the FastAPI router `whatsapp_web.py` proxies frontend calls to it using `WA_SIDECAR_URL` + `WA_SIDECAR_TOKEN` env vars. Sessions are workspace-scoped by `X-Workspace-Id`.

The sidecar also pushes captured messages **back** to the API for CRM timeline sync (see "WhatsApp inbox + CRM sync" below). That direction uses the sidecar's `WA_BACKEND_URL` env (the API origin) and the **same** `WA_SIDECAR_TOKEN` as a shared secret, POSTed to `/whatsapp-web/webhook/inbound`. If `WA_BACKEND_URL` is unset the inbox still works in-memory; only the lead-timeline sync is disabled.

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

# Package the PROTECTED distribution (what the public downloads)
npm run build:extension            # → extension-dist/, THEN zips it straight to
                                    #   public/extensions/leadcaptura-extension-v<ver>.zip
                                    #   (version read from extension/manifest.json)
                                    #   + public/leadcaptura-extension.zip (stable-URL copy)
                                    # `--no-zip` skips packaging if you only want extension-dist/.
```

After editing content scripts, reload the extension (`chrome://extensions` → 🔄) **and** hard-reload the LinkedIn tab (Ctrl+R) — Chrome only injects content scripts on tab load, so an open tab keeps the old code. Confirm the new build is live by checking the `LeadCaptura v<version>` badge in the bottom toolbar.

### Code protection — published builds are always obfuscated (`scripts/build-extension.mjs`)

To let the extension be shared at scale without handing out copyable source, **every
published zip is a protected build**, never the raw source:

- **`extension/` (raw source) = the admin's OPEN copy. It is NEVER published.** It stays
  in the repo (and is excluded from Vercel by `.vercelignore`), so the readable code
  never leaves the repo. That is the "admin download is open, everyone else is protected"
  guarantee — the open build is repo-only.
- **`npm run build:extension`** runs `scripts/build-extension.mjs` → `extension-dist/`
  (gitignored). It strips all comments, minifies, and mangles **function-local** names via
  terser. The transform is deliberately the provably behaviour-preserving subset:
  `compress:false`, `mangle.toplevel:false`, `mangle.properties:false`. So it's alpha-renaming
  + whitespace/comment removal only — **it cannot change runtime behaviour**. The 8-file
  content bundle shares state through `globalThis.__lc*` **property** names (never mangled),
  and each file is IIFE-wrapped (empty program-top-level surface), so nothing that crosses a
  file boundary is touched.
- The build **self-verifies and aborts on any doubt**: every output passes `node --check`
  and an acorn parse asserting its top-level binding names are identical to the source's.
  A broken protected build can never ship.
- **Honest limit:** client-side code always runs on the user's machine, so this is strong
  *deterrence* (removes the how-it-works comments, makes it hostile to read or hand to an AI),
  **not** an uncrackable vault. True one-tap-uncopyable is only possible off-device.
- **The same script then zips it — this is the ONLY place a distributable zip gets
  built.** The zip's top-level entry is always a single folder named `LeadCaptura` (never a
  bare file listing, never `extension`) — unzipping any other way scatters loose folders
  instead of one named folder, which is exactly the bug this convention exists to prevent.
  Never hand-roll a `zip …` command for this elsewhere; if the packaging step ever needs to
  change, change it in `scripts/build-extension.mjs`, not inline in a shell command.
- Only the single current protected zip is kept in `public/extensions/` — the script deletes
  every other `leadcaptura-extension-v*.zip` there itself, so old **readable** zips are never
  left publicly fetchable.
- To hand the admin an open build on purpose, just zip the source dir directly
  (`zip -r open.zip extension`) — do **not** publish that artifact.

## Backend architecture (`/api`)

### Two auth paths share one app

`app/core/deps.py` defines:
- **`get_workspace_context`** — JWT Bearer for the web app. Workspace is selected via `X-Workspace-Id` header (a user can belong to multiple).
- **`get_extension_context`** — `X-API-Key` for the Chrome extension. Keys are SHA-256 hashed at rest and prefix-indexed for fast lookup. Generated in **Settings → API Keys** of the web app.

Every endpoint depends on one or the other — never both. `app/api/v1/extension.py` is the only router using the extension auth path. `/extension/me` also upserts a `ConnectedAccount` row with `provider="linkedin"` so the web app's "LinkedIn connected" indicator flips on as soon as the extension authenticates from a LinkedIn tab.

### CRM data model

All SQLAlchemy models live in **one file**: `app/models/base.py`. This is intentional — relationships are dense (Lead ↔ Stage ↔ Workspace ↔ Enrollment ↔ Playbook ↔ Step ↔ Job) and a single file avoids circular-import gymnastics.

The `Lead.custom` column is **JSONB with a GIN index** so users can add arbitrary fields without migrations. Filters against it use Postgres `@>` containment. Default lead/pipeline schema is seeded by `app/services/bootstrap.py` on workspace creation (7 stages, 14 system fields, 5 saved views). The seed is wrapped in try/except inside `auth.py:register` so a seed failure never blocks user creation.

### Lead Detail endpoints

The Lead Detail page in the frontend depends on a small cluster of endpoints on `app/api/v1/leads.py`:

- `GET  /leads/{id}/timeline`   — unified feed merging `Activity` rows, `EmailMessage` rows, `Note` rows, and `CallLog` rows, sorted newest-first. The UI consumes this directly.
- `POST /leads/{id}/notes`      — adds a `Note` and an `Activity(type=note_added)` in one commit.
- `POST /leads/{id}/log-call`   — same pattern with `CallLog` + `Activity(type=call_logged)`.
- `GET/POST /leads/{id}/tasks`  — per-lead task list and creation. `PATCH /leads/tasks/{id}` toggles status.

If you add a new lead-scoped resource, follow the same pattern and add a branch to `_ensure_lead()` + extend `lead_timeline()` so it surfaces in the activity feed.

### WhatsApp inbox + CRM sync

The Baileys sidecar (`/whatsapp`) captures every real-time 1:1 message via a `messages.upsert` handler and keeps an **in-memory** per-session `chatsStore` + `messagesStore` (capped 200/chat). The web `/whatsapp` page reads these through two proxied endpoints — `GET /whatsapp-web/chats` and `/whatsapp-web/chats/{phone}` — to render an inbox with a reply box. This store is process-memory only; a container restart rebuilds it from `chats.upsert` on reconnect.

For durable CRM history, the sidecar **also** fire-and-forgets each `notify` (real-time, not reconnect-replay) message to `POST /whatsapp-web/webhook/inbound`. That endpoint is the **one** route not behind `get_workspace_context` — the sidecar can't hold a user JWT, so it authenticates with the shared `WA_SIDECAR_TOKEN` via the `X-Sidecar-Token` header. The handler matches the phone to a `Lead` (last-9-digits suffix match, tolerant of country-code/punctuation differences) and writes a **`WhatsAppMessage`** row (`migration 0014`), plus an `Activity(type=whatsapp_received)` for inbound matched messages. `(workspace_id, provider_message_id)` is unique so replays are idempotent. `lead_timeline()` merges these as `kind:"whatsapp"`. Unmatched numbers are still stored (`lead_id` null) for dedup. Outbound bulk/manual sends flow through the same `messages.upsert` echo (`fromMe:true`) so the timeline shows both sides.

### Outreach engine

`app/services/outreach.py` enrolls leads into playbooks and produces work items:
- **Email steps** → `app/services/email_sender.py` sends via Gmail OAuth or SMTP.
- **LinkedIn steps** (`connect`, `message`) → enqueued as **ExtensionJob** rows. The extension polls `/extension/jobs/next` and reports back via `/extension/jobs/{id}/result`.

The "Add to Playbook" UX in the frontend hits `POST /playbooks/{id}/enroll` with `{ lead_ids: [...] }`. That creates `Enrollment` rows. The Celery beat task `tick_outreach_scheduler` (every minute) is what turns those into queued `EmailMessage` rows — so **without a running worker + beat, enrollments sit dormant**. The free-tier Render deploy doesn't run workers; only manual sends through `POST /inbox/send` from the Lead Detail composer actually dispatch.

Daily quotas (`email_limit`, `linkedin_connect_limit`, `linkedin_message_limit`) live on the workspace and are enforced **server-side** in `outreach.py` — the extension never schedules anything itself. Step scheduling jitter goes through `humanise_run_at()` which respects the workspace's outreach time window ±15 min.

> **HARDCODED RULE — WARMUP AND CAMPAIGNS ARE FULLY SEPARATE; NO SENDING CAP, EVER.**
> (User directive, repeated many times — do NOT revert or re-couple.)
> Warmup and Campaigns are two **independent** features. The campaign send path
> must **never read or write any warmup state** — it does not fetch a
> `SenderWarmup` row, does not check `sent_today`, and does not increment warmup
> counters. `campaigns.py:_eligible_senders` returns **plain `ConnectedAccount`s**
> (no warmup), and every active inbox is always eligible: **no per-inbox cap, no
> daily ceiling, no warmup throttle, no "defer to tomorrow."** Warmup keeps its
> own endpoints/counters/seeding engine (`/senders/{id}/warmup`, `_warmup_*`) as a
> separate feature for warming inboxes — it just has zero involvement in campaign
> sending. Do **not** reintroduce warmup into the send path or any `sent_today >=
> cap` gate / `warmup_deferred` cooldown. The old coupling capped campaigns around
> ~100 emails; that is a bug, not a feature.

### Dashboard stats

`GET /playbooks/stats/overview?days=N` is a single aggregate endpoint serving the Playbooks dashboard. It counts outbound `EmailMessage` rows by status, treats `is_won` / `interested` / `customer` / `proposal` stages as the "warm cohort" for the Interested number, and returns a daily series (with zero-filled gaps) for the chart. Date range is a lookback window, not arbitrary `from`/`to` — keep it that way unless the UI grows a calendar picker.

### Celery topology

`app/workers/celery_app.py` defines the beat schedule. The original recurring task is `tick_outreach_scheduler` (every minute), which creates queued jobs from active enrollments. The calendar suite (below) added three more: `tick_reminders` (every minute — deliver due reminders), `generate_daily_agendas` (hourly — one agenda per user per local morning), and the WhatsApp/campaign drains. On Render's free tier the workers are skipped — the API still serves all sync endpoints, but no outreach/reminders fire until a worker + beat run.

### Scheduling, Reminders & Notetaker — the "calendar suite" (migrations 0011–0018)

A GReminders/Calendly-style suite built on top of the CRM. **Reminder preferences are per-user in `Workspace.settings["reminder_prefs"][user_id]`** (NOT on the calendar account) so everything works over **email/SMTP with no calendar connected**; Google Calendar is an optional upgrade. The deliberate "no Twilio/SMS" and "no AI in the reminder path" decisions are load-bearing — the daily agenda is deterministic; only the Notetaker summary uses Claude (with a fallback).

- **`services/google_calendar.py`** — real Google OAuth2 (auth-code flow → refresh token, refreshed + persisted in place on `ConnectedAccount(provider="google_calendar")`), calendar list, free/busy, event CRUD. Needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; the redirect URI auto-derives from `public_api_url` (`/api/v1/calendar/oauth/google/callback`).
- **`services/reminders.py`** — the `Reminder` engine. `create_reminder` + `deliver_reminder` (calendar event OR email; `recipient_email` set ⇒ send to an external invitee, else the owner). `effective_channel` resolves calendar-or-email and **falls back to email**. Signal hooks `on_inbound_reply` / `on_stage_change` / `on_note_added` (best-effort, never raise into the request) auto-create reminders from CRM activity — wired in `leads.py`. `generate_daily_agenda` builds a deterministic prioritized "your day" plan (replies → due tasks → stage moves → notes).
- **`services/scheduling.py`** — event types + bookings. `compute_slots` is host-aware: weekly availability minus each host's free/busy + existing bookings (buffers), and a slot is open if **any** host is free (collective availability for round-robin). `create_booking` picks a load-balanced free host, writes the meeting to that host's calendar, **matches-or-creates a Lead** (`source="booking"`), emails the invitee a confirmation (with a manage link), and schedules: invitee reminders (`reminder_offsets`, e.g. 24h+1h), a host **pre-meeting brief** (`brief_offset_minutes`), and an owner reminder. `reschedule_booking` re-queues both reminder kinds; `set_disposition` (completed/no_show) and create/cancel fire **workflows**.
- **`services/workflows.py`** — booking-lifecycle automations: triggers `booking_created|booking_cancelled|meeting_completed|meeting_no_show` → actions `send_email|create_task|move_stage|add_tag|schedule_reminder` with `{merge}` tags. Isolated per action.
- **`services/notetaker.py`** — upload flow (no auto-join bot). Audio→text via **OpenAI Whisper** (`OPENAI_API_KEY`; Claude can't transcribe audio) or a pasted transcript; transcript→summary+action-items via Claude with a deterministic extractive fallback. Attaching to a lead writes a `Note` + `Activity(type=meeting_note)` to the timeline.
- **Routers**: `calendar.py` (connect/config/availability/reminders/agenda), `scheduling.py` (`/event-types` CRUD + `/bookings` disposition/cancel + `/workflows` CRUD), `booking.py` (**public, no-auth** `/book/{ws}/{event}` slots+book + `/book/manage/{id}` reschedule/cancel — the booking id is the unguessable token), `routing.py` (auth `/routing-forms` + public `/route/{ws}/{form}`), `notetaker.py`.
- **Models** (all in `base.py`): `Reminder`, `EventType`, `Booking`, `Workflow`, `RoutingForm`, `MeetingNote`. New config: `google_client_*`, `openai_api_key`/`whisper_model`.
- **Frontend**: `/calendar` (connect + reminders + agenda + auto-reminders), `/scheduling` (Event types | Workflows | Routing tabs; round-robin, briefs, embed snippet), `/notetaker`, and **public pages outside the `(app)` auth group**: `/book/[workspace]/[event]` (+ `?embed=1`), `/book/manage/[id]`, `/route/[workspace]/[form]`.

### Auth password hashing — bcrypt pin

`requirements.txt` pins **`bcrypt==4.0.1`** on purpose. `passlib==1.7.4`'s bcrypt handler reads `bcrypt.__about__.__version__` for version detection; bcrypt 4.1 removed that attribute, which trips an `AttributeError` on every `hash_password()` / `verify_password()` call and breaks login + registration with a 500. Don't bump bcrypt without also moving off passlib (e.g. to `bcrypt` directly or to `argon2`).

`get_db` in `app/core/db.py` rolls back on exception so a partial failure in a multi-statement endpoint doesn't poison the SQLAlchemy session for the next request.

## Frontend architecture (repo root)

Next.js 15 App Router. Route groups:

- `src/app/login`, `src/app/register` — public, unauthenticated.
- `src/app/(app)/*` — authenticated shell. The `(app)` group's `layout.tsx` enforces a workspace context and renders the sidebar/topbar. Routes here mirror LeadLoft's UX: `prospecting`, `pipeline`, `inbox`, `tasks`, `playbooks/[id]`, `leads/[id]`, and a fully populated `settings/*` tree.

`src/lib/api.ts` is the **only** place that calls the backend. It reads `NEXT_PUBLIC_API_URL`, attaches the JWT from `src/lib/auth.ts`, and adds the `X-Workspace-Id` header. All other code goes through TanStack Query hooks that wrap this client.

The TypeScript build is strict — `src/lib/api.ts:errorMessage` was once written as a chained `&& ||` expression that TypeScript widened to `{}`. If you touch error-handling, use an explicit `if` block and assign to a `let message: string` rather than relying on inference.

### Lead Detail page (`/leads/[id]`)

Two-column screen. Left rail is profile + stage selector + tasks + lead-info fields. Right pane is a tabbed composer (Email / LinkedIn / Note / Log Call) over a unified activity timeline. The composer respects a `?tab=` query param so the hover quick-actions on Pipeline rows can deep-link straight to the email tab (`/leads/<id>?tab=email`). All data hangs off `useQuery(["lead", id, ...])` keys; mutations invalidate the matching key so the timeline and task list update without a hard refresh.

### Reusable cross-page modal: `EnrollPlaybookModal`

`src/components/enroll-playbook-modal.tsx` is consumed in two places: hover send-icon on Pipeline rows, and the "Add to Playbook" button on Lead Detail. Successful enrollment swaps the row's Enroll button for an inline "Enrolled ✓" pill — the modal stays open so the user can enroll into multiple playbooks in one go. If you add a third entry point, reuse this component rather than rolling another.

### Campaign Builder (`/campaigns/new`)

The biggest single page in the app — table-based marketing-email builder with AI generation, AMP-for-Email, recipient picker (CRM + CSV + pipeline stage), sender rotation, per-step follow-ups, and live preview.

**Editor modes** (state: `form.contentMode`):
- `html` — code editor, marketer-pasted HTML.
- `amp` — AMP-for-Email body. Surfaces as a gradient pill in the tab bar so it's obvious AMP is the premium send mode.
- `plain` / `upload` / `visual` — text, file upload, contentEditable preview.

**AI panel** — `AIGeneratorPanel` lives inline at the top of the editor. Sends `POST /ai/write/marketing-html` with `brief`, `brand_color`, `tone`, `include_amp`, and optional `client_id`. Returns `{subject, preview_text, html, amp_html, mode}` where `mode === 'fallback'` means `ANTHROPIC_API_KEY` isn't configured server-side and the hand-built template fired — the panel shows an amber banner so the user knows to set the key on Render. The brief is HTML-stripped client-side to stop pasted markup from being echoed by the fallback as the subject.

**Preview pipeline** — `buildPreviewDoc()` is the small but load-bearing helper that **rewrites the AMP boilerplate visibility rule before stuffing into the iframe srcDoc**. AMP4Email's boilerplate (`<style amp4email-boilerplate>body{visibility:hidden}</style>`) keeps the body hidden until the AMP runtime reveals it; without the runtime in the preview iframe, AMP bodies render as a blank rectangle. The helper injects `html,body{visibility:visible !important}` just before `</head>` (preview only — the sent body is untouched). The Live Preview panel is `position: fixed; right: 0; z-index: 90` — was originally a flex sibling at `width: 400px` and got pushed off-screen on narrower viewports. Don't revert.

**Content Hub integration** — when `?from_asset=<id>` is on the URL, the builder fetches that Content Hub asset and pre-fills name (`<Business> — <Asset title>`), subject, `htmlContent`, and `ampHtml`. The "Use email from Content Hub" picker modal (top of editor, when no edit/from_asset is in URL) calls `GET /content-hub/assets/html-emails` for a workspace-wide list with the business name + AMP badge.

### Content Hub (`/content-hub`)

Multi-business, Google-Drive-style folder system for storing reusable marketing assets (HTML emails with optional AMP body, WhatsApp messages, captions, SMS, "other"). Two routes: `/content-hub` (businesses grid) and `/content-hub/[slug]` (one business's asset library).

**Data model** (`api/app/models/base.py`):
- `ContentBusiness` — workspace-scoped folder. Auto-slugified name with collision-suffixing (`Acme Co` → `acme-co`, `acme-co-2`, …). Carries `brand_color`, `accent_color`, `tone`, `logo_url` so it can later feed the AI writer with on-brand defaults.
- `ContentAsset` — belongs to a business. Type enum: `html_email | whatsapp | caption | sms | other`. HTML email assets carry an **optional `amp_content`** column so one asset = one deliverable to all clients with AMP as the Gmail-only enhancement (migration `0010_content_asset_amp`).

**Routes** (`api/app/api/v1/content_hub.py`):
- `GET/POST /content-hub/businesses` — list (with per-type asset counts) / create. Lookup by `{ref}` accepts slug **or** id.
- `GET/POST /content-hub/businesses/{business_id}/assets` — nested asset CRUD.
- `GET /content-hub/assets/html-emails` — workspace-wide HTML email list with business name, slug, color, AMP flag, content size. **Declared BEFORE `/assets/{asset_id}`** so the literal route wins the FastAPI match.
- `GET/PATCH/DELETE /content-hub/assets/{asset_id}` — direct asset access.

**Send-test from an asset** — the asset library's send-test modal routes through the existing Vercel SMTP bridge (`/api/outreach/send`), forwarding `body_amp` when an AMP body is attached. The bridge attaches AMP as the `text/x-amp-html` MIME alternative via nodemailer; Gmail renders it, every other client falls back to the HTML body.

**Send on WhatsApp from an asset** — `whatsapp`-type assets get a prominent "Send on WhatsApp" action that deep-links to `/whatsapp?from_asset=<id>`. The WhatsApp page reads that param (mirroring the Campaign Builder's `?from_asset` precedent), fetches the asset via `GET /content-hub/assets/{id}`, and seeds the bulk-campaign message once (guarded by a ref so re-renders don't clobber edits). The user then attaches a product image and picks recipients there. `html_email` assets keep going to the Campaign Builder; only `whatsapp` assets surface the WhatsApp action.

### Hudace content routine (`public/email/` + `publish.py`)

The Hudace AI content routine writes:
- **Background photos and baked promo JPGs** → `public/email/` (served by Vercel at `https://leadloftexporter.vercel.app/email/<name>`)
- **Content items** → Neon DB `content_assets` table via `publish.py` (HTTP SQL API, not psycopg2 — port 5432 is blocked in the routine environment; `publish.py` uses the Neon HTTP endpoint on port 443)
- **State tracker** → `.routine/state.json`

**ALWAYS push the content commit to `main`** (not just the feature branch). The images only become live on Vercel after they land on main. The routine should cherry-pick or push directly to main in STEP 4. When running on a dev branch, cherry-pick the content commit to main and push both:
```bash
git push -u origin <feature-branch>
git checkout main && git cherry-pick <commit-hash> && git push -u origin main
```

Key schema facts (confirmed 2026-06-19): item table = `content_assets`, folder table = `content_businesses`, body column = `content` (not `body`), id requires manual UUID generation (no default), tags is JSONB NOT NULL (pass `[]`).

**Type enum** (must match exactly or items show as broken "Other" in the UI): `html_email | whatsapp | caption | sms | other`. Use `html_email` for emails (NOT `email`). LinkedIn posts use `type: caption` + `platform: linkedin`. Outreach messages use `type: other`.

### Daily content pipeline (`/content` + `/scripts`)

A side-channel for AI-routine-generated marketing content. Each business has its own folder under `content/<biz-slug>/`. The current consumer is **Gifts Gulf** (corporate-gifting catalogue marketing in AED/SAR/QAR).

**Tree layout per day:**
```
content/gifts-gulf/<YYYY-MM-DD>/
├── manifest.json                       # the 9 sets that day
├── <CUR>/                              # AED | SAR | QAR
│   └── set-<n>/                        # n = 1..3
│       ├── email.html                  # the file that gets sent
│       ├── email.amp.html              # optional AMP upgrade (Gmail only)
│       ├── whatsapp.txt                # WhatsApp broadcast message
│       ├── linkedin.txt                # LinkedIn outreach DM
│       └── meta.json                   # {date, currency, theme, subject, skus, products[]}
└── _state/
    ├── history.json                    # 14-day no-repeat + forever-unique subjects
    └── used-skus.json                  # legacy; same idea
```

**Image rule (load-bearing) — for product photos in marketing emails:**
- Use the **raw midocean CDN URL** directly: `https://cdn1.midocean.com/image/original/<code>.jpg`. This renders in Gmail (proven by the working "Premium Drinkware" email).
- Do **NOT** use the giftsgulf `_next/image` optimizer — Gmail's image proxy can time out on the cold optimizer and cache the failure (blank tile forever for that message).
- Do **NOT** hand-construct `mo####-##` codes. Pull each code straight from the catalogue row for that SKU. A guessed code 404s upstream → blank tile.

**`scripts/publish_to_hub.py`** — the DB seeder. Fully **business-agnostic**: nothing about any specific business is hardcoded. Each routine supplies the slug, name, and branding via env vars; the script reads files under `content/<slug>/<date>/<CUR>/set-<n>/` and inserts rows. The Hub HTTP API also exists, but routines run the script directly because the routine sandbox can reach Postgres easily but flaked on the HTTP/JWT path. The script:
- Resolves the business by `(workspace_id, slug)`. Creates it on first run with the branding supplied via env (`HUB_BUSINESS_NAME`, `HUB_BRAND_COLOR`, `HUB_ACCENT_COLOR`, `HUB_LOGO_URL`, `HUB_TONE`). Sensible defaults if a routine omits a field.
- For each set under `content/<slug>/<date>/<CUR>/set-<n>/`, inserts **3 ContentAsset rows**: `html_email` (with `amp_content`), `whatsapp`, and `caption` (with `platform: linkedin`).
- **Idempotent** — skips inserts whose `(business_id, title)` tuple already exists. Title encodes date + currency + theme, so reruns are no-ops.
- **Schema-tolerant `meta.json`** — only needs date + currency + theme + skus + products. `campaign_code`/`campaign_name` are optional; the publisher builds a title from date + currency + theme when not provided.
- Required env: `DATABASE_URL` (Neon, accepts the `postgresql+psycopg://` SQLAlchemy prefix; stripped before handing to `psycopg`), `HUB_WORKSPACE` (workspace UUID), `HUB_BUSINESS_SLUG` (folder name under `content/`).

To onboard a new business, the routine that owns it: (1) writes its day's files under `content/<new-slug>/<date>/…`, (2) sets `HUB_BUSINESS_SLUG=<new-slug>` (plus optional name/colour/logo/tone), (3) runs `publish_to_hub.py`. No code change in this repo.

**Usage:**
```bash
pip3 install -r scripts/requirements.txt   # psycopg[binary]
export DATABASE_URL='<rotated Neon URL>'
export HUB_WORKSPACE='<workspace uuid>'
python3 scripts/publish_to_hub.py --date 2026-06-13
```

Prints `{date, business_id, business_slug, created_business, inserted, skipped, failures}` on stdout. Exits non-zero only when `failures` is non-empty.

## Extension architecture (`/extension`)

> **Anti-bot timing is load-bearing — do not regress it.** `connectAllVisible`
> and `_scrollLoadPage` in `overlay.js` use a 4-tier gap distribution + periodic
> micro-breaks and incremental (not jump-to-bottom) scrolling. Keep those
> distributions; see "Bot-detection avoidance" below. The `main.js` cadence
> (1.5s decorate interval, `location.search` watcher, scroll-stop re-decorate)
> is what keeps chips appearing on lazily-rendered/paginated cards — leave it.
>
> The version is bumped in `manifest.json` on every shippable change and the
> zip is named with it (`leadcaptura-extension-v<ver>.zip`).

```
manifest.json                MV3, host: linkedin.com only (backend host requested at runtime)
background/service-worker.js API proxy for content scripts; routes openOptionsPage; enrichProfile/closeMe
content/
  main.js                    SPA-navigation hook, autopilot tick (60s interval), lc_enrich handler
  overlay.js                 profile panel + bottom toolbar + per-card Save pills + Contact Info auto-enrich
  scraper.js                 /in/, /search/, /sales/* DOM scrapers + scrapeContactInfo() modal scraper
  automate.js                human-paced executor for connect/message jobs
  lib/api.js                 sendMessage wrapper around the service worker
popup/                       toolbar popup: status, autopilot toggle
options/                     API key + capture behavior settings (incl. autoEnrichOnSave)
```

### Bot-detection avoidance (design rules — do not break)

1. **Never call LinkedIn's internal APIs.** Read only the rendered DOM the user has already loaded.
2. **Never automate in a hidden tab** for *write* actions. `automate.js` checks `document.visibilityState === "visible"` before each Connect/Message. The Contact Info scraper in `main.js` is read-only and intentionally runs in a background tab — that's a lower risk class and is fine.
3. **Human-paced everything.** 45–180s between consequential actions (~18% long-tail to 3 min), 40–140ms per-typed-character, eased scrolls with randomised offsets, 1.2–3.5s "reading" pause after navigation.
4. **Real DOM events.** Clicks go through `dispatchHumanClick` which fires `pointerover` → `pointerdown` → `pointerup` → `click` with realistic coordinates.
5. **Abort on challenge.** `detectChallenge()` aborts and reports failure if a captcha/checkpoint surfaces.
6. **Daily caps live server-side.** The extension only runs what `/extension/jobs/next` hands it.

### Search-card decoration + bulk Connect/Follow (regular LinkedIn people search)

The hardest-won part of the extension. The model: `decorateSearchCards()`
anchors on each **native action button** (`_isActionButton` → Connect / Follow /
Message / Pending, matched by **whole-word** `\bconnect\b` etc. so the rendered
"+ Connect" label matches and "Connected"/"Following" don't), climbs to the
first ancestor that contains a profile link (`cardFromButton`) — that ancestor
is the row — and injects the Save chip **inline before that button** (the chip
must NOT be `position:absolute`; absolute placement collapsed every card's chip
onto one shared positioned ancestor, so only the first profile appeared chipped).
A link-only fallback pass covers rows with no recognised button.

Three URL→element registries are the single source of truth for bulk actions:
`injectedSaves` (url→chip wrapper), `chipCardEl` (url→row), and `chipActionBtn`
(url→the exact native button the chip sits beside). **Bulk Connect/Follow acts
on the stored button directly** (`_actionBtnForUrl` + `_classifyButton`) rather
than re-scanning the row — re-scanning was unreliable and produced "No action"
on connectable cards. `_gcInjected()` drops all three when a node leaves the DOM.

`connectAllVisible()` per row: Connect → `_sendConnectOnCard` clicks Connect,
waits for the "Add a note to your invitation?" modal, then clicks **"Send
without a note"**; Follow-only → `_sendFollowOnCard` clicks Follow; already
connected/pending → skipped. Critical correctness rules:
- `_forceClick` is the click-of-last-resort and tries **four** strategies in
  order: native `.click()`, a full pointer/mouse sequence on the button, the
  same sequence on the button's inner `<span>` (some handlers bind to the
  child), and an Enter keydown/keyup. LinkedIn (Ember) honours untrusted events,
  so the first usually lands — but the send-invitation button needs the others.
- The send button finder (`_findSendWithoutNoteButton`) scans the **whole
  document**, not just the modal subtree. A previous version scoped it to the
  matched modal node and broke when LinkedIn rendered the footer buttons outside
  it — the finder returned null and the click silently never happened. Prefer a
  visible+enabled match but fall back to any match rather than bail.
- Report `ok:true` **only after the invitation modal actually closes** from
  sending. Never close the modal via its X and call it success — that produced
  fake "Invited ✓" with no invite sent. STEP 4 of `_sendConnectOnCard` is the
  sole success signal; `connectAllVisible`'s post-call guard now only *dismisses*
  a leftover dialog on failure — it never re-sends.

### Send-invitation sequence — single owner (load-bearing)

The send flow had three competing clickers (`_sendConnectOnCard`, a
`connectAllVisible` post-call guard, and the global watcher) racing on the same
"Send without a note" button. As of v1.0.75 there is **one owner per context**:

- **During a Connect All run** (`state.connectActive === true`):
  `_sendConnectOnCard` owns the whole thing as an explicit, logged 4-step
  sequence — STEP 1 click Connect → STEP 2 wait for the "Add a note to your
  invitation?" dialog (≤8s) → STEP 3 `_forceClick` "Send without a note" → STEP 4
  confirm the dialog closed (= invite actually sent). Each step logs
  `[LeadCaptura] step N → …`, so a stuck run is traceable from the console.
- **Outside a run** (a manual Connect click by the user): the global watcher
  `_startInviteAutoConfirm()` handles it — a `MutationObserver` on
  `document.documentElement` + 600ms poll that waits ~250ms for the modal to
  mount (Ember binds the handler late; clicking mid-animation is a no-op) then
  `_forceClick`s the button. **It stands down (`if (state.connectActive) return`)
  during a Connect All run** so it never double-clicks. Keep this guard.

The watcher is **pure DOM — no `chrome.*` calls** — so it survives an
orphaned/stale content-script context. `_invitationModalOpen()` returns true if
either a matching dialog node is visible **or** a visible "Send without a note"
button exists, so neither owner bails when LinkedIn changes the dialog's `role`.

### Auto-apply engine (LinkedIn Apply / Easy Apply) — design rules — do not break

The bulk auto-apply path (`applyAllJobs` → `_applyToJob` → `_runEasyApplyModal`
in `overlay.js`) is the second hardest-won subsystem. Every rule below was
established by a regression — re-introducing any of them re-breaks the run.

**LinkedIn rebranded "Easy Apply" → "LinkedIn Apply" and changed the control
type.** The in-app apply control is now an `<a href=".../jobs/view/<id>/apply/"
aria-label="LinkedIn Apply to this job">` (was a `<button>`). `_classifyJobDetail`
must scan anchors AND buttons, and `_isEasyApplyBtn` accepts both the old
"Easy Apply" label and `linkedin apply` / plain "Apply" + an in-app signal
(`jobs-apply-button` class, `[class*='jobs-apply']` ancestor, the
`linkedin-bug` SVG, OR an href matching `linkedin.com/jobs/view/\d+/apply`).

**Two layouts to support.** Modal popup (on `/jobs/search-results/`) AND
full-page inline form (when LinkedIn navigates to `/jobs/view/<id>/apply/`).
`_easyApplyModal()` detects both — dialog selectors first, then `.jobs-easy-apply-content`
/ form container, then the apply-progress **region** as the last fallback.

**NEVER infer the apply form from a bare "Next" button** — the search page's
own pagination "Next" matches that and made the stepper walk `start=25→50→100`
forever. Use the `aria-label*='job application progress'` region or a real
`/jobs/view/<id>/apply/` path as the only signals for "we're in the apply form."

**`_modalActionButton` must refuse pagination controls** outright
(`.artdeco-pagination`, `[data-testid*='pagination']`, "View next page", "Page N")
and "Back to previous step". Defence-in-depth even when the modal detection is right.

**`_classifyJobDetail` must scope to the right-hand DETAIL pane**
(`.jobs-search__job-details`, `.scaffold-layout__detail`, `.jobs-details`,
`.job-view-layout`). The left job-list cards each show their own "Apply" badge —
if classify clicks one of those, it just re-opens the job and no application
form ever appears (every job logs "failed"). Fall back to `document` only when
no pane matches.

**`_dismissEasyApplyModal` must scope to the real Easy Apply DIALOG only**
(`_realModalDialog()`). A document-wide `button[aria-label*='Dismiss']` hits
the job cards' own Dismiss X — which tells LinkedIn "don't recommend this job"
and silently destroys the user's recommendations. In full-page apply mode there
is no dialog; do nothing (the next job's navigation handles it).

**Clicking — v1.0.47 wiring is load-bearing.** Both the Easy Apply control and
the modal's Next/Submit must be clicked with **`dispatchHumanClick`** first
(real pointer sequence). `_forceClick`'s plain `.click()` doesn't reliably
trigger LinkedIn's React/Ember handlers — pages don't advance. Use `_forceClick`
ONLY as a fallback when the page didn't move after `dispatchHumanClick`.

**Stable selectors** (from live DOM, prefer these over text matching):
- Next: `button[data-easy-apply-next-button]`, `button[data-live-test-easy-apply-next-button]`, aria-label "Continue to next step".
- Submit: `button[data-live-test-easy-apply-submit-button]`, aria-label "Submit application".
- Dismiss inside dialog: `button[aria-label='Dismiss'][data-test-modal-close-btn]`.
- Progress region: `[aria-label*='job application progress'][role='region']`.

**Untick "Follow <company>" via the LABEL, not the input.** The
`#follow-company-checkbox` is `visually-hidden` and Ember binds the toggle to
the `<label for="follow-company-checkbox">`. Clicking the input itself is a
no-op; the box stays checked.

**Decline post-apply NBA prompts.** After submit, LinkedIn often shows a
"show recruiters you're #OpenToWork" / next-best-action modal. Click
"No thanks" / "Not now" / "Skip" — NEVER "Get started" (that toggles real
profile flags the user didn't ask for).

**Stop must be immediate.** `_cancellableSleep(ms)` checks `state.applyCancel`
every 150ms and is used for the inter-job gap (4–50s) and the in-step reading
pause. `_runEasyApplyModal` also guards `if (state.applyCancel) return` right
before any Next/Submit click — never submit/advance after Stop is pressed.

**Job-card detection (`_jobCardEls`) runs BOTH strategies, always.**
- Strategy A: `data-occludable-job-id` / `data-job-id` / known container classes.
- Strategy B: climb from each `button[aria-label*='Dismiss']` to its repeated card.

Gating one behind the other (a previous bug) broke chip decoration on
`/jobs/search-results/?origin=JOB_COLLECTION_PAGE`. Dedup + innermost-filter
handle overlap.

**Per-card chip is a single one-click "Auto Apply" button.** No checkbox. Hidden
via CSS `.lc-applying .lc-job-apply-row { display:none }` while a run is in
progress (toggled by adding/removing `.lc-applying` on `<html>` in
`applyAllJobs`'s start/finally). The chips stay in the DOM so the engine still
reads their keys; they're just not shown.

**State always resets via `try/finally`.** `applyAllJobs` (and `connectAllVisible`,
and bulk save) wrap the run in try/finally that clears `state.applyActive` /
`state.applyCancel` / progress, removes `.lc-applying`, and re-mounts the
toolbar. The toolbar can never get stuck on "Stop." Per-job errors are isolated
in `processPage` (each `_applyToJob` is wrapped) so one bad job becomes "failed"
and the loop continues.

**Form-wait is a poll, not a fixed `waitFor`.** `_runEasyApplyModal` polls
`_easyApplyModal()` every 300ms for up to 12s — catches the form the instant it
renders, whether modal or full-page. Don't go back to `waitFor` on dialog
selectors only (misses full-page).

**Default config baked in for fresh installs.** `service-worker.js` and
`options/options.js` ship `DEFAULT_SETTINGS.apiUrl` = the production backend and
a pre-set workspace `apiKey`, AND `manifest.json` `host_permissions` includes
the backend origin so fetches work without a manual permission grant. These
defaults only apply when `chrome.storage.local` has no prior settings.

### Stale-tab self-heal + version badge

Updating an unpacked extension does **not** re-inject content scripts into
already-open tabs — Chrome only injects on tab load. So a tab can keep running
an old `overlay.js` indefinitely. Two mechanisms make this survivable:

- **`main.js` stale detector** (`_checkRuntime` + `_killStaleUi`): when
  `chrome.runtime?.id` flips to undefined (context invalidated by an extension
  reload), it rips out every LeadCaptura chip/overlay, shows a red full-width
  banner, and force-reloads the tab so fresh scripts load. This guards against
  orphaned chip click-handlers firing with stale, wrong-profile data.
- **Version badge**: the bottom toolbar renders `LeadCaptura v<version>` (read
  from `chrome.runtime.getManifest().version`). When debugging "my fix isn't
  working", check this first — if it doesn't match the installed version the tab
  is on stale code and just needs a reload. `_lcToast()` is a toolbar-independent
  on-page toast ("sending invitation… / sent ✓") giving live proof the current
  build is the one executing.

### Contact Info enrichment flow

This is how the extension fills in `lead.email` and `lead.phone` from a LinkedIn profile:

- **Floating panel on `/in/<handle>`** — `saveCurrentProfile()` calls `Scraper.scrapeProfileWithContact()` which clicks the visible **Contact info** link, waits for the modal, reads `mailto:` / `tel:` anchors, and closes the modal before saving.
- **Per-card Save on search results** — after the initial card-data save, the click handler dispatches `chrome.runtime.sendMessage({ type: "lc:enrichProfile", url })`. The service worker opens that URL in a background tab with `?lc_enrich=1` appended. The content script in the new tab runs `maybeRunEnrichmentTrigger()` from `main.js`, which does a human-paced 1.5–3.5s pause, runs the same `scrapeProfileWithContact()`, syncs the profile (deduped by `linkedin_url` → updates the existing lead), then asks the service worker to close its own tab via `lc:closeMe`.

If you add a new automatic-enrichment surface, route through the same service-worker handlers. Never `chrome.tabs.create` from a content script directly.

### Cross-context API surface

`chrome.runtime.openOptionsPage` only works in extension pages (popup/options/service worker) — **not** in content scripts. The content overlay calls `chrome.runtime.sendMessage({ type: "lc:openOptions" })` and the service worker proxies it. Apply the same pattern for any other privileged API (`chrome.tabs.*`, `chrome.permissions.*`, etc.).

The manifest only grants host permission to `linkedin.com`. When the user pastes a Backend URL in the Options page, `options.js` calls `chrome.permissions.request({ origins: [origin] })` to request that host at runtime — without this, all fetches fail with the generic `Failed to fetch`.

### Selectors drift

LinkedIn rewrites markup often. Prefer multiple selectors via `first(root, [...])`. Sales Navigator uses `data-anonymize` attributes which are stable-ish — `scrapeSalesNavProfile` / `scrapeSalesNavSearch` rely on those. Search-result cards return "LinkedIn Member" placeholders for 3rd-degree profiles on free LinkedIn accounts — `scrapeSearchResults` skips cards with no `/in/` link, which is the correct behavior (no useful data to capture). Tests against the live site would be flaky; instead log every selector attempted on failure.

## Deployment topology

| Component | Host | Key file |
|---|---|---|
| Frontend | Vercel (repo root, no rootDir override) | `vercel.json`, `next.config.mjs` |
| Backend + workers + Redis | Render (Blueprint) | `render.yaml`, `api/Dockerfile` |
| Postgres | Neon (external) | — |

`DATABASE_URL` **must** use the `postgresql+psycopg://` scheme (not `postgresql://`) — SQLAlchemy picks the driver from the scheme.

`FRONTEND_ORIGINS` (backend) controls CORS allowed origins. CORS also has a regex permitting any `chrome-extension://*` origin so the extension always works regardless of this value.

`render.yaml` defaults to Starter plan ($21/mo for api + 2 workers). For a free-tier deploy, create the API as a single Web Service manually (Docker, rootDir `api`) and skip the workers — the API still serves all sync endpoints (including the Lead Detail composer's manual sends via `POST /inbox/send`), only the outreach scheduler stops, so playbook enrollments sit dormant.

## Things to watch for

- **`/api` and `/extension` are excluded from Vercel builds** by `.vercelignore`. If you add another top-level directory that should also be skipped, add it there too.
- **Don't add `web_accessible_resources` to the manifest you don't reference** — Chrome logs a warning.
- **Don't grant `<all_urls>` in the manifest.** Host permissions are restricted to linkedin.com plus runtime-granted backend host.
- **No build step for the extension RUNTIME.** Author raw JS in `extension/`; do not introduce npm/bundlers into the extension's own source or load flow. The ONE exception is packaging for distribution: `npm run build:extension` produces the protected `extension-dist/` that gets zipped and published (see "Code protection" above). Never publish the raw `extension/` source; never load `extension-dist/` as your dev copy (develop against `extension/`).
- **Models in one file.** Resist the urge to split `app/models/base.py` — the import graph relies on it.
- **bcrypt is pinned.** See the auth section above before bumping `requirements.txt`.
