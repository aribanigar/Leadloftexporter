/* Service worker: proxies API calls between content scripts and the
 * LeadCaptura backend, AND enriches profiles with contact data directly
 * from LinkedIn's Voyager API using the user's captured session cookie.
 *
 * Cookie capture: webRequest.onBeforeSendHeaders intercepts every LinkedIn
 * request and stores li_at + JSESSIONID (CSRF token) in memory + storage.
 * This is the same technique used by the official LeadLoft extension.
 *
 * Voyager enrichment: before syncing a profile, we call
 * /voyager/api/identity/profiles/{id}/profileContactInfo with the captured
 * cookie to get email + phone — data LinkedIn only exposes via its API.
 */

const DEFAULT_SETTINGS = {
  apiUrl: "http://localhost:8000",
  apiKey: "",
  enabled: true,
  autopilot: false,
  showOverlay: true,
};

// In-memory LinkedIn session; repopulated from storage on worker restart
let _liCookie = null;
let _liCsrf = null;

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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && data.detail) ||
      (typeof data === "string" && data) ||
      `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return data;
}

// ── LinkedIn Voyager helpers ──────────────────────────────────────────────────

function extractCsrf(cookieStr) {
  const m = (cookieStr || "").match(/JSESSIONID="?([^";]+)"?/);
  return m ? m[1] : null;
}

async function ensureLinkedInSession() {
  if (_liCookie && _liCsrf) return true;
  const s = await chrome.storage.local.get(["_liCookie", "_liCsrf"]);
  if (s._liCookie && s._liCsrf) {
    _liCookie = s._liCookie;
    _liCsrf = s._liCsrf;
    return true;
  }
  return false;
}

async function voyagerGetContactInfo(publicIdentifier) {
  if (!await ensureLinkedInSession()) {
    throw new Error("LinkedIn session not captured yet — browse any LinkedIn page first.");
  }
  const url = `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(publicIdentifier)}/profileContactInfo`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/vnd.linkedin.normalized+json+2.1",
      "accept-language": "en-US,en;q=0.9",
      "csrf-token": _liCsrf,
      "cookie": _liCookie,
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
    },
  });
  if (res.status === 401 || res.status === 403) {
    _liCookie = null;
    _liCsrf = null;
    chrome.storage.local.remove(["_liCookie", "_liCsrf"]);
    throw new Error("LinkedIn session expired. Refresh any LinkedIn tab to reconnect.");
  }
  if (!res.ok) throw new Error(`Voyager API error ${res.status}`);

  const data = await res.json();
  const root = data.data || data;

  const email = root.emailAddress || null;

  let phone = null;
  const phones = root.phoneNumbers || data.phoneNumbers;
  if (Array.isArray(phones) && phones.length > 0) {
    phone = (phones[0].number || "").trim() || null;
  }

  let website = null;
  const sites = root.websites || data.websites;
  if (Array.isArray(sites) && sites.length > 0) {
    website = sites[0].url || null;
  }

  return { email, phone, website };
}

function publicIdFromUrl(linkedinUrl) {
  if (!linkedinUrl) return null;
  try {
    const u = new URL(linkedinUrl);
    const m = u.pathname.match(/\/in\/([^/?#]+)/i) || u.pathname.match(/\/sales\/lead\/([^/?#,]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// ── Backend API handlers ──────────────────────────────────────────────────────

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

  // Enrich via Voyager API then sync — used for all Save actions
  saveWithEnrich: async ({ profile }) => {
    const pid = publicIdFromUrl(profile.linkedin_url);
    if (pid) {
      try {
        const contact = await voyagerGetContactInfo(pid);
        if (contact.email && !profile.email) profile = { ...profile, email: contact.email };
        if (contact.phone && !profile.phone) profile = { ...profile, phone: contact.phone };
        if (contact.website && !profile.company_url) profile = { ...profile, company_url: contact.website };
        profile = { ...profile, raw: { ...(profile.raw || {}), contact_enriched: true } };
      } catch (e) {
        // Enrichment is best-effort — never block the save
        console.warn("[LeadCaptura] Voyager enrichment skipped:", e.message);
      }
    }
    return fetchJson("/extension/sync/profile", { method: "POST", body: profile });
  },

  getLinkedInContact: ({ linkedinUrl }) => {
    const pid = publicIdFromUrl(linkedinUrl);
    if (!pid) throw new Error("Could not extract profile ID from URL.");
    return voyagerGetContactInfo(pid);
  },
};

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "lc:openOptions") {
    chrome.runtime.openOptionsPage(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "lc:enrichProfile") {
    const target = String(msg.url || "");
    if (!target) { sendResponse({ ok: false, error: "url_required" }); return true; }
    let withParam = target;
    try {
      const u = new URL(target);
      u.searchParams.set("lc_enrich", "1");
      withParam = u.toString();
    } catch {
      withParam = target + (target.includes("?") ? "&" : "?") + "lc_enrich=1";
    }
    chrome.tabs.create({ url: withParam, active: false }, (tab) => {
      sendResponse({ ok: true, tabId: tab?.id });
    });
    return true;
  }
  if (msg?.type === "lc:closeMe") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) chrome.tabs.remove(tabId, () => sendResponse({ ok: true }));
    else sendResponse({ ok: false });
    return true;
  }
  if (msg?.type !== "lc:api") return;
  const handler = handlers[msg.action];
  if (!handler) { sendResponse({ error: `Unknown action: ${msg.action}` }); return; }
  Promise.resolve()
    .then(() => handler(msg.payload || {}))
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});

// ── LinkedIn cookie capture ───────────────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    for (const h of details.requestHeaders || []) {
      if (h.name.toLowerCase() === "cookie" && h.value.includes("li_at=")) {
        const csrf = extractCsrf(h.value);
        if (csrf && (h.value !== _liCookie || csrf !== _liCsrf)) {
          _liCookie = h.value;
          _liCsrf = csrf;
          chrome.storage.local.set({ _liCookie, _liCsrf }).catch(() => {});
        }
        break;
      }
    }
  },
  { urls: ["https://*.linkedin.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.alarms?.create("lc-heartbeat", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  ensureLinkedInSession();
});
