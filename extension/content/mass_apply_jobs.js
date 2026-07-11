// extension/content/mass_apply_jobs.js
//
// INDEPENDENT FEATURE — "Mass Apply Jobs"  (Case #6)
// =============================================================================
// This file is COMPLETELY self-contained. It does NOT import, call, or modify
// overlay.js, automate.js, main.js, scraper.js, connect_all_on_page.js, or any
// other prebuilt code. It mounts its OWN floating button on the 2026 LinkedIn
// jobs results UI and runs its OWN end-to-end apply flow. Nothing here shares
// state with the rest of the extension, so it cannot break any other feature.
//
// Flow (per the user spec):
//   1. User is on the jobs results page (/jobs/search-results/ or
//      /jobs/collections/). Left rail = job cards, right rail = job detail.
//   2. For each left card → click it so the right detail pane loads.
//   3. In the detail pane, find the IN-APP apply control:
//        <a aria-label="LinkedIn Apply to this job"
//           href=".../jobs/view/<id>/apply/...">…<span>Apply</span></a>
//      (NOT "Apply on company website" — that's an external ATS we can't fill.)
//   4. Click it → the Easy Apply modal opens. Walk the multi-step form:
//        - select dropdowns (email, phone country code, yes/no) → first valid
//        - phone / experience / numeric → fill (experience answers = "9")
//        - radios → choose "Yes"; required checkboxes → check
//        - untick "Follow <company>"
//        - keep an already-selected resume (file upload can't be scripted)
//        - click "Next" / "Review" until "Submit application", then submit.
//   5. Decline any post-submit "next best action" modal (never "Get started").
//   6. Human-paced ~30s+ gap, then the next job. If a job can't be filled,
//      discard its modal and move on.
//
// Anti-bot rules honoured (see CLAUDE.md > Bot-detection avoidance):
//   - Read-only DOM. Never calls LinkedIn internal APIs.
//   - Human-paced gaps between consequential actions (~30-75s, long tail).
//   - Human pointer-sequence clicks with realistic coordinates.
//   - Aborts on captcha/checkpoint pages.
//   - Never clicks a job card's "Dismiss X" (that nukes recommendations) — we
//     only ever click the card body, the apply anchor, and modal Next/Submit.
// =============================================================================
(function () {
  if (window.__lc_massapply_loaded) return;   // singleton
  window.__lc_massapply_loaded = true;

  const TAG = "[LeadCaptura · MassApplyJobs]";

  // ───────────────────────── helpers ─────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return min + Math.random() * (max - min); }

  function onJobsResultsPage() {
    return /^\/jobs\/(search-results|collections)\//.test(location.pathname)
        || /^\/jobs\/view\/\d+\/apply\//.test(location.pathname);
  }

  function isCheckpoint() {
    return /\/checkpoint\//.test(location.pathname)
        || /\/uas\/captcha-submit/.test(location.pathname);
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textOf(el) {
    return (el && (el.textContent || "")).replace(/\s+/g, " ").trim();
  }

  // ──────────────────── humanised clicking ───────────────────
  // Spotlight a button with a pulsing blue outline so the user can SEE which
  // control Mass Apply is about to click. Mirrors the visual style used by
  // overlay.js's working Auto Apply engine. Auto-clears after `holdMs`.
  function spotlight(el, holdMs) {
    if (!el) return;
    try {
      el.style.setProperty("outline", "3px solid #0a66c2", "important");
      el.style.setProperty("outline-offset", "3px", "important");
      el.style.setProperty("box-shadow", "0 0 0 6px rgba(10,102,194,0.25), 0 0 24px rgba(10,102,194,0.55)", "important");
      el.style.setProperty("transition", "outline .15s, box-shadow .15s", "important");
      el.style.setProperty("animation", "lc-ma-pulse-ring 0.9s ease-in-out infinite", "important");
      el.setAttribute("data-lc-ma-spotlight", "true");
      setTimeout(() => {
        try {
          el.style.removeProperty("outline");
          el.style.removeProperty("outline-offset");
          el.style.removeProperty("box-shadow");
          el.style.removeProperty("animation");
          el.removeAttribute("data-lc-ma-spotlight");
        } catch (_) {}
      }, holdMs || 1500);
    } catch (_) {}
  }

  // ── Audio alert (buzz/beep) for "a question needs your answer" ──
  // Web Audio needs a user gesture to start; the run always begins from the
  // user's click on the Mass Apply button, so we create/resume the context then
  // (see _ensureAudio() calls at run()/runSingle() start). Best-effort — if the
  // browser blocks audio, the on-screen banner still alerts the user.
  let _audioCtx = null;
  function _ensureAudio() {
    try {
      if (!_audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) _audioCtx = new AC();
      }
      if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
    } catch (_) {}
    return _audioCtx;
  }
  function beep(freq, ms) {
    try {
      const ctx = _ensureAudio();
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = freq || 880;
      g.gain.value = 0.09;
      o.connect(g); g.connect(ctx.destination);
      const now = ctx.currentTime;
      o.start(now);
      o.stop(now + (ms || 180) / 1000);
    } catch (_) {}
  }
  // Two-tone attention buzz — distinct from a single beep so it clearly means
  // "I need you."
  function buzz() {
    beep(920, 200);
    setTimeout(() => { try { beep(660, 240); } catch (_) {} }, 240);
  }

  function humanClick(el) {
    if (!el) return false;
    try {
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + (Math.random() * 6 - 3);
      const cy = r.top + r.height / 2 + (Math.random() * 4 - 2);
      // The 2026 SDUI apply flow is React-driven. React's synthetic event system
      // drops PointerEvents that lack pointerId / pointerType / isPrimary, so a
      // bare-options PointerEvent never registers the click. Set them.
      const down = { bubbles: true, cancelable: true, view: window,
                     clientX: cx, clientY: cy, button: 0, buttons: 1,
                     pointerId: 1, pointerType: "mouse", isPrimary: true,
                     width: 1, height: 1, pressure: 0.5 };
      const up = Object.assign({}, down, { buttons: 0, pressure: 0 });
      el.dispatchEvent(new PointerEvent("pointerover", down));
      el.dispatchEvent(new PointerEvent("pointerenter", down));
      el.dispatchEvent(new PointerEvent("pointerdown", down));
      el.dispatchEvent(new MouseEvent("mousedown", down));
      el.dispatchEvent(new PointerEvent("pointerup", up));
      el.dispatchEvent(new MouseEvent("mouseup", up));
      el.dispatchEvent(new MouseEvent("click", up));
    } catch (_) {}
    return true;
  }

  // Click-of-last-resort for modal primary buttons (Ember binds handlers late).
  function forceClick(btn) {
    if (!btn) return false;
    try { btn.click(); } catch (_) {}
    try { humanClick(btn); } catch (_) {}
    try {
      const inner = btn.querySelector(".artdeco-button__text") || btn.firstElementChild;
      if (inner) humanClick(inner);
    } catch (_) {}
    return true;
  }

  // Set <input>/<select>/<textarea> value through the native setter so the
  // React/Ember change tracker fires (a plain .value = … is swallowed).
  function setNativeValue(el, value) {
    try {
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype
                  : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      // Mark our own writes so the learned-answers capture never records the
      // engine's guesses as if they were the user's answers.
      try { el.setAttribute("data-lc-autofilled", "1"); } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  // ─────────────────── job-card detection ────────────────────
  // Left-rail job cards each carry a "Dismiss <Title> job" button. We anchor on
  // that (stable aria-label shape) and climb to the clickable card root. We
  // NEVER click that Dismiss button — only use it to locate + key each card.
  function collectJobCards() {
    const seen = new Set();
    const cards = [];
    document
      .querySelectorAll('button[aria-label^="Dismiss "][aria-label$=" job"]')
      .forEach(btn => {
        const card = btn.closest('div[role="button"][componentkey]')
                  || btn.closest('div[role="button"]');
        if (!card) return;
        const key = card.getAttribute("componentkey")
                 || (btn.getAttribute("aria-label") || "");
        if (!key || seen.has(key)) return;
        seen.add(key);
        cards.push({ key, el: card, title: (btn.getAttribute("aria-label") || "")
          .replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim() });
      });
    // Additive second pass — the 2026 hashed-class SDUI layout keys each job
    // card as componentkey="job-card-component-ref-<jobId>" on a
    // div[role="button"]. Collect those directly so card detection survives
    // any change to the Dismiss button's aria-label. Only adds cards the
    // Dismiss-climb above didn't already register (dedup by key), so it can
    // never double-process or change existing behaviour.
    document
      .querySelectorAll('div[role="button"][componentkey^="job-card-component-ref"]')
      .forEach(card => {
        const key = card.getAttribute("componentkey");
        if (!key || seen.has(key)) return;
        seen.add(key);
        const dis = card.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]');
        const title = dis
          ? (dis.getAttribute("aria-label") || "").replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim()
          : "";
        cards.push({ key, el: card, title });
      });
    // Additive third pass — the CLASSIC (Ember) jobs layout renders each card
    // as <li data-occludable-job-id="<id>"> containing
    // <div data-job-id="<id>" class="job-card-container ...">. These have NO
    // role="button" and NO componentkey, so the two passes above miss them.
    // Collect them by their stable numeric job id (which cardElForKey can
    // resolve back). Deduped by key so a card already found above is never
    // double-processed; this only adds cards the other passes couldn't see.
    document
      .querySelectorAll('div[data-job-id].job-card-container, li[data-occludable-job-id]')
      .forEach(node => {
        const jid = node.getAttribute("data-job-id") || node.getAttribute("data-occludable-job-id");
        if (!jid || seen.has(jid)) return;
        // Prefer the inner clickable card container as the click target.
        const cardEl = node.matches("div.job-card-container")
          ? node
          : (node.querySelector("div[data-job-id].job-card-container") || node);
        if (!cardEl) return;
        seen.add(jid);
        const titleLink = cardEl.querySelector(
          "a.job-card-list__title--link, a.job-card-container__link, a[aria-label]"
        );
        const title = titleLink
          ? (titleLink.getAttribute("aria-label") || (titleLink.textContent || "").replace(/\s+/g, " ").trim())
          : "";
        cards.push({ key: jid, el: cardEl, title });
      });
    // Additive fourth pass — a newer hashed-class layout puts the stable
    // componentkey="job-card-component-ref-<id>" on a PLAIN wrapper <div> while
    // the clickable role="button" is a DESCENDANT carrying a different (UUID)
    // componentkey. The second pass (which requires role="button" on the SAME
    // element) misses these, and there is no Dismiss button or data-job-id
    // either. Collect by the job-card-component-ref key on ANY element and use
    // the inner role="button" as the click target. Deduped by key so a card
    // already registered by the passes above is never processed twice.
    document
      .querySelectorAll('[componentkey^="job-card-component-ref"]')
      .forEach(node => {
        const key = node.getAttribute("componentkey");
        if (!key || seen.has(key)) return;
        // Click target: this element if it's itself role="button", else the
        // first descendant role="button", else the element itself.
        const clickable = (node.getAttribute("role") === "button")
          ? node
          : (node.querySelector('[role="button"]') || node);
        if (!clickable) return;
        seen.add(key);
        const dis = node.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]');
        let title = "";
        if (dis) {
          title = (dis.getAttribute("aria-label") || "").replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim();
        } else {
          const t = node.querySelector('p span[aria-hidden="true"]') || node.querySelector("p");
          title = t ? (t.textContent || "").replace(/\s+/g, " ").trim() : "";
        }
        cards.push({ key, el: clickable, title });
      });
    return cards;
  }

  function cardElForKey(key) {
    const esc = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
    let el = null;
    try { el = document.querySelector('div[role="button"][componentkey="' + esc + '"]'); } catch (_) {}
    // Classic (Ember) layout fallback: cards are keyed by their numeric job id
    // on div[data-job-id].job-card-container (or li[data-occludable-job-id]).
    if (!el) {
      try {
        el = document.querySelector('div[data-job-id="' + esc + '"].job-card-container')
          || document.querySelector('li[data-occludable-job-id="' + esc + '"] div[data-job-id].job-card-container')
          || document.querySelector('li[data-occludable-job-id="' + esc + '"]');
      } catch (_) {}
    }
    // Newer hashed-class fallback: the componentkey="job-card-component-ref-<id>"
    // may sit on a plain wrapper whose clickable role="button" is a descendant.
    if (!el && typeof key === "string" && key.indexOf("job-card-component-ref") === 0) {
      try {
        const host = document.querySelector('[componentkey="' + esc + '"]');
        if (host) el = (host.getAttribute("role") === "button") ? host : (host.querySelector('[role="button"]') || host);
      } catch (_) {}
    }
    return el;
  }

  // The left job list is VIRTUALISED — only a handful of cards exist in the DOM
  // at once. We must scroll the list's own scroll container (not the window) to
  // render the rest. Find that container by climbing from a card to the first
  // scrollable ancestor.
  function listScroller() {
    // Anchor on an actual job card — present on EVERY layout — then climb to the
    // first scrollable ancestor. The old anchor (Dismiss button →
    // closest('div[role="button"]')) returned null on the 2026 hashed-class
    // layout, where the Dismiss button has no role="button" ancestor. A null
    // scroller made scrollListDown() a no-op, so the run couldn't load the rest
    // of a virtualised page and paginated after only the first few cards.
    let anchor = document.querySelector('[componentkey^="job-card-component-ref"]')
      || document.querySelector('div[data-job-id].job-card-container')
      || document.querySelector('li[data-occludable-job-id]');
    if (!anchor) {
      const btn = document.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]');
      anchor = btn ? (btn.closest('div[role="button"]') || btn) : null;
    }
    let el = anchor;
    while (el && el !== document.body) {
      try {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 24) return el;
      } catch (_) {}
      el = el.parentElement;
    }
    return null;
  }
  function _firstCardEl() {
    return document.querySelector('[componentkey^="job-card-component-ref"]')
      || document.querySelector('div[data-job-id].job-card-container')
      || document.querySelector('li[data-occludable-job-id]');
  }
  function _lastCardEl() {
    const c = document.querySelectorAll(
      '[componentkey^="job-card-component-ref"], div[data-job-id].job-card-container, li[data-occludable-job-id]'
    );
    return c.length ? c[c.length - 1] : null;
  }
  function listScrollTop() {
    const s = listScroller();
    if (s) return Math.round(s.scrollTop);
    // No detectable scroll container: use the first card's viewport position as
    // a scroll-position proxy so scroll progress is still measurable.
    const c = _firstCardEl();
    if (c) { try { return Math.round(c.getBoundingClientRect().top); } catch (_) {} }
    return Math.round(window.scrollY);
  }
  function scrollListDown() {
    const s = listScroller();
    if (s) { s.scrollBy(0, Math.round(s.clientHeight * 0.8)); return true; }
    // Fallback for layouts where the scroll container can't be resolved: nudge
    // the last rendered job card into view, which advances the virtualised list
    // without scrolling the whole page into the LinkedIn footer.
    const last = _lastCardEl();
    if (last) { try { last.scrollIntoView({ block: "end", behavior: "instant" }); return true; } catch (_) {} }
    return false;
  }

  // Advance to the NEXT results page — robustly. LinkedIn rewrites its
  // pagination markup constantly, so we try every known control in order
  // (newest first) rather than a single selector; a single-selector miss was
  // what made a run stop after one page. Returns true only when the page
  // actually changed (detected by a URL-query change OR the top card's key
  // changing), so the caller never mistakes "no-op click" for progress.
  async function goToNextResultsPage() {
    let nextBtn =
      document.querySelector('button[data-testid="pagination-controls-next-button-visible"]:not([disabled])') ||
      document.querySelector('button[data-testid="pagination-controls-next-button"]:not([disabled])') ||
      document.querySelector('button[aria-label="View next page"]:not([disabled])') ||
      document.querySelector('button[aria-label*="next page" i]:not([disabled])') ||
      document.querySelector('.artdeco-pagination__button--next:not([disabled])') ||
      null;

    // Button whose visible label is a child <span> "Next" + a chevron icon.
    if (!nextBtn) {
      nextBtn = Array.from(document.querySelectorAll("button")).find(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
        return /^next$/i.test(t) && b.querySelector("svg[id*='chevron-right' i], [class*='chevron-right']");
      }) || null;
    }

    // Numbered indicators (data-testid form): click current+1.
    if (!nextBtn) {
      const pageBtns = Array.from(document.querySelectorAll(
        'button[data-testid^="pagination-indicator-"][aria-label^="Page "]'
      ));
      if (pageBtns.length) {
        const cur = pageBtns.find(b => b.getAttribute("aria-current") === "true");
        const curNum = cur ? parseInt((cur.getAttribute("aria-label") || "").replace(/\D/g, ""), 10) : NaN;
        if (!isNaN(curNum)) {
          nextBtn = pageBtns.find(b =>
            parseInt((b.getAttribute("aria-label") || "").replace(/\D/g, ""), 10) === curNum + 1
          ) || null;
        }
      }
    }

    // Classic Ember indicators (<li> list): active → next sibling's button.
    if (!nextBtn) {
      const indicators = Array.from(document.querySelectorAll("li.artdeco-pagination__indicator--number"));
      const activeIdx = indicators.findIndex(li =>
        li.classList.contains("active") || li.querySelector("[aria-current]") || li.getAttribute("aria-current") === "true"
      );
      if (activeIdx >= 0 && activeIdx < indicators.length - 1) {
        nextBtn = indicators[activeIdx + 1].querySelector("button");
      }
    }

    if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true" || !visible(nextBtn)) {
      return false;
    }

    const prevSearch = location.search;
    const prevFirstKey = (collectJobCards()[0] || {}).key || "";
    setLabel("Loading next page… · " + state.applied + " applied");
    try { nextBtn.scrollIntoView({ block: "center" }); } catch (_) {}
    await sleep(rand(500, 900));
    humanClick(nextBtn);

    // Wait up to 9s for the page to actually change.
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      if (state.cancel) return false;
      if (location.search !== prevSearch) break;
      const fk = (collectJobCards()[0] || {}).key || "";
      if (fk && fk !== prevFirstKey) break;
      await sleep(300);
    }
    await sleep(rand(1800, 2800));   // let the fresh page hydrate
    const nowFirstKey = (collectJobCards()[0] || {}).key || "";
    return (location.search !== prevSearch) || (!!nowFirstKey && nowFirstKey !== prevFirstKey);
  }

  // The in-app apply control inside the right detail pane. Detects the older
  // "Easy Apply" label, the renamed "LinkedIn Apply to this job", and the
  // hashed-class new layouts — on BOTH <button> and <a>. The external "Apply
  // on company website" anchor is excluded so we never start applications we
  // can't auto-fill.
  function findInAppApply() {
    // Prefer the right-hand detail pane; fall back to <main>; finally the
    // whole document. The footer-rejection below makes the wider scope safe.
    const root = document.querySelector(
      ".jobs-search__job-details, .jobs-search__job-details--container, " +
      ".jobs-search__job-details--wrapper, .scaffold-layout__detail, " +
      ".jobs-details, .job-view-layout, .jobs-details__main-content, " +
      ".job-details-jobs-unified-top-card__container--two-pane"
    ) || document.querySelector("main") || document;

    // Reject any element that lives inside the LinkedIn page footer, promo
    // strip, language picker, or the LEFT job-list column — these are the
    // things v1.0.249/250/251 were accidentally clicking. The leftmost
    // job-list rail also contains per-card "Auto Apply" chips; clicking them
    // re-opens the same job and never starts a fresh apply.
    const inForbiddenSubtree = (el) =>
         !!el.closest("footer, [role='contentinfo']")
      || !!el.closest(".jobs-search-results-list, .jobs-search-results, .scaffold-layout__list, ul[role='list']")
      || !!el.closest(".global-footer, .footer, [class*='global-footer'], [class*='page-footer']")
      || !!el.closest("[data-test-modal-id='collection-banner-modal'], .artdeco-toast-item")
      || !!el.closest(".lc-job-apply-row");  // our own per-card chip

    const isExternal = (el) => {
      const t = textOf(el).toLowerCase();
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      if (a.includes("company website") || /apply on company website/i.test(t)) return true;
      if (el.querySelector("svg#link-external-medium, svg[id='link-external-medium']")) return true;
      const href = (el.getAttribute("href") || "").toLowerCase();
      if (href && /\/safety\/go\?|linkedin\.com\/safety\/go/.test(href)) return true;
      return false;
    };

    // A candidate is the REAL in-app apply control only if at least one strong
    // signal matches. Plain text "Apply" without any of these is REJECTED —
    // too many false positives in the footer / promo strips.
    const isInAppApply = (el) => {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const href = (el.getAttribute("href") || "").toLowerCase();
      // Explicit match for the 2026 hashed-class detail-pane apply button,
      // whose aria-label is exactly "Easy Apply to this job" or "LinkedIn
      // Apply to this job" (with the linkedin-bug-medium glyph + "Easy Apply"
      // text inside). Additive — the general regex below already covers these,
      // this just pins the exact labels so the condition is unmistakable.
      if (aria === "easy apply to this job" || aria === "linkedin apply to this job") return true;
      if (/easy apply|linkedin apply/i.test(aria)) return true;
      // Classic (Ember) top-card apply button: stable id + test hook, e.g.
      // <button id="jobs-apply-button-id" data-live-test-job-apply-button
      //   aria-label="LinkedIn Apply to <role> at <company>" class="jobs-apply-button">.
      // Additive — the jobs-apply-button class check below already covers it.
      if (el.id === "jobs-apply-button-id" || el.hasAttribute("data-live-test-job-apply-button")) return true;
      if (el.classList && el.classList.contains("jobs-apply-button")) return true;
      if (el.closest && el.closest(".jobs-apply-button__container, [class*='jobs-apply-button']")) return true;
      // The 2026 in-app control is an <a> pointing at LinkedIn's own
      // /jobs/view/<id>/apply/ URL — a reliable in-app signal.
      if (/(^|linkedin\.com)\/jobs\/view\/\d+\/apply/i.test(href)) return true;
      // SVG bug icon — LinkedIn's branded Apply button uses this glyph.
      if (el.querySelector && el.querySelector("svg#linkedin-bug-medium, svg[id^='linkedin-bug']")) return true;
      return false;
    };

    const cands = Array.from(root.querySelectorAll("button, a"));
    for (const el of cands) {
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (inForbiddenSubtree(el)) continue;
      if (isExternal(el)) continue;
      if (!isInAppApply(el)) continue;
      return el;
    }
    // Last-resort, document-wide fallback for the exact detail-pane apply button
    // by aria-label ("Easy Apply to this job" / "LinkedIn Apply to this job"),
    // in case the detail-pane root scoping above matched the wrong/stale pane on
    // the fully-hashed layout. Additive — only runs when the scoped scan found
    // nothing; still rejects forbidden subtrees (page footer, left job list, our
    // own chips) and the external "company website" apply.
    const exact = document.querySelectorAll(
      'button[aria-label="Easy Apply to this job"],' +
      'a[aria-label="Easy Apply to this job"],' +
      'button[aria-label="LinkedIn Apply to this job"],' +
      'a[aria-label="LinkedIn Apply to this job"]'
    );
    for (const el of exact) {
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (inForbiddenSubtree(el)) continue;
      if (isExternal(el)) continue;
      return el;
    }
    return null;
  }

  // ─────────────────── easy-apply modal ──────────────────────
  // The Next/Review/Submit buttons carry GLOBALLY-UNIQUE attributes that only
  // ever exist inside the Easy Apply form, so we detect + click them at
  // document scope. The Next button lives in a <footer> that is a SIBLING of
  // (not inside) the progress "region", so scoping the search to that region —
  // or to any single container — silently misses it. Document scope is the fix.
  function applyFormPresent() {
    // Structural check first: any visible dialog that passes the structural
    // Easy Apply test (Apply to <Company> heading, jobs-apply-header,
    // data-test-modal-id, progress region, or contains a data-easy-apply-*
    // button). Robust even on steps with no action button rendered yet.
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'));
    for (const d of dialogs) if (visible(d) && isEasyApplyDialog(d)) return true;
    // Fallbacks — progress region or any apply-button selector visible.
    if (
      document.querySelector('[aria-label*="job application progress" i][role="region"]') ||
      document.querySelector(
        "button[data-easy-apply-next-button]," +
        "button[data-live-test-easy-apply-next-button]," +
        'button[aria-label="Continue to next step"],' +
        "button[data-live-test-easy-apply-submit-button]," +
        'button[aria-label="Submit application"],' +
        "button[data-live-test-easy-apply-review-button]," +
        'button[aria-label="Review your application"]'
      )
    ) return true;
    // New SDUI form: a Next/Continue/Review/Submit action button in a non-page
    // <footer>. runApplyModal() is only ever entered AFTER the Apply button was
    // clicked, so this button existing means the SDUI apply form is open.
    return !!sduiAnyActionBtn();
  }

  // The container we autofill WITHIN. This MUST be the Easy Apply modal —
  // never <document>. If we can't pin down a real modal/form container, we
  // return null and the caller skips autofill entirely. v1.0.252/253 fell
  // back to document, which caused autofill to click random thumbs / On-site
  // chips / "Show match details" buttons all over the page — opening the
  // LinkedIn feedback and Preferences-match popups instead of advancing.
  function applyFormScope() {
    const modal = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],' +
      'div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      ".jobs-easy-apply-modal,.jobs-easy-apply-modal__content,.jobs-easy-apply-content"
    );
    if (modal && visible(modal)) return modal;
    const region = document.querySelector('[aria-label*="job application progress" i][role="region"]');
    if (region) {
      const c = region.closest("form, .artdeco-modal, div[role='dialog'], .jobs-easy-apply-modal");
      if (c && visible(c)) return c;
    }
    // Anchor on the Next/Submit button (globally unique in the apply form)
    // and climb to the nearest form/dialog/modal container.
    const btn = document.querySelector(
      "button[data-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-submit-button]," +
      "button[data-live-test-easy-apply-review-button]," +
      'button[aria-label="Continue to next step"],' +
      'button[aria-label="Submit application"],' +
      'button[aria-label="Review your application"]'
    );
    if (btn) {
      const c = btn.closest("form, .artdeco-modal, div[role='dialog'], .jobs-easy-apply-modal");
      if (c && visible(c)) return c;
    }
    // New SDUI form: anchor on its footer action button and climb to the
    // nearest ancestor that also holds the step's form fields, so autofill is
    // scoped to the apply form — never <document>. If a step has no fillable
    // fields, fall back to the footer's parent (still a bounded container).
    const sdui = sduiAnyActionBtn();
    if (sdui) {
      let c = sdui.closest("form");
      if (!c) {
        let node = (sdui.closest("footer") || sdui).parentElement;
        for (let i = 0; node && i < 6; i++, node = node.parentElement) {
          if (node.querySelector("input, select, textarea, [contenteditable='true'], fieldset")) { c = node; break; }
        }
        if (!c) c = (sdui.closest("footer") || sdui).parentElement;
      }
      if (c && visible(c)) return c;
    }
    return null;   // safer than <document>
  }

  function qDoc(sels) {
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e && visible(e) && !e.disabled) return e;
    }
    return null;
  }

  // Helper — find the Easy Apply dialog itself so the action-button finders
  // can scope to it. Falls back to document if no dialog node is found.
  function easyApplyDialogEl() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'));
    for (const d of dialogs) {
      if (visible(d) && isEasyApplyDialog(d)) return d;
    }
    return document;
  }

  // Text/aria matcher — used as a last-resort fallback when LinkedIn changes
  // the data-attributes. Looks only at buttons inside the Easy Apply dialog.
  function findActionByText(re) {
    const scope = easyApplyDialogEl();
    const btns = Array.from(scope.querySelectorAll("button, [role='button']"));
    for (const b of btns) {
      if (!visible(b)) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (re.test(t) || re.test(a)) return b;
    }
    return null;
  }

  // ── New SDUI (hashed-class) apply form support ──────────────────────────
  // LinkedIn's 2026 "SDUI" apply flow renders its action button as a plain
  // <button> inside a <footer>, with NO aria-label and NO data-* hooks — only
  // its visible text ("Next" / "Continue" / "Review" / "Submit application")
  // and a per-instance `componentkey`. The classic Easy Apply selectors above
  // never match it. This finder is a LAST-RESORT fallback used only after the
  // existing selectors return null, so the proven Ember/Easy-Apply path is
  // completely unchanged.
  //
  // Safety gates (so a page-chrome / pagination "Next" is never mistaken for
  // the apply footer button): the element must (a) be a real <button>,
  // (b) live inside a <footer>, (c) NOT be the global/page footer or a
  // pagination control, and (d) have EXACTLY the expected action text.
  function sduiFooterActionBtn(labelRe) {
    const footers = Array.from(document.querySelectorAll("footer"));
    for (const f of footers) {
      if (f.matches("[role='contentinfo'], .global-footer, [class*='global-footer'], [class*='page-footer']")) continue;
      if (f.closest("[role='contentinfo'], .global-footer, [class*='global-footer'], [class*='page-footer'], .artdeco-pagination")) continue;
      for (const b of Array.from(f.querySelectorAll("button"))) {
        if (!visible(b)) continue;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
        if (b.closest(".artdeco-pagination")) continue;
        const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
        if (labelRe.test(t)) return b;
      }
    }
    return null;
  }
  // Any SDUI apply-form action button (Next/Continue/Review/Submit) — used as
  // a supplementary "the apply form is open / autofill here" signal.
  function sduiAnyActionBtn() {
    return sduiFooterActionBtn(
      /^(next|continue to next step|continue|next step|review|review your application|review application|submit|submit application|send|send application)$/i
    );
  }

  function nextButton() {
    return qDoc([
      "button[data-easy-apply-next-button]",
      "button[data-live-test-easy-apply-next-button]",
      'button[aria-label="Continue to next step"]',
      'button[aria-label*="Continue to next" i]',
    ]) || findActionByText(/^(next|continue to next step|continue|next step)$/i)
       || sduiFooterActionBtn(/^(next|continue to next step|continue|next step)$/i);
  }
  function reviewButton() {
    return qDoc([
      "button[data-live-test-easy-apply-review-button]",
      'button[aria-label="Review your application"]',
      'button[aria-label*="Review your" i]',
    ]) || findActionByText(/^(review|review your application|review application)$/i)
       || sduiFooterActionBtn(/^(review|review your application|review application)$/i);
  }
  function submitButton() {
    return qDoc([
      "button[data-live-test-easy-apply-submit-button]",
      'button[aria-label="Submit application"]',
      'button[aria-label*="Submit application" i]',
    ]) || findActionByText(/^(submit|submit application|send|send application)$/i)
       || sduiFooterActionBtn(/^(submit|submit application|send|send application)$/i);
  }

  // ─── proven click sequence, mirrored from overlay.js's working engine ───
  // STAGE 1 — humanClick: a real pointer-event sequence. This is what
  // overlay.js's dispatchHumanClick fires and is what the LinkedIn SPA
  // listens for. The classic Easy Apply Ember modal advances on this alone.
  // The new SDUI React modal also accepts it as the entry attempt.
  // STAGE 2 — escalate ONLY if the form didn't advance: native .click() →
  // inner span click → keyboard Enter → React fiber onClick(isTrusted:true).
  // Firing all five at once (which v1.0.250 did) causes the second strategy
  // to land AFTER the form already advanced, hitting the NEXT step's button
  // — which is why the modal looked stuck at 1/4.
  function escalateClick(btn) {
    if (!btn) return;
    try { btn.click(); } catch (_) {}
    try {
      const inner = btn.querySelector(".artdeco-button__text") || btn.querySelector("span") || btn.firstElementChild;
      if (inner && inner !== btn) { try { inner.click(); } catch (_) {} humanClick(inner); }
    } catch (_) {}
    try {
      const k = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      btn.dispatchEvent(new KeyboardEvent("keydown", k));
      btn.dispatchEvent(new KeyboardEvent("keyup", k));
    } catch (_) {}
    try {
      const fKey = Object.keys(btn).find(
        k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (fKey) {
        let fiber = btn[fKey];
        for (let depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
          const onClick = (fiber.memoizedProps && fiber.memoizedProps.onClick)
                      || (fiber.pendingProps && fiber.pendingProps.onClick);
          if (typeof onClick === "function") {
            onClick({
              type: "click", bubbles: true, cancelable: true,
              isTrusted: true, target: btn, currentTarget: btn,
              preventDefault: () => {}, stopPropagation: () => {},
              nativeEvent: { isTrusted: true },
            });
            break;
          }
        }
      }
    } catch (_) {}
  }

  // Visible-text fingerprint of the modal content area. The proven engine
  // detects "did the step advance?" by comparing innerText — far more
  // reliable than progress-bar % or character counts, and immune to LinkedIn
  // renaming its internal CSS classes.
  function modalText() {
    const m = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],' +
      'div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      ".jobs-easy-apply-modal,.jobs-easy-apply-content,.jobs-easy-apply-form," +
      "[class*='easy-apply-content'],.artdeco-modal__content"
    );
    return ((m || document).innerText || "").trim();
  }

  // ─────────────────── form autofill ─────────────────────────
  function untickFollowCompany(scope) {
    const cb = (scope || document).querySelector("#follow-company-checkbox");
    if (cb && cb.checked) {
      const lab = (scope || document).querySelector('label[for="follow-company-checkbox"]');
      humanClick(lab || cb);
    }
  }

  function looksLikeExperience(str) {
    return /experien|years|how many|number of|notice period|salary|ctc|expected/i.test(str || "");
  }

  // Detect "No longer accepting applications" / closed jobs in the detail
  // pane. Opening Easy Apply on these triggers LinkedIn's "Preferences match"
  // modal instead of a real apply form — which my autofill then walks into.
  function detailPaneIsClosedJob() {
    const root = document.querySelector(
      ".jobs-search__job-details, .scaffold-layout__detail, .jobs-details, .job-view-layout"
    ) || document;
    const txt = (root.innerText || "").toLowerCase();
    return /no longer accepting applications|this job is no longer|applications are closed/i.test(txt);
  }

  // Apply Profile — user's stored answers for repeat-question autofill.
  // Loaded from chrome.storage.local["lc_apply_profile"]; sensible defaults
  // until the user customises them. Future Options page lets the user edit.
  // No hard-coded personal data — the user fills these in the extension Options
  // page (Auto-Apply — Application profile), which writes lc_apply_profile.
  // Neutral EEO defaults are kept so those optional questions still advance.
  let APPLY_PROFILE = {
    full_name: "",
    email: "",
    phone: "",
    nationality: "",
    city: "",
    country: "",
    current_title: "",
    years_of_experience: "",
    years_in_role: "",
    education: "",
    notice_period_days: "",
    languages: "",
    expected_salary: "",
    expected_salary_currency: "",
    current_salary: "",
    current_salary_currency: "",
    willing_to_relocate: "Yes",
    authorized_to_work: "Yes",
    require_sponsorship: "No",
    visa_status: "",
    driving_license: "",
    work_mode: "",
    gender: "Prefer not to say",
    ethnicity: "Prefer not to say",
    veteran_status: "Prefer not to say",
    disability_status: "Prefer not to say",
    linkedin_url: "",
    portfolio_url: "",
    github_url: "",
    website: "",
    cover_letter: "",
  };
  // Learned answers — questions the engine has seen answered before (either
  // prefilled by LinkedIn from the user's past manual applications, or entered
  // by the user). Keyed by a normalized question label → answer. Persisted in
  // chrome.storage.local["lc_learned_answers"] so it survives across jobs,
  // pages, sessions, and grows smarter over time.
  let LEARNED = {};
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["lc_apply_profile", "lc_learned_answers"], (res) => {
        if (res && res.lc_apply_profile && typeof res.lc_apply_profile === "object") {
          APPLY_PROFILE = Object.assign({}, APPLY_PROFILE, res.lc_apply_profile);
        }
        if (res && res.lc_learned_answers && typeof res.lc_learned_answers === "object") {
          LEARNED = Object.assign({}, res.lc_learned_answers);
        }
      });
      // Keep both in sync if the user edits the Options page mid-session.
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          if (changes.lc_apply_profile && changes.lc_apply_profile.newValue) {
            APPLY_PROFILE = Object.assign({}, APPLY_PROFILE, changes.lc_apply_profile.newValue);
          }
          if (changes.lc_learned_answers && changes.lc_learned_answers.newValue) {
            LEARNED = Object.assign({}, changes.lc_learned_answers.newValue);
          }
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Normalize a question label to a stable key for the learned-answers map.
  function _normLabel(s) {
    return (s || "").toString().toLowerCase()
      .replace(/\*|\(required\)|required/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Record an answer the user (or LinkedIn's prefill of the user's past answer)
  // provided, so the engine can auto-answer the SAME question next time. Never
  // records the engine's own writes (those are marked data-lc-autofilled).
  function rememberAnswer(label, value) {
    const key = _normLabel(label);
    const val = (value == null ? "" : String(value)).trim();
    if (!key || key.length < 3 || !val || val.length > 300) return;
    if (LEARNED[key] === val) return;
    LEARNED[key] = val;
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ lc_learned_answers: LEARNED });
      }
    } catch (_) {}
  }

  // Map a question label → a sensible answer from the Apply Profile. Order
  // matters: specific patterns first. Returns null if no rule matches.
  function answerForLabel(rawLabel) {
    const l = (rawLabel || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!l) return null;
    // 0) Learned answers win — anything the user has answered before for this
    //    exact question is reused automatically.
    const learned = LEARNED[_normLabel(rawLabel)];
    if (learned != null && learned !== "") return learned;
    // Identity fields from the saved profile.
    if (/\b(full name|your name|first and last name|name)\b/.test(l) && !/company|manager|reference|user ?name|file/.test(l)) return APPLY_PROFILE.full_name;
    if (/e-?mail/.test(l)) return APPLY_PROFILE.email;
    if (/phone|mobile|contact number/.test(l)) return APPLY_PROFILE.phone;
    if (/nationality|citizenship/.test(l)) return APPLY_PROFILE.nationality;
    if (/\bcity\b|current location|which city/.test(l)) return APPLY_PROFILE.city;
    if (/\bcountry\b|country of residence/.test(l)) return APPLY_PROFILE.country;
    if (/current (job )?title|present title|current role|most recent (job )?title|job title/.test(l)) return APPLY_PROFILE.current_title;
    if (/highest (level of )?education|education level|qualification|degree/.test(l)) return APPLY_PROFILE.education;
    if (/language/.test(l)) return APPLY_PROFILE.languages;
    if (/driving licen|driver'?s? licen/.test(l)) return APPLY_PROFILE.driving_license;
    if (/visa status|residenc|iqama|work permit|residence permit/.test(l)) return APPLY_PROFILE.visa_status;
    if (/on-?site|hybrid|remote|work (mode|arrangement|setting)/.test(l)) return APPLY_PROFILE.work_mode;
    if (/years.*experience|how many years|total experience|relevant experience/.test(l)) return APPLY_PROFILE.years_of_experience;
    if (/notice period/.test(l)) return APPLY_PROFILE.notice_period_days;
    if (/expected .*currency|currency.*expected/.test(l)) return APPLY_PROFILE.expected_salary_currency;
    if (/current .*currency|currency.*current|salary currency/.test(l)) return APPLY_PROFILE.current_salary_currency;
    if (/expected (salary|ctc|compensation)|salary expectation/.test(l)) return APPLY_PROFILE.expected_salary;
    if (/current (salary|ctc|compensation)|present salary/.test(l)) return APPLY_PROFILE.current_salary;
    if (/willing to relocate|open to relocat|relocation/.test(l)) return APPLY_PROFILE.willing_to_relocate;
    if (/authori[sz]ed to work|right to work|work authori/.test(l)) return APPLY_PROFILE.authorized_to_work;
    if (/sponsorship|require .* visa|visa sponsor/.test(l)) return APPLY_PROFILE.require_sponsorship;
    if (/\bgender\b/.test(l)) return APPLY_PROFILE.gender;
    if (/linkedin.*url|linkedin profile/.test(l)) return APPLY_PROFILE.linkedin_url;
    if (/portfolio/.test(l)) return APPLY_PROFILE.portfolio_url;
    if (/github/.test(l)) return APPLY_PROFILE.github_url;
    if (/website|personal site/.test(l)) return APPLY_PROFILE.website;
    if (/cover letter/.test(l)) return APPLY_PROFILE.cover_letter;
    return null;
  }

  function fillSelects(scope) {
    scope.querySelectorAll("select").forEach(sel => {
      const cur = (sel.value || "").trim();
      if (cur && cur !== "Select an option") return;     // already answered
      const opts = Array.from(sel.options).filter(o => {
        const v = (o.value || "").trim();
        return v && v !== "Select an option";
      });
      if (!opts.length) return;
      // Pull the field's label/aria for profile matching.
      let label = "";
      if (sel.id) {
        const l = scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(sel.id) : sel.id) + '"]');
        if (l) label = textOf(l);
      }
      label = label || sel.getAttribute("aria-label") || sel.name || "";
      const profileAns = (answerForLabel(label) || "").toString().toLowerCase();
      const byText = t => opts.find(o => (o.textContent || "").trim().toLowerCase() === t);
      const byContains = t => opts.find(o => (o.textContent || "").trim().toLowerCase().includes(t));
      let pick =
        opts.find(o => /@/.test(o.value || o.textContent))          // email
        || opts.find(o => /India \(\+91\)/i.test(o.value || o.textContent)) // phone cc
        || (profileAns && (byText(profileAns) || byContains(profileAns)))   // profile match
        || byText("yes")                                            // yes/no default
        || opts[0];                                                 // first valid
      if (pick) setNativeValue(sel, pick.value);
    });
  }

  function fillTextInputs(scope) {
    scope.querySelectorAll('input, textarea').forEach(el => {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "file", "checkbox", "radio", "submit", "button"].includes(type)) return;
      if (el.value && el.value.trim()) return;             // already filled / prefilled
      const required = el.required || el.getAttribute("aria-required") === "true";
      if (!required) return;
      // Pull the field's label text to decide on a sensible value.
      let label = "";
      const id = el.id;
      if (id) {
        const l = scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
        if (l) label = textOf(l);
      }
      label = label || el.getAttribute("aria-label") || el.name || "";
      // 1) Try the Apply Profile — answers questions like notice period,
      //    expected salary, LinkedIn URL, etc. from the user's saved data.
      const fromProfile = answerForLabel(label);
      if (fromProfile != null && fromProfile !== "") {
        setNativeValue(el, fromProfile);
        return;
      }
      // 2) Number / experience-shaped questions → the profile's years value
      //    (only if the user set one — never a hard-coded guess).
      if ((type === "number" || looksLikeExperience(label)) && APPLY_PROFILE.years_of_experience) {
        setNativeValue(el, APPLY_PROFILE.years_of_experience);
        return;
      }
      // 3) Otherwise leave it blank. Better to skip this job (it won't advance)
      //    than to submit a random guess into a real question. Once the user
      //    answers this question once (here or in a manual LinkedIn apply),
      //    learnFromScope remembers it and future jobs auto-fill it.
    });
  }

  function fillRadios(scope) {
    const groups = {};
    scope.querySelectorAll('input[type="radio"]').forEach(r => {
      (groups[r.name] = groups[r.name] || []).push(r);
    });
    Object.values(groups).forEach(group => {
      if (group.some(r => r.checked)) return;              // already answered
      // Prefer the "Yes" option, else the first.
      let pick = group.find(r => {
        const l = r.id && scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]');
        return l && /^\s*yes\s*$/i.test(textOf(l));
      }) || group[0];
      if (pick) {
        const l = pick.id && scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(pick.id) : pick.id) + '"]');
        humanClick(l || pick);
      }
    });
  }

  function checkRequiredBoxes(scope) {
    scope.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.id === "follow-company-checkbox") return;     // handled separately
      const required = cb.required || cb.getAttribute("aria-required") === "true";
      if (required && !cb.checked) {
        const l = cb.id && scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(cb.id) : cb.id) + '"]');
        humanClick(l || cb);
      }
    });
  }

  // Resolve a form field's human label (for the learned-answers key).
  function _labelForField(scope, el) {
    let label = "";
    const id = el.id;
    if (id) {
      const l = scope.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (l) label = textOf(l);
    }
    return label || el.getAttribute("aria-label") || el.name || el.getAttribute("placeholder") || "";
  }

  // Learn the answers already present in this step — prefilled by LinkedIn from
  // the user's past applications, or entered by the user — so the SAME question
  // is auto-answered on future jobs. Skips fields the engine itself wrote
  // (data-lc-autofilled) so it never learns its own guesses. Text inputs +
  // selects only (those go through setNativeValue, which marks our writes).
  function learnFromScope(scope) {
    try {
      scope.querySelectorAll("input, textarea").forEach(el => {
        const type = (el.type || "").toLowerCase();
        if (["hidden", "file", "checkbox", "radio", "submit", "button", "password"].includes(type)) return;
        if (el.getAttribute("data-lc-autofilled") === "1") return;
        const v = (el.value || "").trim();
        if (!v) return;
        rememberAnswer(_labelForField(scope, el), v);
      });
      scope.querySelectorAll("select").forEach(sel => {
        if (sel.getAttribute("data-lc-autofilled") === "1") return;
        const opt = sel.options && sel.options[sel.selectedIndex];
        const txt = opt ? (opt.textContent || "").trim() : "";
        if (!txt || /^select an option$/i.test(txt)) return;
        rememberAnswer(_labelForField(scope, sel), txt);
      });
    } catch (_) {}
  }

  function autofill(scope) {
    // CRITICAL: never operate at document scope. autofill on the whole page
    // clicks the BETA thumbs-down (opens the "Why are these results not
    // helpful?" feedback modal) and the On-site / Full-time chips (opens
    // the Preferences-match popup). Both bugs were visible in the user's
    // 1.0.253 screenshots.
    if (!scope || scope === document || scope === document.body) return;
    // Learn anything already answered in this step BEFORE we fill, so we
    // capture the user's / LinkedIn's values and never our own writes.
    try { learnFromScope(scope); } catch (_) {}
    try { fillSelects(scope); } catch (_) {}
    try { fillTextInputs(scope); } catch (_) {}
    try { fillRadios(scope); } catch (_) {}
    try { checkRequiredBoxes(scope); } catch (_) {}
    try { untickFollowCompany(scope); } catch (_) {}
  }

  // Is THIS dialog node the Easy Apply modal? Detected STRUCTURALLY so we
  // never accidentally close it on a step whose visible text doesn't happen
  // to contain one of our keep-keywords. The bug v1.0.257 was: step 1 says
  // "Contact info" (matched the keep-list) but steps 2-6 say "Home address",
  // "Resume", "Additional questions" etc. — none matched, so the background
  // watcher closed the Easy Apply modal itself the moment it advanced.
  function isEasyApplyDialog(d) {
    if (!d) return false;
    // Strongest structural signals — present on every step of the modal.
    if (d.getAttribute("aria-labelledby") === "jobs-apply-header") return true;
    if (d.getAttribute("data-test-modal-id") === "easy-apply-modal") return true;
    if (d.querySelector(
      "button[data-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-next-button]," +
      "button[data-live-test-easy-apply-submit-button]," +
      "button[data-live-test-easy-apply-review-button]," +
      ".jobs-easy-apply-content,.jobs-easy-apply-form,.jobs-easy-apply-modal__content," +
      "[aria-label*='job application progress' i][role='region']"
    )) return true;
    // Title text always starts with "Apply to <Company>" on every step.
    const header = d.querySelector("h2, h3, [role='heading']");
    if (header) {
      const ht = (header.textContent || "").trim();
      if (/^apply to /i.test(ht)) return true;
    }
    return false;
  }

  // Close any LinkedIn popup that ISN'T the Easy Apply modal (feedback,
  // preferences-match, premium upsells). Use forceClick so dismiss never
  // fails silently on a React handler.
  function closeStrayModals() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], .artdeco-modal'));
    let closed = 0;
    for (const d of dialogs) {
      if (!visible(d)) continue;
      // NEVER close the Easy Apply modal, regardless of step content.
      if (isEasyApplyDialog(d)) continue;
      // If this dialog contains the Easy Apply modal as a descendant
      // (shouldn't happen but defensively), skip it.
      if (d.querySelector(
        "[aria-labelledby='jobs-apply-header']," +
        "[data-test-modal-id='easy-apply-modal']," +
        "button[data-easy-apply-next-button]," +
        "button[data-live-test-easy-apply-submit-button]"
      )) continue;
      const x = d.querySelector(
        'button[aria-label="Dismiss"][data-test-modal-close-btn],' +
        'button[aria-label="Dismiss"],' +
        'button[aria-label="Close"],' +
        ".artdeco-modal__dismiss"
      );
      if (x) { forceClick(x); closed++; }
    }
    return closed;
  }

  // Background watcher — dismisses the Preferences-match / feedback /
  // premium-upsell popups the millisecond they appear, without my apply
  // loop having to wait between sleeps. Started while Mass Apply is
  // running, stopped when it ends.
  let _strayWatchTimer = null;
  function startStrayWatcher() {
    if (_strayWatchTimer) return;
    _strayWatchTimer = setInterval(() => {
      try { closeStrayModals(); } catch (_) {}
    }, 250);
  }
  function stopStrayWatcher() {
    if (_strayWatchTimer) { clearInterval(_strayWatchTimer); _strayWatchTimer = null; }
  }

  // CSS injected when Mass Apply is running — hides the existing engine's
  // per-card "Auto Apply" chips so they can't visually conflict with the
  // Mass Apply flow (and so they can't be accidentally clicked by stray
  // events). The chips stay in the DOM, just hidden, per overlay.js's
  // own .lc-applying pattern.
  let _runStyleEl = null;
  function injectRunStyles() {
    if (_runStyleEl) return;
    _runStyleEl = document.createElement("style");
    _runStyleEl.id = "lc-mass-apply-run-style";
    _runStyleEl.textContent =
      "html.lc-mass-applying .lc-job-apply-row { display: none !important; }" +
      "html.lc-mass-applying .lc-job-apply-chip { display: none !important; }" +
      "html.lc-mass-applying [class*='lc-job-apply'] { display: none !important; }" +
      "html.lc-mass-applying .lc-job-select { display: none !important; }" +
      "html.lc-mass-applying #lc-massapply-selbar { display: none !important; }";
    document.head.appendChild(_runStyleEl);
  }
  function removeRunStyles() {
    if (_runStyleEl) { _runStyleEl.remove(); _runStyleEl = null; }
  }

  // ─────────────────── modal lifecycle ───────────────────────
  function dismissModal() {
    // The modal close control is EXACTLY aria-label="Dismiss" (job cards use
    // "Dismiss <title> job", so the exact match never hits a card).
    const x = document.querySelector(
      'button[aria-label="Dismiss"][data-test-modal-close-btn],' +
      'button[aria-label="Dismiss"]'
    );
    if (x) forceClick(x);
  }

  // After Dismiss, LinkedIn asks "Discard application?" → click Discard.
  async function confirmDiscard() {
    await sleep(rand(500, 900));
    let btn =
      document.querySelector('button[data-control-name="discard_application_confirm_btn"]') ||
      Array.from(document.querySelectorAll(".artdeco-modal button, div[role='dialog'] button"))
        .find(b => /^\s*discard\s*$/i.test(textOf(b)));
    if (btn) forceClick(btn);
  }

  async function discardAndClose() {
    dismissModal();
    await confirmDiscard();
    await sleep(rand(700, 1200));
  }

  // After Submit, decline the "next best action" upsell. NEVER click a
  // commitment button (Get started / Add / Upgrade / Follow / Try Premium).
  async function closePostSubmit() {
    await sleep(rand(1200, 2200));
    const safe = ["done", "not now", "no thanks", "no, thanks", "skip", "got it", "close"];
    const danger = /get started|add|upgrade|follow|try premium|reactivate|premium/i;
    // Prefer an explicit Done / Dismiss X.
    const x = document.querySelector('button[aria-label="Dismiss"]');
    const buttons = Array.from(document.querySelectorAll(
      '.artdeco-modal button, div[role="dialog"] button, button[aria-label="Dismiss"]'
    ));
    let pick = buttons.find(b => safe.includes(textOf(b).toLowerCase()) && !danger.test(textOf(b)));
    if (!pick && x) pick = x;
    if (pick) { forceClick(pick); await sleep(rand(600, 1100)); }
  }

  // Wait up to timeoutMs for the modal's innerText to differ from `before`.
  // Returns true if it changed (= step advanced) or the modal closed (= done).
  async function waitAdvanced(before, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(220);
      if (!applyFormPresent()) return true;     // modal closed = advanced/submitted
      if (modalText() !== before) return true;  // text changed = stepped forward
    }
    return false;
  }

  // A step won't advance because it asks something only the user can answer
  // (a free-text screening question, a file we can't script, etc.). Instead of
  // skipping the job, ALERT the user (buzz + beep + banner) and WAIT — polling
  // until they fill it in and the form moves on (or they press Stop). We keep
  // re-autofilling + re-clicking Next/Review/Submit each cycle, so the moment
  // the answer is present the form advances on its own. Returns true when the
  // step advanced (user answered), false only if the user pressed Stop.
  async function waitForUserAnswer(beforeText) {
    banner("⏸ This job asks a question only you can answer — type it into the LinkedIn form. I'll continue automatically once it's filled. (Press Stop to cancel.)");
    try { buzz(); } catch (_) {}
    let beat = 0;
    while (!state.cancel) {
      if (!applyFormPresent()) return true;          // user finished / closed the form
      if (modalText() !== beforeText) return true;   // step changed = user answered
      // Flash the button label so it's obvious the run is paused on YOU.
      setLabel(beat % 2 ? "⏸ Waiting for your answer…" : "⏸ Answer the question in the form");
      // Every ~3s: buzz, then re-autofill + re-attempt the action button — if
      // the user has now filled the field, our click advances the form.
      if (beat % 3 === 0) {
        try { buzz(); } catch (_) {}
        try { const sc = applyFormScope(); if (sc) autofill(sc); } catch (_) {}
        const adv = submitButton() || reviewButton() || nextButton();
        if (adv) {
          humanClick(adv);
          if (await waitAdvanced(beforeText, 1200)) return true;
        }
      }
      beat++;
      await sleep(1000);   // 1s cadence keeps Stop responsive
    }
    return false;          // cancelled
  }

  // Walk the multi-step apply form. Returns "applied" | "skipped".
  // Mirrors overlay.js's proven _runEasyApplyModal: ONE click strategy at a
  // time, between each strategy verify the form actually advanced via
  // innerText comparison, and only escalate when the previous strategy
  // failed. Firing all strategies at once (v1.0.250) caused later clicks to
  // land on the NEXT step's button after the form had already advanced.
  async function runApplyModal() {
    // Wait for the form to mount (up to 12s). If a non-apply LinkedIn modal
    // pops up first (Preferences match / feedback / premium upsell), close
    // it and keep polling.
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (applyFormPresent()) break;
      try { closeStrayModals(); } catch (_) {}
      await sleep(300);
    }
    if (!applyFormPresent()) return "skipped";
    await sleep(700 + Math.random() * 300);

    let stuck = 0;
    for (let step = 0; step < 16; step++) {
      if (state.cancel) { await discardAndClose(); return "skipped"; }
      if (isCheckpoint()) return "skipped";
      if (!applyFormPresent()) return "skipped";

      // Autofill this step — but ONLY if we have a real modal scope. If
      // applyFormScope returns null, the Easy Apply container disappeared
      // mid-flight; bail rather than autofill at document scope.
      const scope = applyFormScope();
      if (!scope) { await discardAndClose(); return "skipped"; }
      autofill(scope);
      await sleep(rand(500, 900));

      // Sweep stray popups EVERY step — Preferences-match / feedback /
      // premium upsell can open at any time and would deflect the next click.
      try { closeStrayModals(); } catch (_) {}

      // Terminal step → Submit. Spotlight, click, wait for the modal to close.
      const submit = submitButton();
      if (submit) {
        const beforeSubmit = modalText();
        spotlight(submit, 2000);
        await sleep(rand(220, 380));
        humanClick(submit);
        let done = await waitAdvanced(beforeSubmit, 5000);
        if (!done) { escalateClick(submitButton() || submit); done = await waitAdvanced(beforeSubmit, 4000); }
        // Submit didn't go through and the form is still open → a required
        // field on the final step needs the user. Buzz + wait, then resume.
        if (!done && applyFormPresent()) {
          const answered = await waitForUserAnswer(beforeSubmit);
          if (!answered) { await discardAndClose(); return "skipped"; }
          if (applyFormPresent()) { continue; }   // advanced but not closed → re-loop
        }
        await closePostSubmit();
        return "applied";
      }
      // Otherwise: Review (final pre-submit) → Next.
      let advance = reviewButton() || nextButton();
      if (!advance) {
        // Footer not rendered yet — scroll the modal body and retry once.
        try {
          const sc = scope.querySelector(".artdeco-modal__content, .jobs-easy-apply-content") || scope;
          sc.scrollTop = sc.scrollHeight;
        } catch (_) {}
        await sleep(500);
        advance = reviewButton() || nextButton() || submitButton();
        if (!advance) { await discardAndClose(); return "skipped"; }
      }

      const before = modalText();

      // STAGE 1 — spotlight + human pointer click. Pulsing outline tells the
      // user exactly which button Mass Apply is targeting.
      spotlight(advance, 2000);
      await sleep(rand(220, 380));
      humanClick(advance);
      let advanced = await waitAdvanced(before, 4000);

      // STAGE 2 — escalate. Re-find the button (LinkedIn re-renders between
      // steps) and fire the heavy 4-fallback sequence: native click, inner
      // span click, keyboard Enter, React fiber onClick(isTrusted:true).
      if (!advanced) {
        try { closeStrayModals(); } catch (_) {}
        const fresh = reviewButton() || nextButton() || submitButton();
        if (fresh) {
          spotlight(fresh, 1800);
          escalateClick(fresh);
          advanced = await waitAdvanced(before, 4000);
        }
      }

      if (!advanced) {
        // The step has a validation error we couldn't satisfy. Try one more
        // autofill+click pass before concluding it needs the user.
        stuck++;
        if (stuck >= 2) {
          // It needs a human answer → buzz + beep and WAIT for the user rather
          // than skipping. Resume automatically once they've answered.
          const answered = await waitForUserAnswer(before);
          if (!answered) { await discardAndClose(); return "skipped"; }
          stuck = 0;
          continue;   // re-enter on the now-advanced step
        }
      } else {
        stuck = 0;
      }
    }
    await discardAndClose();
    return "skipped";
  }

  // ─────────────── per-job flow ──────────────────────────────
  // Returns "applied" | "skipped" | "challenge".
  async function applyToCard(card) {
    if (isCheckpoint()) return "challenge";
    const el = (card.el && document.contains(card.el)) ? card.el : cardElForKey(card.key);
    if (!el) return "skipped";

    // Sweep any leftover LinkedIn popups that opened during the previous
    // job (feedback, preferences-match) so they can't deflect this click.
    try { closeStrayModals(); } catch (_) {}

    // Click the card body to load the right detail pane.
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(900, 1600));
    humanClick(el);
    await sleep(rand(1800, 3000));   // let the detail pane render

    // Skip closed jobs early. "No longer accepting applications" jobs make
    // LinkedIn open the Preferences-match modal instead of the apply form.
    if (detailPaneIsClosedJob()) return "skipped";

    // Wait up to ~6s for the detail pane to render the Easy Apply button.
    // Do NOT re-click the card or any child element — re-clicking can hit
    // the On-site / Full-time chips behind the modal (which open the
    // Preferences-match popup) or footer links. If Easy Apply still isn't
    // there after the poll, skip the card cleanly.
    let apply = findInAppApply();
    if (!apply) {
      for (let t = 0; t < 12; t++) {
        if (state.cancel) return "skipped";
        try { closeStrayModals(); } catch (_) {}     // keep popups dismissed while waiting
        await sleep(500);
        apply = findInAppApply();
        if (apply) break;
      }
    }
    if (!apply) return "skipped";    // external apply / no in-app apply

    apply.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(400, 700));
    // Spotlight the Easy Apply button so the user sees what's being clicked.
    spotlight(apply, 2000);
    await sleep(rand(220, 380));
    // STAGE 1 — human pointer click. The classic Easy Apply control opens the
    // modal on this alone (proven by overlay.js's working engine).
    humanClick(apply);
    // Give LinkedIn ~3s to mount the modal; if nothing appeared, escalate.
    let mounted = false;
    for (let t = 0; t < 12; t++) {
      await sleep(280);
      if (applyFormPresent()) { mounted = true; break; }
    }
    if (!mounted) escalateClick(findInAppApply() || apply);

    return await runApplyModal();
  }

  // ─────────────── main loop ─────────────────────────────────
  const state = { running: false, cancel: false, applied: 0, skipped: 0 };

  // ─────────────── Select-All / per-card selection ───────────────
  // A user-driven subset of jobs to apply to. When NON-EMPTY, the Mass Apply
  // button runs in "selection mode": it applies ONLY the selected cards and
  // never paginates. When empty, behaviour is unchanged (apply everything,
  // page by page). Purely additive — the keys are the same card keys the
  // bulk loop already uses, so nothing else has to change.
  const _selected = new Set();

  // Keep this tab running at full speed even when it's in the background, so
  // the auto-apply keeps going while the user works in another tab. The
  // service worker pins the tab "active" via chrome.debugger
  // (Page.setWebLifecycleState), which stops Chrome from throttling/freezing a
  // hidden tab's timers. Best-effort: if the SW/debugger is unavailable the run
  // still works while the tab is visible. Turned off in each run's finally.
  function keepAwake(on) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: "lc:massApplyKeepAwake", on: !!on }, () => { void chrome.runtime.lastError; });
      }
    } catch (_) {}
  }

  async function run() {
    if (state.running) return;
    // Snapshot the selection at start. Non-empty ⇒ "selection mode": apply ONLY
    // these cards and never paginate. Empty ⇒ apply everything (page by page).
    const selectionMode = _selected.size > 0;
    const targetKeys = selectionMode ? new Set(_selected) : null;
    state.running = true; state.cancel = false;
    state.applied = state.skipped = 0;
    setLabel(selectionMode ? ("Applying " + targetKeys.size + " selected…") : "Scanning jobs…");

    // Hide per-card Auto Apply chips, start the stray-popup watcher.
    try { document.documentElement.classList.add("lc-mass-applying"); } catch (_) {}
    try { injectRunStyles(); } catch (_) {}
    try { startStrayWatcher(); } catch (_) {}
    keepAwake(true);   // keep applying even when the tab is in the background
    _ensureAudio();    // unlock audio now (this run began from the user's click)

    // Process ONE freshly-rendered card per iteration, then scroll the
    // virtualised list to reveal more. This survives cards unmounting as the
    // list scrolls — we never hold a stale list, we re-collect every loop.
    const processed = new Set();
    let idle = 0;
    let stuckScroll = 0;   // consecutive "list couldn't scroll" checks
    let noNextTries = 0;   // consecutive failed attempts to reach the next page

    try {
      while (!state.cancel) {
        if (isCheckpoint()) { banner("LinkedIn challenge detected — stopping."); break; }

        let fresh = collectJobCards().filter(c => !processed.has(c.key));
        if (selectionMode) fresh = fresh.filter(c => targetKeys.has(c.key));

        // In selection mode we're done once every selected card has been
        // processed — no pagination, ever.
        if (selectionMode && processed.size >= targetKeys.size) break;

        if (!fresh.length) {
          // Nothing new rendered → scroll to load more of THIS page first.
          const before = listScrollTop();
          scrollListDown();
          await sleep(rand(900, 1500));
          const moved = listScrollTop() !== before;

          if (moved) {
            // Scroll moved → more of this page is loading; keep going. High
            // safety valve — if the list keeps moving but yields no new cards
            // for a very long time, fall through to a pagination attempt rather
            // than looping forever.
            stuckScroll = 0;
            if (++idle < 120) { continue; }
          } else {
            // Scroll didn't move. Require TWO consecutive "couldn't scroll"
            // reads before treating the page as exhausted — guards against a
            // transient during a virtualised re-render prematurely paginating.
            if (++stuckScroll < 2) { continue; }
          }

          // ── This page is fully processed. ──
          // Selection mode never paginates (it targets a fixed picked set).
          if (selectionMode) break;

          // Advance to the next page — robustly (many selectors). The run must
          // keep going across ALL pages and only stop when the user presses
          // Stop, a challenge appears, or there is genuinely no next page.
          const advanced = await goToNextResultsPage();
          if (advanced) {
            processed.clear();
            idle = 0; stuckScroll = 0; noNextTries = 0;
            continue;
          }

          // Couldn't advance THIS attempt. Don't stop yet — LinkedIn may still
          // be hydrating the pagination control, or a scroll nudge may reveal
          // it. Retry a few times before concluding it's the last page.
          if (++noNextTries < 5) {
            setLabel("Looking for more jobs… · " + state.applied + " applied, " + state.skipped + " skipped");
            // A gentle scroll to the very bottom often mounts the pager.
            try { scrollListDown(); } catch (_) {}
            await sleep(rand(1600, 2800));
            stuckScroll = 0; idle = 0;
            continue;
          }

          // Robustly confirmed: no more pages anywhere. Natural end.
          break;
        }

        idle = 0; stuckScroll = 0; noNextTries = 0;
        const card = fresh[0];
        processed.add(card.key);
        setLabel("Applying #" + processed.size + " · " + state.applied + " applied, " + state.skipped + " skipped");

        let result = "skipped";
        try { result = await applyToCard(card); }
        catch (e) { console.warn(TAG, "job error:", e); result = "skipped"; }

        if (result === "applied") state.applied++;
        else if (result === "challenge") { banner("Challenge — stopping."); break; }
        else state.skipped++;

        // Clean up before the next job — close any stray modals (preferences
        // match / feedback / premium upsell) and the Easy Apply modal if it's
        // still around. A short settle pause covers DOM transitions only.
        if (applyFormPresent()) { try { await discardAndClose(); } catch (_) {} }
        try { closeStrayModals(); } catch (_) {}
        await sleep(400);
        try { closeStrayModals(); } catch (_) {}

        // Human-pace gap between jobs — ~45s (with a small jitter) so LinkedIn's
        // "applying at a fast pace" safeguard doesn't pause LinkedIn Apply and
        // put the account at risk. Cancellable: checks state.cancel every
        // second so Stop is immediate; shows a live countdown in the label.
        const gapMs = 45000 + Math.floor(Math.random() * 6000); // 45–51s
        for (let remain = Math.round(gapMs / 1000); remain > 0 && !state.cancel; remain--) {
          setLabel("Next job in " + remain + "s · " + state.applied + " applied, " + state.skipped + " skipped");
          await sleep(1000);
        }
        if (state.cancel) break;
        setLabel("Next job · " + state.applied + " applied, " + state.skipped + " skipped");
      }
    } finally {
      keepAwake(false);
      try { stopStrayWatcher(); } catch (_) {}
      try { document.documentElement.classList.remove("lc-mass-applying"); } catch (_) {}
      try { removeRunStyles(); } catch (_) {}
      setLabel("Done · " + state.applied + " applied, " + state.skipped + " skipped");
      state.running = false; state.cancel = false;
      // A selection run consumes the selection so the next Mass Apply click
      // goes back to "apply everything" unless the user re-selects.
      if (selectionMode) { try { clearSelection(); } catch (_) {} }
      setTimeout(resetLabel, 9000);
    }
  }

  function cancel() {
    if (!state.running) return;
    state.cancel = true;
    setLabel("Stopping…");
  }

  // ─────────────── floating button UI ────────────────────────
  let btnEl = null;
  let selBarEl = null;
  const BTN_ID = "lc-massapply-button";
  const SELBAR_ID = "lc-massapply-selbar";

  function setLabel(text) {
    if (!btnEl) return;
    const lab = btnEl.querySelector(".lc-ma-text");
    if (lab) lab.textContent = text;
    btnEl.classList.toggle("lc-ma-running", state.running);
  }
  function resetLabel() { setLabel("Mass Apply Jobs"); }

  // ─────────────── per-card single Auto Apply ────────────────
  // Apply to ONE job card, using the exact same per-card flow (applyToCard +
  // runApplyModal) the bulk loop uses — just for that single card. Wrapped in
  // the same guards/lifecycle as run() so a single apply and the bulk run can
  // never overlap (state.running is the mutex), stray popups are swept, and the
  // toolbar/state always resets via try/finally.
  async function runSingle(cardKey, chip) {
    if (state.running) return;                 // bulk run or another single is active
    state.running = true; state.cancel = false;
    try { document.documentElement.classList.add("lc-mass-applying"); } catch (_) {}
    try { injectRunStyles(); } catch (_) {}
    try { startStrayWatcher(); } catch (_) {}
    keepAwake(true);
    _ensureAudio();    // unlock audio now (this run began from the user's click)
    setLabel("Applying 1 job…");
    try {
      // Re-resolve the card fresh so we never act on a stale node.
      let card = null;
      try { card = collectJobCards().find(c => c.key === cardKey) || null; } catch (_) {}
      if (!card) card = { key: cardKey, el: cardElForKey(cardKey), title: "" };
      let result = "skipped";
      try { result = await applyToCard(card); }
      catch (e) { console.warn(TAG, "single apply error:", e); result = "skipped"; }
      if (result === "applied") setLabel("Applied ✓ 1 job");
      else if (result === "challenge") banner("LinkedIn challenge detected — stopping.");
      else setLabel("Skipped (no in-app apply)");
      if (applyFormPresent()) { try { await discardAndClose(); } catch (_) {} }
      try { closeStrayModals(); } catch (_) {}
    } finally {
      keepAwake(false);
      try { stopStrayWatcher(); } catch (_) {}
      try { document.documentElement.classList.remove("lc-mass-applying"); } catch (_) {}
      try { removeRunStyles(); } catch (_) {}
      state.running = false; state.cancel = false;
      setTimeout(resetLabel, 6000);
    }
  }

  // Inject a one-click "⚡ Auto Apply" chip on each job card (the same cards the
  // bulk loop collects) so a single job can be applied to on its own. Purely
  // additive: the chips are our own elements, they are hidden during any run by
  // the existing .lc-mass-applying CSS, they never bubble their click to the
  // card (capture-phase stopPropagation), and they don't affect card collection
  // or the apply-button finder (which ignores our .lc-* elements).
  function decorateCards() {
    if (!onJobsResultsPage()) return;
    let cards;
    try { cards = collectJobCards(); } catch (_) { return; }
    for (const card of cards) {
      const host = card.el;
      if (!host || !document.contains(host)) continue;
      if (host.querySelector(":scope > .lc-job-apply-chip")) continue;
      try {
        // Give THIS card its own positioning context (only when static), so
        // each absolute chip anchors to its own card, never a shared ancestor.
        const pos = getComputedStyle(host).position;
        if (!pos || pos === "static") host.style.position = "relative";
      } catch (_) {}
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "lc-job-apply-chip";
      chip.dataset.lcKey = card.key;
      chip.textContent = "⚡ Auto Apply";
      chip.title = "Apply to this one job";
      chip.style.cssText = [
        "position:absolute", "bottom:10px", "right:10px", "z-index:60",
        "background:linear-gradient(135deg,#047857 0%,#059669 100%)",
        "color:#fff", "border:none", "border-radius:999px",
        "padding:4px 10px",
        "font:700 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif",
        "letter-spacing:0.01em", "cursor:pointer",
        "box-shadow:0 3px 10px rgba(5,150,105,0.35)", "user-select:none",
      ].join(";");
      chip.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        runSingle(card.key, chip);
      }, true);
      // Swallow the press so the card's own open-job handler never fires.
      ["mousedown", "pointerdown"].forEach(t =>
        chip.addEventListener(t, (e) => { e.stopPropagation(); }, true));
      host.appendChild(chip);

      // Per-card selection checkbox (top-left). Toggling it adds/removes this
      // card's key from _selected; the Mass Apply button then applies only the
      // selected set. Our own element — never bubbles to the card's open handler.
      const sel = document.createElement("button");
      sel.type = "button";
      sel.className = "lc-job-select";
      sel.dataset.lcKey = card.key;
      styleSelectBox(sel, _selected.has(card.key));
      sel.title = "Select this job for Mass Apply";
      sel.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (_selected.has(card.key)) _selected.delete(card.key);
        else _selected.add(card.key);
        styleSelectBox(sel, _selected.has(card.key));
        updateSelectionUi();
      }, true);
      ["mousedown", "pointerdown"].forEach(t =>
        sel.addEventListener(t, (e) => { e.stopPropagation(); }, true));
      host.appendChild(sel);
    }
    updateSelectionUi();
  }

  // Paints a selection checkbox to reflect checked/unchecked.
  function styleSelectBox(el, on) {
    el.textContent = on ? "✓" : "";
    el.style.cssText = [
      "position:absolute", "top:10px", "left:10px", "z-index:60",
      "width:22px", "height:22px", "border-radius:6px",
      "display:inline-flex", "align-items:center", "justify-content:center",
      "font:800 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif",
      "cursor:pointer", "user-select:none", "padding:0",
      on ? "background:linear-gradient(135deg,#047857 0%,#059669 100%)" : "background:#ffffff",
      on ? "color:#fff" : "color:transparent",
      on ? "border:1.5px solid #047857" : "border:1.5px solid #94a3b8",
      "box-shadow:0 2px 6px rgba(15,23,42,0.18)",
    ].join(";");
  }

  // Keeps the Select-All bar label, its checkbox state, every rendered card
  // checkbox, and the Mass Apply button label in sync with _selected. Safe to
  // call often; it never touches the button text while a run is in progress
  // (setLabel owns it then).
  function updateSelectionUi() {
    const n = _selected.size;
    // Reconcile any rendered checkboxes (e.g. after a Select-All click).
    try {
      document.querySelectorAll(".lc-job-select").forEach((el) => {
        const key = el.dataset.lcKey;
        styleSelectBox(el, !!key && _selected.has(key));
      });
    } catch (_) {}
    if (selBarEl) {
      const lab = selBarEl.querySelector(".lc-sel-text");
      if (lab) lab.textContent = n > 0 ? (n + " selected") : "Select jobs";
      const clr = selBarEl.querySelector(".lc-sel-clear");
      if (clr) clr.style.display = n > 0 ? "inline-flex" : "none";
    }
    if (btnEl && !state.running) {
      const t = btnEl.querySelector(".lc-ma-text");
      if (t) t.textContent = n > 0 ? ("Mass Apply (" + n + ")") : "Mass Apply Jobs";
    }
  }

  // Selects every currently-rendered job card (one page's worth). LinkedIn's
  // list is virtualised, so this is "select all visible/loaded" — the honest
  // scope, surfaced in the toast.
  function selectAllVisible() {
    let cards = [];
    try { cards = collectJobCards(); } catch (_) {}
    for (const c of cards) _selected.add(c.key);
    updateSelectionUi();
  }

  function clearSelection() {
    _selected.clear();
    updateSelectionUi();
  }

  function mountButton() {
    if (btnEl || !document.body) return;
    btnEl = document.createElement("button");
    btnEl.id = BTN_ID;
    btnEl.type = "button";
    btnEl.style.cssText = [
      "position: fixed",
      "right: 18px",
      "bottom: 122px",                // sits above the Connect-All-On-Page button
      "z-index: 2147483646",
      "background: linear-gradient(135deg, #047857 0%, #059669 100%)",
      "color: #ffffff",
      "border: none",
      "border-radius: 999px",
      "padding: 10px 18px 10px 14px",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif",
      "font-size: 13px",
      "font-weight: 700",
      "letter-spacing: 0.01em",
      "box-shadow: 0 8px 22px rgba(5, 150, 105, 0.35)",
      "cursor: pointer",
      "user-select: none",
      "display: inline-flex",
      "align-items: center",
      "gap: 8px",
    ].join(";");
    btnEl.innerHTML =
      '<span class="lc-ma-dot" style="width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block;flex-shrink:0"></span>' +
      '<span class="lc-ma-text">Mass Apply Jobs</span>';
    btnEl.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.running) cancel();
      else run();
    });
    document.body.appendChild(btnEl);
    mountSelBar();

    const style = document.createElement("style");
    style.id = "lc-massapply-style";
    style.textContent =
      "#" + BTN_ID + ".lc-ma-running .lc-ma-dot { animation: lc-ma-pulse 1.2s infinite; }" +
      "@keyframes lc-ma-pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }" +
      "@keyframes lc-ma-pulse-ring { 0%,100% { box-shadow: 0 0 0 6px rgba(10,102,194,0.25), 0 0 24px rgba(10,102,194,0.55); }" +
      "                              50%     { box-shadow: 0 0 0 12px rgba(10,102,194,0.10), 0 0 32px rgba(10,102,194,0.75); } }";
    document.head.appendChild(style);
  }

  // Small "Select all / clear" pill that sits just above the Mass Apply button.
  // Hidden while a run is active (the whole selection UI is a pre-run control).
  function mountSelBar() {
    if (selBarEl || !document.body) return;
    selBarEl = document.createElement("div");
    selBarEl.id = SELBAR_ID;
    selBarEl.style.cssText = [
      "position: fixed", "right: 18px", "bottom: 166px",
      "z-index: 2147483646",
      "display: inline-flex", "align-items: center", "gap: 6px",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif",
    ].join(";");

    const selAll = document.createElement("button");
    selAll.type = "button";
    selAll.className = "lc-sel-all";
    selAll.style.cssText = [
      "background:#ffffff", "color:#047857", "border:1.5px solid #059669",
      "border-radius:999px", "padding:6px 12px",
      "font-size:12px", "font-weight:700", "cursor:pointer", "user-select:none",
      "box-shadow:0 4px 12px rgba(5,150,105,0.20)",
      "display:inline-flex", "align-items:center", "gap:6px",
    ].join(";");
    selAll.innerHTML = '<span>☑</span><span class="lc-sel-text">Select jobs</span>';
    selAll.title = "Select all jobs loaded on this page";
    selAll.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.running) return;
      selectAllVisible();
    });

    const clr = document.createElement("button");
    clr.type = "button";
    clr.className = "lc-sel-clear";
    clr.textContent = "Clear";
    clr.style.cssText = [
      "background:#fff1f2", "color:#be123c", "border:1.5px solid #fecdd3",
      "border-radius:999px", "padding:6px 10px",
      "font-size:12px", "font-weight:700", "cursor:pointer", "user-select:none",
      "display:none", "align-items:center",
    ].join(";");
    clr.title = "Clear the current selection";
    clr.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.running) return;
      clearSelection();
    });

    selBarEl.appendChild(selAll);
    selBarEl.appendChild(clr);
    document.body.appendChild(selBarEl);
    updateSelectionUi();
  }

  function unmountButton() {
    if (btnEl) { btnEl.remove(); btnEl = null; }
    if (selBarEl) { selBarEl.remove(); selBarEl = null; }
    const s = document.getElementById("lc-massapply-style");
    if (s) s.remove();
  }

  function banner(msg) {
    let b = document.getElementById("lc-massapply-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "lc-massapply-banner";
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
    if (onJobsResultsPage()) { mountButton(); try { decorateCards(); } catch (_) {} }
    else unmountButton();
  }
  setInterval(maybeMount, 1500);
  maybeMount();

  // Self-heal when the extension reloads (chrome.runtime.id flips to undef).
  setInterval(() => {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
        unmountButton();
      }
    } catch (_) { unmountButton(); }
  }, 2500);

  console.log(TAG, "loaded");
})();
