// extension/content/connect_all_on_page.js
//
// INDEPENDENT FEATURE — "Connect All On Page"
// =============================================================================
// This file is completely self-contained. It does NOT touch overlay.js,
// automate.js, main.js, scraper.js, or any other prebuilt code. It mounts its
// own floating button on the new LinkedIn People search results UI and runs
// its own end-to-end Connect → "Send without a note" flow.
//
// Why a separate file?
// --------------------
// The existing Connect All flow targets the legacy search-result markup. The
// 2026 LinkedIn redesign moved the Connect action to an <a> with a
// "/preload/search-custom-invite/" href and now opens a modal with
// "Add a note" + "Send without a note" — the existing flow clicks the anchor
// but does not reliably click "Send without a note" on the new modal. Rather
// than touch the existing code, this file ships an isolated, parallel button.
//
// Anchor for each result (Case #4 — new search page):
//   <a href="/preload/search-custom-invite/?vanityName=<handle>"
//      aria-label="Invite <Name> to connect">
//     ...<span>Connect</span>
//   </a>
//
// Modal after click:
//   <button aria-label="Send without a note" ... >Send without a note</button>
//
// Anti-bot rules honoured (see CLAUDE.md > Bot-detection avoidance):
//   - Read-only DOM. Never calls LinkedIn internal APIs.
//   - 45-180s gap between consequential actions, with ~18% long-tail.
//   - Human-paced click sequence (pointerover/down/up/click) with realistic
//     coordinates.
//   - Aborts on captcha/checkpoint pages.
//   - Verifies the modal actually CLOSED from sending before counting a
//     success — never reports success on a leftover/dismissed dialog.
//
// =============================================================================
(function () {
  if (window.__lc_cap_loaded) return;       // singleton
  window.__lc_cap_loaded = true;

  const TAG = "[LeadCaptura · ConnectAllOnPage]";

  // ───────────────────────── helpers ─────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return min + Math.random() * (max - min); }

  // Human-paced delay between consequential actions:
  //   55% → 45–75s, 27% → 70–130s, 18% → 60–180s long tail
  function nextActionDelayMs() {
    const r = Math.random();
    if (r < 0.18) return 60000 + rand(0, 120000);
    if (r < 0.45) return 70000 + rand(0, 60000);
    return 45000 + rand(0, 30000);
  }

  function onSearchPeoplePage() {
    return /^\/search\/results\/people\//.test(location.pathname);
  }

  function isCheckpoint() {
    return /\/checkpoint\//.test(location.pathname)
        || /\/uas\/captcha-submit/.test(location.pathname);
  }

  // ──────────────────── humanised clicking ───────────────────
  function humanClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + (Math.random() * 6 - 3);
      const cy = r.top  + r.height / 2 + (Math.random() * 4 - 2);
      const init = { bubbles: true, cancelable: true, view: window,
                     clientX: cx, clientY: cy, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerover", init));
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown",     init));
      el.dispatchEvent(new PointerEvent("pointerup",   init));
      el.dispatchEvent(new MouseEvent("mouseup",       init));
      el.dispatchEvent(new MouseEvent("click",         init));
    } catch (_) {}
    return true;
  }

  // Multi-strategy click for the modal's primary button. LinkedIn (Ember)
  // mostly honours untrusted events; native .click() lands first, then we
  // escalate to the pointer sequence + Enter as the desperate fallback.
  function forceClickSendBtn(btn) {
    if (!btn) return false;
    try { btn.click(); } catch (_) {}
    try { humanClick(btn); } catch (_) {}
    try {
      const inner = btn.querySelector(".artdeco-button__text") || btn.firstElementChild;
      if (inner) humanClick(inner);
    } catch (_) {}
    try {
      const kdInit = { key: "Enter", code: "Enter", bubbles: true };
      btn.dispatchEvent(new KeyboardEvent("keydown", kdInit));
      btn.dispatchEvent(new KeyboardEvent("keyup",   kdInit));
    } catch (_) {}
    return true;
  }

  // ─────────────────── DOM detection ─────────────────────────
  // Each visible Connect anchor on the search page. We anchor on the href
  // (uniquely "/preload/search-custom-invite/") + the aria-label shape
  // "Invite <Name> to connect" because the hashed class names rotate.
  function findConnectAnchors() {
    const seen = new Set();
    const out = [];
    document
      .querySelectorAll('a[href*="/preload/search-custom-invite/"]')
      .forEach(a => {
        if (seen.has(a)) return;
        const aria = (a.getAttribute("aria-label") || "").toLowerCase();
        if (!aria.startsWith("invite ")) return;
        if (!aria.includes("to connect")) return;
        if (a.getAttribute("aria-disabled") === "true") return;
        // Must be on-screen (rendered)
        const r = a.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        seen.add(a);
        out.push(a);
      });
    return out;
  }

  // The "Add a note to your invitation?" modal exposes a stable button:
  //   <button aria-label="Send without a note" ... >
  // Scan the WHOLE document (per CLAUDE.md's load-bearing rule — sometimes
  // LinkedIn renders the footer button outside the matched modal node).
  function findSendWithoutNoteBtn() {
    const btns = document.querySelectorAll(
      'button[aria-label="Send without a note"]'
    );
    // Prefer one that's visible + enabled, else first match.
    let visible = null;
    for (const b of btns) {
      if (b.disabled) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { visible = b; break; }
    }
    return visible || btns[0] || null;
  }

  // The invitation modal is open if either the dialog node is visible or a
  // visible "Send without a note" button exists. Mirrors the resilience rule
  // in the legacy flow.
  function invitationModalOpen() {
    const dialog = document.querySelector(
      '.artdeco-modal[role="dialog"], div[role="dialog"][data-test-modal-id]'
    );
    if (dialog) {
      const text = (dialog.textContent || "").toLowerCase();
      if (text.includes("add a note to your invitation")) return true;
    }
    const sb = document.querySelector('button[aria-label="Send without a note"]');
    if (sb) {
      const r = sb.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  // Dismiss the modal (for skipped rows so we don't leave it open).
  function dismissModal() {
    const x = document.querySelector(
      '.artdeco-modal__dismiss[aria-label*="Dismiss" i],' +
      'button[aria-label="Dismiss"][data-test-modal-close-btn]'
    );
    if (x) { humanClick(x); return true; }
    return false;
  }

  // ─────────────── per-card flow ─────────────────────────────
  // Returns "sent" | "skipped" | "challenge" | "error".
  async function connectOneCard(anchor) {
    if (isCheckpoint()) return "challenge";
    if (!document.body.contains(anchor)) return "skipped";

    // STEP 1 — click the Connect anchor (human pointer sequence)
    anchor.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rand(700, 1400));   // 1.2s avg reading pause
    humanClick(anchor);
    console.log(TAG, "step 1 → clicked Connect anchor");

    // STEP 2 — wait up to 8s for the "Add a note" modal
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (invitationModalOpen()) break;
      await sleep(220);
    }
    if (!invitationModalOpen()) {
      console.log(TAG, "step 2 → no modal opened, skipping");
      return "skipped";
    }
    console.log(TAG, "step 2 → modal open");

    // STEP 3 — click "Send without a note"
    await sleep(rand(450, 950));
    const sendBtn = findSendWithoutNoteBtn();
    if (!sendBtn) {
      console.log(TAG, "step 3 → Send-without-a-note button missing");
      dismissModal();
      return "error";
    }
    forceClickSendBtn(sendBtn);
    console.log(TAG, "step 3 → force-clicked Send without a note");

    // STEP 4 — confirm the modal closes from sending (= invite actually sent)
    const t1 = Date.now();
    while (Date.now() - t1 < 7000) {
      if (!invitationModalOpen()) {
        console.log(TAG, "step 4 → modal closed → SENT");
        return "sent";
      }
      await sleep(250);
    }
    // Retry once
    const retry = findSendWithoutNoteBtn();
    if (retry) {
      forceClickSendBtn(retry);
      await sleep(2200);
      if (!invitationModalOpen()) return "sent";
    }
    // Bail — dismiss to keep things clean
    dismissModal();
    return "error";
  }

  // ─────────────── main loop ─────────────────────────────────
  const state = { running: false, cancel: false, sent: 0, skipped: 0, errored: 0 };

  async function run() {
    if (state.running) return;
    state.running = true; state.cancel = false;
    state.sent = state.skipped = state.errored = 0;
    setLabel("Scanning…");

    try {
      const anchors = findConnectAnchors();
      if (anchors.length === 0) {
        setLabel("No connectable rows on page");
        setTimeout(resetLabel, 4000);
        return;
      }

      for (let i = 0; i < anchors.length; i++) {
        if (state.cancel) break;
        if (isCheckpoint()) { banner("LinkedIn challenge detected — stopping."); break; }

        setLabel(`Working ${i + 1} / ${anchors.length}`);
        let result;
        try {
          result = await connectOneCard(anchors[i]);
        } catch (e) {
          console.warn(TAG, "card error:", e);
          result = "error";
        }
        if (result === "sent")        state.sent++;
        else if (result === "skipped") state.skipped++;
        else if (result === "challenge") { banner("Challenge — stopping."); break; }
        else                            state.errored++;

        if (i < anchors.length - 1 && !state.cancel) {
          const wait = nextActionDelayMs();
          const start = Date.now();
          // Cancellable wait, 200ms tick
          while (Date.now() - start < wait) {
            if (state.cancel) break;
            const left = Math.max(0, Math.round((wait - (Date.now() - start)) / 1000));
            setLabel(`Wait ${left}s · ${i + 1}/${anchors.length}`);
            await sleep(200);
          }
        }
      }
    } finally {
      const summary = `Done · ${state.sent} sent, ${state.skipped} skipped${state.errored ? `, ${state.errored} err` : ""}`;
      setLabel(summary);
      state.running = false; state.cancel = false;
      setTimeout(resetLabel, 8000);
    }
  }

  function cancel() {
    if (!state.running) return;
    state.cancel = true;
    setLabel("Stopping…");
  }

  // ─────────────── floating button UI ────────────────────────
  let btnEl = null;
  const BTN_ID = "lc-cap-button";

  function setLabel(text) {
    if (!btnEl) return;
    const lab = btnEl.querySelector(".lc-cap-text");
    if (lab) lab.textContent = text;
    btnEl.classList.toggle("lc-cap-running", state.running);
  }
  function resetLabel() { setLabel("Connect All On Page"); }

  function mountButton() {
    if (btnEl || !document.body) return;
    btnEl = document.createElement("button");
    btnEl.id = BTN_ID;
    btnEl.type = "button";
    btnEl.style.cssText = [
      "position: fixed",
      "right: 18px",
      "bottom: 78px",                 // sits above any existing LeadCaptura toolbar
      "z-index: 2147483646",
      "background: linear-gradient(135deg, #0a66c2 0%, #0959a8 100%)",
      "color: #ffffff",
      "border: none",
      "border-radius: 999px",
      "padding: 10px 18px 10px 14px",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif",
      "font-size: 13px",
      "font-weight: 700",
      "letter-spacing: 0.01em",
      "box-shadow: 0 8px 22px rgba(10, 102, 194, 0.35)",
      "cursor: pointer",
      "user-select: none",
      "display: inline-flex",
      "align-items: center",
      "gap: 8px",
    ].join(";");
    btnEl.innerHTML =
      '<span class="lc-cap-dot" style="width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block;flex-shrink:0"></span>' +
      '<span class="lc-cap-text">Connect All On Page</span>';
    btnEl.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.running) cancel();
      else run();
    });
    document.body.appendChild(btnEl);

    // Pulse the dot while running
    const style = document.createElement("style");
    style.id = "lc-cap-style";
    style.textContent =
      "#" + BTN_ID + ".lc-cap-running .lc-cap-dot { animation: lc-cap-pulse 1.2s infinite; }" +
      "@keyframes lc-cap-pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }";
    document.head.appendChild(style);
  }

  function unmountButton() {
    if (btnEl) { btnEl.remove(); btnEl = null; }
    const s = document.getElementById("lc-cap-style");
    if (s) s.remove();
  }

  function banner(msg) {
    let b = document.getElementById("lc-cap-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "lc-cap-banner";
      b.style.cssText = [
        "position:fixed", "top:60px", "left:50%", "transform:translateX(-50%)",
        "background:#b91c1c", "color:#fff",
        "padding:10px 18px", "border-radius:8px",
        "font:600 13px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif",
        "z-index:2147483647",
        "box-shadow:0 8px 22px rgba(0,0,0,0.28)",
      ].join(";");
      document.body.appendChild(b);
    }
    b.textContent = msg;
    setTimeout(() => { if (b && b.parentNode) b.remove(); }, 7000);
  }

  // ─────────────── mount lifecycle ───────────────────────────
  function maybeMount() {
    if (onSearchPeoplePage()) mountButton();
    else unmountButton();
  }
  // SPA-aware: LinkedIn does soft navigations. Re-check every 1.5s.
  setInterval(maybeMount, 1500);
  maybeMount();

  // Self-heal when the extension reloads (chrome.runtime.id flips to undef)
  setInterval(() => {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
        unmountButton();
      }
    } catch (_) { unmountButton(); }
  }, 2500);

  console.log(TAG, "loaded");
})();
