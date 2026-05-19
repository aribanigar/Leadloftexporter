# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this project is

The **LeadCaptura monorepo** — a full-stack LinkedIn lead-generation SaaS:

```
/api          FastAPI backend (Postgres + Redis + Celery)
(root)        Next.js 15 frontend
/extension    Chrome MV3 extension (LinkedIn capture + human-paced outreach)
```

This document covers the **extension**. Backend has its own conventions in `/api`; frontend in repo root.

## Commands

- Install locally: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
- Reload after edits: click the reload icon on the extension card. For content-script changes, also reload the LinkedIn tab.
- Syntax-check before commit:
  ```
  for f in $(find extension -name '*.js'); do node --check "$f"; done
  python3 -c "import json; json.load(open('extension/manifest.json'))"
  ```
- Package: `zip -r leadcaptura-extension.zip extension`

## Architecture

```
extension/
  manifest.json                 # MV3 manifest, host: linkedin.com
  background/
    service-worker.js           # API proxy for content scripts; fetch->backend
  content/
    main.js                     # entry: hooks SPA nav, boots overlay + autopilot
    overlay.js                  # floating capture panel, per-card Save chips
    overlay.css                 # overlay styles (lc-* prefix; no shadow DOM)
    scraper.js                  # /in, /search, /sales/* DOM scrapers
    automate.js                 # human-paced executor for connect/message jobs
    lib/
      api.js                    # talks to service-worker via runtime.sendMessage
      dom.js                    # querySelector helpers, human-click, type
      human.js                  # paceBetweenActions, scrollLikeHuman, etc.
      storage.js                # chrome.storage wrappers
  popup/                        # toolbar popup: status, autopilot toggle, Save current
  options/                      # API key + capture behavior settings
  icons/
```

### Bot-detection avoidance — design rules

1. **Never call LinkedIn's internal APIs.** We only read the rendered DOM the user has already loaded.
2. **Never automate in a hidden tab.** `automate.js` waits for `document.visibilityState === "visible"` before each action.
3. **Human-paced everything.**
   - 45-180 seconds between consequential actions (with a ~18% long-tail to 3 min).
   - Per-character typing 40-140ms.
   - Scrolls use eased animation and randomised target offsets.
   - "Reading" pause 1.2-3.5s after navigation before clicking.
4. **Real DOM events.** Clicks use `dispatchHumanClick`, which fires `pointerover`/`pointerdown`/`pointerup`/`click` with realistic coordinates.
5. **Abort on challenge.** `detectChallenge()` aborts the action and reports failure if a captcha/checkpoint surfaces.
6. **Daily caps live server-side.** The extension just runs what the backend hands it via `/extension/jobs/next`; it never schedules outreach itself.

### Message flow

```
LinkedIn page (main.js → overlay.js)
        │
        │ chrome.runtime.sendMessage({ type: "lc:api", action })
        ▼
service-worker.js  ─ fetch ─▶  LeadCaptura backend
```

Job execution:

```
1. main.js setInterval(60s) → automate.tick()
2. automate.tick() → api.nextJobs(1)
3. service-worker → GET /extension/jobs/next
4. backend returns at most one job (connect | message)
5. automate.executeOne(job) → human-paced DOM interaction
6. automate → api.submitJobResult(job.id, { status, error? })
```

## Things to watch for

- **Selectors drift.** LinkedIn rewrites its DOM often. Prefer multiple selectors via `first(root, [...])`. Tests would be flaky against the live site; instead, log failures with the selectors we attempted.
- **Sales Navigator markup is different.** `scrapeSalesNavProfile` / `scrapeSalesNavSearch` use `data-anonymize` attributes which are stable-ish.
- **Don't add `web_accessible_resources` you don't reference.** Causes a manifest warning.
- **Don't grant `<all_urls>`.** Host permissions are limited to `linkedin.com`; optional permissions exist for future server-routed flows.
- **No external dependencies, no build step.** Keep raw JS, no npm.

## Backend dependency

Requires the LeadCaptura backend (`/api` in this same repo, or deployed via `render.yaml`) reachable at the URL configured in the options page. Generate an API key in `Settings → API Keys` in the web app and paste it into the extension options.
