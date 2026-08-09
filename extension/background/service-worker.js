/* Service worker: proxies API calls between content scripts and the
 * LeadCaptura backend. We centralize HTTP here for three reasons:
 *   1. Content scripts run inside linkedin.com's origin; we don't want
 *      direct cross-origin fetches polluting LinkedIn's request graph.
 *   2. The same API client can be reused by the popup and options page.
 *   3. We can transparently refresh the API key from storage on every call.
 */

const DEFAULT_SETTINGS = {
  apiUrl: "https://leadloftexporter-1.onrender.com",
  apiKey: "lcx_o9Ku7iUTYTnq3jC23cbpZsA_sloQTkog9LuUeTRBX4E",
  enabled: true,
  // Autopilot defaults ON so bulk-message / connect jobs queued from the CRM
  // start sending immediately when the user opens any LinkedIn tab. The popup
  // toggle still lets a user turn this off if they prefer manual mode.
  autopilot: true,
  showOverlay: true,
};

// ---- Safe zones: limit how many enrichments we open per hour/day ----------

const SAFE_ZONES = {
  perHour: 250,  // burst ceiling — ~4/min sustained, allows quick batches
  perDay: 2000,  // daily cap
};

// Per-tab capture of the enrichment trigger's actual syncProfile outcome.
// The lc:openProfileTab handler resolves on tab close, but tab close alone
// is NOT proof a save succeeded — main.js:maybeRunEnrichmentTrigger
// catches sync errors and closes anyway. Without this map, the bulk loop
// in overlay.js would mark "Saved ✓" for tabs whose syncProfile silently
// failed (Noora Al-Khori v1.0.291 bug — chip showed Saved, CRM was empty).
// The trigger posts lc:enrichResult right before close; we read it back
// in finish() and forward as syncOk / syncError to the bulk loop, which
// then has ground truth to decide whether to mark "Saved ✓" or fall back.
const _enrichResults = new Map(); // tabId -> { ok: bool, error: string|null }

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

// Close a tab safely. chrome.tabs.remove reports failures via
// chrome.runtime.lastError (NOT by throwing), so a bare try/catch never
// catches them — leaving "Unchecked runtime.lastError" in the extension
// Errors panel. The common failure is "Tabs cannot be edited right now
// (user may be dragging a tab)", which is transient: we retry a few times
// with a short backoff, reading lastError each time so it's never unchecked.
// Pin an enrichment tab so Chrome doesn't kill it while we're scraping.
// Chrome has TWO process-level powers over background tabs that the
// v1.0.304 visibility shim CAN'T defeat:
//   • autoDiscardable=true (default): Chrome can discard the tab entirely
//     to free memory — the page is killed; our content scripts vanish
//     mid-scrape and the tab returns nothing.
//   • Frozen state: after ~5 min hidden the tab is suspended (all JS
//     stops). Our tabs live 22-28s so freezing is rare, but Chrome's
//     Memory Saver can be more aggressive on low-memory machines.
// Flipping autoDiscardable=false on every enrichment tab tells Chrome
// "this one is in active use, keep it alive" — the cheapest and most
// reliable way to guarantee the page keeps running until WE close it.
// Errors are swallowed (chrome.runtime.lastError just read & discarded)
// because this is best-effort hardening, not a hard requirement.
function pinEnrichmentTab(tabId) {
  if (tabId == null) return;
  try {
    chrome.tabs.update(tabId, { autoDiscardable: false }, () => {
      void chrome.runtime.lastError; // swallow "no such tab" on already-closed
    });
  } catch (e) { /* best-effort */ }
}

// Force a backgrounded enrichment tab into the "active" web-lifecycle state.
// This defeats Chrome's THIRD throttling layer that the visibility shim and
// autoDiscardable=false can't touch: the C++ renderer-process scheduler.
// Even when the JS-level `document.hidden` says "visible," Chrome's
// scheduler still runs hidden-tab renderers at a fraction of foreground
// CPU. requestAnimationFrame, IntersectionObserver, fetch priority — all
// throttled at the OS process level. That's why bulk enrichment "only
// gets the name" until the user clicks the tab: clicking flips the
// renderer to active and the deferred React commits flood in.
//
// Page.setWebLifecycleState({state:"active"}) is the official Chrome
// DevTools Protocol command that overrides this — it tells the scheduler
// "treat this renderer as foreground even though it's hidden." The tab
// then runs at full CPU and hydrates the Contact info modal in
// milliseconds, not "whenever the user happens to click."
//
// We hold the `debugger` permission already (used elsewhere for the
// trusted Send-Without-Note click). The yellow "debugging this browser"
// infobar that Chrome shows only appears on the AFFECTED tab — and our
// enrichment tabs are background-only and self-close in ~22 s, so the
// user never actually sees it.
//
// Idempotent + best-effort: attach failures (DevTools already open on
// this tab, Chrome too old to support the command, etc.) are swallowed.
// The shim + autoDiscardable fallbacks still apply in those cases.
async function pinTabActive(tabId) {
  if (tabId == null) return;
  try {
    await new Promise((resolve, reject) => {
      try {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || "attach_failed"));
          resolve();
        });
      } catch (e) { reject(e); }
    });
  } catch (e) {
    // Couldn't attach — already attached (DevTools open) or permission
    // missing. Visibility shim + autoDiscardable still help.
    console.log("[LeadCaptura SW] pinTabActive: debugger.attach failed, falling back:", e?.message || e);
    return;
  }
  try {
    await new Promise((resolve) => {
      try {
        chrome.debugger.sendCommand(
          { tabId },
          "Page.setWebLifecycleState",
          { state: "active" },
          () => { void chrome.runtime.lastError; resolve(); }
        );
      } catch (e) { resolve(); }
    });
    // Belt-and-suspenders second command: make Chrome's scheduler treat
    // this renderer as a FOCUSED tab regardless of actual focus. This is
    // additive — if the command isn't supported or the previous attach
    // already failed, the callback's lastError is swallowed and nothing
    // changes. Cannot affect the scraper or any content-script logic.
    await new Promise((resolve) => {
      try {
        chrome.debugger.sendCommand(
          { tabId },
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          () => { void chrome.runtime.lastError; resolve(); }
        );
      } catch (e) { resolve(); }
    });
    console.log("[LeadCaptura SW] tab " + tabId + " pinned active+focused (no throttling)");
  } catch (e) { /* best-effort */ }
  // Do NOT detach here — detaching reverts the lifecycle state. Chrome
  // auto-detaches when the tab closes (which is the only exit path for
  // our enrichment tabs — they self-close via lc:closeMe).
}

