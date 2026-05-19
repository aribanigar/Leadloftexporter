/* Service worker: proxies API calls between content scripts and the
 * LeadCaptura backend. We centralize HTTP here for three reasons:
 *   1. Content scripts run inside linkedin.com's origin; we don't want
 *      direct cross-origin fetches polluting LinkedIn's request graph.
 *   2. The same API client can be reused by the popup and options page.
 *   3. We can transparently refresh the API key from storage on every call.
 */

const DEFAULT_SETTINGS = {
  apiUrl: "http://localhost:8000",
  apiKey: "",
  enabled: true,
  autopilot: false,
  showOverlay: true,
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function fetchJson(path, opts = {}) {
  const { apiUrl, apiKey } = await getSettings();
  if (!apiUrl) throw new Error("API URL not configured.");
  if (!apiKey) throw new Error("API key not configured. Open the extension options.");
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && data.detail) ||
      (typeof data === "string" && data) ||
      `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return data;
}

const handlers = {
  me: () => fetchJson("/extension/me"),
  options: () => fetchJson("/extension/options"),
  syncProfile: ({ profile }) =>
    fetchJson("/extension/sync/profile", { method: "POST", body: profile }),
  syncSearch: (body) => fetchJson("/extension/sync/search", { method: "POST", body }),
  enrollBatch: ({ playbook_id, lead_ids }) =>
    fetchJson("/extension/enroll", { method: "POST", body: { playbook_id, lead_ids } }),
  nextJobs: ({ limit }) => fetchJson(`/extension/jobs/next?limit=${limit || 1}`),
  submitJobResult: ({ jobId, result }) =>
    fetchJson(`/extension/jobs/${jobId}/result`, { method: "POST", body: result }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content scripts cannot call chrome.runtime.openOptionsPage; proxy it here.
  if (msg?.type === "lc:openOptions") {
    chrome.runtime.openOptionsPage(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type !== "lc:api") return;
  const handler = handlers[msg.action];
  if (!handler) {
    sendResponse({ error: `Unknown action: ${msg.action}` });
    return;
  }
  Promise.resolve()
    .then(() => handler(msg.payload || {}))
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true; // async
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// Tiny periodic heartbeat to keep the worker alive while the user is on LI
chrome.alarms?.create("lc-heartbeat", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  // No-op: just ensures Chrome rouses the worker periodically.
});
