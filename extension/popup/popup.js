/* eslint-disable no-undef */
const $ = (sel) => document.querySelector(sel);

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign(
    { apiUrl: "https://leadloftexporter.onrender.com", apiKey: "", enabled: true, autopilot: false, showOverlay: true },
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

  $("#search-linkedin").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/search/results/people/" });
  });
  $("#search-sales-nav").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/sales/search/people" });
  });
  $("#search-jobs").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/jobs/search/" });
  });

  $("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#open-app").addEventListener("click", async () => {
    const s = await getSettings();
    const base = (s.apiUrl || "http://localhost:8000").replace(/\/api\/v1$/, "");
    const url = base.replace(/:8000$/, ":3000");
    chrome.tabs.create({ url });
  });

  // The same set of files the manifest auto-injects. Used to recover from
  // "Could not establish connection" — which happens when the LinkedIn tab
  // was open before the extension was loaded/reloaded.
  const CONTENT_FILES = [
    "content/lib/storage.js",
    "content/lib/human.js",
    "content/lib/api.js",
    "content/lib/dom.js",
    "content/scraper.js",
    "content/overlay.js",
    "content/automate.js",
    "content/main.js",
  ];

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ __error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve({ __error: e?.message || "send_failed" });
      }
    });
  }

  async function injectContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: CONTENT_FILES,
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/overlay.css"],
    });
    // Let IIFEs register their globals
    await new Promise((r) => setTimeout(r, 400));
  }

  $("#save-current").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/linkedin\.com/.test(tab.url || "")) {
      setStatus("Open a LinkedIn page first.", "err");
      return;
    }
    setStatus("Saving…");

    let response = await sendTabMessage(tab.id, { type: "lc:saveCurrent" });

    // If the content script is missing (stale tab / extension just reloaded),
    // inject the scripts on demand and retry once.
    const connErr = response?.__error || "";
    if (
      connErr.includes("Could not establish connection") ||
      connErr.includes("Receiving end does not exist") ||
      connErr.includes("message channel closed")
    ) {
      try {
        setStatus("Initializing on this tab…");
        await injectContentScript(tab.id);
        response = await sendTabMessage(tab.id, { type: "lc:saveCurrent" });
      } catch (e) {
        setStatus("Refresh the LinkedIn tab and try again.", "err");
        return;
      }
    }

    if (response?.__error) {
      setStatus("Refresh the LinkedIn tab and try again.", "err");
      return;
    }
    if (!response) {
      setStatus("No response from page. Refresh and retry.", "err");
      return;
    }
    if (response.ok) {
      const counts =
        response.created != null
          ? `+${response.created} new, ${response.updated || 0} updated`
          : "Saved ✓";
      setStatus(counts, "ok");
    } else {
      setStatus(response.error || "Failed", "err");
    }
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