function safeRemoveTab(tabId, done, attempt = 0) {
  if (tabId == null) { done?.(); return; }
  chrome.tabs.remove(tabId, () => {
    const err = chrome.runtime.lastError; // read to mark as handled
    if (err && attempt < 5 && /dragging|cannot be edited/i.test(err.message || "")) {
      setTimeout(() => safeRemoveTab(tabId, done, attempt + 1), 400 + attempt * 300);
      return;
    }
    done?.();
  });
}


async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

// Ask Google which models this API key can actually use (Google keeps
// deprecating model names for new keys, so hardcoding one is fragile).
// Returns short names that support generateContent, ranked best-first, with
// the user's saved model first if it's still available. Falls back to a
// static best-guess list if the listing call fails.
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
    /* fall through */
  }
  const usable = names.filter((n) => !/embedding|aqa|vision|imagen|veo|tts|image-generation/i.test(n));
  const score = (n) => {
    let s = 0;
    if (/flash-lite/i.test(n)) s += 100;
    else if (/flash/i.test(n)) s += 80;
    else if (/pro/i.test(n)) s += 40;
    const v = parseFloat((n.match(/(\d+\.\d+)/) || [])[1] || "0");
    s += v * 5;
    if (/preview|exp|experimental/i.test(n)) s -= 30;
    return s;
  };
  const ranked = usable.sort((a, b) => score(b) - score(a));
  const ordered = [];
  if (prefer && ranked.includes(prefer)) ordered.push(prefer);
  for (const n of ranked) if (!ordered.includes(n)) ordered.push(n);
  if (!ordered.length) {
    return ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
  }
  return ordered;
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
    console.log(`[LeadCaptura SW] fetch threw ${opts.method || "GET"} ${url} error="${e?.message || e}"`);
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
    const rawDetail =
      (data && typeof data === "object" && data.detail) ||
      (typeof data === "string" && data) ||
      "";
    // FastAPI 422 validation errors return detail as an array of {loc, msg, type}
    // objects. Stringifying via template literals yields "[object Object]"; pull
    // the human-readable .msg fields instead.
    const detail = Array.isArray(rawDetail)
      ? rawDetail.map((e) => e?.msg || JSON.stringify(e)).join("; ")
      : String(rawDetail || "");
    const message = `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
    console.log(`[LeadCaptura SW] fetch !ok ${url} status=${res.status} detail="${detail}"`);
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
  connectResult: ({ linkedin_url, action }) =>
    fetchJson("/extension/connect-result", { method: "POST", body: { linkedin_url, action } }),
  // Case #2 24h sent-log (backend-synced; see api/app/api/v1/extension.py).
  case2MessageSent: ({ linkedin_url }) =>
    fetchJson("/extension/case2-message-sent", { method: "POST", body: { linkedin_url } }),
  case2MessageSentList: ({ since_ms }) =>
    fetchJson(
      "/extension/case2-message-sent" +
        (since_ms ? `?since_ms=${encodeURIComponent(since_ms)}` : "")
    ),
  knownUrls: () => fetchJson("/extension/known-urls"),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content scripts cannot call chrome.runtime.openOptionsPage; proxy it here.
  if (msg?.type === "lc:openOptions") {
    chrome.runtime.openOptionsPage(() => sendResponse({ ok: true }));
    return true;
  }
  // Keep the mass-apply LinkedIn tab running at full speed while it's in the
  // background, so jobs keep applying when the user is on another tab. Reuses
  // pinTabActive() (chrome.debugger Page.setWebLifecycleState "active") — the
  // same mechanism the enrichment tabs already use. on:false detaches. Purely
  // additive: a new handler that touches no existing behaviour or integration.
  if (msg?.type === "lc:massApplyKeepAwake") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) {
      if (msg.on) { pinTabActive(tabId).catch(() => {}); }
      else {
        try { chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      }
    }
    sendResponse({ ok: true });
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

          // 1. React fiber traversal — defer via queueMicrotask so React's
          //    concurrent renderer doesn't throw error #418 ("component
          //    suspended while responding to synchronous input").
          try {
            const fKey = Object.keys(btn).find(
              (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
            );
            if (fKey) {
              let fiber = btn[fKey];
              for (let d = 0; fiber && d < 12; fiber = fiber.return, d++) {
                const onClick = fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
                if (typeof onClick === "function") {
                  const _oc = onClick, _btn = btn;
                  queueMicrotask(() => {
                    try {
                      _oc({
                        type: "click", bubbles: true, cancelable: true,
                        isTrusted: true, target: _btn, currentTarget: _btn,
                        preventDefault() {}, stopPropagation() {},
                        nativeEvent: { isTrusted: true },
                      });
                    } catch (_) {}
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

  // ── isTrusted-patch click ─────────────────────────────────────────────────
  //
  // A completely different mechanism from every other click path:
  //
  //   1. Inject MAIN-world code via chrome.scripting (CSP-immune).
  //   2. Temporarily REDEFINE Event.prototype.isTrusted's getter so it always
  //      returns true.
  //   3. While the patch is active, fire the entire click stack on the
  //      "Send without a note" button — `.click()`, full pointer/mouse event
  //      sequence, AND a direct React-fiber onClick call. ALL of them now
  //      report isTrusted=true to any handler that reads it.
  //   4. Restore the original isTrusted descriptor on the next tick.
  //
  // This bypasses LinkedIn's `if (!event.isTrusted) return` gate without
  // needing the chrome.debugger permission or any user gesture. It works for
  // synthetic events because the gate only LOOKS at `event.isTrusted`, which
  // is now lying to it.
  //
  // The patch window is intentionally tiny (≤ ~50ms inside this single
  // script execution) so it can't affect anything else on the page.
  if (msg?.type === "lc:isTrustedPatchClick") {
    const tabId = _sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab_id" }); return true; }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: () => {
          // Find the Send-without-a-note button.
          const all = Array.from(document.querySelectorAll("button,[role='button'],a[role='button']"));
          const btn = all.find((b) => {
            const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            const a = (b.getAttribute("aria-label") || "").toLowerCase();
            if (!/send without a note/i.test(t) && !/send without a note/i.test(a)) return false;
            const r = b.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const cs = getComputedStyle(b);
            if (cs.visibility === "hidden" || cs.display === "none") return false;
            return true;
          });
          if (!btn) return { found: false };

          // Save the original isTrusted descriptor so we can restore it.
          // It lives on Event.prototype as a configurable getter — we
          // intentionally don't delete the property after, we put the
          // original descriptor back.
          // NOTE: If LinkedIn has made isTrusted non-configurable, the
          // defineProperty below will throw — we catch it and still proceed
          // with the React-fiber direct call which uses a plain object event
          // (bypassing the native getter entirely).
          const origDesc =
            Object.getOwnPropertyDescriptor(Event.prototype, "isTrusted") || null;

          let _patchActive = false;
          const restore = () => {
            if (!_patchActive || !origDesc) return;
            try {
              Object.defineProperty(Event.prototype, "isTrusted", origDesc);
            } catch (_) {}
          };

          let clicked = false;
          try {
            // Patch the getter so EVERY event in this turn reports isTrusted=true.
            try {
              Object.defineProperty(Event.prototype, "isTrusted", {
                configurable: true,
                get() { return true; },
              });
              _patchActive = true;
            } catch (_patchErr) {
              // LinkedIn may have locked Event.prototype.isTrusted — proceed
              // without the patch; the React-fiber call below still works.
            }

            btn.scrollIntoView({ block: "center", inline: "center" });
            try { btn.focus(); } catch (_) {}

            // 1. Native .click().
            try { btn.click(); } catch (_) {}

            // 2. Full pointer/mouse event sequence at the button's centre.
            try {
              const r = btn.getBoundingClientRect();
              const cx = Math.round(r.left + r.width / 2);
              const cy = Math.round(r.top + r.height / 2);
              const base = {
                bubbles: true, cancelable: true, composed: true, view: window,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                button: 0, buttons: 1,
                pointerId: 1, pointerType: "mouse", isPrimary: true,
                pressure: 0.5,
              };
              btn.dispatchEvent(new PointerEvent("pointerover", base));
              btn.dispatchEvent(new PointerEvent("pointerenter", base));
              btn.dispatchEvent(new PointerEvent("pointerdown", base));
              btn.dispatchEvent(new MouseEvent("mousedown", base));
              btn.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
              btn.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
              btn.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
            } catch (_) {}

            // 3. React-fiber direct onClick call (handler reads .isTrusted on
            //    our SyntheticEvent shape; also Event.prototype is patched
            //    so any new Event it constructs reports trusted too).
            try {
              const fKey = Object.keys(btn).find(
                (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
              );
              if (fKey) {
                let fiber = btn[fKey];
                for (let d = 0; fiber && d < 16; fiber = fiber.return, d++) {
                  const oc =
                    fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
                  if (typeof oc === "function") {
                    try {
                      oc({
                        type: "click", bubbles: true, cancelable: true,
                        isTrusted: true, target: btn, currentTarget: btn,
                        preventDefault: () => {}, stopPropagation: () => {},
                        stopImmediatePropagation: () => {},
                        // Plain object for nativeEvent so .isTrusted is a real
                        // writable property — Object.assign on an actual Event
                        // silently fails because isTrusted is read-only there.
                        nativeEvent: {
                          isTrusted: true, type: "click",
                          bubbles: true, cancelable: true,
                          preventDefault() {}, stopPropagation() {},
                          stopImmediatePropagation() {},
                        },
                      });
                    } catch (_) {}
                    break;
                  }
                }
              }
            } catch (_) {}

            // 4. Form submit fallback — if the button is inside a form, ask
            //    the form to submit with `btn` as the submitter. requestSubmit
            //    fires a real submit event (now reported trusted).
            try {
              const f = btn.closest("form");
              if (f) {
                try { f.requestSubmit(btn); } catch (_) {
                  try { f.submit(); } catch (__) {}
                }
              }
            } catch (_) {}

            clicked = true;
          } finally {
            // Restore the prototype after the next microtask. We can't
            // restore synchronously here because some click handlers run
            // asynchronously (queueMicrotask / Promise.then) and we want
            // them to read isTrusted=true too.
            queueMicrotask(restore);
            setTimeout(restore, 0);
            setTimeout(restore, 50);
          }
          return { found: true, clicked };
        },
      },
      (results) => {
        sendResponse({ ok: true, result: results?.[0]?.result });
      }
    );
    return true;
  }

  // ── Trusted "Send without a note" click via the Chrome DevTools Protocol ──
  // The CSP-immune MAIN-world click above dispatches events with
  // isTrusted=false. LinkedIn's invitation modal handler rejects those in many
  // sessions — which is why the "Send without a note" step would stall and
  // require a manual user click.
  //
  // The fix: attach chrome.debugger to the tab and dispatch OS-level mouse
  // events via Input.dispatchMouseEvent. These arrive at the page with
  // isTrusted=true — the same flag a physical click sets — and LinkedIn
  // accepts them without question.
  //
  // Cost: the `debugger` permission, requested ONCE on the user's first
  // Connect All click in a content-script user gesture. If the user declines,
  // the call returns { ok:false, error:"no_permission" } and overlay.js falls
  // back to the spotlight + manual click path.
  if (msg?.type === "lc:trustedClickSendWithoutNote") {
    const tabId = _sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab_id" }); return true; }
    // debugger is now a required manifest permission — always available.
    (async () => {

      let attached = false;
      const detach = () => {
        if (!attached) return;
        try {
          chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
        } catch {}
        attached = false;
      };
      try {
        await new Promise((resolve, reject) => {
          chrome.debugger.attach({ tabId }, "1.3", () => {
            const err = chrome.runtime.lastError;
            // "Another debugger is already attached" → DevTools is open. In
            // that case we can't drive CDP. Fall back to the SW MAIN-world
            // path by returning a soft error.
            if (err && /already attached|cannot attach/i.test(err.message || "")) {
              return reject(new Error("debugger_busy"));
            }
            if (err) return reject(new Error(err.message || "attach_failed"));
            attached = true;
            resolve();
          });
        });

        // Find the button's centre coordinate inside the page. We do this via
        // Runtime.evaluate (which runs in the page world) rather than
        // chrome.scripting because we want the same CDP session that will
        // dispatch the click — keeps coords consistent if the page reflows.
        const evalResult = await new Promise((resolve, reject) => {
          chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `(()=>{
              const all = Array.from(document.querySelectorAll('button,[role="button"],a[role="button"]'));
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return null;
                const cs = getComputedStyle(el);
                if (cs.visibility === 'hidden' || cs.display === 'none') return null;
                return r;
              };
              const matches = (el) => {
                const t = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                const a = (el.getAttribute('aria-label') || '').toLowerCase();
                return /send without a note/i.test(t) || /send without a note/i.test(a);
              };
              for (const el of all) {
                if (!matches(el)) continue;
                const r = visible(el);
                if (!r) continue;
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
              return null;
            })()`,
            returnByValue: true,
            awaitPromise: false,
          }, (result) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(result);
          });
        });

        const coords = evalResult?.result?.value;
        if (!coords) { sendResponse({ ok: false, error: "button_not_found" }); return; }

        // Dispatch mousePressed + mouseReleased. These produce a real trusted
        // click on the page — same path a hardware mouse takes.
        for (const type of ["mousePressed", "mouseReleased"]) {
          await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
              type,
              x: coords.x,
              y: coords.y,
              button: "left",
              buttons: type === "mousePressed" ? 1 : 0,
              clickCount: 1,
            }, () => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve();
            });
          });
        }
        // Also focus + keyboard Enter for belt-and-suspenders: a keyboard-derived
        // click has isTrusted=true even when the handler stores the original getter.
        try {
          await new Promise((res) => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `(()=>{
              const btn = Array.from(document.querySelectorAll('button,[role="button"],a[role="button"]'))
                .find(b => /send without a note/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()) ||
                           /send without a note/i.test(b.getAttribute('aria-label')||''));
              if (btn) { btn.scrollIntoView({block:'center'}); btn.focus(); return true; }
              return false;
            })()`,
            returnByValue: true, awaitPromise: false,
          }, () => res()));
          await new Promise(r => setTimeout(r, 100));
          for (const kType of ["keyDown", "keyUp"]) {
            await new Promise((res) => chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: kType, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
              key: "Enter", code: "Enter", text: kType === "keyDown" ? "\r" : "", modifiers: 0,
            }, () => res()));
            await new Promise(r => setTimeout(r, 50));
          }
        } catch (_) {}
        sendResponse({ ok: true, clicked: true, x: coords.x, y: coords.y });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        detach();
      }
    })();
    return true;
  }

  // ── Keyboard Enter click via chrome.debugger ─────────────────────────────
  // Focus the "Send without a note" button and dispatch a keyboard Enter key.
  // A keyboard-derived click event is created by Chrome at the C++ level with
  // isTrusted=true — this is the most robust approach because it bypasses
  // BOTH the `if (!event.isTrusted) return` check AND any stored getter
  // references that would defeat the Event.prototype patch.
  if (msg?.type === "lc:debuggerKeyEnterClick") {
    const tabId = _sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab_id" }); return true; }
    // debugger is now a required manifest permission — always available.
    (async () => {
      let attached = false;
      const detach = () => {
        if (!attached) return;
        try { chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError); } catch {}
        attached = false;
      };
      try {
        await new Promise((res, rej) => chrome.debugger.attach({ tabId }, "1.3", () => {
          const e = chrome.runtime.lastError;
          if (e && /already attached|cannot attach/i.test(e.message || "")) return rej(new Error("debugger_busy"));
          if (e) return rej(new Error(e.message || "attach_failed"));
          attached = true; res();
        }));

        // Focus the button inside the page via Runtime.evaluate
        const focusResult = await new Promise((res) =>
          chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `(()=>{
              const all = Array.from(document.querySelectorAll('button,[role="button"],a[role="button"]'));
              const btn = all.find(b => {
                if (b.classList?.contains('lc-inline-save')) return false;
                const t = (b.textContent||'').replace(/\\s+/g,' ').trim();
                const a = b.getAttribute('aria-label')||'';
                return /send without a note/i.test(t) || /send without a note/i.test(a);
              });
              if (!btn) return false;
              btn.scrollIntoView({ block: 'center' });
              btn.focus();
              return true;
            })()`,
            returnByValue: true,
            awaitPromise: false,
          }, (r) => res(r))
        );

        if (!focusResult?.result?.value) {
          sendResponse({ ok: false, error: "button_not_found" });
          return;
        }

        // Small pause for focus to settle before key dispatch
        await new Promise((r) => setTimeout(r, 120));

        // Dispatch Enter keydown then keyup. Chrome synthesises a click event
        // on the focused button with isTrusted=true — same as a physical keyboard.
        for (const kType of ["keyDown", "keyUp"]) {
          await new Promise((res) =>
            chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: kType,
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
              key: "Enter",
              code: "Enter",
              text: kType === "keyDown" ? "\r" : "",
              modifiers: 0,
            }, () => res())
          );
          await new Promise((r) => setTimeout(r, 60));
        }

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        detach();
      }
    })();
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
          pinEnrichmentTab(tab?.id);
          pinTabActive(tab?.id);
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
          pinEnrichmentTab(tabId);
          pinTabActive(tabId);
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
            // Read the trigger's own outcome report. If we have one, surface
            // the truth (syncOk:true/false). If we have nothing (trigger
            // crashed, message never arrived, very old extension build),
            // syncOk:null tells the bulk loop to TREAT IT AS A FAILURE and
            // fall back. We never assume success on the absence of evidence.
            const er = _enrichResults.get(tabId);
            _enrichResults.delete(tabId);
            sendResponse({
              ok: true,
              tabId,
              syncOk: er ? er.ok : null,
              syncError: er?.error || null,
              ...extra,
            });
          };
          const onRemoved = (closedId) => {
            if (closedId === tabId) finish();
          };
          chrome.tabs.onRemoved.addListener(onRemoved);
          const safetyTimer = setTimeout(() => {
            // If the tab is still open, force-close it so we don't pile up.
            // 28s ceiling: enough headroom for the v1.0.290 / v1.0.291
            // pipeline (8s h1 + 1.2s read + 6s contact-info polling + 1.3s
            // pre/post-close settle + 3.6s confirmation-visible linger +
            // ~6s margin for website scrape) so genuinely slow profiles
            // don't report "Timed out", but short enough that a single
            // stuck profile can't stall the bulk run.
            safeRemoveTab(tabId);
            finish({ timedOut: true });
          }, 28_000);
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  // Enrichment trigger reports the actual syncProfile outcome from inside
  // the background tab just before it self-closes. We stash it keyed by
  // tabId so lc:openProfileTab's finish() can surface it as ground truth
  // to the bulk loop. Without this, the bulk loop trusts "tab closed" as
  // proof of save — which is the Noora Al-Khori bug (chip lies, CRM empty).
  if (msg?.type === "lc:enrichResult") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) {
      _enrichResults.set(tabId, {
        ok: !!msg.ok,
        error: msg.error ? String(msg.error).slice(0, 240) : null,
      });
    }
    sendResponse({ ok: true });
    return true;
  }
  // The enrichment-trigger content script asks us to close its own tab.
  if (msg?.type === "lc:closeMe") {
    const tabId = _sender?.tab?.id;
    if (tabId != null) {
      safeRemoveTab(tabId, () => sendResponse({ ok: true }));
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
          const _geminiCall = async (m) => {
            const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
            return fetch(u, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
              }),
            });
          };
          let usedModel = s.geminiModel || "gemini-2.5-flash";
          let res;
          try {
            res = await _geminiCall(usedModel);
            // 404 (model deprecated for new keys) or 429 (quota): ask Google
            // which models this key can actually use and try the best one.
            // Google keeps removing model names, so discovery is the only
            // reliable fix rather than guessing another hardcoded name.
            if (!res.ok && (res.status === 429 || res.status === 404)) {
              const models = await listGeminiModels(s.geminiApiKey, usedModel);
              for (const m of models) {
                if (m === usedModel) continue;
                res = await _geminiCall(m);
                if (res.ok) {
                  usedModel = m;
                  // Persist so subsequent answers skip discovery entirely.
                  try {
                    const cur = (await chrome.storage.local.get("settings")).settings || {};
                    chrome.storage.local.set({ settings: { ...cur, geminiModel: m } });
                  } catch {}
                  break;
                }
                if (res.status !== 404 && res.status !== 429) break;
              }
            }
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
  // Personalise a LinkedIn message for a specific profile using Claude or Gemini.
  // Called from overlay.js _resumeMessageRunIfActive when run.useAI is true.
  if (msg?.type === "lc:personalizeMessage") {
    (async () => {
      try {
        const s = await getSettings();
        const provider = s.aiProvider || "gemini";
        const template = String(msg.template || "").slice(0, 1000);
        const p = msg.profile || {};

        const name = (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "this person").trim();
        const firstName = (p.first_name || name.split(" ")[0] || "there").trim();
        const title = (p.title || "").trim();
        const company = (p.company_name || "").trim();
        const location = (p.location || "").trim();
        const summary = (p.summary || p.about || "").slice(0, 400).trim();

        const profileDesc = [
          `Name: ${name}`,
          title && `Job title: ${title}`,
          company && `Company: ${company}`,
          location && `Location: ${location}`,
          summary && `About: ${summary}`,
        ].filter(Boolean).join("\n");

        const prompt =
          `You are writing a personalized LinkedIn message on behalf of a sales professional.\n\n` +
          `RECIPIENT PROFILE:\n${profileDesc}\n\n` +
          `MESSAGE TEMPLATE (use as a starting point or inspiration):\n${template}\n\n` +
          `TASK: Write a short, natural LinkedIn message to ${firstName}. ` +
          `Keep it under 300 characters. Be genuine, not spammy. ` +
          `Reference something specific from their profile if possible. ` +
          `Do NOT add any preamble, labels, or quotes — output ONLY the message text itself.`;

        let message = "";
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
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }],
              }),
            });
          } catch (e) {
            sendResponse({ ok: false, error: `fetch_failed: ${e?.message || e}` }); return;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => "");
            sendResponse({ ok: false, error: `claude_http_${res.status}: ${t.slice(0, 160)}` }); return;
          }
          const data = await res.json();
          message = (data?.content?.[0]?.text || "").trim();
        } else {
          if (!s.geminiApiKey) { sendResponse({ ok: false, error: "no_gemini_key" }); return; }
          const model = s.geminiModel || "gemini-2.5-flash";
          let res;
          try {
            res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
                }),
              }
            );
          } catch (e) {
            sendResponse({ ok: false, error: `fetch_failed: ${e?.message || e}` }); return;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => "");
            sendResponse({ ok: false, error: `gemini_http_${res.status}: ${t.slice(0, 160)}` }); return;
          }
          const data = await res.json();
          message = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        }

        if (!message) { sendResponse({ ok: false, error: "empty_response" }); return; }
        sendResponse({ ok: true, message });
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
          const addresses = new Set();
          let companyName = null;
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
          const _addAddress = (a) => {
            a = (a || "").replace(/\s+/g, " ").trim();
            if (a.length >= 8 && a.length <= 200) addresses.add(a);
          };
          // Flatten a schema.org PostalAddress object into one line.
          const _addrFromObj = (a) => {
            if (!a) return;
            if (typeof a === "string") { _addAddress(a); return; }
            if (typeof a !== "object") return;
            const parts = [
              a.streetAddress, a.addressLocality, a.addressRegion,
              a.postalCode, a.addressCountry?.name || a.addressCountry,
            ].filter((x) => x && typeof x === "string");
            if (parts.length) _addAddress(parts.join(", "));
          };

          // 1. JSON-LD schema.org — most structured (email, phone, address, name)
          const jlRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
          let jm;
          while ((jm = jlRe.exec(html)) !== null) {
            try {
              const walk = (obj) => {
                if (!obj || typeof obj !== "object") return;
                if (obj.email) _addEmail(obj.email);
                if (obj.telephone) _addPhone(obj.telephone);
                if (obj.address) _addrFromObj(obj.address);
                // Organization / LocalBusiness name = the company name
                if (!companyName && obj.name && typeof obj.name === "string" &&
                    /Organization|LocalBusiness|Corporation|Company/i.test(String(obj["@type"] || ""))) {
                  companyName = obj.name.trim();
                }
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

          // 3. Meta tags (email/phone + og:site_name for company name)
          const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:email|og:phone_number|email)["'][^>]+content=["']([^"']+)["']/gi;
          while ((mm = metaRe.exec(html)) !== null) {
            const v = mm[1].trim();
            if (v.includes("@")) _addEmail(v);
            else _addPhone(v);
          }
          if (!companyName) {
            const siteName = /<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html);
            if (siteName) companyName = siteName[1].trim();
          }
          if (!companyName) {
            const title = /<title[^>]*>([^<]{2,80})<\/title>/i.exec(html);
            if (title) companyName = title[1].split(/[|\-–—:]/)[0].trim() || null;
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

          // Contextual address: text following an "Address"/"Location"/"Find us" label.
          const addrCtxRe = /(?:address|location|find us|visit us|our office|headquarters|head office)[\s:–\-]*<?[^>]*>?\s*([A-Za-z0-9][^<\n]{10,160}?\d{3,}[^<\n]{0,40})/gi;
          while ((mm = addrCtxRe.exec(html)) !== null) {
            _addAddress(mm[1].replace(/<[^>]+>/g, " "));
          }

          return {
            emails: [...emails],
            phones: [...phones],
            addresses: [...addresses],
            name: companyName || null,
          };
        }

        const allEmails = new Set();
        const allPhones = new Set();
        const allAddresses = new Set();
        let scrapedName = null;

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
              const { emails, phones, addresses, name } = _parseHtml(html);
              emails.forEach((e) => allEmails.add(e));
              phones.forEach((p2) => allPhones.add(p2));
              addresses.forEach((a) => allAddresses.add(a));
              if (!scrapedName && name) scrapedName = name;
            } catch { continue; }
            // Stop once we have enough emails AND at least one address — we want
            // location too now, not just contact emails.
            if (allEmails.size >= 3 && allAddresses.size >= 1) break outer;
          }
          if (allEmails.size >= 3 && allAddresses.size >= 1) break;
        }

        // Sort: personal emails (with a name in the local part) before generic ones
        const isGeneric = /^(info|hello|contact|support|admin|sales|team|help|enquir|enqui|hr|office|mail|web|media|press|pr|marketing|jobs|career|recruit)@/i;
        const emailArr = [...allEmails]
          .sort((a, b) => (isGeneric.test(a) ? 1 : 0) - (isGeneric.test(b) ? 1 : 0))
          .slice(0, 5);
        const phoneArr = [...allPhones].slice(0, 3);
        const addressArr = [...allAddresses].slice(0, 3);

        sendResponse({
          ok: true,
          emails: emailArr,
          phones: phoneArr,
          addresses: addressArr,
          location: addressArr[0] || null,
          name: scrapedName || null,
        });
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

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  // One-time migration to v1.0.141+: pre-existing users had autopilot
  // defaulted OFF in v1.0.140 and earlier. Without this flip, the CRM's bulk
  // "Send to N leads" button queued jobs that nothing ever claimed — the
  // progress bar sat at "0 sent · N in progress" indefinitely. Flip it ON
  // once for every install/update so the next time the user has a LinkedIn
  // tab open, queued messages start flowing. Users who explicitly want
  // manual control can still toggle it back off in the popup.
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && settings.autopilot === false && !settings.lcAutopilotMigratedToOn) {
      await chrome.storage.local.set({
        settings: { ...settings, autopilot: true, lcAutopilotMigratedToOn: true },
      });
    } else if (settings && !settings.lcAutopilotMigratedToOn) {
      // Mark migration done even when already-true to avoid re-running.
      await chrome.storage.local.set({
        settings: { ...settings, lcAutopilotMigratedToOn: true },
      });
    }
  } catch {}

  // One-time migration: rotate the OLD pre-set default workspace API key over
  // to the new one. Pre-existing installs cached the old default in
  // chrome.storage.local on first save, which then wins the merge over
  // DEFAULTS forever — so just bumping DEFAULTS.apiKey only helps fresh
  // installs. This flips any storage that's still on the old default value;
  // a user who pasted their OWN generated key is left untouched (their key
  // doesn't match the old default, so it stays).
  try {
    const KNOWN_OLD_DEFAULTS = new Set([
      "lcx_lqpLWLIgFoMLKCTs7-Xj38dKp9QCe2BG60BQ5N59Uo8",
    ]);
    const NEW_DEFAULT = "lcx_o9Ku7iUTYTnq3jC23cbpZsA_sloQTkog9LuUeTRBX4E";
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && KNOWN_OLD_DEFAULTS.has(settings.apiKey)) {
      await chrome.storage.local.set({
        settings: { ...settings, apiKey: NEW_DEFAULT },
      });
    }
  } catch {}

  // One-time wipe of the poisoned "already-contacted" URL cache. v1.0.291
  // marked URLs as contacted purely on enrichment-tab close — even when the
  // in-tab syncProfile silently failed — so the cache holds URLs that are
  // NOT in CRM yet are greyed out as "Contacted" in the search-card chips.
  // The Avoid Duplicate Outreach toggle then SKIPS them on re-runs,
  // perpetuating the missing-from-CRM problem (Noora Al-Khori symptom).
  // v1.0.292+ only marks contacted after a verified save, so once the cache
  // is wiped, it self-heals: genuinely-saved URLs get re-added on next
  // bulk pass (backend dedupes by linkedin_url — harmless re-save), and the
  // truly-missing leads finally land in CRM. Idempotent: keyed by a
  // sentinel so it only runs once per workspace.
  try {
    const { lcContactedWipedV292 } = await chrome.storage.local.get("lcContactedWipedV292");
    if (!lcContactedWipedV292) {
      await chrome.storage.local.remove("lc_contacted_urls");
      await chrome.storage.local.set({ lcContactedWipedV292: true });
      console.log("[LeadCaptura SW] wiped lc_contacted_urls (v292 one-time migration)");
    }
  } catch {}

  // One-time FRESH-START reset of the auto-apply answer memory. The user asked
  // to wipe everything the extension had learned/stored so far and let it build
  // a clean memory from scratch. We clear the learned-answers map AND the saved
  // application profile (it reverts to the code's neutral defaults), guarded by
  // a sentinel so it happens exactly once. The API key + core settings are NOT
  // touched, so the extension keeps working — only the answer memory resets, and
  // it re-learns every question as the user answers it going forward.
  try {
    const { lcMemoryResetV372 } = await chrome.storage.local.get("lcMemoryResetV372");
    if (!lcMemoryResetV372) {
      await chrome.storage.local.remove(["lc_learned_answers", "lc_apply_profile"]);
      await chrome.storage.local.set({ lcMemoryResetV372: true });
      console.log("[LeadCaptura SW] fresh-start: wiped learned answers + apply profile (one-time v372 reset)");
    }
  } catch {}

  // Reconcile update state on install/update: after an update lands, the
  // running version now equals (or exceeds) the manifest's latest, so this
  // clears the "update available" flag + toolbar badge automatically.
  try { lcCheckForUpdate(); } catch (_) {}
});

// GC the per-tab enrichment-result map whenever a tab closes for ANY
// reason. lc:openProfileTab's finish() already deletes on awaited closes,
// but the per-card fire-and-forget path (awaitClose:false) never runs
// finish(), so its trigger's lc:enrichResult would otherwise leak forever.
chrome.tabs.onRemoved.addListener((closedId) => {
  _enrichResults.delete(closedId);
});

// Tiny periodic heartbeat to keep the worker alive while the user is on LI
chrome.alarms?.create("lc-heartbeat", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  // No-op: just ensures Chrome rouses the worker periodically.
});

// ───────────────────────── In-extension auto-update ─────────────────────────
// Chrome cannot silently replace an UNPACKED extension's files (only the Chrome
// Web Store can), so "auto-update" here means: detect a newer build in the
// BACKGROUND (even with the popup closed), badge the toolbar icon like a phone
// app-update dot, fire one desktop notification per version, and let the popup
// turn that into a one-click Download + one-click Restart. The restart uses
// chrome.runtime.reload(), which reloads the freshly-unzipped files WITHOUT a
// trip to chrome://extensions. Purely additive: no existing message, handler,
// setting, or integration is touched, and NO new permission is requested
// (alarms/notifications/storage/action are already granted).
const LC_VERSION_MANIFEST_URL = "https://leadloftexporter.vercel.app/extension-version.json";

// Numeric dotted-version compare: 1 if a>b, -1 if a<b, 0 if equal.
function _lcCmpVersion(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || "0", 10), nb = parseInt(pb[i] || "0", 10);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function _lcSetUpdateBadge(latest) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
    await chrome.action.setBadgeText({ text: "1" });
    await chrome.action.setTitle({ title: `LeadCaptura — update available (v${latest})` });
  } catch (_) {}
}
async function _lcClearUpdateBadge() {
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "LeadCaptura" });
  } catch (_) {}
}

// Check the hosted version manifest and reconcile local update state. Best-effort:
// any failure (offline, blocked) leaves everything exactly as-is.
async function lcCheckForUpdate() {
  try {
    const cur = chrome.runtime.getManifest().version;
    const res = await fetch(LC_VERSION_MANIFEST_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    const latest = info && info.version;
    if (!latest) return;
    if (_lcCmpVersion(latest, cur) <= 0) {
      // Already up to date (e.g. the user just restarted onto the new build) —
      // clear any stale flag/badge so the dot disappears the moment they update.
      await chrome.storage.local.remove("lc_update_available");
      await _lcClearUpdateBadge();
      return;
    }
    // A newer build exists. Persist it so the popup can render instantly (even
    // offline) and badge the toolbar icon like a phone app-update dot.
    const payload = {
      version: latest,
      notes: info.notes || "",
      zip: info.zip || "/leadcaptura-extension.zip",
      from: cur,
      seenAt: Date.now(),
    };
    await chrome.storage.local.set({ lc_update_available: payload });
    await _lcSetUpdateBadge(latest);
    // One desktop notification per version — never on every check.
    try {
      const { lc_update_notified } = await chrome.storage.local.get("lc_update_notified");
      if (lc_update_notified !== latest && chrome.notifications) {
        chrome.notifications.create("lc-update-" + latest, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "LeadCaptura update available",
          message: `Version ${latest} is ready. Click the LeadCaptura toolbar icon to update.`,
          priority: 1,
        }, () => { void chrome.runtime.lastError; });
        await chrome.storage.local.set({ lc_update_notified: latest });
      }
    } catch (_) {}
  } catch (_) { /* offline / blocked — silent, retried on the next tick */ }
}

// Clicking the update notification opens the popup-equivalent flow: focus/open
// the toolbar popup isn't scriptable, so open the CRM download page as a
// dependable fallback and drop the OS notification.
chrome.notifications?.onClicked.addListener((id) => {
  if (!id || !String(id).startsWith("lc-update-")) return;
  chrome.storage.local.get("lc_update_available", ({ lc_update_available }) => {
    const zip = lc_update_available?.zip || "/leadcaptura-extension.zip";
    const url = /^https?:/i.test(zip) ? zip : ("https://leadloftexporter.vercel.app" + zip);
    chrome.tabs.create({ url });
    try { chrome.notifications.clear(id); } catch (_) {}
  });
});

// Run the check on the events that matter: browser startup, install/update, and
// a periodic 6-hour alarm. (onInstalled after an update finds latest<=current
// and self-clears the badge.)
chrome.runtime.onStartup?.addListener(() => { lcCheckForUpdate(); });
chrome.alarms?.create("lc-update-check", { periodInMinutes: 360 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "lc-update-check") lcCheckForUpdate();
});
// Also check shortly after the worker first spins up so a freshly-opened
// browser doesn't wait up to 6h for the first alarm.
lcCheckForUpdate();
