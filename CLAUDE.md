# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single-purpose Chrome extension (Manifest V3) that captures lead lists on `*.leadloft.com` pages and exports them to CSV. It works two ways at once: it **hooks the page's network layer** to grab the JSON the LeadLoft SPA fetches, and it **scrapes the rendered DOM** as a fallback. No build step, no package manager, no tests — the `extension/` directory is loaded directly via **chrome://extensions → Load unpacked**.

## Commands

There is no build system. Common tasks:

- **Install for local testing**: `chrome://extensions` → Developer mode on → Load unpacked → select `extension/`.
- **After editing**: click the reload icon on the extension card in `chrome://extensions`. For content-script changes, also reload the LeadLoft tab. Because `inject.js` runs at `document_start` in the MAIN world and only hooks requests fired *after* it installs, an edit to capture logic generally requires reloading the LeadLoft tab too, not just the extension.
- **Syntax-check JS / JSON before committing**:
  ```
  node --check extension/content.js
  node --check extension/popup.js
  node --check extension/background.js
  node --check extension/inject.js
  python3 -c "import json; json.load(open('extension/manifest.json'))"
  ```
- **Regenerate icons** (PNG, no PIL dependency): the Python snippet that originally created them lives in the git history of the first commit — re-run it from there if you change branding.
- **Package a zip for distribution**: `zip -r leadloft-exporter.zip extension` (already gitignored).
- **Debug**:
  - Popup: right-click the toolbar icon → Inspect popup.
  - Content script (ISOLATED world): open DevTools on the LeadLoft tab; logs are prefixed `[LeadLoft Exporter]`.
  - Network hook (MAIN world): same DevTools console; logs are prefixed `[LeadLoft Exporter:hook]`.
  - Service worker: `chrome://extensions` → extension card → "Service worker" link.

## Architecture

Four JS contexts cooperate. Two of them (`inject.js`, `content.js`) run on the LeadLoft page but in **different JS worlds** and communicate via `window.postMessage`; the popup and background talk over `chrome.runtime`/`chrome.tabs` messaging. Understanding both the world split and the message flow is the key to being productive here.

```
inject.js  (MAIN world, document_start)
   │  hooks fetch / XHR / WebSocket, finds arrays-of-objects in every JSON
   │  response, postMessage({__leadloftExporter, kind:'CAPTURE', url, items})
   ▼
content.js (ISOLATED world, document_idle)  ── runs in LeadLoft page
   │   ├─ ingests CAPTURE messages into captureSources (one per API endpoint)
   │   ├─ scores each source for "lead-likeness", normalises LeadLoft records
   │   ├─ DETECT_TABLES → returns candidate list (API sources + DOM tables)
   │   └─ EXTRACT_TABLE → returns { headers, rows }
   ▲
   │ chrome.tabs.sendMessage
popup.js  ── UI orchestration
   │
   └─ chrome.runtime.sendMessage ──▶ background.js (service worker)
                                       └─ DOWNLOAD_CSV → chrome.downloads.download
```

There are **two independent data paths to a CSV**, and the popup lets the user pick which candidate to export:

1. **API capture path (preferred).** `inject.js` sees the raw JSON; `content.js` turns each endpoint into an `api:` candidate. This yields complete, clean data even for fields the UI never renders.
2. **DOM scraping path (fallback).** `content.js` detects rendered tables/grids/lists and reads cells. Used when capture missed the data (e.g. the tab was already open before the extension loaded).

### `extension/inject.js` — the network hook (MAIN world)

Runs at `document_start` in the page's MAIN world (required so it can wrap the page's own `window.fetch`, `XMLHttpRequest`, and `WebSocket`). For every JSON response it depth-walks the payload (`findArrays`) collecting every array-of-objects, `unwrap`s GraphQL-style `edges/node`/`attributes` wrappers, and posts each array to the content script tagged with the source URL. It is deliberately **dumb about what's a lead** — it forwards everything and lets `content.js` score it. It does **not** flatten nested objects up to the top level (`flattenOneLevel` is a documented no-op): doing so previously caused every row to show the account owner's email. Idempotent via `window.__leadloftNetHookInstalled`.

### `extension/content.js` — capture ingestion + DOM scraper (ISOLATED world)

The largest and most complex file. Two responsibilities:

**(a) API capture ingestion.** `captureSources` is a `Map` keyed by URL with the query string stripped, so paginated responses to the same endpoint merge into one source. For each source:
- `scoreArrayAsLeads()` assigns a lead-likeness score: positive points for contact-shaped keys/values (email/phone/LinkedIn/name), strong negative points for clearly-not-leads payloads (billing, SMTP settings, saved filters, permissions). The popup auto-selects the highest scorer when `score >= 8`.
- Records are **deduped across endpoints** by `itemKey()` → `contactIdFor()`: a Deal containing `primaryContact` X and a standalone Contact X hash to the same key. When the same person appears twice, the version with more non-empty fields wins.
- **LeadLoft-specific normalisation**: LeadLoft's lead-list endpoint returns *Deal* objects whose real person lives in `deal.primaryContact` and company in `deal.company`. `normalizeDeal()` / `normalizeContact()` map these to a curated, fixed column order (Name, Email, Phone, LinkedIn, Title, Company, …). Top-level `email`/`firstName` on a Deal are ambiguous and deliberately **not** used as the lead's own contact info.

