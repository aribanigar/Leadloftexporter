/* Service worker: proxies API calls between content scripts and the
 * LeadCaptura backend. We centralize HTTP here for three reasons:
 *   1. Content scripts run inside linkedin.com's origin; we don't want
 *      direct cross-origin fetches polluting LinkedIn's request graph.
 *   2. The same API client can be reused by the popup and options page.
 *   3. We can transparently refresh the API key from storage on every call.
 */

const DEFAULT_SETTINGS = {
  apiUrl: "http://localhost:8000",
  apiKey: "",
  enabled: true,
  autopilot: false,
  showOverlay: true,
};

// ---- Safe zones: limit how many enrichments we open per hour/day ----------

const SAFE_ZONES = {
  perHour: 250,  // burst ceiling — ~4/min sustained, allows quick batches
  perDay: 2000,  // daily cap
};

// In-memory mirror of the enrichment timestamps. The async chrome.storage
// read-modify-write in recordEnrich() races when 20 cards are clicked at
// once: every handler reads the same pre-record value and all pass the
// limit gate. Doing reserve+record synchronously in this in-memory array
// closes that window — the service worker is single-threaded, so an array
// push between two awaits cannot be interleaved by another handler.
const _enrichMem = { hourly: [], daily: [], loaded: false };

async function _hydrateEnrichMem() {
  if (_enrichMem.loaded) return;
  const { safeZone } = await chrome.storage.local.get("safeZone");
  // Double-check after the await: another handler may have hydrated AND
  // reserved while we were suspended. Overwriting would discard their
  // reservation, defeating the in-memory race fix.
  if (_enrichMem.loaded) return;
  const now = Date.now();
  _enrichMem.hourly = (safeZone?.hourly || []).filter((t) => now - t < 3_600_000);
  _enrichMem.daily = (safeZone?.daily || []).filter((t) => now - t < 86_400_000);
  _enrichMem.loaded = true;
}

async function canEnrich() {
  await _hydrateEnrichMem();
  const now = Date.now();
  _enrichMem.hourly = _enrichMem.hourly.filter((t) => now - t < 3_600_000);
  _enrichMem.daily = _enrichMem.daily.filter((t) => now - t < 86_400_000);
  if (_enrichMem.hourly.length >= SAFE_ZONES.perHour) return false;
  if (_enrichMem.daily.length >= SAFE_ZONES.perDay) return false;
  return true;
}

// Synchronous reserve: atomically increments the in-memory counters so a
// concurrent canEnrich call in the same task tick sees the reservation.
// Persistence to chrome.storage happens fire-and-forget afterwards.
function reserveEnrich() {
  const now = Date.now();
  _enrichMem.hourly.push(now);
  _enrichMem.daily.push(now);
  chrome.storage.local
    .set({ safeZone: { hourly: _enrichMem.hourly, daily: _enrichMem.daily } })
    .catch(() => { /* best-effort persist */ });
}

