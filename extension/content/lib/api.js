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

  async function call(action, payload) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      let runtimeAlive = false;
      try { runtimeAlive = !!chrome.runtime?.id; } catch {}
      if (!runtimeAlive) {
        const err = new Error(_decorate("Extension context invalidated", action));
        console.error(`[LeadCaptura] api.call no-runtime action=${action} err="${err.message}"`);
        reject(err);
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "lc:api", action, payload }, (response) => {
          const elapsed = Date.now() - t0;
          if (chrome.runtime.lastError) {
            const err = new Error(_decorate(chrome.runtime.lastError.message, action));
            console.log(`[LeadCaptura] api.call lastError action=${action} elapsed=${elapsed}ms raw="${chrome.runtime.lastError.message}" decorated="${err.message}"`);
            reject(err);
            return;
          }
          if (!response) {
            const err = new Error(_decorate("No response from background", action));
            console.log(`[LeadCaptura] api.call no-response action=${action} elapsed=${elapsed}ms`);
            reject(err);
            return;
          }
          if (response.error) {
            const err = new Error(_decorate(response.error, action));
            console.log(`[LeadCaptura] api.call backend-error action=${action} elapsed=${elapsed}ms raw="${typeof response.error === "string" ? response.error : JSON.stringify(response.error)}" decorated="${err.message}"`);
            reject(err);
            return;
          }
          console.log(`[LeadCaptura] api.call ok action=${action} elapsed=${elapsed}ms`);
          resolve(response.data);
        });
      } catch (e) {
        const err = new Error(_decorate(e?.message || String(e), action));
        console.log(`[LeadCaptura] api.call threw action=${action} raw="${e?.message || String(e)}" decorated="${err.message}"`);
        reject(err);
      }
    });
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
