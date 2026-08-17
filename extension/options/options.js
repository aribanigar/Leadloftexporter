/* eslint-disable no-undef */
const $ = (s) => document.querySelector(s);

// Pre-seeded CV so Gemini auto-answers work out of the box. The user can
// replace this in the textarea at any time.
const DEFAULT_CV = "";

const DEFAULTS = {
  apiUrl: "https://leadloftexporter-1.onrender.com",
  apiKey: "lcx_o9Ku7iUTYTnq3jC23cbpZsA_sloQTkog9LuUeTRBX4E",
  enabled: true,
  autopilot: false,
  showOverlay: true,
  autoSaveOnOpen: true,
  autoEnrichOnSave: true,
  syncLinkedInMessages: false,
  webScrapeEnabled: true,
  // Auto-apply: pre-configured answers (Option A)
  applicationProfile: {
    fullName: "",
    email: "",
    phone: "",
    nationality: "",
    city: "",
    country: "",
    jobTitle: "",
    years: "",
    education: "",
    notice: "",
    languages: "",
    linkedin: "",
    website: "",
    expectedSalary: "",
    expectedCurrency: "",
    currentSalary: "",
    currentCurrency: "",
    workAuth: "Yes",
    sponsorship: "No",
    relocate: "Yes",
    visaStatus: "",
    drivingLicense: "",
    workMode: "",
    gender: "Prefer not to say",
  },
  // Auto-apply: AI fallback (Option B)
  aiEnabled: false,
  aiProvider: "gemini", // "gemini" | "claude"
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  claudeApiKey: "",
  claudeModel: "claude-haiku-4-5-20251001",
  cvText: DEFAULT_CV,
};

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = Object.assign({}, DEFAULTS, settings || {});
  // One-time cleanup: strip the old "Todd Santner" demo data if a previous
  // build stored it. Only fires on the exact sentinel values, so real user
  // data is never touched.
  const ap = merged.applicationProfile || {};
  if (ap.fullName === "Todd Santner" || ap.email === "access.toddproject@gmail.com") {
    merged.applicationProfile = Object.assign({}, DEFAULTS.applicationProfile, {
      workAuth: ap.workAuth || "Yes",
      sponsorship: ap.sponsorship || "No",
      relocate: ap.relocate || "Yes",
      gender: ap.gender || "Prefer not to say",
    });
  }
  if (typeof merged.cvText === "string" && /^\s*TODD SANTNER/.test(merged.cvText)) {
    merged.cvText = "";
  }
  return merged;
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

