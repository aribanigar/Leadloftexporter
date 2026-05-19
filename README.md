# LeadCaptura — LinkedIn Chrome Extension

A Manifest V3 Chrome extension that captures LinkedIn leads to your LeadCaptura workspace and executes outreach actions (connect, message) at a human pace inside your own browser session.

Pairs with the SaaS backend + frontend in [`aribanigar/leadautocapture`](https://github.com/aribanigar/leadautocapture).

## Features

- Floating capture panel on `/in/<handle>`, search results, and Sales Navigator.
- Per-card "Save" chip on each visible search result.
- "Save all on page" for bulk sync.
- Autopilot: executes queued LinkedIn connects and messages at a human pace, only while the LinkedIn tab is in the foreground, with captcha detection and abort.
- Server-side daily caps (set in `Settings → Outreach`): 80 emails / 15 connects / 30 messages by default.

## Why it can't be bot-detected

It uses the **user's own logged-in browser session**. There are no headless flags, no fetch overrides on LinkedIn's URLs, no fake user-agent. The extension reads only the rendered DOM the user has already loaded and dispatches real DOM events at human pace. See `CLAUDE.md` for the design rules.

## Installation (local dev)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** → select the `extension/` directory.
4. Click the LeadCaptura icon → **Options** → paste your backend URL and API key.

Generate an API key in your workspace at `Settings → API Keys`.

## Permissions used

- `activeTab` / `scripting` — inject the content script on demand.
- `storage` — remember API key, capture toggles.
- `tabs` — open the workspace web UI from the popup.
- `alarms` / `notifications` — keep the service worker awake periodically.
- Host permission: `https://www.linkedin.com/*` only.

The extension never reads or sends data from any other site. Captured lead data is sent only to the backend URL you configure.

## Layout

See `CLAUDE.md` for the full architecture, message flow, and bot-detection design rules.