**(b) DOM detection + extraction.** Detects four patterns, registered as candidates in `candidateRegistry` (a `Map` by id), in this priority order:
1. **`eltable`** — Element UI `.el-table` (LeadLoft is built on Element UI). Renders header and body as *separate* `<table>`s; treated as one logical table. Skips checkbox/action columns.
2. **`native`** — plain `<table>` (skips ones inside an `.el-table`).
3. **`aria`** — `[role="grid"]`/`[role="table"]`.
4. **`repeat`** — heuristic for virtualized lists: a container whose direct children share a dominant primary-class signature (≥ `MIN_ROWS_FOR_HEURISTIC` matching siblings, ≥ 60% of children, ≥ 2 leaf text cells/row, not inside a detected table/grid).

DOM rows are **enriched from the API capture** (`enrichContactsWithApi` / `findLeadForRow`): the scraper matches a row's text against captured leads by normalised name to backfill Email/Phone/LinkedIn/Twitter/Website even when those are hidden behind hover-only action icons. Every extraction appends the `CONTACT_COLUMNS` and runs `pruneEmptyColumns` to drop all-blank columns.

`text()` reads `textContent` first (not `innerText`, which can return CSS-ellipsis-truncated emails), then falls back to `aria-label`/`title`/`img[alt]`.

**Safety-net probe** (`probeForLeads`): if the user opens the popup on a tab loaded *before* the hook was active, the content script replays every API-looking URL from the Performance API via `fetch(..., {credentials:'include'})` so cookies authenticate the calls, then ingests the responses.

**Element-UI pagination**: capture only sees the current page, so for `.el-table`s with `.el-pagination`, the content script can click through every page. Two modes, both gated on the Auto-scroll option:
- `extractElTableAllPages` (DOM path) — pages through and scrapes each page, deduping by row signature.
- `drivePaginationForCapture` (API path) — pages through *without* scraping, purely to make the SPA fetch each page so the hook captures all records.

### `extension/popup.js` — UI orchestration

State: `detectedTables` (candidates from the content script), `activeTabId`, `disabledColumns` (a persisted `Set` of column names to exclude). Flow:
1. On open, `scan()` verifies the tab matches the `leadloft.com` host, ensures the content script is present (`ensureContentScript` re-injects via `chrome.scripting` if `PING` fails), sends `DETECT_TABLES`, renders the dropdown + header chips + column picker, and surfaces capture stats (records/sources/best score) in the status line.
2. **Column picker**: per-column checkboxes with Select all / none / "Essentials only" (`ESSENTIAL_COLUMNS`). Disabled columns are filtered out client-side after extraction (`filterColumns`).
3. On Export, sends `EXTRACT_TABLE` (with `autoScroll`/`includeHidden`), filters columns, then forwards `{ headers, rows }` to background via `DOWNLOAD_CSV`.
4. **Reload tab** button: reloads the LeadLoft tab and re-scans, so the hook captures the API responses from scratch — the fix-it action when Email/Phone come back blank.
5. Options (`autoScroll`, `includeHidden`, `filename`, `disabledColumns`) persist in `chrome.storage.local`. Auto-scroll defaults on when the chosen table reports `pages > 1`.

### `extension/background.js` — CSV + download

Service worker. Renders headers+rows to RFC 4180 CSV with `\r\n` line endings, doubling internal quotes and only quoting fields containing `"`, `,`, `\r`, or `\n`. Prepends a UTF-8 BOM so Excel auto-detects encoding. Because MV3 service workers can't create `blob:` URLs, the CSV is base64-encoded into a `data:text/csv;…;base64,…` URL; the base64 step chunks the `TextEncoder` byte buffer at `0x8000` to avoid `String.fromCharCode` argument-count limits on large exports.

### `extension/manifest.json`

MV3. Host permissions limited to `leadloft.com`. **Two content-script entries**: `inject.js` at `document_start` in `world: "MAIN"`, and `content.js` at `document_idle` in the default ISOLATED world. `activeTab` + `scripting` let the popup re-inject `content.js` on demand; `tabs` is used to reload the LeadLoft tab; `downloads` and `storage` are self-explanatory.

## Things to watch for when editing

- **Respect the two-world split.** `inject.js` (MAIN) can touch the page's globals but not `chrome.*`; `content.js` (ISOLATED) can use `chrome.*` but not the page's patched `fetch`. They only talk via `window.postMessage` with the `__leadloftExporter` tag. Don't move logic across this line.
- **Don't flatten nested API objects in `inject.js`.** Promoting `owner.email`/`createdBy.email` to the top level makes every row show the account owner's contact info. Normalisation belongs in `content.js`, which knows the LeadLoft Deal/Contact shape.
- **Keep the candidate-id contract** between `content.js` and `popup.js`. The popup sends back an opaque id; if you change id generation, also handle the registry-miss path in the popup ("Click Rescan").
- **Lead scoring is the gatekeeper.** Detection order and the auto-select threshold (`score >= 8`) decide what the user exports by default. When LeadLoft changes its payload shape, retune `scoreArrayAsLeads` and the `normalizeDeal`/`normalizeContact` field maps together.
- **Repeating-row heuristic is fragile by design.** It's the last-resort fallback for non-semantic markup; trust the order eltable → native → aria → repeat, and the deliberate skip of repeating candidates that overlap a detected table/grid.
- **Auto-scroll vs. pagination.** For virtualized lists, "auto-scroll" scrolls the table's *nearest scrolling ancestor* (not the window). For `.el-table`s it instead means "page through all pages" — the same checkbox drives different code paths per candidate kind.
- **CSV encoding**: keep the BOM. Removing it makes Excel mis-detect UTF-8 and corrupt non-ASCII names.
- **No external dependencies, no build step.** Resist adding a bundler unless someone is materially blocked by raw JS — it adds far more friction than it removes for a project this size.
- **Don't add `web_accessible_resources` unless you reference the file.** A stale entry causes a manifest warning on load.
