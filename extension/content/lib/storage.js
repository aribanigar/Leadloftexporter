/* eslint-disable no-undef */
// Shared chrome.storage helpers exposed on globalThis so other content scripts
// (loaded in the same isolated world) can call them without ESM.
(() => {
  if (globalThis.__lcStorage) return;

  const KEY_PREFIX = "leadcaptura:";

  const Storage = {
    async getSettings() {
      const { settings } = await chrome.storage.local.get("settings");
      return Object.assign(
        {
          apiUrl: "http://localhost:8000",
          apiKey: "",
          enabled: true,
          autopilot: false, // do queued LI actions automatically when a LI tab is open
          showOverlay: true,
        },
        settings || {}
      );
    },
    async saveSettings(patch) {
      const current = await Storage.getSettings();
      const merged = Object.assign({}, current, patch);
      await chrome.storage.local.set({ settings: merged });
      return merged;
    },
    async getCache(key) {
      const full = KEY_PREFIX + key;
      const result = await chrome.storage.local.get(full);
      return result[full] ?? null;
    },
    async setCache(key, value) {
      const full = KEY_PREFIX + key;
      await chrome.storage.local.set({ [full]: value });
    },
  };

  globalThis.__lcStorage = Storage;
})();
