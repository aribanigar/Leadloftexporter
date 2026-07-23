/* eslint-disable no-undef */
const $ = (sel) => document.querySelector(sel);

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign(
    { apiUrl: "https://leadloftexporter.onrender.com", apiKey: "", enabled: true, autopilot: true, showOverlay: true },
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

// Numeric version compare: returns 1 if a > b, -1 if a < b, 0 if equal.
function cmpVersion(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || "0", 10), nb = parseInt(pb[i] || "0", 10);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Check the hosted version manifest and, if a newer build exists, reveal the
// "Update extension" banner. Purely additive + best-effort: any failure
// (offline, blocked) leaves the popup exactly as before. The download opens the
// versioned zip; the user unzips over the SAME folder and reloads — chrome
// keeps the extension ID (so chrome.storage.local: API key, settings, learned
// answers, application profile all persist).
const VERSION_MANIFEST_URL = "https://leadloftexporter.vercel.app/extension-version.json";

// Render the "Update available" card from a resolved {version, notes, zip}.
// Wires the Download button (opens the versioned zip) and the Restart button
// (chrome.runtime.reload() — reloads the freshly-unzipped files with NO trip to
// chrome://extensions). Idempotent: safe to call from both the instant
// storage prefill and the live network check.
let _updateRendered = false;
function renderUpdateCard(cur, info) {
  const latest = info && info.version;
  if (!latest || cmpVersion(latest, cur) <= 0) return;   // already up to date
  if (_updateRendered) return;
  _updateRendered = true;
  const zip = info.zip || "/leadcaptura-extension.zip";
  const zipUrl = /^https?:/i.test(zip) ? zip : ("https://leadloftexporter.vercel.app" + zip);
  const verEl = $("#update-ver");
  if (verEl) verEl.textContent = "v" + cur + " → v" + latest;
  const notesEl = $("#update-notes");
  if (notesEl && info.notes) { notesEl.textContent = info.notes; notesEl.hidden = false; }
  const sec = $("#update-section");
  if (sec) sec.hidden = false;
  const dl = $("#update-download");
  if (dl) dl.addEventListener("click", () => { chrome.tabs.create({ url: zipUrl }); });
  const restart = $("#update-restart");
  if (restart) restart.addEventListener("click", () => {
    // Reload the extension so Chrome re-reads the files the user just unzipped
    // over the folder. Data in chrome.storage.local (API key, settings, learned
    // answers) survives because the extension ID is unchanged.
    try { chrome.runtime.reload(); } catch (_) {}
  });
}

async function checkForUpdate() {
  const cur = chrome.runtime.getManifest().version;
  // 1) Instant prefill from what the background check already found — the card
  //    shows immediately, even offline, matching the toolbar badge.
  try {
    const { lc_update_available } = await chrome.storage.local.get("lc_update_available");
    if (lc_update_available) renderUpdateCard(cur, lc_update_available);
  } catch (_) {}
  // 2) Live check so an update published while the popup is open still appears.
  try {
    const res = await fetch(VERSION_MANIFEST_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    renderUpdateCard(cur, info);
  } catch (_) { /* offline / blocked — silently skip */ }
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
  checkForUpdate();   // fire-and-forget; shows the update banner if one exists

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
