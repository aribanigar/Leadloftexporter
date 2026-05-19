/* eslint-disable no-undef */
/* API client that talks to the LeadCaptura backend via the service worker.
 * Content scripts never make cross-origin requests directly — we always
 * proxy through the service worker so the same code path works whether the
 * user clicks Save on a profile or the worker fires a polling job. */
(() => {
  if (globalThis.__lcApi) return;

  async function call(action, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "lc:api", action, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("No response from background"));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.data);
      });
    });
  }

  globalThis.__lcApi = {
    me: () => call("me"),
    syncProfile: (profile) => call("syncProfile", { profile }),
    syncSearch: (data) => call("syncSearch", data),
    nextJobs: (limit = 1) => call("nextJobs", { limit }),
    submitJobResult: (jobId, result) => call("submitJobResult", { jobId, result }),
  };
})();