// Jittered delay: base range with 20% chance of "distracted user" extra pause
function jitter(minMs, maxMs) {
  const base = minMs + Math.random() * (maxMs - minMs);
  const bonus = Math.random() < 0.2 ? base * (0.4 + Math.random() * 0.8) : 0;
  return Math.round(base + bonus);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function fetchJson(path, opts = {}) {
  const { apiUrl, apiKey } = await getSettings();
  if (!apiUrl) throw new Error("API URL not configured.");
  if (!apiKey) throw new Error("API key not configured. Open the extension options.");
  const url = `${apiUrl}/api/v1${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // Network / DNS / CORS failure — fetch throws, never gets to .ok
    console.error("[LeadCaptura SW] fetch threw", { url, method: opts.method, error: e?.message });
    throw new Error(`Failed to fetch ${url}: ${e?.message || e}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    // Surface HTTP status alongside the server's message so the content
    // script's error decorator can map 401/403 etc. to actionable hints.
    const detail =
      (data && typeof data === "object" && data.detail) ||
      (typeof data === "string" && data) ||
      "";
    const message = `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
    console.error("[LeadCaptura SW] fetch !ok", { url, status: res.status, detail });
    throw new Error(message);
  }
  return data;
}

const handlers = {
  me: () => fetchJson("/extension/me"),
  options: () => fetchJson("/extension/options"),
  createSegment: ({ name }) =>
    fetchJson("/extension/segments", { method: "POST", body: { name } }),
  syncProfile: ({ profile }) =>
    fetchJson("/extension/sync/profile", { method: "POST", body: profile }),
  syncSearch: (body) => fetchJson("/extension/sync/search", { method: "POST", body }),
  enrollBatch: ({ playbook_id, lead_ids }) =>
    fetchJson("/extension/enroll", { method: "POST", body: { playbook_id, lead_ids } }),
  nextJobs: ({ limit }) => fetchJson(`/extension/jobs/next?limit=${limit || 1}`),
  submitJobResult: ({ jobId, result }) =>
    fetchJson(`/extension/jobs/${jobId}/result`, { method: "POST", body: result }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content scripts cannot call chrome.runtime.openOptionsPage; proxy it here.
  if (msg?.type === "lc:openOptions") {
    chrome.runtime.openOptionsPage(() => sendResponse({ ok: true }));
    return true;
  }
  // Run a click on "Send without a note" inside the PAGE's MAIN world.
  // Content scripts live in an isolated world; code injected via executeScript
  // with world:"MAIN" runs in the actual page context and can reach window.jQuery
  // and fire events that page-level handlers see as same-origin synthetic events.
  if (msg?.type === "lc:clickMainWorldSend") {
    const tabId = _sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab_id" }); return true; }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: () => {
          const all = Array.from(document.querySelectorAll("button,[role='button']"));
          const btn = all.find((b) => {
            const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            const a = (b.getAttribute("aria-label") || "").toLowerCase();
            return (
              /send without a note/i.test(t) ||
              /send without a note/i.test(a) ||
              t === "send now" || t === "send"
            );
          });
          if (!btn) return { found: false };

          // 1. React fiber traversal — most reliable from MAIN world because we
          //    have direct access to LinkedIn's React instance. Walk the fiber tree
          //    to find and call the onClick handler with a synthetic trusted event.
          try {
            const fKey = Object.keys(btn).find(
              (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
            );
            if (fKey) {
              let fiber = btn[fKey];
              for (let d = 0; fiber && d < 12; fiber = fiber.return, d++) {
                const onClick = fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
                if (typeof onClick === "function") {
                  onClick({
                    type: "click", bubbles: true, cancelable: true,
                    isTrusted: true, target: btn, currentTarget: btn,
                    preventDefault() {}, stopPropagation() {},
                    nativeEvent: { isTrusted: true },
                  });
                  break;
                }
              }
            }
          } catch (_) {}

          // 2. jQuery — LinkedIn may still use it for some interactions.
          if (window.jQuery || window.$) {
            try { (window.jQuery || window.$)(btn).trigger("click"); } catch (_) {}
          }

          // 3. Native prototype click — bypasses overridden element.click.
          HTMLElement.prototype.click.call(btn);

          // 4. Full pointer event sequence — closest to a real user click.
          try {
            const r = btn.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
            btn.dispatchEvent(new PointerEvent("pointerover", { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
            btn.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
            btn.dispatchEvent(new MouseEvent("mousedown", opts));
            btn.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse", buttons: 0 }));
            btn.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
            btn.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
          } catch (_) {}

          // 5. Form submission fallback.
          const form = btn.closest("form");
          if (form) {
            try { form.requestSubmit(btn); } catch (_) {
              try { form.submit(); } catch (_2) {}
            }
          }
          return { found: true };
        },
      },
      (results) => {
        sendResponse({ ok: true, result: results?.[0]?.result });
      }
    );
    return true;
  }
  // Open a profile in a background tab for contact-info enrichment.
  // Key improvements vs the old approach:
  //   1. Navigate directly to /overlay/contact-info/ so LinkedIn's SPA router
  //      pre-opens the modal — no button click needed in the content script.
  //   2. Check safe-zone rate limits before opening any tab.
  //   3. Jittered delay (0.8–4s, with 20% long-tail) so tabs don't open in
  //      rapid bursts which would look bot-like.
  if (msg?.type === "lc:enrichProfile") {
    const target = String(msg.url || "");
    if (!target) {
      sendResponse({ ok: false, error: "url_required" });
      return true;
    }
    (async () => {
      try {
        const allowed = await canEnrich();
        if (!allowed) {
          sendResponse({ ok: false, error: "safe_zone_limit_reached" });
          return;
        }
        // Reserve the slot synchronously NOW so concurrent handlers can't
        // all pass the canEnrich gate before any of them have recorded.
        // The persist to chrome.storage is fire-and-forget inside reserve.
        reserveEnrich();
        // Jittered delay before opening to avoid time-pattern detection
        await sleep(jitter(100, 400));
        // Navigate to the plain profile URL (NOT the /overlay/contact-info
        // sub-path) so the about/experience sections render normally — that
        // way the content script can both click Contact info AND scan the
        // visible profile text for email/phone patterns as a fallback.
        let enrichUrl = target;
        try {
          const u = new URL(target);
          u.searchParams.set("lc_enrich", "1");
          enrichUrl = u.toString();
        } catch {
          enrichUrl = target + (target.includes("?") ? "&" : "?") + "lc_enrich=1";
        }
        chrome.tabs.create({ url: enrichUrl, active: false }, (tab) => {
          sendResponse({ ok: true, tabId: tab?.id });
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // Hidden-iframe enrichment (no new tab) checks the rate limit through us.
  // We hold the counters in the service worker so all tabs share one budget;
  // the content script can't safely keep its own counter (different tabs
  // would each have their own). On allow, we reserve the slot synchronously
  // so concurrent clicks across tabs can't all sneak past the daily cap.
  if (msg?.type === "lc:reserveEnrich") {
    (async () => {
      try {
        const allowed = await canEnrich();
        if (!allowed) {
          sendResponse({ ok: false, error: "safe_zone_limit_reached" });
          return;
        }
        reserveEnrich();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // Open a LinkedIn profile in a tab and (optionally) wait for it to close.
  // Used by the per-card Save chip (foreground, fire-and-forget) and by the
  // "Save All Leads" bulk loop (background, awaits each tab's close so the
  // next profile only opens AFTER the current one finished enriching).
  //
  // Options:
  //   url           — required, the LinkedIn /in/ URL
  //   active        — true: foreground tab (user clicked one card)
  //                   false: background tab (silent bulk sequencer)
  //   awaitClose    — if true, sendResponse fires when the tab is removed
  //                   (the enrichment-trigger calls lc:closeMe on success)
  //   enrichFlag    — if true, append ?lc_enrich=1 so the content script
  //                   runs maybeRunEnrichmentTrigger() and self-closes
  if (msg?.type === "lc:openProfileTab") {
    const target = String(msg.url || "");
    if (!target) {
      sendResponse({ ok: false, error: "url_required" });
      return true;
    }
    const active = msg.active !== false;
    const awaitClose = !!msg.awaitClose;
    const includeEnrichFlag = !!msg.enrichFlag;
    (async () => {
      try {
        const allowed = await canEnrich();
        if (!allowed) {
          sendResponse({ ok: false, error: "safe_zone_limit_reached" });
          return;
        }
        reserveEnrich();
        // Small jittered open delay so 50 cards can't all spawn tabs in the
        // exact same millisecond. v1.0.23 aggressive cut → 80–300ms.
        await sleep(jitter(80, 300));
        let openUrl = target;
        if (includeEnrichFlag) {
          const seg = msg.segment ? String(msg.segment) : "";
          try {
            const u = new URL(target);
            u.searchParams.set("lc_enrich", "1");
            if (seg) u.searchParams.set("lc_segment", seg);
            openUrl = u.toString();
          } catch {
            openUrl = target + (target.includes("?") ? "&" : "?") + "lc_enrich=1" +
              (seg ? "&lc_segment=" + encodeURIComponent(seg) : "");
          }
        }
        chrome.tabs.create({ url: openUrl, active }, (tab) => {
          const tabId = tab?.id;
          if (!awaitClose) {
            sendResponse({ ok: true, tabId });
            return;
          }
          // Resolve when the tab closes (signals enrichment completed) OR
          // when the safety timeout fires (90s — generous for slow profiles).
          let resolved = false;
          const finish = (extra = {}) => {
            if (resolved) return;
            resolved = true;
            chrome.tabs.onRemoved.removeListener(onRemoved);
            clearTimeout(safetyTimer);
            sendResponse({ ok: true, tabId, ...extra });
          };
          const onRemoved = (closedId) => {
            if (closedId === tabId) finish();
          };
          chrome.tabs.onRemoved.addListener(onRemoved);
          const safetyTimer = setTimeout(() => {
            // If the tab is still open, force-close it so we don't pile up.
            // 22s ceiling: enough headroom for the worst-case pipeline
            // (8s h1 + 1s read + 8.5s contact-info polling + 4s margin) so
            // genuinely slow profiles don't report "Timed out", but short
            // enough that a single stuck profile can't stall the bulk run.
            try { chrome.tabs.remove(tabId); } catch {}
            finish({ timedOut: true });
          }, 22_000);
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // The enrichment-trigger content script asks us to close its own tab.
  if (msg?.type === "lc:closeMe") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) {
      chrome.tabs.remove(tabId, () => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }
  // Ask the configured AI provider (Gemini or Claude) to answer a single
  // Easy-Apply question using the stored CV. Routed through the SW so the
  // content script (linkedin.com origin) doesn't make the cross-origin call
  // itself, and the API key never touches the page.
  if (msg?.type === "lc:aiAnswer" || msg?.type === "lc:geminiAnswer") {
    (async () => {
      try {
        const s = await getSettings();
        const provider = s.aiProvider || "gemini";
        const q = String(msg.question || "").slice(0, 500);
        const kind = msg.kind || "text"; // text | number | select | radio
        const options = Array.isArray(msg.options) ? msg.options.filter(Boolean) : [];

        let instruction;
        if (kind === "select" || kind === "radio") {
          instruction =
            `Choose the single best option for this job-application question. ` +
            `Respond with EXACTLY one option copied verbatim from this list, nothing else:\n` +
            options.map((o) => `- ${o}`).join("\n");
        } else if (kind === "number") {
          instruction =
            `Answer this job-application question with ONLY a number (no words, no units, no symbols). ` +
            `If it asks years of experience, give a realistic integer based on the CV.`;
        } else {
          instruction =
            `Answer this job-application question concisely (a short phrase or a single value). ` +
            `Do not add explanations or quotation marks.`;
        }

        const profileLines = s.applicationProfile
          ? Object.entries(s.applicationProfile)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")
          : "";

        const prompt =
          `You are filling out a LinkedIn job application on behalf of a candidate. ` +
          `Use the candidate's CV and profile below to answer truthfully and favourably.\n\n` +
          `=== CANDIDATE PROFILE ===\n${profileLines}\n\n` +
          `=== CANDIDATE CV ===\n${String(s.cvText || "").slice(0, 8000)}\n\n` +
          `=== QUESTION ===\n${q}\n\n` +
          `=== INSTRUCTION ===\n${instruction}\n\nAnswer:`;

        let answer = "";
        if (provider === "claude") {
          if (!s.claudeApiKey) { sendResponse({ ok: false, error: "no_claude_key" }); return; }
          const model = s.claudeModel || "claude-haiku-4-5-20251001";
          let res;
          try {
            res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": s.claudeApiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
              },
              body: JSON.stringify({
                model,
                max_tokens: 80,
                messages: [{ role: "user", content: prompt }],
              }),
            });
          } catch (e) {
            sendResponse({ ok: false, error: `fetch_failed: ${e?.message || e}` });
            return;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => "");
            sendResponse({ ok: false, error: `claude_http_${res.status}: ${t.slice(0, 160)}` });
            return;
          }
          const data = await res.json();
          answer = (data?.content?.[0]?.text || "").trim();
        } else {
          if (!s.geminiApiKey) { sendResponse({ ok: false, error: "no_gemini_key" }); return; }
          const model = s.geminiModel || "gemini-2.0-flash";
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
          let res;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
              }),
            });
          } catch (e) {
            sendResponse({ ok: false, error: `fetch_failed: ${e?.message || e}` });
            return;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => "");
            sendResponse({ ok: false, error: `gemini_http_${res.status}: ${t.slice(0, 160)}` });
            return;
          }
          const data = await res.json();
          answer = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        }
        // Strip surrounding quotes the model sometimes adds
        answer = answer.replace(/^["'`]+|["'`]+$/g, "").trim();
        sendResponse({ ok: true, answer });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // Fetch company website(s) and extract contact info (emails, phones) from
  // the raw HTML. Strategies in priority order:
  //   1. JSON-LD schema.org (structured, most reliable)
  //   2. mailto: / tel: anchor href attributes
  //   3. <meta> og:email / og:phone_number
  //   4. Regex scan over full HTML text
  // Tries root URL, then /contact, /contact-us, /about, /about-us, /team,
  // /people, /our-team, /staff — stopping when ≥2 personal emails found.
  // Accepts an optional `extraUrls` array to scan additional origins (e.g.
  // when a LinkedIn profile links both a personal site and a company site).
  if (msg?.type === "lc:scrapeWebsite") {
    const rawUrl = String(msg.url || "").trim();
    const extraUrls = Array.isArray(msg.extraUrls)
      ? msg.extraUrls.map((u) => String(u || "").trim()).filter(Boolean)
      : [];
    if (!rawUrl) { sendResponse({ ok: false, error: "url_required" }); return true; }
    (async () => {
      try {
        const granted = await chrome.permissions.contains({
          origins: ["http://*/*", "https://*/*"],
        });
        if (!granted) { sendResponse({ ok: false, error: "needs_permission" }); return; }

        // Parse a raw HTML string and return { emails, phones } using the
        // highest-fidelity extraction methods available without a DOM parser.
        function _parseHtml(html) {
          const emails = new Set();
          const phones = new Set();
          const _addEmail = (e) => {
            e = (e || "").toLowerCase().trim();
            if (!e || /\.(png|jpg|gif|svg|css|js|woff|eot|ttf|otf)$/i.test(e)) return;
            if (/@(2x|webpack|babel|example\.|sentry|rollup)/i.test(e)) return;
            if (/noreply|no-reply|donotreply|unsubscribe/i.test(e)) return;
            emails.add(e);
          };
          const _addPhone = (p) => {
            const digits = (p || "").replace(/\D/g, "");
            if (digits.length >= 7 && digits.length <= 15) phones.add(p.trim());
          };

          // 1. JSON-LD schema.org — most structured
          const jlRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
          let jm;
          while ((jm = jlRe.exec(html)) !== null) {
            try {
              const walk = (obj) => {
                if (!obj || typeof obj !== "object") return;
                if (obj.email) _addEmail(obj.email);
                if (obj.telephone) _addPhone(obj.telephone);
                if (Array.isArray(obj)) obj.forEach(walk);
                else Object.values(obj).forEach(walk);
              };
              walk(JSON.parse(jm[1]));
            } catch {}
          }

          // 2. mailto: and tel: anchors — explicit, author-provided
          const mlRe = /href=["']mailto:([^"'?&#\s]+)/gi;
          let mm;
          while ((mm = mlRe.exec(html)) !== null) _addEmail(mm[1]);
          const tlRe = /href=["']tel:([+\d\s\-().]+)/gi;
          while ((mm = tlRe.exec(html)) !== null) _addPhone(mm[1]);

          // 3. Meta tags
          const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:email|og:phone_number|email)["'][^>]+content=["']([^"']+)["']/gi;
          while ((mm = metaRe.exec(html)) !== null) {
            const v = mm[1].trim();
            if (v.includes("@")) _addEmail(v);
            else _addPhone(v);
          }

          // 4. Regex fallback over full HTML
          const emailRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
          while ((mm = emailRe.exec(html)) !== null) _addEmail(mm[1]);

          // Contextual phone: digits following a phone-label word
          const phCtxRe = /(?:phone|tel|call|mobile|mob|ph|fax)[\s:–\-]+([+]?[\d][\d\s\-\(\).]{5,18}[\d])/gi;
          while ((mm = phCtxRe.exec(html)) !== null) _addPhone(mm[1]);
          // International bare format: +CC digits
          const phIntlRe = /\+\d{1,3}[\s\-]?\(?\d{2,4}\)?[\s\-]?\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{0,4}\b/g;
          while ((mm = phIntlRe.exec(html)) !== null) _addPhone(mm[0]);

          return { emails: [...emails], phones: [...phones] };
        }

        const allEmails = new Set();
        const allPhones = new Set();

        // Collect distinct origins: primary URL + any extra URLs from LinkedIn profile
        const origins = [];
        const seenOrigins = new Set();
        for (const u of [rawUrl, ...extraUrls]) {
          try {
            const orig = new URL(u).origin;
            if (!seenOrigins.has(orig)) { seenOrigins.add(orig); origins.push(orig); }
          } catch {}
        }

        const paths = [
          "", "/contact", "/contact-us", "/about", "/about-us",
          "/team", "/people", "/our-team", "/staff", "/directory",
        ];

        outer: for (const orig of origins) {
          for (const p of paths) {
            try {
              const res = await fetch(orig + p, {
                headers: {
                  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                  "User-Agent": "Mozilla/5.0 (compatible; LeadCapturaBot/1.0)",
                },
                signal: AbortSignal.timeout(8000),
              });
              if (!res.ok) continue;
              const html = await res.text();
              const { emails, phones } = _parseHtml(html);
              emails.forEach((e) => allEmails.add(e));
              phones.forEach((p2) => allPhones.add(p2));
            } catch { continue; }
            if (allEmails.size >= 3) break outer; // enough personal emails
          }
          if (allEmails.size >= 3) break;
        }

        // Sort: personal emails (with a name in the local part) before generic ones
        const isGeneric = /^(info|hello|contact|support|admin|sales|team|help|enquir|enqui|hr|office|mail|web|media|press|pr|marketing|jobs|career|recruit)@/i;
        const emailArr = [...allEmails]
          .sort((a, b) => (isGeneric.test(a) ? 1 : 0) - (isGeneric.test(b) ? 1 : 0))
          .slice(0, 5);
        const phoneArr = [...allPhones].slice(0, 3);

        sendResponse({ ok: true, emails: emailArr, phones: phoneArr });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type !== "lc:api") return;
  const handler = handlers[msg.action];
  if (!handler) {
    sendResponse({ error: `Unknown action: ${msg.action}` });
    return;
  }
  Promise.resolve()
    .then(() => handler(msg.payload || {}))
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true; // async
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// Tiny periodic heartbeat to keep the worker alive while the user is on LI
chrome.alarms?.create("lc-heartbeat", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  // No-op: just ensures Chrome rouses the worker periodically.
});
