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

// ---- Safe zones: limit how many enrichments we open per hour/day ----------

const SAFE_ZONES = {
  perHour: 250,  // burst ceiling — ~4/min sustained, allows quick batches
  perDay: 2000,  // daily cap
};

// In-memory mirror of the enrichment timestamps. The async chrome.storage
// read-modify-write in recordEnrich() races when 20 cards are clicked at
// once: every handler reads the same pre-record value and all pass the
// limit gate. Doing reserve+record synchronously in this in-memory array
// closes that window — the service worker is single-threaded, so an array
// push between two awaits cannot be interleaved by another handler.
const _enrichMem = { hourly: [], daily: [], loaded: false };

async function _hydrateEnrichMem() {
  if (_enrichMem.loaded) return;
  const { safeZone } = await chrome.storage.local.get("safeZone");
  // Double-check after the await: another handler may have hydrated AND
  // reserved while we were suspended. Overwriting would discard their
  // reservation, defeating the in-memory race fix.
  if (_enrichMem.loaded) return;
  const now = Date.now();
  _enrichMem.hourly = (safeZone?.hourly || []).filter((t) => now - t < 3_600_000);
  _enrichMem.daily = (safeZone?.daily || []).filter((t) => now - t < 86_400_000);
  _enrichMem.loaded = true;
}

async function canEnrich() {
  await _hydrateEnrichMem();
  const now = Date.now();
  _enrichMem.hourly = _enrichMem.hourly.filter((t) => now - t < 3_600_000);
  _enrichMem.daily = _enrichMem.daily.filter((t) => now - t < 86_400_000);
  if (_enrichMem.hourly.length >= SAFE_ZONES.perHour) return false;
  if (_enrichMem.daily.length >= SAFE_ZONES.perDay) return false;
  return true;
}

// Synchronous reserve: atomically increments the in-memory counters so a
// concurrent canEnrich call in the same task tick sees the reservation.
// Persistence to chrome.storage happens fire-and-forget afterwards.
function reserveEnrich() {
  const now = Date.now();
  _enrichMem.hourly.push(now);
  _enrichMem.daily.push(now);
  chrome.storage.local
    .set({ safeZone: { hourly: _enrichMem.hourly, daily: _enrichMem.daily } })
    .catch(() => { /* best-effort persist */ });
}

// Jittered delay: base range with 20% chance of "distracted user" extra pause
function jitter(minMs, maxMs) {
  const base = minMs + Math.random() * (maxMs - minMs);
  const bonus = Math.random() < 0.2 ? base * (0.4 + Math.random() * 0.8) : 0;
  return Math.round(base + bonus);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  // Open a profile in a background tab for contact-info enrichment.
  // Key improvements vs the old approach:
  //   1. Navigate directly to /overlay/contact-info/ so LinkedIn's SPA router
  //      pre-opens the modal — no button click needed in the content script.
  //   2. Check safe-zone rate limits before opening any tab.
  //   3. Jittered delay (0.8–4s, with 20% long-tail) so tabs don't open in
  //      rapid bursts which would look bot-like.
  if (msg?.type === "lc:enrichProfile") {
    const target = String(msg.url || "");
    if (!target) {
      sendResponse({ ok: false, error: "url_required" });
      return true;
    }
    (async () => {
      try {
        const allowed = await canEnrich();
        if (!allowed) {
          sendResponse({ ok: false, error: "safe_zone_limit_reached" });
          return;
        }
        // Reserve the slot synchronously NOW so concurrent handlers can't
        // all pass the canEnrich gate before any of them have recorded.
        // The persist to chrome.storage is fire-and-forget inside reserve.
        reserveEnrich();
        // Jittered delay before opening to avoid time-pattern detection
        await sleep(jitter(800, 4000));
        // Navigate to the plain profile URL (NOT the /overlay/contact-info
        // sub-path) so the about/experience sections render normally — that
        // way the content script can both click Contact info AND scan the
        // visible profile text for email/phone patterns as a fallback.
        let enrichUrl = target;
        try {
          const u = new URL(target);
          u.searchParams.set("lc_enrich", "1");
          enrichUrl = u.toString();
        } catch {
          enrichUrl = target + (target.includes("?") ? "&" : "?") + "lc_enrich=1";
        }
        chrome.tabs.create({ url: enrichUrl, active: false }, (tab) => {
          sendResponse({ ok: true, tabId: tab?.id });
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // Hidden-iframe enrichment (no new tab) checks the rate limit through us.
  // We hold the counters in the service worker so all tabs share one budget;
  // the content script can't safely keep its own counter (different tabs
  // would each have their own). On allow, we reserve the slot synchronously
  // so concurrent clicks across tabs can't all sneak past the daily cap.
  if (msg?.type === "lc:reserveEnrich") {
    (async () => {
      try {
        const allowed = await canEnrich();
        if (!allowed) {
          sendResponse({ ok: false, error: "safe_zone_limit_reached" });
          return;
        }
        reserveEnrich();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // The enrichment-trigger content script asks us to close its own tab.
  if (msg?.type === "lc:closeMe") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) {
      chrome.tabs.remove(tabId, () => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false });
    }
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
