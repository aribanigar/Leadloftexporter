# LeadLoft Exporter

A Chrome extension that detects lead tables on [leadloft.com](https://www.leadloft.com) and exports them to a CSV file with one column per visible field.

## Features

- Detects three kinds of tables on LeadLoft pages:
  - Native `<table>` elements
  - ARIA grids (`role="grid"` / `role="table"`)
  - Virtualized lists with repeating row signatures (common in React/Vue lead views)
- Preserves header names as CSV columns; falls back to `Column N` when a header can't be inferred
- Optional **auto-scroll** to force the page to load all rows before extracting (helps with virtualized/infinite-scroll lists)
- Optional inclusion of hidden columns
- Properly escaped RFC 4180 CSV with a UTF-8 BOM so Excel opens it correctly
- Picks a sensible default filename, with timestamp; configurable from the popup

## Installation (developer mode)

1. Clone or download this repo.
2. Open Chrome and visit `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the `extension/` directory in this repo.
5. The "LeadLoft Exporter" icon will appear in the toolbar.

## Usage

1. Sign in to LeadLoft and navigate to a view that lists leads (e.g. a campaign's leads, a contact list, a search result).
2. Click the **LeadLoft Exporter** toolbar icon.
3. The popup scans the page and lists every detected table with row/column counts.
4. Pick the table that contains the leads you want.
5. (Optional) Expand **Options** and:
   - Enable **Auto-scroll** if the list is virtualized — the extension will scroll the list to the bottom (multiple times if needed) so all rows load before extraction.
   - Enable **Include hidden columns** if columns you care about are toggled off in the UI.
   - Set a base **Filename** (a timestamp is appended automatically).
6. Click **Export CSV**. Chrome saves the file to your default downloads folder.

## How detection works

The content script (`extension/content.js`) walks the DOM and registers any element that looks like a tabular lead list:

1. Every visible `<table>` with at least one body row.
2. Every visible element with `role="grid"` or `role="table"` and at least one row.
3. Any container whose direct children share a dominant class signature (≥3 children with the same primary class, plus at least 2 leaf text cells per child). This catches React/Vue virtualized lists that don't use semantic table markup.

Each candidate is given an ID and registered in memory. When you trigger an export, the popup sends `EXTRACT_TABLE` with that ID; the content script extracts headers + rows and ships them back. The background service worker (`extension/background.js`) renders the CSV (escaping fields per RFC 4180, prepending a UTF-8 BOM) and saves it via `chrome.downloads.download`.

## Project layout

```
extension/
  manifest.json     # MV3 manifest
  popup.html        # popup UI
  popup.css         # popup styles
  popup.js          # popup logic (scan / extract / download orchestration)
  content.js        # in-page scraper
  background.js     # service worker — turns headers+rows into a CSV file
  icons/
    icon16.png
    icon48.png
    icon128.png
```

## Permissions used

- `activeTab` — read the currently focused tab when the popup is open
- `scripting` — inject the content script on demand for tabs loaded before install
- `downloads` — save the CSV file
- `storage` — remember popup option preferences between sessions
- Host: `https://*.leadloft.com/*` — only runs on LeadLoft pages

The extension does not send any data anywhere; the CSV is generated and saved locally.

## Troubleshooting

- **"No tables detected"** — Make sure you're on a page that actually shows a lead list. Some screens (settings, single-lead detail) have no tabular data. Click **Rescan** after the list finishes loading.
- **Some rows are missing** — The list is probably virtualized. Enable **Auto-scroll** in the popup options and re-export.
- **Header says `Column 1`** — The detector couldn't find a semantic header. The data is still exported correctly; you can rename columns in your spreadsheet.
- **Export button is greyed out** — Either no tables were found, or the active tab isn't a `leadloft.com` page.
