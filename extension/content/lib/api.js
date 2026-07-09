/* eslint-disable no-undef */
/* API client that talks to the LeadCaptura backend via the service worker.
 * Content scripts never make cross-origin requests directly — we always
 * proxy through the service worker so the same code path works whether the
 * user clicks Save on a profile or the worker fires a polling job.
 *
 * Errors are decorated with actionable hints. The user used to see opaque
 * "HTTP 401" or "Failed to fetch" in the panel's status pill; now they
 * get "Invalid API key — open the extension Options and paste a fresh key"
 * so they know what to actually DO. Every call also logs full timing and
 * outcome to the page console for debugging.
 */
(() => {
  if (globalThis.__lcApi) return;

  function _decorate(rawError, action) {
    let m;
    if (rawError && typeof rawError === "object") {
      // Backend sometimes returns a structured error ({detail}, {message},
      // FastAPI validation arrays, etc.). Stringifying directly yields a
      // useless "[object Object]"; pull the human-readable field instead.
      m =
        rawError.message ||
        rawError.detail ||
        rawError.error ||
        (() => { try { return JSON.stringify(rawError); } catch { return "Unknown error"; } })();
      m = String(m);
    } else {
      m = String(rawError || "");
    }
    if (/401|invalid.*api.*key|unauthorized/i.test(m)) {
      return "Invalid API key — open the LeadCaptura extension Options and paste a fresh key from Settings → API Keys";
    }
    if (/api.url.*not.*configured/i.test(m)) {
      return "Backend URL not set — open the LeadCaptura extension Options";
    }
    if (/api.key.*not.*configured/i.test(m)) {
      return "API key not set — open the LeadCaptura extension Options";
    }
    if (/failed to fetch|network|err_connection|cors|err_name_not_resolved/i.test(m)) {
      return "Cannot reach backend — check internet + Backend URL in extension Options";
    }
    if (/extension context invalidated|no response from background/i.test(m)) {
      return "Extension was just reloaded — refresh this LinkedIn tab and try again";
    }
    return `${action} failed: ${m}`;
  }

  // Single attempt — throws raw (undecorated) error string on failure.
  function _callOnce(action, payload) {
    return new Promise((resolve, reject) => {
      let runtimeAlive = false;
      try { runtimeAlive = !!chrome.runtime?.id; } catch {}
      if (!runtimeAlive) {
        reject(new Error("Extension context invalidated"));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "lc:api", action, payload }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "lastError"));
            return;
          }
          if (!response) { reject(new Error("No response from background")); return; }
          if (response.error) {
            reject(new Error(typeof response.error === "string" ? response.error : JSON.stringify(response.error)));
            return;
          }
          resolve(response.data);
        });
      } catch (e) {
        reject(new Error(e?.message || String(e)));
      }
    });
  }

  async function call(action, payload) {
    const t0 = Date.now();
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await _callOnce(action, payload);
        console.log(`[LeadCaptura] api.call ok action=${action} elapsed=${Date.now() - t0}ms`);
        return data;
      } catch (rawErr) {
        const raw = rawErr?.message || String(rawErr);
        const elapsed = Date.now() - t0;
        // Retry on MV3 service-worker wakeup race: Chrome terminates the SW
        // after ~30 s idle; the first sendMessage after that can fail before
        // Chrome restarts it. One retry (150 ms later) is always enough.
        if (attempt < MAX_RETRIES && /receiving end does not exist|could not establish connection/i.test(raw)) {
          console.log(`[LeadCaptura] api.call SW-wake retry ${attempt + 1} action=${action} elapsed=${elapsed}ms`);
          await new Promise(r => setTimeout(r, 150 * Math.pow(2, attempt)));
          continue;
        }
        if (/Extension context invalidated/i.test(raw)) {
          const err = new Error(_decorate(raw, action));
          console.error(`[LeadCaptura] api.call no-runtime action=${action} err="${err.message}"`);
          throw err;
        }
        const err = new Error(_decorate(raw, action));
        console.log(`[LeadCaptura] api.call error action=${action} elapsed=${elapsed}ms raw="${raw}" decorated="${err.message}"`);
        throw err;
      }
    }
  }

  globalThis.__lcApi = {
    me: () => call("me"),
    options: () => call("options"),
    createSegment: (name) => call("createSegment", { name }),
    syncProfile: (profile) => call("syncProfile", { profile }),
    syncSearch: (data) => call("syncSearch", data),
    enrollBatch: (playbook_id, lead_ids) => call("enrollBatch", { playbook_id, lead_ids }),
    nextJobs: (limit = 1) => call("nextJobs", { limit }),
    submitJobResult: (jobId, result) => call("submitJobResult", { jobId, result }),
    // AI answer (Gemini or Claude, per the user's chosen provider) for an
    // Easy-Apply form question. Resolves to { ok, answer } or { ok:false,
    // error }. Never throws — the caller treats any failure as "leave blank".
    // Notify the CRM that a Connect or Follow action was completed for a profile.
    // Called after each successful queue step so Pipeline/Prospecting stay in sync.
    connectResult: (linkedin_url, action) =>
      call("connectResult", { linkedin_url, action }),
    // Case #2 bulk-message 24h sent-history — backend-synced layer so the
    // local dedupe survives extension reinstall / browser change / new
    // device. Backend is at api/app/api/v1/extension.py (POST + GET
    // /case2-message-sent). Both calls are best-effort: the local
    // chrome.storage + linkedin.com localStorage mirror remain the
    // fast-path. If the network call fails we just fall back to local.
    case2MessageSent: (linkedin_url) =>
      call("case2MessageSent", { linkedin_url }),
    case2MessageSentList: (since_ms) =>
      call("case2MessageSentList", { since_ms }),
    // List of LinkedIn URLs the workspace ALREADY has as leads. Used by
    // bulk Save All Leads to skip already-saved profiles upfront — no tab
    // opened, no scrape wasted. Backend: GET /extension/known-urls.
    knownUrls: () => call("knownUrls"),
    geminiAnswer: ({ question, kind, options }) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "lc:aiAnswer", question, kind, options },
            (response) => {
              if (chrome.runtime.lastError || !response) {
                resolve({ ok: false, error: chrome.runtime.lastError?.message || "no_response" });
                return;
              }
              resolve(response);
            }
          );
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      }),
  };
})();
