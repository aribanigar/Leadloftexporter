# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

The **LeadCaptura monorepo** — a LinkedIn lead-generation SaaS in four independent deployables:

```
/api         FastAPI backend (Postgres + Redis + Celery)  → Render
(root)       Next.js 15 frontend (App Router + TanStack)  → Vercel
/extension   Chrome MV3 extension (LinkedIn capture)      → unpacked / zipped
/whatsapp    Node/Baileys WhatsApp sidecar (Express)      → Render (Docker)
```

Each can be modified independently. The extension talks to the API; the frontend talks to the API; nothing talks to the extension. The WhatsApp sidecar is **internal only** — the FastAPI router `whatsapp_web.py` proxies frontend calls to it using `WA_SIDECAR_URL` + `WA_SIDECAR_TOKEN` env vars. Sessions are workspace-scoped by `X-Workspace-Id`.

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

After editing content scripts, reload the extension (`chrome://extensions` → 🔄) **and** hard-reload the LinkedIn tab (Ctrl+R) — Chrome only injects content scripts on tab load, so an open tab keeps the old code. Confirm the new build is live by checking the `LeadCaptura v<version>` badge in the bottom toolbar.

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

### Outreach engine

`app/services/outreach.py` enrolls leads into playbooks and produces work items:
- **Email steps** → `app/services/email_sender.py` sends via Gmail OAuth or SMTP.
- **LinkedIn steps** (`connect`, `message`) → enqueued as **ExtensionJob** rows. The extension polls `/extension/jobs/next` and reports back via `/extension/jobs/{id}/result`.

The "Add to Playbook" UX in the frontend hits `POST /playbooks/{id}/enroll` with `{ lead_ids: [...] }`. That creates `Enrollment` rows. The Celery beat task `tick_outreach_scheduler` (every minute) is what turns those into queued `EmailMessage` rows — so **without a running worker + beat, enrollments sit dormant**. The free-tier Render deploy doesn't run workers; only manual sends through `POST /inbox/send` from the Lead Detail composer actually dispatch.

Daily quotas (`email_limit`, `linkedin_connect_limit`, `linkedin_message_limit`) live on the workspace and are enforced **server-side** in `outreach.py` — the extension never schedules anything itself. Step scheduling jitter goes through `humanise_run_at()` which respects the workspace's outreach time window ±15 min.

### Dashboard stats

`GET /playbooks/stats/overview?days=N` is a single aggregate endpoint serving the Playbooks dashboard. It counts outbound `EmailMessage` rows by status, treats `is_won` / `interested` / `customer` / `proposal` stages as the "warm cohort" for the Interested number, and returns a daily series (with zero-filled gaps) for the chart. Date range is a lookback window, not arbitrary `from`/`to` — keep it that way unless the UI grows a calendar picker.

### Celery topology

`app/workers/celery_app.py` defines a beat schedule with a single recurring task: `tick_outreach_scheduler` (every minute). That task is what creates queued jobs from active enrollments. On Render's free tier the workers are skipped — the API still serves all sync endpoints but no outreach fires.

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
- **No build step for the extension.** Keep raw JS; do not introduce npm or bundlers.
- **Models in one file.** Resist the urge to split `app/models/base.py` — the import graph relies on it.
- **bcrypt is pinned.** See the auth section above before bumping `requirements.txt`.
