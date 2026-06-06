/* Content-script entry point. Coordinates the scraper, overlay, and
 * autopilot tick on LinkedIn pages. */
(() => {
  // If we were mounted under a previous extension load, the chrome.runtime
  // we registered our message listener against is now invalidated — the
  // popup gets "Could not establish connection" when it tries to reach us.
  // Detect that here and allow a fresh re-mount so the new listener attaches
  // to the live runtime.
  if (window.__leadCapturaMounted) {
    let runtimeAlive = false;
    try { runtimeAlive = !!chrome.runtime?.id; } catch { runtimeAlive = false; }
    if (runtimeAlive) return;
    window.__leadCapturaMounted = false;
  }
  window.__leadCapturaMounted = true;

  // Periodic stale-runtime detector. After the extension is reloaded
  // (chrome://extensions → 🔄), OPEN LinkedIn tabs keep the old content
  // scripts running, but chrome.runtime.id flips to undefined. Every API
  // call we attempt fails with chrome-extension://invalid/ — but worse,
  // the old chips' click handlers are still bound to PROFILE OBJECTS
  // captured at chip-injection time using whatever buggy card-detection
  // logic shipped in that old version. User clicks Save on Mohamed's
  // card, the old click handler fires with Dania's profile data.
  //
  // Defense: when staleness is detected, RIP OUT every chip and our
  // overlay from the page (so the user physically can't click them),
  // show a red modal that blocks LinkedIn's own action buttons too,
  // then force-reload the tab after a short visible delay. The next
  // load injects the fresh content scripts and the bug is gone.
  let _staleBanner = null;
  let _staleReloadQueued = false;
  function _killStaleUi() {
    try {
      document
        .querySelectorAll(
          ".lc-save-row, .lc-inline-save, .lc-overlay-root, #lc-overlay-root, .lc-floating-panel"
        )
        .forEach((n) => {
          try {
            n.remove();
          } catch {}
        });
    } catch {}
  }
  function _checkRuntime() {
    let alive = false;
    try { alive = !!chrome.runtime?.id; } catch { alive = false; }
    if (alive) {
      if (_staleBanner) {
        _staleBanner.remove();
        _staleBanner = null;
      }
      return;
    }
    if (_staleBanner && document.documentElement.contains(_staleBanner)) return;

    // 1. Strip every LeadCaptura UI element from the page so the user
    //    can't click a stale chip. This is the critical step — banner
    //    alone wasn't enough; users kept clicking Save chips and saving
    //    mutual-connection people because the chip handlers were already
    //    bound to wrong profile data.
    _killStaleUi();
    // Re-strip every 200ms in case LinkedIn's React re-injects stale
    // chips before the reload fires.
    const stripper = setInterval(_killStaleUi, 200);

    // 2. Show a non-dismissable full-width banner so the user knows
    //    what's about to happen.
    _staleBanner = document.createElement("div");
    _staleBanner.id = "lc-stale-banner";
    _staleBanner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "background:#dc2626",
      "color:white",
      "padding:14px 20px",
      "font:600 15px/1.5 -apple-system, system-ui, sans-serif",
      "text-align:center",
      "box-shadow:0 4px 16px rgba(0,0,0,0.3)",
    ].join(";");
    _staleBanner.textContent =
      "LeadCaptura updated — refreshing this LinkedIn tab in 2 seconds to load the new version. Save chips are disabled until reload.";
    try {
      document.documentElement.appendChild(_staleBanner);
    } catch {}

    // 3. Hard-reload the tab. Window-level reload still works even when
    //    the extension context is gone — it's a window API, not a
    //    chrome.* API.
    if (!_staleReloadQueued) {
      _staleReloadQueued = true;
      setTimeout(() => {
        clearInterval(stripper);
        try {
          location.reload();
        } catch {
          /* if reload is blocked we still removed the chips so no bad save */
        }
      }, 2000);
    }
  }
  setInterval(_checkRuntime, 3000);
  // Also check right away in case the runtime was already dead at mount
  setTimeout(_checkRuntime, 500);

  const Overlay = globalThis.__lcOverlay;
  const Automate = globalThis.__lcAutomate;
  const Scraper = globalThis.__lcScraper;
  const Human = globalThis.__lcHuman;
  const Storage = globalThis.__lcStorage;

  let lastPath = null;
  let autopilotInterval = null;
  let _visibilityListenerAdded = false;

  // ─── Connect All: profile-page navigation queue ───────────────────────────
  // When the user clicks "Connect All", overlay.js saves a queue of profile
  // URLs to chrome.storage.local and navigates to the first profile. On each
  // profile-page load this function picks up the queue, runs the connect flow,
  // then advances to the next URL. When the queue is empty it returns to the
  // original search URL.

  function _ccDetectChallenge() {
    return [
      "form#captcha", "form[action*='checkpoint']",
      "div[data-test-id='challenge']", "div.cp-multi-step-flow", "input[name='pin']",
    ].some((s) => { try { return !!document.querySelector(s); } catch { return false; } });
  }

  function _ccFindInviteModal() {
    for (const d of document.querySelectorAll(
      "div[role='dialog'], .artdeco-modal, [role='alertdialog'], [data-test-modal]"
    )) {
      const rect = d.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const cs = getComputedStyle(d);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const txt = d.textContent || "";
      const heading = d.querySelector("h2, h3, h4, [role='heading']");
      const headingTxt = (heading?.textContent || "").toLowerCase();
      // Must NOT be LinkedIn's "Send [Name]'s Post" share/DM modal
      if (heading && /send .+['']s post/i.test(headingTxt)) continue;
      // Classic invite modal: contains invite-specific body phrases
      if (/add a note|send without a note|personalize your invitation|note.*optional/i.test(txt))
        return d;
      // Redesigned modal: heading references "invite" or "connect" and has a
      // non-dismiss action button. LinkedIn removed "Send without a note" wording
      // in 2025 and now shows a plain "Send" CTA inside an "Invite … to connect" modal.
      if (/invite|connect.*request|connection request/i.test(headingTxt)) {
        const actionBtn = d.querySelector(
          "button:not([aria-label*='close' i]):not([aria-label*='dismiss' i]):not([aria-label*='back' i])"
        );
        if (actionBtn) return d;
      }
    }
    return null;
  }

  function _ccFindSendBtn() {
    // ALWAYS scan the whole document — never scope to the modal element.
    // LinkedIn renders the invite modal's action buttons ("Send without a note")
    // in a portal sibling OUTSIDE the div[role='dialog'] element on many
    // profiles. Scoping to modal.querySelectorAll() silently returns null and
    // the button is never clicked.
    const all = Array.from(document.querySelectorAll("button, [role='button'], a")).filter(
      (b) => !(b.classList && b.classList.contains("lc-inline-save")) && !b.closest?.(".lc-overlay-root, #lc-overlay-root, .lc-floating-panel")
    );
    const label = (b) => ({
      t: (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
      a: (b.getAttribute("aria-label") || "").trim().toLowerCase(),
    });
    const isVisible = (b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !b.disabled;
    };
    // Progressive passes, strictest first.
    const tests = [
      (s) => s === "send without a note",
      (s) => /\bsend without a note\b/.test(s),
      (s) => s === "send now" || s === "send invitation",
      (s) => s.includes("send without a note"),
    ];
    for (const test of tests) {
      const matches = all.filter((b) => {
        const { t, a } = label(b);
        return test(t) || test(a);
      });
      if (!matches.length) continue;
      const vis = matches.filter(isVisible);
      return vis[0] || matches.find((b) => !b.disabled) || matches[0];
    }
    // Fallback for redesigned modal: bare "send" is safe when inside a confirmed
    // invite modal (no share modal can be open on a /in/ profile page mid-connect).
    const modal = _ccFindInviteModal();
    if (modal) {
      // Primary action button in the modal (artdeco primary style = the "Send" CTA).
      for (const sel of [
        ".artdeco-button--primary",
        ".artdeco-modal__actionbar .artdeco-button",
        "[data-test-dialog-primary-btn]",
        "[data-test-modal-action-primary]",
      ]) {
        try {
          const btn = modal.querySelector(sel);
          if (btn && !btn.disabled && isVisible(btn)) {
            const { t } = label(btn);
            if (!/(cancel|close|dismiss|back|add.*note|note)/i.test(t)) return btn;
          }
        } catch {}
      }
      // Bare "send" button anywhere in the document — safe because we verified
      // the invite modal is open and we are on a /in/ profile page.
      const sendBtn = all.find((b) => {
        const { t, a } = label(b);
        return (t === "send" || a === "send") && isVisible(b);
      });
      if (sendBtn) return sendBtn;
    }
    return null;
  }

  function _ccInviteModalOpen() {
    // Primary: the invite modal itself is visible.
    if (_ccFindInviteModal()) return true;
    // Fallback: a specific "Send without a note" or "Send now" button is visible.
    // Intentionally excludes bare "Send" — that phrase matches LinkedIn's
    // "Send [Name]'s Post" share modal submit button and causes false positives.
    const all = Array.from(document.querySelectorAll("button, [role='button'], a"));
    for (const b of all) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (
        /^send without a note$/i.test(t) || /^send without a note$/i.test(a) ||
        /^send now$/i.test(t) || /^send now$/i.test(a)
      ) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  // Fire a full pointer/mouse sequence on one element at its centre.
  function _ccPointerSequence(el) {
    try {
      const r = el.getBoundingClientRect();
      const o = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new PointerEvent("pointerenter", o));
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
    } catch {}
  }

  // Inject code into the PAGE's MAIN world to click "Send without a note".
  // Content scripts run in an isolated world; a <script> tag appended to the DOM
  // runs in the page's own JS context where window.jQuery and other page globals
  // are accessible, giving us one more click channel against LinkedIn's handler.
  function _ccMainWorldClick() {
    try {
      const code =
        "(function(){" +
        "var all=Array.from(document.querySelectorAll('button,[role=\"button\"]'));" +
        "var b=all.find(function(x){" +
        "  var t=(x.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();" +
        "  var a=(x.getAttribute('aria-label')||'').toLowerCase();" +
        "  return /send without a note/i.test(t)||/send without a note/i.test(a)||t==='send now'||t==='send';" +
        "});" +
        "if(!b)return;" +
        "if(window.jQuery||window.$){try{(window.jQuery||window.$)(b).trigger('click');}catch(e){}}" +
        "HTMLElement.prototype.click.call(b);" +
        "var f=b.closest('form');" +
        "if(f){try{f.requestSubmit(b);}catch(e){try{f.submit();}catch(e2){}}}" +
        "})();";
      const s = document.createElement("script");
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch {}
  }

  // Request the service worker to executeScript with world:"MAIN" — the most
  // authoritative injection path available from a content script.
  function _ccSwMainWorldClick() {
    try { chrome.runtime.sendMessage({ type: "lc:clickMainWorldSend" }, () => {}); } catch {}
  }

  // Click an element as reliably as possible. Ports the proven _forceClick from
  // overlay.js: LinkedIn's button handler may be bound to the <button>, to an
  // inner <span>, or driven by keyboard activation, so we try ALL of —
  //   1. native .click()
  //   2. a pointer/mouse sequence on the button
  //   3. the same sequence on the inner label <span> (handlers often sit there)
  //   4. an Enter keydown/keyup
  // — until something lands. The "Send without a note" button specifically
  // needs strategies 3 and 4; .click() + a button-level sequence alone is not
  // enough (this was the v1.0.82 send_failed cause).
  function _ccForceClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
    try { el.focus(); } catch {}
    try { el.click(); } catch {}
    _ccPointerSequence(el);
    try {
      const inner = el.querySelector("span, .artdeco-button__text");
      if (inner && inner !== el) {
        inner.click?.();
        _ccPointerSequence(inner);
      }
    } catch {}
    try {
      const kopts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", kopts));
      el.dispatchEvent(new KeyboardEvent("keyup", kopts));
    } catch {}
    // Direct React fiber call — bypasses the DOM event system entirely.
    // When LinkedIn's button handler checks event.isTrusted, synthetic DOM
    // events fail (isTrusted is always false for programmatic events). Calling
    // the React onClick prop directly with a plain object where isTrusted=true
    // passes that check. Walk up the fiber tree so we find the onClick even if
    // it is attached to a parent wrapper component.
    try {
      const fKey = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (fKey) {
        let fiber = el[fKey];
        for (let depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
          const onClick =
            fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
          if (typeof onClick === "function") {
            onClick({
              type: "click", bubbles: true, cancelable: true,
              isTrusted: true, target: el, currentTarget: el,
              preventDefault: () => {}, stopPropagation: () => {},
              nativeEvent: { isTrusted: true },
            });
            break;
          }
        }
      }
    } catch {}
  }

  // Returns true if a Contact Info modal or overlay is currently open/loading.
  // We check this before and during the connect flow so we never fire into
  // a page that's mid-contact-info scrape.
  function _contactInfoModalOpen() {
    // The SPA pushes /overlay/contact-info into the URL while the modal animates
    if (location.pathname.includes("/overlay/contact-info")) return true;
    // The actual modal dialog contains "Contact info" header text
    for (const d of document.querySelectorAll("div[role='dialog'], .artdeco-modal")) {
      const rect = d.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (/contact info/i.test(d.textContent || "")) return true;
    }
    return false;
  }

  // Full connect flow on the current profile page. Returns { ok, reason }.
  async function _ccConnectOnProfile() {
    const { sleep, readingPause, scrollLikeHuman, simulateCursorMove } = Human;
    const { waitFor, dispatchHumanClick } = globalThis.__lcDom;

    // If a Contact Info modal is still open from auto-save enrichment, wait for
    // it to close before attempting to interact. It should close within ~4s.
    if (_contactInfoModalOpen()) {
      console.log("[LeadCaptura] connect-queue: waiting for Contact Info modal to close…");
      for (let i = 0; i < 16; i++) {
        await sleep(300);
        if (!_contactInfoModalOpen()) break;
      }
      if (_contactInfoModalOpen()) {
        // Still open — dismiss it by restoring the URL so LinkedIn closes it.
        try { history.replaceState({}, "", location.pathname.split("/overlay/")[0] + "/"); } catch {}
        await sleep(600);
      }
    }

    // Human-like reading before touching anything
    await sleep(readingPause());
    await scrollLikeHuman(160 + Math.random() * 120);
    await sleep(500 + Math.random() * 800);

    // Glance at the h1 name (cursor movement is an anti-bot signal)
    if (simulateCursorMove) {
      const h1 = document.querySelector("main h1");
      if (h1) {
        await simulateCursorMove(h1);
        await sleep(250 + Math.random() * 350);
      }
    }

    // Helper: returns true for a button that is a genuine Connect action —
    // has "connect" in its text or aria-label and does NOT reference
    // "contact", "pending", "following", "message", or "withdraw".
    const _isConnectBtn = (el) => {
      if (!el || el.disabled) return false;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const hay = txt + " " + aria;
      if (!/\bconnect\b/.test(hay)) return false;
      if (/\bcontact\b|\bpending\b|\bfollowing\b|\bmessage\b|\bwithdraw\b/.test(hay)) return false;
      return true;
    };

    // Scan for the profile's primary Connect button. LinkedIn's 2025 markup is
    // inconsistent: the button is sometimes <button>, sometimes NO aria-label
    // (just <span>Connect</span>), and for many profiles it is an
    // <a href="/preload/custom-invite/..."> anchor styled to look like a button
    // — the status-bar URL proves this (hover shows the /preload/custom-invite/ href).
    // We scan ALL buttons AND anchors, exclude only open dropdown menus,
    // prefer the profile action strip, and fall back to the "More actions" menu.
    const _findConnect = () => {
      const candidates = [];
      const seen = new Set();
      const q = (sel) => { try { return document.querySelectorAll(sel); } catch { return []; } };

      // Phase 1: broad scan — buttons, role=button, and invite/connect anchors
      for (const b of [
        ...q("button, [role='button']"),
        ...q("a[href*='invite' i], a[href*='connect' i], a[href*='/mynetwork/' i]"),
      ]) {
        if (seen.has(b)) continue; seen.add(b);
        // Exclude items inside open dropdown menus only (not aside — LinkedIn 2025
        // sometimes renders the action strip inside an aside container)
        if (b.closest("[role='menu'], .artdeco-dropdown__content")) continue;
        if (!_isConnectBtn(b)) continue;
        const cs = window.getComputedStyle(b);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        candidates.push(b);
      }

      if (!candidates.length) return null;

      // Phase 2: prefer match inside the profile action strip
      const ACTION_STRIP =
        ".pvs-profile-actions, .pv-top-card-v2-ctas, .pv-top-card-v3-ctas, " +
        ".ph5, .pv-top-card, [class*='top-card'][class*='ctas'], " +
        "[class*='profile-actions'], .scaffold-layout__main";
      const inActions = candidates.find(
        (b) => b.closest(ACTION_STRIP) && b.closest("main")
      );
      if (inActions) return inActions;

      // Phase 3: any candidate inside <main>
      const inMain = candidates.find((b) => b.closest("main"));
      if (inMain) return inMain;

      // Phase 4: absolute fallback — first candidate regardless of container
      return candidates[0];
    };

    // Phase 5: nuclear document-wide text scan used when _findConnect returns null
    const _findConnectNuclear = () => {
      const seen = new Set();
      // Walk every element with a click handler — covers custom components
      for (const el of document.querySelectorAll(
        "button, [role='button'], a[href], [data-control-name*='connect' i]"
      )) {
        if (seen.has(el)) continue; seen.add(el);
        if (el.closest("[role='menu'], .artdeco-dropdown__content")) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const hay = txt + " " + aria;
        if (!/\bconnect\b/.test(hay)) continue;
        if (/\bcontact\b|\bpending\b|\bfollowing\b|\bmessage\b|\bwithdraw\b/.test(hay)) continue;
        if (el.disabled) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        return el;
      }
      return null;
    };

    let connectBtn = _findConnect();

    // SPA hydration: LinkedIn injects the action buttons a beat after the
    // profile shell mounts. Poll every 500ms for up to ~8s before giving up.
    if (!connectBtn) {
      for (let w = 0; w < 16 && !connectBtn; w++) {
        await sleep(500);
        connectBtn = _findConnect() || _findConnectNuclear();
      }
    }

    // Last resort (has a side effect — opens a menu): "More actions" dropdown,
    // for the rare profile that hides Connect behind "More".
    if (!connectBtn) {
      const moreBtn =
        document.querySelector("main button[aria-label*='More actions' i]") ||
        document.querySelector("main button[aria-label*='More' i]") ||
        document.querySelector(".pvs-profile-actions button[aria-label*='More' i]") ||
        (() => {
          // text-content fallback for "More" button
          for (const b of document.querySelectorAll("main button")) {
            const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
            if (/^more$/i.test(txt) && !b.disabled) return b;
          }
          return null;
        })();
      if (moreBtn) {
        if (simulateCursorMove) await simulateCursorMove(moreBtn);
        await sleep(400 + Math.random() * 400);
        await dispatchHumanClick(moreBtn);
        await sleep(700 + Math.random() * 500);
        // Search dropdown by aria-label AND by text content
        const dropdownItems = document.querySelectorAll(
          "div[role='menu'] li, div[role='menu'] [role='menuitem'], " +
          "div.artdeco-dropdown__content li, li.artdeco-dropdown__item"
        );
        for (const item of dropdownItems) {
          const txt = (item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          const aria = (item.getAttribute("aria-label") || "").toLowerCase();
          if (/\bconnect\b/.test(txt + " " + aria) && !/\bpending\b|\bwithdraw\b/.test(txt + " " + aria)) {
            const clickable = item.querySelector("button, a") || item;
            if (_isConnectBtn(clickable) || /\bconnect\b/.test(txt)) {
              connectBtn = clickable;
              break;
            }
          }
        }
        // Also try waitFor as secondary
        if (!connectBtn) {
          const found = await waitFor(
            [
              "div[role='menu'] [aria-label*='Connect' i]",
              "div.artdeco-dropdown__content [aria-label*='Connect' i]",
              "li.artdeco-dropdown__item [aria-label*='Connect' i]",
            ],
            { timeout: 2000 }
          );
          if (found && _isConnectBtn(found)) connectBtn = found;
        }
      }
    }

    if (!connectBtn) {
      // ── Follow fallback ──────────────────────────────────────────────────
      // Some profiles only offer "Follow" (e.g. LinkedIn celebrities, pages,
      // or accounts where Connect has been withdrawn). If Connect is absent
      // after exhausting all searches, find a Follow button and follow instead.
      const _findFollow = () => {
        for (const b of document.querySelectorAll("button, [role='button']")) {
          if (b.closest("[role='menu'], .artdeco-dropdown__content")) continue;
          const txt = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          const hay = txt + " " + aria;
          if (!/\bfollow\b/.test(hay)) continue;
          if (/\bfollowing\b|\bunfollow\b|\bcontact\b/.test(hay)) continue;
          if (b.disabled) continue;
          const cs = window.getComputedStyle(b);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const rect = b.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          return b;
        }
        return null;
      };

      let followBtn = _findFollow();
      if (!followBtn) {
        for (let w = 0; w < 8 && !followBtn; w++) {
          await sleep(500);
          followBtn = _findFollow();
        }
      }

      if (followBtn) {
        console.log("[LeadCaptura] connect-queue: no Connect button — falling back to Follow");
        try { followBtn.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
        await sleep(300 + Math.random() * 200);
        if (simulateCursorMove) await simulateCursorMove(followBtn);
        await sleep(80 + Math.random() * 120);
        await dispatchHumanClick(followBtn);
        // Wait for "Following" state to appear (no modal for Follow)
        const _followingVisible = () => {
          for (const b of document.querySelectorAll(
            "main button, main a, .pvs-profile-actions button, [class*='profile-actions'] button"
          )) {
            const hay = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
            if (/\bfollowing\b/.test(hay)) return true;
          }
          return false;
        };
        for (let w = 0; w < 10; w++) {
          await sleep(300);
          if (_followingVisible()) break;
        }
        console.log("[LeadCaptura] connect-queue: Follow clicked ✓");
        return { ok: true, action: "followed" };
      }

      return { ok: false, reason: "no_connect_button" };
    }

    // Skip if already pending / following
    const hay = (
      (connectBtn.textContent || "") +
      " " +
      (connectBtn.getAttribute("aria-label") || "")
    ).toLowerCase();
    if (/\bpending\b|\bfollowing\b/.test(hay))
      return { ok: false, reason: "already_pending" };
    if (/\bmessage\b/.test(hay) && !/\bconnect\b/.test(hay))
      return { ok: false, reason: "already_connected" };

    console.log("[LeadCaptura] connect-queue: clicking Connect on", location.pathname,
      connectBtn.tagName === "A" ? "(anchor)" : "(button)");

    // Scroll the button to the centre of the viewport so its bounding rect
    // gives valid in-viewport coordinates for the pointer events.
    try { connectBtn.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
    await sleep(300 + Math.random() * 200);

    // Cursor movement + dwell before click (anti-bot)
    if (simulateCursorMove) await simulateCursorMove(connectBtn);
    await sleep(80 + Math.random() * 120);

    if (connectBtn.tagName === "A") {
      // Temporarily remove the href before clicking. When the href is present
      // (/preload/custom-invite/…), LinkedIn's SPA router intercepts the click
      // and — for untrusted synthetic events — routes to its Share modal rather
      // than the invite modal. Without the href, LinkedIn's handler falls back to
      // reading data-* attributes which correctly opens the "Add a note?" invite
      // modal. (This is the v1.0.80 approach that proved it works; the only
      // v1.0.80 failure was a 10s modal wait that was too short — now 20s.)
      const savedHref = connectBtn.getAttribute("href");
      if (savedHref) connectBtn.removeAttribute("href");
      await dispatchHumanClick(connectBtn);
      // Restore href so LinkedIn's UI remains consistent after the click.
      if (savedHref) {
        setTimeout(() => {
          try { connectBtn.setAttribute("href", savedHref); } catch {}
        }, 600);
      }
    } else {
      await dispatchHumanClick(connectBtn);
    }

    // ── Integrated wait-and-send loop ───────────────────────────────────────
    // After clicking Connect, the "Add a note to your invitation?" modal opens.
    // We must click "Send without a note". Two things can complete the invite:
    //   (a) our own _ccForceClick on the button below, and
    //   (b) the global overlay.js auto-confirm watcher, which ALSO fires on this
    //       modal (its stand-down guard only triggers during a SEARCH-page run,
    //       not this profile queue).
    // We drive (a) ourselves so we never depend on the watcher, and we accept
    // EITHER outcome. The authoritative success signal is the profile flipping
    // to a "Pending" state (or the modal we saw closing) — NOT merely catching
    // the transient modal, which made earlier versions mis-report when the modal
    // opened/closed between polls.
    const _pendingVisible = () => {
      if (
        document.querySelector(
          "main button[aria-label*='Pending' i], main a[aria-label*='Pending' i], " +
            ".pvs-profile-actions button[aria-label*='Pending' i]"
        )
      )
        return true;
      for (const b of document.querySelectorAll(
        "main button, main a, .pvs-profile-actions button"
      )) {
        if (/^pending$/i.test((b.textContent || "").replace(/\s+/g, " ").trim()))
          return true;
      }
      return false;
    };

    // Poll for the "Send without a note" button DIRECTLY every cycle — do NOT
    // gate on a separate _ccInviteModalOpen() check. Earlier versions gated on
    // that helper, which used a stricter anchored regex than the button-finder;
    // when the gate returned false the lenient finder never ran, so a clearly
    // visible button went unclicked and we mis-reported "no_dialog_appeared".
    // One matcher, used for both detection and the click target.
    let sawSendBtn = false;
    let firstClickDone = false;
    let swClickFired = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (_pendingVisible()) {
        console.log("[LeadCaptura] connect-queue: Pending detected → invitation sent ✓");
        return { ok: true };
      }

      const sendBtn = _ccFindSendBtn();
      if (sendBtn) {
        if (!sawSendBtn) {
          sawSendBtn = true;
          await sleep(280);  // let modal fully mount
        }
        if (!firstClickDone) {
          firstClickDone = true;
          if (simulateCursorMove) {
            try { await simulateCursorMove(sendBtn); } catch {}
          }
          // First click: use all nuclear strategies simultaneously
          _ccSwMainWorldClick();
          swClickFired = true;
        }
        console.log("[LeadCaptura] connect-queue: found 'Send without a note' → clicking", sendBtn);
        _ccForceClick(sendBtn);
        _ccMainWorldClick();
        // Re-fire SW main-world click every ~2s while stuck
        if (!swClickFired || Date.now() % 2000 < 200) {
          _ccSwMainWorldClick();
          swClickFired = true;
        }
      } else if (sawSendBtn) {
        console.log("[LeadCaptura] connect-queue: send button gone → invitation sent ✓");
        return { ok: true };
      }

      await sleep(200);
    }

    if (_pendingVisible()) return { ok: true };
    if (sawSendBtn) {
      console.log("[LeadCaptura] connect-queue: button stayed visible, send did not complete");
      return { ok: false, reason: "send_failed" };
    }
    console.log("[LeadCaptura] connect-queue: no invite button appeared after Connect click");
    return { ok: false, reason: "no_dialog_appeared" };
  }

  // Called on every profile page. If there is a pending connect queue in
  // chrome.storage.local, runs the connect flow and advances to the next URL.
  async function maybeRunConnectQueue() {
    let queueData;
    try {
      queueData = await new Promise((r) =>
        chrome.storage.local.get("lc_connect_queue", r)
      );
    } catch {
      return;
    }
    const queue = queueData?.lc_connect_queue;
    if (!queue || !queue.urls?.length) return;

    // Only run on profile pages
    if (!location.pathname.startsWith("/in/")) return;

    // Let the page settle before interacting
    await Human.sleep(1800 + Math.random() * 1200);

    // Bail on security challenge
    if (_ccDetectChallenge()) {
      await new Promise((r) => chrome.storage.local.remove("lc_connect_queue", r)).catch(() => {});
      Overlay.toast?.(
        "⚠️ LinkedIn security check detected — Connect All stopped. Please complete the challenge.",
        9000
      );
      return;
    }

    // Run the connect flow
    let result;
    try {
      result = await _ccConnectOnProfile();
    } catch (e) {
      result = { ok: false, reason: String(e) };
    }

    // Update persistent queue state
    const [, ...remaining] = queue.urls;
    // "followed" counts as success — the user chose to engage with this profile
    const resultStatus = result.ok
      ? (result.action === "followed" ? "followed" : "sent")
      : (result.reason || "failed");
    const updatedQueue = {
      ...queue,
      urls: remaining,
      sent: queue.sent + (result.ok ? 1 : 0),
      failed: queue.failed + (result.ok ? 0 : 1),
      results: { ...(queue.results || {}), [queue.urls[0]]: resultStatus },
    };

    // Sync result back to CRM if the lead was successfully acted on
    if (result.ok) {
      const profileUrl = queue.urls[0];
      try {
        const Api = globalThis.__lcApi;
        if (Api?.connectResult) {
          Api.connectResult(profileUrl, result.action === "followed" ? "followed" : "connected")
            .catch(() => {});
        }
      } catch {}
    }

    // Show brief progress toast on the profile page
    const done = updatedQueue.sent + updatedQueue.failed;
    const actionLabel = result.action === "followed" ? "Followed" : "Connected";
    Overlay.toast?.(
      result.ok
        ? `${actionLabel} ✓  ${done}/${updatedQueue.total}`
        : `Skipped (${result.reason || "failed"})  ${done}/${updatedQueue.total}`,
      2800
    );

    if (remaining.length > 0) {
      // Human-paced gap between profiles — 4-tier distribution, same as
      // the old inline approach so the rhythm is statistically consistent.
      const r = Math.random();
      const gap =
        r < 0.60 ? 5000 + Math.random() * 5000   // 5-10s  (60 %)
        : r < 0.82 ? 11000 + Math.random() * 8000 // 11-19s (22 %)
        : r < 0.93 ? 21000 + Math.random() * 12000 // 21-33s (11 %)
        : 38000 + Math.random() * 22000;            // 38-60s  (7 %)

      await new Promise((res) =>
        chrome.storage.local.set({ lc_connect_queue: updatedQueue }, res)
      ).catch(() => {});
      await Human.sleep(gap);
      location.href = remaining[0];
    } else {
      // Queue exhausted — clear storage and navigate back to search
      await new Promise((r) => chrome.storage.local.remove("lc_connect_queue", r)).catch(() => {});
      // Store a summary so the search page can show a toast when it loads
      await new Promise((res) =>
        chrome.storage.local.set({
          lc_connect_summary: {
            sent: updatedQueue.sent,
            failed: updatedQueue.failed,
            total: updatedQueue.total,
            results: updatedQueue.results,
          },
        }, res)
      ).catch(() => {});
      Overlay.toast?.("All done! Returning to results…", 3000);
      await Human.sleep(1500 + Math.random() * 1000);
      if (updatedQueue.returnUrl) location.href = updatedQueue.returnUrl;
    }
  }

  // Called on search/list pages to pick up a completed connect summary.
  async function maybeShowConnectSummary() {
    try {
      const data = await new Promise((r) =>
        chrome.storage.local.get(["lc_connect_summary", "lc_connect_queue"], r)
      );
      if (data.lc_connect_summary) {
        const s = data.lc_connect_summary;
        const msg =
          `Connect All done: ${s.sent} sent, ${s.failed} skipped out of ${s.total} ✓`;
        Overlay.toast?.(msg, 7000);
        Overlay.applyConnectResults?.(s.results || {});
        await new Promise((r) =>
          chrome.storage.local.remove("lc_connect_summary", r)
        ).catch(() => {});
      }
      // Stale queue left over (e.g. extension reloaded mid-run)
      if (data.lc_connect_queue && data.lc_connect_queue.urls?.length === 0) {
        const q = data.lc_connect_queue;
        Overlay.toast?.(
          `Connect All: ${q.sent} sent, ${q.failed} skipped ✓`, 5000
        );
        Overlay.applyConnectResults?.(q.results || {});
        await new Promise((r) =>
          chrome.storage.local.remove("lc_connect_queue", r)
        ).catch(() => {});
      }
    } catch {}
  }
  // ─── end Connect All queue ─────────────────────────────────────────────────

  function onPathChange() {
    // Skip the /overlay/contact-info/ sub-route that scrapeContactInfo
    // navigates to temporarily via pushState. We don't want to unmount
    // and remount the profile panel mid-scrape, and we don't want to
    // update lastPath either (so the restore replaceState is also a no-op).
    if (location.pathname.includes("/overlay/contact-info")) return;

    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const type = Scraper.pageType();

    // Always tear down everything before deciding what to render.
    Overlay.unmountProfilePanel();
    Overlay.unmountToolbar();
    Overlay.unmountSelectAllHeader?.();
    document.body.classList.remove("lc-toolbar-mounted");

    if (type === "unknown" || type === "feed") return;

    // Don't render any overlay UI on the background enrichment tab — it's
    // about to close itself, and an "Unknown profile" panel rendering before
    // LinkedIn finished hydrating just confused the user.
    if (new URLSearchParams(location.search).has("lc_enrich")) return;

    const isProfile = type === "profile" || type === "salesnav-profile";
    const isList = type === "search-people" || type === "salesnav-search";
    const isJobs = type === "jobs";

    // Profile panel opens immediately so the user sees it the moment the
    // profile URL loads. The overlay watches the h1 for name mutations and
    // re-renders as soon as LinkedIn hydrates the correct person's name.
    if (isProfile) {
      // Check for an active Connect All queue BEFORE deciding to auto-save.
      // triggerAutoSave() → saveCurrentProfile() → scrapeContactInfo() CLICKS
      // the "Contact info" link. If a connect queue is running that click races
      // with _ccConnectOnProfile() trying to click the Connect button, causing
      // the extension to hit "Contact info" instead. Suppress auto-save for the
      // entire duration of any connect queue run.
      const _launchProfile = (inConnectQueue) => {
        setTimeout(() => {
          Overlay.renderProfilePanel();
          if (!inConnectQueue) Overlay.triggerAutoSave?.();
          maybeRunConnectQueue().catch((e) =>
            console.warn("[LeadCaptura] connect queue error", e?.message || e)
          );
        }, 50);
      };
      try {
        chrome.storage.local.get("lc_connect_queue", (qData) => {
          _launchProfile(!!(qData?.lc_connect_queue?.urls?.length > 0));
        });
      } catch {
        // Storage unavailable (stale context) — assume no queue, normal flow.
        _launchProfile(false);
      }
    }

    if (isJobs) {
      // Jobs toolbar + select-all header show immediately; chip decoration
      // runs in multiple passes as cards hydrate lazily.
      setTimeout(() => {
        Overlay.renderToolbar();
        Overlay.mountSelectAllHeader?.();
        document.body.classList.add("lc-toolbar-mounted");
        try { Overlay.decorateJobCards?.(); } catch {}
      }, 150);
      [700, 1500].forEach((ms) =>
        setTimeout(() => { try { Overlay.decorateJobCards?.(); } catch {} }, ms)
      );
    } else {
      // People lists and other toolbar pages settle before decoration.
      setTimeout(() => {
        if (isList) {
          Overlay.renderToolbar();
          Overlay.mountSelectAllHeader?.();
          document.body.classList.add("lc-toolbar-mounted");
          // Show Connect All summary toast if we just returned from a run
          maybeShowConnectSummary().catch(() => {});
        }
        Overlay.decorateSearchCards();
      }, 600);
    }
  }

  // Detect SPA navigation
  const _push = history.pushState;
  history.pushState = function (...args) {
    const r = _push.apply(this, args);
    onPathChange();
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function (...args) {
    const r = _replace.apply(this, args);
    onPathChange();
    return r;
  };
  window.addEventListener("popstate", onPathChange);

  // Re-decorate the current surface (people cards on search, job cards on
  // jobs). Centralised so the interval / scroll / search-change handlers stay
  // in lock-step about which decorator to call.
  function _decorateCurrent() {
    try {
      const type = Scraper.pageType();
      if (type === "jobs") Overlay.decorateJobCards?.();
      else Overlay.decorateSearchCards?.();
    } catch (e) {
      // A transient DOM error during a re-render must never break the 1.5s
      // heartbeat — swallow it; the next tick retries on fresh DOM.
      console.warn("[LeadCaptura] decorate tick failed:", e?.message || e);
    }
  }

  // Pagination (and most LinkedIn search filters) change only the QUERY
  // STRING, not the pathname — so onPathChange early-returns and never
  // re-decorates. Watch location.search separately and re-decorate hard when
  // it changes, with a few staggered passes because the new page's cards
  // hydrate lazily over a couple of seconds.
  let lastSearch = location.search;
  function _onSearchMaybeChanged() {
    if (location.search === lastSearch) return;
    lastSearch = location.search;
    const type = Scraper.pageType();
    if (type !== "search-people" && type !== "salesnav-search" && type !== "jobs") return;
    [300, 900, 1800, 3000].forEach((ms) =>
      setTimeout(() => {
        try { _decorateCurrent(); } catch {}
      }, ms)
    );
  }

  // Periodically re-decorate (LinkedIn re-renders cards on scroll AND
  // paginates without a pathname change). 1.5s keeps chips appearing quickly
  // on freshly-rendered cards without hammering the DOM.
  setInterval(() => {
    try { _onSearchMaybeChanged(); } catch {}
    _decorateCurrent();
  }, 1500);

  // Re-decorate shortly after the user stops scrolling — catches lazily
  // virtualised cards the moment they render, rather than waiting for the
  // next interval tick.
  let _scrollDecorateTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      if (_scrollDecorateTimer) return;
      _scrollDecorateTimer = setTimeout(() => {
        _scrollDecorateTimer = null;
        try { _decorateCurrent(); } catch {}
      }, 400);
    },
    { passive: true }
  );

  // Autopilot tick: roughly every minute, but only when the tab is foreground,
  // and the actual gap between actions is enforced inside automate.js by
  // paceBetweenActions(). Self-terminates if it detects the extension was
  // reloaded (stale chrome.runtime) so we don't spam "Cannot read properties
  // of undefined (reading 'get')" errors forever.
  function startAutopilot() {
    if (autopilotInterval) return;

    // Delay the first tick by 5 s so the page finishes rendering before any
    // job-driven navigation kicks in — prevents a jarring takeover the instant
    // the user opens LinkedIn while message jobs are queued.
    setTimeout(() => { Automate.tick().catch(() => {}); }, 5000);

    autopilotInterval = setInterval(async () => {
      let runtimeAlive = false;
      try { runtimeAlive = !!chrome.runtime?.id; } catch { runtimeAlive = false; }
      if (!runtimeAlive || !chrome?.storage?.local?.get) {
        clearInterval(autopilotInterval);
        autopilotInterval = null;
        return;
      }
      // No longer short-circuit when the tab is backgrounded. Automate.tick()
      // now polls jobs and inside executeOne it only gates connect/follow on
      // foreground — message jobs flow regardless. This is what makes the
      // CRM's "Send to N leads" actually deliver while the user is looking at
      // the CRM tab (LinkedIn tab in background).
      try {
        await Automate.tick();
      } catch (e) {
        console.warn("[LeadCaptura] autopilot tick failed", e?.message || e);
      }
    }, 15_000);

    // When the user brings this LinkedIn tab to the foreground, immediately
    // check for waiting jobs instead of waiting for the next 15s tick. This
    // ensures bulk-message jobs start as soon as the user switches to LinkedIn.
    if (!_visibilityListenerAdded) {
      _visibilityListenerAdded = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        let runtimeAlive = false;
        try { runtimeAlive = !!chrome.runtime?.id; } catch {}
        if (!runtimeAlive) return;
        Automate.tick().catch(() => {});
      }, { passive: true });
    }
  }

  // Listen for settings changes (autopilot toggle from popup/options)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    onPathChange();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Liveness ping so the popup can verify the content script is responsive
    // (and re-inject if not) before sending real commands.
    if (msg?.type === "lc:ping") {
      sendResponse({
        ok: true,
        pageType: Scraper.pageType(),
        url: location.href,
      });
      return true;
    }
    if (msg?.type === "lc:scrape") {
      sendResponse(Scraper.scrapeCurrentPage());
      return true;
    }
    if (msg?.type === "lc:saveCurrent") {
      const scraped = Scraper.scrapeCurrentPage();
      if (scraped.kind === "profile" && scraped.profile?.linkedin_url) {
        // On profile pages, use the full enrichment pipeline (Contact Info modal,
        // website scraping) if the overlay is loaded — same as clicking "Save Lead"
        // in the floating panel. Respond immediately; enrichment runs in background.
        const overlay = globalThis.__lcOverlay;
        if (overlay?.saveCurrentProfile) {
          sendResponse({ ok: true });
          overlay.saveCurrentProfile(scraped.profile).catch(() => {});
          return true;
        }
        globalThis.__lcApi
          .syncProfile(scraped.profile)
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (scraped.kind === "search" && scraped.profiles?.length) {
        globalThis.__lcApi
          .syncSearch({
            page_url: location.href,
            captured_at: new Date().toISOString(),
            profiles: scraped.profiles,
          })
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      // Fallback #1: URL says we're on a profile but pageType returned
      // "unknown" — try scrapeProfile() directly. Helps when the SPA hasn't
      // hydrated yet or LinkedIn ships a sub-path we don't recognise.
      if (location.pathname.startsWith("/in/")) {
        try {
          const profile = Scraper.scrapeProfile();
          if (profile?.linkedin_url) {
            globalThis.__lcApi
              .syncProfile(profile)
              .then((r) => sendResponse({ ok: true, ...r }))
              .catch((e) => sendResponse({ ok: false, error: e.message }));
            return true;
          }
        } catch (e) {
          /* fall through */
        }
      }
      // Fallback #2: Sales Navigator profile page
      if (location.pathname.startsWith("/sales/lead/")) {
        try {
          const profile = Scraper.scrapeSalesNavProfile();
          if (profile?.linkedin_url) {
            globalThis.__lcApi
              .syncProfile(profile)
              .then((r) => sendResponse({ ok: true, ...r }))
              .catch((e) => sendResponse({ ok: false, error: e.message }));
            return true;
          }
        } catch (e) {
          /* fall through */
        }
      }
      // Fallback #3: Any page with /in/ anchors → try search-results scrape
      if (document.querySelector("a[href*='/in/']")) {
        try {
          const profiles = Scraper.scrapeSearchResults();
          if (profiles.length) {
            globalThis.__lcApi
              .syncSearch({
                page_url: location.href,
                captured_at: new Date().toISOString(),
                profiles,
              })
              .then((r) => sendResponse({ ok: true, ...r }))
              .catch((e) => sendResponse({ ok: false, error: e.message }));
            return true;
          }
        } catch (e) {
          /* fall through */
        }
      }
      sendResponse({
        ok: false,
        error: "Navigate to a LinkedIn profile or people-search page to capture.",
      });
      return true;
    }
  });

  // Auto-enrichment trigger: when the service worker opens a background tab at
  // /in/<handle>/overlay/contact-info/?lc_enrich=1, the content script runs
  // here. We wait for the page to settle, scrape the contact info (the modal
  // is pre-opened by LinkedIn's SPA router for the overlay URL), sync to the
  // backend (deduped by linkedin_url → updates the existing lead), then close.
  async function maybeRunEnrichmentTrigger() {
    const params = new URLSearchParams(location.search);
    if (!params.has("lc_enrich")) return;
    if (window.__lcEnrichmentRan) return;
    window.__lcEnrichmentRan = true;

    // Always close the tab, no matter what happens below. A blank lingering
    // background tab is the worst UX — the user sees a stale page they can't
    // explain. 75s is generous: enough for slow hydration + Contact info open
    // + sync, but short enough that broken pages disappear quickly.
    const closeSelf = () => {
      try { chrome.runtime.sendMessage({ type: "lc:closeMe" }); } catch {}
      setTimeout(() => { try { window.close(); } catch {} }, 250);
    };
    const safetyTimer = setTimeout(closeSelf, 18_000);
    let redirected = false;

    try {
      // Sales Navigator lead pages don't expose the Contact info modal —
      // LinkedIn only renders it on /in/ pages. The Sales Nav saved-list rows
      // often link to /sales/lead/<id> with no /in/ anchor in the row itself,
      // so we have to land on the Sales Nav lead page first, then bounce to
      // the matching /in/ URL via the "View LinkedIn profile" anchor.
      if (location.pathname.startsWith("/sales/lead/")) {
        const liLink = await globalThis.__lcDom.waitFor(
          [
            "a[data-control-name='visit_linkedin_profile']",
            "a[data-control-name='profile_lockup_view_full_profile']",
            "a[href*='/in/']",
          ],
          { timeout: 15000 }
        );
        if (liLink?.href && liLink.href.includes("/in/")) {
          const u = new URL(liLink.href, location.origin);
          u.searchParams.set("lc_enrich", "1");
          redirected = true;
          // Same-tab redirect; trigger re-fires on the /in/ page where the
          // Contact info modal actually exists.
          location.replace(u.toString());
          return;
        }
        // Sales Nav lead page didn't expose an /in/ link — nothing scrapable.
        return;
      }

      if (!location.pathname.startsWith("/in/")) return;

      // Wait for the profile to hydrate. Cut the ceiling so a profile that
      // refuses to render doesn't burn ~20s of bulk-run time.
      await globalThis.__lcDom.waitFor(["main h1", "h1"], { timeout: 8000 });

      // v1.0.23 aggressive cut: 0.3–0.9s base, 8% chance of 0.6–1.5s
      // long-tail. Target avg per-tab time ≤5s end-to-end.
      const base = Human.rand(300, 900);
      const longTail = Math.random() < 0.08 ? Human.rand(600, 1500) : 0;
      await Human.sleep(base + longTail);

      const profile = Scraper.scrapeProfile();
      const contact = await Scraper.scrapeContactInfo({
        settleMs: 400,
        allowPushStateFallback: true,
      });
      if (contact.email) profile.email = contact.email;
      if (contact.phone) profile.phone = contact.phone;
      if (contact.website) profile.company_url = contact.website;
      if (contact.address) profile.location = contact.address.slice(0, 200);
      // Stash all linked websites so the website scraper can try each one.
      if (contact.websites?.length) {
        profile.raw = { ...(profile.raw || {}), websites: contact.websites };
      }
      // Text-scan fallback for emails/phones the user wrote into their About
      // or Experience. This catches public contact info even when LinkedIn's
      // Contact-Info modal is empty (non-1st-degree connections).
      if ((!profile.email || !profile.phone) && Scraper._scrapeFromProfileText) {
        try {
          const fromText = Scraper._scrapeFromProfileText();
          if (!profile.email && fromText.email) profile.email = fromText.email;
          if (!profile.phone && fromText.phone) profile.phone = fromText.phone;
        } catch {}
      }
      profile.raw = { ...(profile.raw || {}), contact_info_scraped: true };
      // Carry the segment the user picked in the toolbar through the bulk
      // enrichment tab (passed as ?lc_segment= by the service worker).
      const segParam = params.get("lc_segment");
      if (segParam) profile.segment = segParam;

      try {
        await globalThis.__lcApi.syncProfile(profile);
      } catch (e) {
        console.warn("[LeadCaptura] enrichment sync failed", e?.message);
      }

      // Website scraping: fill any missing email / phone / location from the
      // company website. Uses the primary company_url plus any extra sites
      // captured from the Contact Info modal (personal site, portfolio, etc.).
      const _wsUrl = profile.company_url;
      const _wsExtra = (profile.raw?.websites || []).filter(u => u && u !== _wsUrl);
      const _wsPrimary = _wsUrl || _wsExtra[0] || null;
      const _wsAdditional = _wsUrl ? _wsExtra : _wsExtra.slice(1);
      // Run whenever we have a site AND are still missing ANY of the three
      // fields the user wants populated (email / phone / location).
      const _needsMore = !profile.email || !profile.phone || !profile.location;
      if (_wsPrimary && _needsMore) {
        try {
          const wsSettings = await globalThis.__lcStorage.getSettings();
          if (wsSettings.webScrapeEnabled) {
            const wsResult = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage(
                  { type: "lc:scrapeWebsite", url: _wsPrimary, extraUrls: _wsAdditional },
                  (r) => resolve(r || {})
                );
              } catch { resolve({}); }
            });
            // Surface the one common silent failure: the broad host permission
            // for website scraping was never granted (it lives behind the
            // Options toggle). Tell the user instead of failing invisibly.
            if (!wsResult.ok && wsResult.error === "needs_permission") {
              console.warn(
                "[LeadCaptura] Website scraping is ON but the host permission " +
                "isn't granted. Open the extension Options and re-save to grant it."
              );
            }
            if (wsResult.ok && (wsResult.emails?.length || wsResult.phones?.length || wsResult.location || wsResult.name)) {
              const merged = { ...profile };
              if (wsResult.emails?.[0] && !merged.email) merged.email = wsResult.emails[0];
              if (wsResult.phones?.[0] && !merged.phone) merged.phone = wsResult.phones[0];
              if (wsResult.location && !merged.location) merged.location = wsResult.location.slice(0, 200);
              if (wsResult.name && !merged.company_name) merged.company_name = wsResult.name;
              merged.raw = {
                ...(merged.raw || {}),
                contact_source: "website_scrape",
                scraped_emails: wsResult.emails,
                scraped_phones: wsResult.phones,
                scraped_addresses: wsResult.addresses,
                scraped_company_name: wsResult.name,
              };
              try { await globalThis.__lcApi.syncProfile(merged); } catch {}
            }
          }
        } catch { /* best-effort */ }
      }

      await Human.sleep(Human.rand(80, 200));
    } catch (e) {
      console.warn("[LeadCaptura] enrichment trigger failed", e?.message);
    } finally {
      clearTimeout(safetyTimer);
      // Skip the close on the Sales Nav → /in/ redirect: the in-flight
      // location.replace() will tear down this page in a moment.
      if (!redirected) closeSelf();
    }
  }

  // ── LinkedIn message interceptor drain ─────────────────────────────────────
  // interceptor.js (document_start) buffers conversation participants into
  // window.__lcMsgQueue. We drain that queue here — after the API client is
  // ready — and sync each unique participant as a lead. This passively turns
  // anyone the user has messaged on LinkedIn into an enriched lead, with no
  // additional page opens or LinkedIn API calls on our part.
  let _msgQueueDrained = new Set(); // deduplicate across multiple drains

  async function _drainMsgQueue() {
    const queue = window.__lcMsgQueue;
    if (!Array.isArray(queue) || !queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      const settings = await globalThis.__lcStorage.getSettings();
      if (!settings.apiKey || !settings.syncLinkedInMessages) return;
    } catch { return; }

    for (const p of batch) {
      if (!p.linkedin_url || !p.first_name) continue;
      const key = p.linkedin_url.toLowerCase().replace(/\?.*$/, "");
      if (_msgQueueDrained.has(key)) continue;
      _msgQueueDrained.add(key);
      try {
        await globalThis.__lcApi.syncProfile({
          linkedin_url: p.linkedin_url,
          first_name: p.first_name,
          last_name: p.last_name,
          full_name: p.full_name,
          headline: p.headline,
          photo_url: p.photo_url,
          raw: { contact_source: "linkedin_messages" },
        });
        console.log("[LeadCaptura] msg-sync: saved lead from conversation →", p.full_name);
      } catch (e) {
        console.warn("[LeadCaptura] msg-sync: sync failed for", p.linkedin_url, e?.message);
      }
    }
  }

  // Run drain once on boot (catches conversations already loaded by the time
  // main.js initialises) then again after 5s to catch async-loaded batches.
  setTimeout(_drainMsgQueue, 1500);
  setTimeout(_drainMsgQueue, 6000);
  // Also drain whenever the user navigates to /messaging/ SPA route.
  const _origOnPathChange = onPathChange;

  // Boot
  onPathChange();
  // Resume a bulk-message job that was mid-navigation when the previous
  // page unloaded — see automate.js _persistPending. Runs BEFORE the
  // autopilot tick so the resume finishes (and reports its result) before
  // the loop claims the next queued job.
  try { Automate.resumePendingMessage?.().catch(() => {}); } catch {}
  startAutopilot();
  maybeRunEnrichmentTrigger();

  // Connect Run resume (v1.0.155):
  // If a Connect All run was in progress when the previous page unloaded,
  // pick up here. On a /in/ profile page → run profile-page connect; on a
  // /search/ page with empty queue → gather chip URLs and start. Delayed
  // 1.8s so the overlay finishes mounting and the page hydrates.
  setTimeout(() => {
    try { globalThis.__lcOverlay?.resumeConnectRunIfActive?.().catch(() => {}); } catch {}
  }, 1800);
})();
