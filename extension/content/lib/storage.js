/* eslint-disable no-undef */
// Shared chrome.storage helpers exposed on globalThis so other content scripts
// (loaded in the same isolated world) can call them without ESM.
//
// Every chrome.* call is wrapped because after an extension reload the OLD
// content scripts in already-open LinkedIn tabs still run on intervals
// (autopilot tick, decoration tick) — but their chrome.runtime references
// are now dead, throwing "Extension context invalidated". The chrome://
// extensions Errors panel fills with thousands of stack traces. We swallow
// the error and return sensible defaults so the stale content script
// no-ops quietly until the tab is reloaded.
(() => {
  if (globalThis.__lcStorage) return;

  const KEY_PREFIX = "leadcaptura:";

  const DEFAULTS = {
    apiUrl: "https://leadloftexporter.onrender.com",
    apiKey: "",
    licenseKey: "",
    enabled: true,
    // Autopilot defaults ON so bulk-message jobs the user just queued in the
    // CRM actually fire from their browser without an extra hidden toggle.
    // Users can still turn it off from the popup if they want manual control.
    autopilot: true,
    showOverlay: true,
    webScrapeEnabled: true,
  };

  function _runtimeAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function _safeGet(key) {
    if (!_runtimeAlive()) return {};
    try {
      return await chrome.storage.local.get(key);
    } catch {
      return {};
    }
  }

  async function _safeSet(obj) {
    if (!_runtimeAlive()) return;
    try {
      await chrome.storage.local.set(obj);
    } catch {
      /* swallow — stale content script after extension reload */
    }
  }

  const Storage = {
    async getSettings() {
      const { settings } = await _safeGet("settings");
      return Object.assign({}, DEFAULTS, settings || {});
    },
    async saveSettings(patch) {
      const current = await Storage.getSettings();
      const merged = Object.assign({}, current, patch);
      await _safeSet({ settings: merged });
      return merged;
    },
    async getCache(key) {
      const full = KEY_PREFIX + key;
      const result = await _safeGet(full);
      return result[full] ?? null;
    },
    async setCache(key, value) {
      const full = KEY_PREFIX + key;
      await _safeSet({ [full]: value });
    },
  };

  globalThis.__lcStorage = Storage;
})();