// A 5xx with an HTML body is almost always the HOSTING PROVIDER talking
// (Render/Fly/nginx error page), not the LeadCaptura backend — e.g. Render's
// "This service has been suspended by its owner" page. Dumping that raw
// markup into the status pill is unreadable, so pull out the page's own
// <title> (if any) and show a clean sentence instead. Returns "" when the
// body isn't HTML, so the caller falls back to its normal error text.
function describeHostErrorPage(status, bodyText) {
  const trimmed = String(bodyText || "").trim();
  if (!/^<!doctype html|^<html/i.test(trimmed)) return "";
  const title = (trimmed.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim();
  return title
    ? `Backend host says "${title}" (HTTP ${status}) — that's a message from the hosting provider, not the LeadCaptura app. Check the hosting dashboard (e.g. Render).`
    : `Backend returned an HTML error page (HTTP ${status}) instead of a response — likely a hosting-provider outage, not the app itself.`;
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
      const hostErrorMessage = describeHostErrorPage(res.status, body);
      setStatus(hostErrorMessage || `Backend rejected (${res.status}). ${body.slice(0, 140)}`, "err");
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

function setGeminiStatus(msg, level = "") {
  const el = $("#gemini-status");
  el.textContent = msg;
  el.className = "status " + level;
}

// Query Google for the models this key can actually use, then return them as
// short names ordered best-first. Google keeps removing older models for new
// keys, so the only reliable approach is to ask rather than hardcode a name.
// `prefer` (the user's saved model) is tried first if it's still available.
async function listGeminiModels(key, prefer) {
  let names = [];
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`
    );
    if (r.ok) {
      const d = await r.json();
      names = (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => (m.name || "").replace(/^models\//, ""))
        .filter(Boolean);
    }
  } catch {
    /* fall through to static list */
  }

  // Rank: flash-lite (cheapest) → flash → everything else; exclude preview/
  // experimental/vision-only/embedding variants which 404 or aren't chat models.
  const usable = names.filter((n) => !/embedding|aqa|vision|imagen|veo|tts|image-generation/i.test(n));
  const score = (n) => {
    let s = 0;
    if (/flash-lite/i.test(n)) s += 100;
    else if (/flash/i.test(n)) s += 80;
    else if (/pro/i.test(n)) s += 40;
    // Prefer higher version numbers (2.5 > 2.0 > 1.5)
    const v = parseFloat((n.match(/(\d+\.\d+)/) || [])[1] || "0");
    s += v * 5;
    if (/preview|exp|experimental/i.test(n)) s -= 30; // less stable
    return s;
  };
  const ranked = usable.sort((a, b) => score(b) - score(a));

  // Put the saved model first if it survived the cull.
  const ordered = [];
  if (prefer && ranked.includes(prefer)) ordered.push(prefer);
  for (const n of ranked) if (!ordered.includes(n)) ordered.push(n);

  // If listing failed entirely (network/permission), fall back to a static
  // best-guess list so Test can still attempt something.
  if (!ordered.length) {
    return ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
  }
  return ordered;
}

async function ensureAiPermission(provider) {
  const origin =
    provider === "claude"
      ? "https://api.anthropic.com/*"
      : "https://generativelanguage.googleapis.com/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return await chrome.permissions.request({ origins: [origin] });
}

async function testGemini() {
  setGeminiStatus("Checking…");
  const provider = $("#aiProvider").value;
  try {
    const ok = await ensureAiPermission(provider);
    if (!ok) {
      setGeminiStatus("Browser blocked access. Click Test again and approve the prompt.", "err");
      return;
    }
  } catch (e) {
    setGeminiStatus("Couldn't request permission: " + (e.message || e), "err");
    return;
  }

  try {
    if (provider === "claude") {
      const key = $("#claudeApiKey").value.trim();
      const model = $("#claudeModel").value.trim() || "claude-haiku-4-5-20251001";
      if (!key) { setGeminiStatus("Add a Claude API key first.", "err"); return; }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setGeminiStatus(`Claude rejected (${res.status}). ${t.slice(0, 160)}`, "err");
        return;
      }
      const data = await res.json();
      const reply = (data?.content?.[0]?.text || "").trim();
      setGeminiStatus(reply ? `Claude connected ✓ (replied: ${reply.slice(0, 40)})` : "Claude connected ✓", "ok");
    } else {
      const key = $("#geminiApiKey").value.trim();
      const saved = $("#geminiModel").value.trim();
      if (!key) { setGeminiStatus("Add a Gemini API key first.", "err"); return; }

      const _callGemini = async (m) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Reply with the single word: OK" }] }],
            generationConfig: { maxOutputTokens: 10, temperature: 0 },
          }),
        });
      };

      // Ask Google which models THIS key can actually use, instead of guessing
      // names that Google keeps deprecating. Returns short names that support
      // generateContent (e.g. "gemini-2.5-flash"). [] if the listing fails.
      const candidates = await listGeminiModels(key, saved);
      if (!candidates.length) {
        setGeminiStatus("This API key has no usable models. Check the key is valid and that the Generative Language API is enabled in your Google Cloud project.", "err");
        return;
      }

      // Try each candidate until one responds OK. 404 (deprecated) / 429 (quota)
      // → move to the next; any other error (401 bad key, etc.) → stop and show it.
      let res = null, working = null, lastStatus = 0, lastText = "";
      for (const m of candidates) {
        setGeminiStatus(`Testing ${m}…`);
        res = await _callGemini(m);
        lastStatus = res.status;
        if (res.ok) { working = m; break; }
        if (res.status !== 404 && res.status !== 429) {
          lastText = await res.text().catch(() => "");
          break;
        }
      }

      if (!working) {
        const hint = lastStatus === 429
          ? "All available models are over quota. Enable billing on your Google Cloud project at console.cloud.google.com, or try again later."
          : lastStatus === 401 || lastStatus === 403
          ? "API key rejected. Generate a fresh key at aistudio.google.com/app/apikey and make sure the Generative Language API is enabled."
          : `Gemini rejected (${lastStatus}). ${lastText.slice(0, 120)}`;
        setGeminiStatus(hint, "err");
        return;
      }

      // Lock in the model that actually works so future calls skip discovery.
      $("#geminiModel").value = working;
      await save({ geminiModel: working });
      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      setGeminiStatus(reply ? `Gemini connected ✓ using ${working} (replied: ${reply.slice(0, 40)})` : `Gemini connected ✓ using ${working}`, "ok");
    }
  } catch (err) {
    setGeminiStatus(err.message || "Failed to reach the AI provider.", "err");
  }
}

function syncAiFields() {
  const provider = $("#aiProvider").value;
  $("#gemini-fields").style.display = provider === "gemini" ? "" : "none";
  $("#claude-fields").style.display = provider === "claude" ? "" : "none";
}

// Currency options for the salary fields — Gulf + Europe + common. First entry
// is a blank placeholder so no currency is assumed until the user picks one.
const CURRENCIES = [
  ["", "—"],
  ["SAR", "SAR — Saudi Riyal"], ["AED", "AED — UAE Dirham"], ["QAR", "QAR — Qatari Riyal"],
  ["KWD", "KWD — Kuwaiti Dinar"], ["BHD", "BHD — Bahraini Dinar"], ["OMR", "OMR — Omani Rial"],
  ["EUR", "EUR — Euro"], ["GBP", "GBP — British Pound"], ["CHF", "CHF — Swiss Franc"],
  ["SEK", "SEK — Swedish Krona"], ["NOK", "NOK — Norwegian Krone"], ["DKK", "DKK — Danish Krone"],
  ["PLN", "PLN — Polish Złoty"], ["USD", "USD — US Dollar"], ["EGP", "EGP — Egyptian Pound"],
  ["JOD", "JOD — Jordanian Dinar"], ["TRY", "TRY — Turkish Lira"], ["INR", "INR — Indian Rupee"],
];
function fillCurrencySelect(sel) {
  if (!sel || sel.options.length) return;
  for (const [val, label] of CURRENCIES) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    sel.appendChild(o);
  }
}

// Read every Application-profile field from the form into one object (UI names).
function collectApplicationProfile() {
  return {
    fullName: $("#ap_fullName").value.trim(),
    email: $("#ap_email").value.trim(),
    phone: $("#ap_phone").value.trim(),
    nationality: $("#ap_nationality").value.trim(),
    city: $("#ap_city").value.trim(),
    country: $("#ap_country").value.trim(),
    jobTitle: $("#ap_jobTitle").value.trim(),
    years: $("#ap_years").value.trim(),
    education: $("#ap_education").value,
    notice: $("#ap_notice").value.trim(),
    languages: $("#ap_languages").value.trim(),
    linkedin: $("#ap_linkedin").value.trim(),
    website: $("#ap_website").value.trim(),
    expectedSalary: $("#ap_expectedSalary").value.trim(),
    expectedCurrency: $("#ap_expectedCurrency").value,
    currentSalary: $("#ap_currentSalary").value.trim(),
    currentCurrency: $("#ap_currentCurrency").value,
    workAuth: $("#ap_workAuth").value,
    sponsorship: $("#ap_sponsorship").value,
    relocate: $("#ap_relocate").value,
    visaStatus: $("#ap_visaStatus").value,
    drivingLicense: $("#ap_drivingLicense").value,
    workMode: $("#ap_workMode").value,
    gender: $("#ap_gender").value,
  };
}

// Mirror the Application-profile fields into the key the auto-apply engine
// actually reads (chrome.storage.local["lc_apply_profile"]), mapping the UI
// field names to the engine's field names. Without this the profile you fill
// here never reaches the LinkedIn auto-apply autofill. Additive — writes its
// own key and never touches `settings` or any integration.
async function syncApplyProfileToEngine() {
  const a = collectApplicationProfile();
  const p = {
    full_name: a.fullName,
    email: a.email,
    phone: a.phone,
    nationality: a.nationality,
    city: a.city,
    country: a.country,
    current_title: a.jobTitle,
    years_of_experience: a.years,
    years_in_role: a.years,
    education: a.education,
    notice_period_days: a.notice,
    languages: a.languages,
    linkedin_url: a.linkedin,
    website: a.website,
    portfolio_url: a.website,
    expected_salary: a.expectedSalary,
    expected_salary_currency: a.expectedCurrency,
    current_salary: a.currentSalary,
    current_salary_currency: a.currentCurrency,
    authorized_to_work: a.workAuth,
    require_sponsorship: a.sponsorship,
    willing_to_relocate: a.relocate,
    visa_status: a.visaStatus,
    driving_license: a.drivingLicense,
    work_mode: a.workMode,
    gender: a.gender,
  };
  try { await chrome.storage.local.set({ lc_apply_profile: p }); } catch (_) {}
}

// Save ONLY the Application profile (used by the card's own Save button) —
// persists to settings + syncs to the engine, without the connection test or
// permission prompts that the top-level Save runs. Touches no integration.
async function saveApplicationProfileOnly() {
  const el = $("#ap_status");
  try {
    await save({ applicationProfile: collectApplicationProfile() });
    await syncApplyProfileToEngine();
    if (el) { el.textContent = "Profile saved ✓ — auto-apply will use these answers."; el.className = "status ok"; }
  } catch (e) {
    if (el) { el.textContent = "Couldn't save: " + (e.message || e); el.className = "status err"; }
  }
}

// Show how many questions the engine has memorised (in the profile card).
async function refreshMemoryCount() {
  const el = $("#ap_mem_count");
  if (!el) return;
  try {
    const { lc_learned_answers } = await chrome.storage.local.get("lc_learned_answers");
    const n = lc_learned_answers && typeof lc_learned_answers === "object"
      ? Object.keys(lc_learned_answers).length : 0;
    el.textContent = n
      ? `It currently remembers ${n} answer${n === 1 ? "" : "s"}.`
      : "It hasn't learned any answers yet.";
  } catch (_) { el.textContent = ""; }
}

// Clear the learned-answers memory on demand. Keeps the API key, settings, and
// the application profile above — only the auto-learned Q&A is wiped, and the
// engine picks it up live via the chrome.storage.onChanged listener, then
// re-learns from scratch as new questions are answered.
async function resetLearnedAnswers() {
  const el = $("#ap_status");
  try {
    await chrome.storage.local.remove("lc_learned_answers");
    await refreshMemoryCount();
    if (el) { el.textContent = "Learned answers cleared ✓ — the engine will re-learn as you apply."; el.className = "status ok"; }
  } catch (e) {
    if (el) { el.textContent = "Couldn't reset: " + (e.message || e); el.className = "status err"; }
  }
}

async function onSave() {
  await save({
    apiUrl: $("#apiUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("#apiKey").value.trim(),
    enabled: $("#enabled").checked,
    autopilot: $("#autopilot").checked,
    showOverlay: $("#showOverlay").checked,
    autoSaveOnOpen: $("#autoSaveOnOpen").checked,
    autoEnrichOnSave: $("#autoEnrichOnSave").checked,
    syncLinkedInMessages: $("#syncLinkedInMessages").checked,
    webScrapeEnabled: $("#webScrapeEnabled").checked,
    applicationProfile: collectApplicationProfile(),
    aiEnabled: $("#aiEnabled").checked,
    aiProvider: $("#aiProvider").value,
    geminiApiKey: $("#geminiApiKey").value.trim(),
    geminiModel: $("#geminiModel").value.trim() || "gemini-2.5-flash",
    claudeApiKey: $("#claudeApiKey").value.trim(),
    claudeModel: $("#claudeModel").value.trim() || "claude-haiku-4-5-20251001",
    cvText: $("#cvText").value,
  });
  // Push the profile into the engine's key so LinkedIn auto-apply uses it.
  await syncApplyProfileToEngine();
  // Pre-request the AI host permission if AI is enabled so the SW can fetch later.
  if ($("#aiEnabled").checked) {
    try { await ensureAiPermission($("#aiProvider").value); } catch {}
  }
  // Request broad host permission for website scraping when the toggle is on.
  if ($("#webScrapeEnabled").checked) {
    const el = document.getElementById("web-scrape-status");
    try {
      const already = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
      if (!already) {
        const ok = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
        if (!ok) {
          el.textContent = "Permission denied — website scraping disabled.";
          el.className = "status err";
          await save({ webScrapeEnabled: false });
          $("#webScrapeEnabled").checked = false;
        } else {
          el.textContent = "Permission granted ✓";
          el.className = "status ok";
        }
      }
    } catch (e) {
      el.textContent = "Couldn't request permission: " + (e.message || e);
      el.className = "status err";
    }
  }
  await testConnection();
}

async function init() {
  const settings = await load();
  $("#apiUrl").value = settings.apiUrl;
  $("#apiKey").value = settings.apiKey;
  $("#enabled").checked = settings.enabled;
  $("#autopilot").checked = settings.autopilot;
  $("#showOverlay").checked = settings.showOverlay;
  $("#autoSaveOnOpen").checked = settings.autoSaveOnOpen !== false;
  $("#autoEnrichOnSave").checked = settings.autoEnrichOnSave !== false;
  $("#syncLinkedInMessages").checked = !!settings.syncLinkedInMessages;
  $("#webScrapeEnabled").checked = !!settings.webScrapeEnabled;
  $("#docs-link").href = `${settings.apiUrl.replace(/:8000$/, ":3000") || "http://localhost:3000"}/settings/api-keys`;

  // Application profile (Option A)
  fillCurrencySelect($("#ap_expectedCurrency"));
  fillCurrencySelect($("#ap_currentCurrency"));
  const ap = settings.applicationProfile || {};
  $("#ap_fullName").value = ap.fullName || "";
  $("#ap_email").value = ap.email || "";
  $("#ap_phone").value = ap.phone || "";
  $("#ap_nationality").value = ap.nationality || "";
  $("#ap_city").value = ap.city || "";
  $("#ap_country").value = ap.country || "";
  $("#ap_jobTitle").value = ap.jobTitle || "";
  $("#ap_years").value = ap.years || "";
  $("#ap_education").value = ap.education || "";
  $("#ap_notice").value = ap.notice || "";
  $("#ap_languages").value = ap.languages || "";
  $("#ap_linkedin").value = ap.linkedin || "";
  $("#ap_website").value = ap.website || "";
  $("#ap_expectedSalary").value = ap.expectedSalary || "";
  $("#ap_expectedCurrency").value = ap.expectedCurrency || "";
  $("#ap_currentSalary").value = ap.currentSalary || "";
  $("#ap_currentCurrency").value = ap.currentCurrency || "";
  $("#ap_workAuth").value = ap.workAuth || "Yes";
  $("#ap_sponsorship").value = ap.sponsorship || "No";
  $("#ap_relocate").value = ap.relocate || "Yes";
  $("#ap_visaStatus").value = ap.visaStatus || "";
  $("#ap_drivingLicense").value = ap.drivingLicense || "";
  $("#ap_workMode").value = ap.workMode || "";
  $("#ap_gender").value = ap.gender || "Prefer not to say";

  // AI (Option B)
  $("#aiEnabled").checked = !!settings.aiEnabled;
  $("#aiProvider").value = settings.aiProvider || "gemini";
  $("#geminiApiKey").value = settings.geminiApiKey || "";
  // Migrate deprecated models that Google has removed for new users.
  // Migrate models Google has removed for new users to a current default.
  // (Test will further auto-correct to whatever the key can actually use.)
  const _savedModel = settings.geminiModel || "gemini-2.5-flash";
  $("#geminiModel").value = /^gemini-(1\.5|2\.0)-/.test(_savedModel) ? "gemini-2.5-flash" : _savedModel;
  $("#claudeApiKey").value = settings.claudeApiKey || "";
  $("#claudeModel").value = settings.claudeModel || "claude-haiku-4-5-20251001";
  $("#cvText").value = settings.cvText || "";
  syncAiFields();

  $("#save").addEventListener("click", onSave);
  $("#ap_save").addEventListener("click", saveApplicationProfileOnly);
  $("#ap_reset_memory").addEventListener("click", resetLearnedAnswers);
  refreshMemoryCount();
  $("#test").addEventListener("click", testConnection);
  $("#test-gemini").addEventListener("click", testGemini);
  $("#toggle-show").addEventListener("click", () => {
    const inp = $("#apiKey");
    inp.type = inp.type === "password" ? "text" : "password";
    $("#toggle-show").textContent = inp.type === "password" ? "Show" : "Hide";
  });
  $("#toggle-gemini").addEventListener("click", () => {
    const inp = $("#geminiApiKey");
    inp.type = inp.type === "password" ? "text" : "password";
    $("#toggle-gemini").textContent = inp.type === "password" ? "Show" : "Hide";
  });
  $("#toggle-claude").addEventListener("click", () => {
    const inp = $("#claudeApiKey");
    inp.type = inp.type === "password" ? "text" : "password";
    $("#toggle-claude").textContent = inp.type === "password" ? "Show" : "Hide";
  });
  $("#aiProvider").addEventListener("change", syncAiFields);
}

document.addEventListener("DOMContentLoaded", init);
