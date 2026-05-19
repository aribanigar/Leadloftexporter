/* eslint-disable no-undef */
const $ = (sel) => document.querySelector(sel);

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign(
    { apiUrl: "http://localhost:8000", apiKey: "", enabled: true, autopilot: false, showOverlay: true },
    settings || {}
  );
}

async function saveSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: Object.assign({}, current, patch) });
}

function setStatus(msg, level = "") {
  const el = $("#status");
  el.textContent = msg || "";
  el.className = "status " + level;
}

function callApi(action, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "lc:api", action, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response?.data);
    });
  });
}

async function init() {
  const settings = await getSettings();
  $("#autopilot-toggle").checked = !!settings.autopilot;
  $("#autopilot-toggle").addEventListener("change", async (e) => {
    await saveSettings({ autopilot: e.target.checked });
    setStatus(e.target.checked ? "Autopilot on" : "Autopilot off", "ok");
  });

  $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#open-app").addEventListener("click", async () => {
    const s = await getSettings();
    const base = (s.apiUrl || "http://localhost:8000").replace(/\/api\/v1$/, "");
    const url = base.replace(/:8000$/, ":3000");
    chrome.tabs.create({ url });
  });

  $("#save-current").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/linkedin\.com/.test(tab.url || "")) {
      setStatus("Open a LinkedIn page first.", "err");
      return;
    }
    setStatus("Saving…");
    chrome.tabs.sendMessage(tab.id, { type: "lc:saveCurrent" }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, "err");
        return;
      }
      if (!response) return setStatus("No response from page. Refresh and retry.", "err");
      if (response.ok) {
        const counts = response.created != null ? `+${response.created} new, ${response.updated || 0} updated` : "Saved";
        setStatus(counts, "ok");
      } else {
        setStatus(response.error || "Failed", "err");
      }
    });
  });

  if (!settings.apiKey) {
    $("#status-badge").textContent = "Disconnected";
    $("#status-badge").classList.add("disconnected");
    setStatus("Add your API key in Options to start.");
    return;
  }
  try {
    const me = await callApi("me");
    $("#status-badge").textContent = "Connected";
    $("#status-badge").classList.add("connected");
    $("#me-section").hidden = false;
    $("#me-workspace").textContent = me.workspace?.name || "—";
    $("#me-user").textContent = me.user?.email || "—";
  } catch (err) {
    $("#status-badge").textContent = "Error";
    $("#status-badge").classList.add("disconnected");
    setStatus(err.message, "err");
  }
}

document.addEventListener("DOMContentLoaded", init);
