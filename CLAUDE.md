# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single-purpose Chrome extension (Manifest V3) that scrapes lead tables on `*.leadloft.com` pages and exports them to CSV. No build step, no package manager, no tests — the `extension/` directory is loaded directly via **chrome://extensions → Load unpacked**.

## Commands

There is no build system. Common tasks:

- **Install for local testing**: `chrome://extensions` → Developer mode on → Load unpacked → select `extension/`.
- **After editing**: click the reload icon on the extension card in `chrome://extensions`. For content-script changes, also reload the LeadLoft tab.
- **Syntax-check JS / JSON before committing**:
  ```
  node --check extension/content.js
  node --check extension/popup.js
  node --check extension/background.js
  python3 -c "import json; json.load(open('extension/manifest.json'))"
  ```
- **Regenerate icons** (PNG, no PIL dependency): the Python snippet that originally created them lives in the git history of the first commit — re-run it from there if you change branding.
- **Package a zip for distribution**: `zip -r leadloft-exporter.zip extension` (already gitignored).
- **Debug**:
  - Popup: right-click the toolbar icon → Inspect popup.
  - Content script: open DevTools on the LeadLoft tab; logs are prefixed `[LeadLoft Exporter]`.
  - Service worker: `chrome://extensions` → extension card → "Service worker" link.

## Architecture

Three JS contexts cooperate via `chrome.runtime` / `chrome.tabs` messaging. Understanding the message flow is the key to being productive here.

```
popup.js  ──(chrome.tabs.sendMessage)──▶  content.js   (runs in LeadLoft page)
   │                                          │
   │                                          ├─ DETECT_TABLES → returns candidate list
   │                                          └─ EXTRACT_TABLE → returns { headers, rows }
   │
   └─(chrome.runtime.sendMessage)──▶  background.js  (service worker)
                                          └─ DOWNLOAD_CSV → chrome.downloads.download
```

### `extension/content.js` — the scraper (most of the complexity lives here)

Detects three different DOM patterns and registers each as a candidate keyed by an id:

1. **`native`** — `<table>` elements. Headers come from `<thead>` last row, or first row's `<th>`s.
2. **`aria`** — `[role="grid"]` / `[role="table"]`. Headers come from `[role="columnheader"]`; rows from `[role="row"]` (excluding header rows); cells from `[role="cell"]` / `[role="gridcell"]` / `[role="rowheader"]`.
3. **`repeat`** — A heuristic for virtualized React/Vue lists: any element whose direct children share a dominant class signature (≥ `MIN_ROWS_FOR_HEURISTIC` siblings with the same primary class, ≥ 60% of children, ≥ 2 leaf text cells per row, and not already inside a detected `table`/grid). Headers are guessed from a sibling header bar above the container, or fall back to `Column N`.

Candidates are stored in a module-level `candidateRegistry` Map by id. When the popup sends `EXTRACT_TABLE`, the content script looks the entry up there — so `DETECT_TABLES` must run before `EXTRACT_TABLE` for the same page load, and the page must not have been re-rendered in a way that invalidates the cached element reference. If extraction fails because the page mutated, the user is told to click Rescan.

`autoScrollToLoad(entry)` finds the nearest scrolling ancestor of the table element (via `findScrollContainer`, which walks parents looking for `overflow-y: auto|scroll`) and scrolls it to the bottom in a loop until the row count stops growing for `SCROLL_NO_GROWTH_LIMIT` consecutive iterations. This is how virtualized lists get fully materialized before extraction.

Cell text is read via the `text()` helper, which prefers `innerText`, then `aria-label`, then `title` — so icon-only action cells don't end up empty.

The content script is idempotent (`window.__leadloftExporterInstalled` guard) because the popup re-injects it on demand via `chrome.scripting.executeScript` when `PING` fails on tabs that were loaded before the extension was installed/reloaded.

### `extension/popup.js` — UI orchestration

State: `detectedTables` (array of candidates returned by content script) and `activeTabId`. Flow:

1. On open, `scan()` checks the active tab matches the `leadloft.com` host pattern, ensures the content script is present, sends `DETECT_TABLES`, and renders the dropdown + header chip preview.
2. On Export click, sends `EXTRACT_TABLE` with the selected id and current options, then forwards `{ headers, rows }` to the background worker via `DOWNLOAD_CSV`.
3. Options (`autoScroll`, `includeHidden`, base `filename`) are persisted in `chrome.storage.local`.

### `extension/background.js` — CSV + download

Service worker. Renders headers+rows to RFC 4180 CSV with `\r\n` line endings, doubling internal quotes and only quoting fields containing `"`, `,`, `\r`, or `\n`. Prepends a UTF-8 BOM (`﻿`) so Excel auto-detects encoding.

Because MV3 service workers cannot create `blob:` URLs, the CSV is base64-encoded into a `data:text/csv;charset=utf-8;base64,…` URL and passed to `chrome.downloads.download`. The base64 step uses `btoa` over a `TextEncoder`'d byte buffer chunked at 0x8000 to avoid `String.fromCharCode` argument-count limits on large exports.

### `extension/manifest.json`

MV3. Host permissions limited to `leadloft.com`. Content script auto-injects at `document_idle`. The popup can also re-inject it on demand via `scripting` permission. `activeTab` covers tabs the user explicitly clicked the action on; `downloads` and `storage` are self-explanatory.

## Things to watch for when editing

- **Don't break the candidate-id contract** between `content.js` and `popup.js`. The popup sends back an opaque id; if you change id generation, also handle the registry-miss path in the popup ("Click Rescan").
- **Repeating-row heuristic is fragile by design.** It's the fallback for non-semantic markup, so trust the order: native → aria → repeat. The detector deliberately skips repeating-list candidates that overlap with detected tables/grids (`el.closest('table, [role="grid"], [role="table"]')`).
- **Auto-scroll uses the table's nearest scrolling ancestor, not the window.** LeadLoft lead lists are likely embedded in a scrollable panel, so scrolling `document.scrollingElement` would do nothing.
- **CSV encoding**: keep the BOM. Removing it makes Excel mis-detect UTF-8 and corrupts non-ASCII names.
- **No external dependencies, no build step.** Resist the temptation to add a bundler unless someone is materially blocked by raw JS — it would add far more friction than it removes for a project this size.
- **Don't add `web_accessible_resources` unless you actually reference the file.** A stale entry causes a manifest warning on load. (There was one earlier in this branch's history; it was removed.)
