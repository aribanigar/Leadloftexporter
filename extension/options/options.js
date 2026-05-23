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
  apiUrl: "http://localhost:8000",
  apiKey: "",
  enabled: true,
  autopilot: false,
  showOverlay: true,
  autoSaveOnOpen: true,
  autoEnrichOnSave: true,
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
  // Auto-apply: Gemini AI fallback (Option B)
  aiEnabled: false,
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
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

async function testGemini() {
  setGeminiStatus("Checking…");
  const key = $("#geminiApiKey").value.trim();
  const model = $("#geminiModel").value.trim() || "gemini-2.0-flash";
  if (!key) {
    setGeminiStatus("Add a Gemini API key first.", "err");
    return;
  }
  // Ensure host permission for the Gemini endpoint so the service worker can fetch it.
  try {
    const origin = "https://generativelanguage.googleapis.com/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) {
        setGeminiStatus("Browser blocked access to Gemini. Click Test again and approve the prompt.", "err");
        return;
      }
    }
  } catch (e) {
    setGeminiStatus("Couldn't request permission: " + (e.message || e), "err");
    return;
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Reply with the single word: OK" }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      setGeminiStatus(`Gemini rejected (${res.status}). ${t.slice(0, 160)}`, "err");
      return;
    }
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    setGeminiStatus(reply ? `Gemini connected ✓ (replied: ${reply.slice(0, 40)})` : "Gemini connected ✓", "ok");
  } catch (err) {
    setGeminiStatus(err.message || "Failed to reach Gemini.", "err");
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
    geminiApiKey: $("#geminiApiKey").value.trim(),
    geminiModel: $("#geminiModel").value.trim() || "gemini-2.0-flash",
    cvText: $("#cvText").value,
  });
  // Pre-request Gemini host permission if AI is enabled so the SW can fetch later.
  if ($("#aiEnabled").checked && $("#geminiApiKey").value.trim()) {
    try {
      await chrome.permissions.request({ origins: ["https://generativelanguage.googleapis.com/*"] });
    } catch {}
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

  // Gemini AI (Option B)
  $("#aiEnabled").checked = !!settings.aiEnabled;
  $("#geminiApiKey").value = settings.geminiApiKey || "";
  $("#geminiModel").value = settings.geminiModel || "gemini-2.0-flash";
  $("#cvText").value = settings.cvText || "";

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
}

document.addEventListener("DOMContentLoaded", init);
