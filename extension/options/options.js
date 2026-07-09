/* eslint-disable no-undef */
const $ = (s) => document.querySelector(s);

// Pre-seeded CV so Gemini auto-answers work out of the box. The user can
// replace this in the textarea at any time.
const DEFAULT_CV = `TODD SANTNER
Business Growth & Marketing Strategist | Program Manager | Digital Transformation Leader
Email: access.toddproject@gmail.com
LinkedIn: linkedin.com/in/todd-santner

PROFESSIONAL SUMMARY
Results-driven Business Growth & Marketing Strategist and Program Manager with 9+ years of cross-functional experience spanning strategic marketing, digital transformation, program management, and revenue operations across global markets including the GCC and APAC regions. Proven track record of delivering measurable ROI through performance marketing, high-impact content creation, vendor lifecycle management, and data-driven decision-making. Certified in Agile Project Management, SEO, Marketing Analytics, and AI Foundations.

KEY ACHIEVEMENTS
- Delivered $4M+ in incremental revenue through strategic advertiser engagement programs at Meta (APAC)
- Architected the Escalation Elites program, unlocking $65M in revenue recovery across APAC markets
- Improved client retention by 6-10% at Gartner through data-driven service strategy and segmentation
- Saved 40+ hours weekly via workflow automation and Power BI dashboards
- Founded and scaled AlDhaheriya Marketing, driving growth for SME clients
- Led 20+ integrated marketing campaigns achieving 4,000+ views in the first month

EXPERIENCE
Business Development Manager & Founder | AlDhaheriya Marketing | Oct 2023 - Present | Riyadh, Saudi Arabia
Program Manager - SBG, APAC | Meta | Jun 2023 - Aug 2025 | India
Principal/Senior Associate - Service Strategy | Gartner | May 2019 - Jun 2023 | Gurgaon, India
Business Associate | Asahi India Glass Limited | Sep 2016 - Apr 2019 | Gurgaon, India
Team Lead - Digital Marketing | InstaLively (acquired by Hike) | 2015 | New Delhi, India

CORE COMPETENCIES
Strategic Marketing, Performance Marketing, Content Strategy & Production, Brand Development, SEO & Digital Advertising, Campaign Management, Program Management, Agile & Waterfall, Sprint Planning, Vendor Lifecycle Management, Cross-functional Leadership, Strategic Partnerships, Data & Analytics, Power BI & Tableau, SQL, Excel/VBA, Business Intelligence, KPI Monitoring, Marketing Analytics

EDUCATION
Digital Marketing | Indian School of Business | 2019-2020
Business Analytics 360 (Excel, VBA, Tableau, SQL) | AnalytixLabs | 2019
Economics Honours | Delhi University | 2013-2016

CERTIFICATIONS
Marketing and Customer Analytics - Wharton/Coursera; SEO Certified; Trusted AI Foundations; Agile Project Management - PRINCE2; Asana Workflow Certification

TOOLS
Power BI, Tableau, Google Analytics, SQL, Excel/VBA, Meta Ads Manager, Google Ads, LinkedIn Ads`;

const DEFAULTS = {
  apiUrl: "https://leadloftexporter.onrender.com",
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
    fullName: "Todd Santner",
    email: "access.toddproject@gmail.com",
    phone: "",
    city: "Riyadh",
    country: "Saudi Arabia",
    years: "9",
    notice: "1 month",
    expectedSalary: "",
    currentSalary: "",
    workAuth: "Yes",
    sponsorship: "No",
    relocate: "Yes",
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
    applicationProfile: {
      fullName: $("#ap_fullName").value.trim(),
      email: $("#ap_email").value.trim(),
      phone: $("#ap_phone").value.trim(),
      city: $("#ap_city").value.trim(),
      country: $("#ap_country").value.trim(),
      years: $("#ap_years").value.trim(),
      notice: $("#ap_notice").value.trim(),
      expectedSalary: $("#ap_expectedSalary").value.trim(),
      currentSalary: $("#ap_currentSalary").value.trim(),
      workAuth: $("#ap_workAuth").value,
      sponsorship: $("#ap_sponsorship").value,
      relocate: $("#ap_relocate").value,
    },
    aiEnabled: $("#aiEnabled").checked,
    aiProvider: $("#aiProvider").value,
    geminiApiKey: $("#geminiApiKey").value.trim(),
    geminiModel: $("#geminiModel").value.trim() || "gemini-2.5-flash",
    claudeApiKey: $("#claudeApiKey").value.trim(),
    claudeModel: $("#claudeModel").value.trim() || "claude-haiku-4-5-20251001",
    cvText: $("#cvText").value,
  });
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
  const ap = settings.applicationProfile || {};
  $("#ap_fullName").value = ap.fullName || "";
  $("#ap_email").value = ap.email || "";
  $("#ap_phone").value = ap.phone || "";
  $("#ap_city").value = ap.city || "";
  $("#ap_country").value = ap.country || "";
  $("#ap_years").value = ap.years || "";
  $("#ap_notice").value = ap.notice || "";
  $("#ap_expectedSalary").value = ap.expectedSalary || "";
  $("#ap_currentSalary").value = ap.currentSalary || "";
  $("#ap_workAuth").value = ap.workAuth || "Yes";
  $("#ap_sponsorship").value = ap.sponsorship || "No";
  $("#ap_relocate").value = ap.relocate || "Yes";

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
