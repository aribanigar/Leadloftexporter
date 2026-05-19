/* eslint-disable no-undef */
const $ = (s) => document.querySelector(s);

const DEFAULTS = {
  apiUrl: "http://localhost:8000",
  apiKey: "",
  enabled: true,
  autopilot: false,
  showOverlay: true,
  autoEnrichOnSave: true,
};

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULTS, settings || {});
}
async function save(patch) {
  const cur = await load();
  await chrome.storage.local.set({ settings: Object.assign({}, cur, patch) });
}

function setStatus(msg, level = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status " + level;
}

async function ensureHostPermission(apiUrl) {
  let origin;
  try {
    origin = new URL(apiUrl).origin + "/*";
  } catch {
    throw new Error("Backend URL is not a valid URL.");
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return;
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) {
    throw new Error(
      "Browser blocked access to " + origin + ". Click Save & verify again and approve the prompt."
    );
  }
}

async function testConnection() {
  setStatus("Checking…");
  const settings = await load();
  if (!settings.apiKey) {
    setStatus("Add an API key first.", "err");
    return;
  }
  try {
    await ensureHostPermission(settings.apiUrl);
    const res = await fetch(`${settings.apiUrl}/api/v1/extension/me`, {
      headers: { "X-API-Key": settings.apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setStatus(`Backend rejected (${res.status}). ${body.slice(0, 140)}`, "err");
      return;
    }
    const data = await res.json();
    setStatus(
      `Connected to ${data.workspace?.name || "workspace"} as ${data.user?.email}`,
      "ok"
    );
  } catch (err) {
    setStatus(err.message || "Failed to fetch — is the backend reachable?", "err");
  }
}

async function onSave() {
  await save({
    apiUrl: $("#apiUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("#apiKey").value.trim(),
    enabled: $("#enabled").checked,
    autopilot: $("#autopilot").checked,
    showOverlay: $("#showOverlay").checked,
    autoEnrichOnSave: $("#autoEnrichOnSave").checked,
  });
  await testConnection();
}

async function init() {
  const settings = await load();
  $("#apiUrl").value = settings.apiUrl;
  $("#apiKey").value = settings.apiKey;
  $("#enabled").checked = settings.enabled;
  $("#autopilot").checked = settings.autopilot;
  $("#showOverlay").checked = settings.showOverlay;
  $("#autoEnrichOnSave").checked = settings.autoEnrichOnSave !== false;
  $("#docs-link").href = `${settings.apiUrl.replace(/:8000$/, ":3000") || "http://localhost:3000"}/settings/api-keys`;

  $("#save").addEventListener("click", onSave);
  $("#test").addEventListener("click", testConnection);
  $("#toggle-show").addEventListener("click", () => {
    const inp = $("#apiKey");
    inp.type = inp.type === "password" ? "text" : "password";
    $("#toggle-show").textContent = inp.type === "password" ? "Show" : "Hide";
  });
}

document.addEventListener("DOMContentLoaded", init);
