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

  // Human gap between consequential job applications:
  //   55% → 30-55s, 27% → 50-90s, 18% → 60-180s long tail
  function nextJobDelayMs() {
    const r = Math.random();
    if (r < 0.18) return 60000 + rand(0, 120000);
    if (r < 0.45) return 50000 + rand(0, 40000);
    return 30000 + rand(0, 25000);
  }

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
    return cards;
  }

  function cardElForKey(key) {
    let el = null;
    try { el = document.querySelector('div[role="button"][componentkey="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]'); } catch (_) {}
    return el;
  }

  // The left job list is VIRTUALISED — only a handful of cards exist in the DOM
  // at once. We must scroll the list's own scroll container (not the window) to
  // render the rest. Find that container by climbing from a card to the first
  // scrollable ancestor.
  function listScroller() {
    const btn = document.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]');
    let el = btn ? btn.closest('div[role="button"]') : null;
    while (el && el !== document.body) {
      try {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 24) return el;
      } catch (_) {}
      el = el.parentElement;
    }
    return null;
  }
  function listScrollTop() { const s = listScroller(); return s ? Math.round(s.scrollTop) : Math.round(window.scrollY); }
  function scrollListDown() {
    const s = listScroller();
    if (s) { s.scrollBy(0, Math.round(s.clientHeight * 0.8)); return true; }
    // Don't fall back to window.scrollBy — that scrolls the whole page into
    // the LinkedIn footer (promo cards, language picker, etc.), and the
    // wider scope makes the apply finder more likely to misfire too.
    return false;
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
      if (/easy apply|linkedin apply/i.test(aria)) return true;
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
    return null;
  }

  // ─────────────────── easy-apply modal ──────────────────────
  // The Next/Review/Submit buttons carry GLOBALLY-UNIQUE attributes that only
  // ever exist inside the Easy Apply form, so we detect + click them at
  // document scope. The Next button lives in a <footer> that is a SIBLING of
  // (not inside) the progress "region", so scoping the search to that region —
  // or to any single container — silently misses it. Document scope is the fix.
  function applyFormPresent() {
    return !!(
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
    );
  }

  // The container we autofill WITHIN (for select/input scoping only). Prefer the
  // modal content; fall back to document so a class rename never blocks fill.
  function applyFormScope() {
    const modal = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],' +
      'div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      ".jobs-easy-apply-modal,.jobs-easy-apply-modal__content,.jobs-easy-apply-content"
    );
    if (modal && visible(modal)) return modal;
    const region = document.querySelector('[aria-label*="job application progress" i][role="region"]');
    if (region) return region.closest("form, .artdeco-modal, div[role='dialog']") || document;
    return document;
  }

  function qDoc(sels) {
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e && visible(e) && !e.disabled) return e;
    }
    return null;
  }

  function nextButton() {
    return qDoc([
      "button[data-easy-apply-next-button]",
      "button[data-live-test-easy-apply-next-button]",
      'button[aria-label="Continue to next step"]',
    ]);
  }
  function reviewButton() {
    return qDoc([
      "button[data-live-test-easy-apply-review-button]",
      'button[aria-label="Review your application"]',
    ]);
  }
  function submitButton() {
    return qDoc([
      "button[data-live-test-easy-apply-submit-button]",
      'button[aria-label="Submit application"]',
    ]);
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

  function fillSelects(scope) {
    scope.querySelectorAll("select").forEach(sel => {
      const cur = (sel.value || "").trim();
      if (cur && cur !== "Select an option") return;     // already answered
      const opts = Array.from(sel.options).filter(o => {
        const v = (o.value || "").trim();
        return v && v !== "Select an option";
      });
      if (!opts.length) return;
      const byText = t => opts.find(o => (o.textContent || "").trim().toLowerCase() === t);
      let pick =
        opts.find(o => /@/.test(o.value || o.textContent))          // email
        || opts.find(o => /India \(\+91\)/i.test(o.value || o.textContent)) // phone cc
        || byText("yes")                                            // yes/no
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
      // Experience / numeric questions → "9" (per spec). Other required-empty
      // text → "9" as a last resort so the step can advance.
      if (type === "number" || looksLikeExperience(label)) setNativeValue(el, "9");
      else setNativeValue(el, "9");
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

  function autofill(scope) {
    if (!scope) return;
    try { fillSelects(scope); } catch (_) {}
    try { fillTextInputs(scope); } catch (_) {}
    try { fillRadios(scope); } catch (_) {}
    try { checkRequiredBoxes(scope); } catch (_) {}
    try { untickFollowCompany(scope); } catch (_) {}
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

  // Walk the multi-step apply form. Returns "applied" | "skipped".
  // Mirrors overlay.js's proven _runEasyApplyModal: ONE click strategy at a
  // time, between each strategy verify the form actually advanced via
  // innerText comparison, and only escalate when the previous strategy
  // failed. Firing all strategies at once (v1.0.250) caused later clicks to
  // land on the NEXT step's button after the form had already advanced.
  async function runApplyModal() {
    // Wait for the form to mount (up to 12s).
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (applyFormPresent()) break;
      await sleep(300);
    }
    if (!applyFormPresent()) return "skipped";
    await sleep(700 + Math.random() * 300);

    let stuck = 0;
    for (let step = 0; step < 16; step++) {
      if (state.cancel) { await discardAndClose(); return "skipped"; }
      if (isCheckpoint()) return "skipped";
      if (!applyFormPresent()) return "skipped";

      // Autofill this step.
      const scope = applyFormScope();
      autofill(scope);
      await sleep(rand(500, 900));

      // Terminal step → Submit. Click, then wait for the modal to close.
      const submit = submitButton();
      if (submit) {
        const beforeSubmit = modalText();
        humanClick(submit);
        let done = await waitAdvanced(beforeSubmit, 5000);
        if (!done) { escalateClick(submitButton() || submit); done = await waitAdvanced(beforeSubmit, 4000); }
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

      // STAGE 1 — human pointer click (what overlay.js's working engine uses).
      humanClick(advance);
      let advanced = await waitAdvanced(before, 4000);

      // STAGE 2 — escalate. Re-find the button (LinkedIn re-renders between
      // steps) and fire the heavy 4-fallback sequence: native click, inner
      // span click, keyboard Enter, React fiber onClick(isTrusted:true).
      if (!advanced) {
        const fresh = reviewButton() || nextButton() || submitButton();
        if (fresh) {
          escalateClick(fresh);
          advanced = await waitAdvanced(before, 4000);
        }
      }

      if (!advanced) {
        // The step has a validation error we couldn't satisfy. Try one more
        // autofill+click pass before declaring stuck.
        stuck++;
        if (stuck >= 2) { await discardAndClose(); return "skipped"; }
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

    // Click the card body to load the right detail pane.
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(900, 1600));
    humanClick(el);
    await sleep(rand(1800, 3000));   // let the detail pane render

    // Wait up to ~4s for the detail pane to render the Easy Apply button.
    // Don't try clicking random child elements as a fallback — that risks
    // hitting promo links / footer triggers. Just re-click the card itself.
    let apply = findInAppApply();
    if (!apply) {
      for (let t = 0; t < 8; t++) {
        await sleep(500);
        apply = findInAppApply();
        if (apply) break;
      }
    }
    if (!apply) {
      // Try a single re-click of the card itself, then poll again.
      humanClick(el);
      for (let t = 0; t < 8; t++) {
        await sleep(500);
        apply = findInAppApply();
        if (apply) break;
      }
    }
    if (!apply) return "skipped";    // external apply / no in-app apply

    apply.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(rand(600, 1100));
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

  async function run() {
    if (state.running) return;
    state.running = true; state.cancel = false;
    state.applied = state.skipped = 0;
    setLabel("Scanning jobs…");

    // Process ONE freshly-rendered card per iteration, then scroll the
    // virtualised list to reveal more. This survives cards unmounting as the
    // list scrolls — we never hold a stale list, we re-collect every loop.
    const processed = new Set();
    let idle = 0;

    try {
      while (!state.cancel) {
        if (isCheckpoint()) { banner("LinkedIn challenge detected — stopping."); break; }

        const fresh = collectJobCards().filter(c => !processed.has(c.key));

        if (!fresh.length) {
          // Nothing new rendered → scroll to load more.
          const before = listScrollTop();
          scrollListDown();
          await sleep(rand(900, 1500));
          if (listScrollTop() === before) {
            // List can't scroll further → try the next results page.
            const nextPage = document.querySelector(
              'button[data-testid="pagination-controls-next-button-visible"]'
            );
            if (nextPage && !nextPage.disabled && visible(nextPage)) {
              setLabel("Loading next page…");
              humanClick(nextPage);
              await sleep(rand(2600, 4200));
              processed.clear();
              idle = 0;
              continue;
            }
            break;                       // no more cards, no more pages
          }
          if (++idle > 60) break;        // safety valve
          continue;
        }

        idle = 0;
        const card = fresh[0];
        processed.add(card.key);
        setLabel("Applying #" + processed.size + " · " + state.applied + " applied");

        let result = "skipped";
        try { result = await applyToCard(card); }
        catch (e) { console.warn(TAG, "job error:", e); result = "skipped"; }

        if (result === "applied") state.applied++;
        else if (result === "challenge") { banner("Challenge — stopping."); break; }
        else state.skipped++;

        // Make sure nothing is left open before the gap.
        if (applyFormPresent()) { try { await discardAndClose(); } catch (_) {} }

        if (!state.cancel) {
          const wait = nextJobDelayMs();
          const start = Date.now();
          while (Date.now() - start < wait) {
            if (state.cancel) break;
            const left = Math.max(0, Math.round((wait - (Date.now() - start)) / 1000));
            setLabel("Next in " + left + "s · " + state.applied + " applied");
            await sleep(250);
          }
        }
      }
    } finally {
      setLabel("Done · " + state.applied + " applied, " + state.skipped + " skipped");
      state.running = false; state.cancel = false;
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
  const BTN_ID = "lc-massapply-button";

  function setLabel(text) {
    if (!btnEl) return;
    const lab = btnEl.querySelector(".lc-ma-text");
    if (lab) lab.textContent = text;
    btnEl.classList.toggle("lc-ma-running", state.running);
  }
  function resetLabel() { setLabel("Mass Apply Jobs"); }

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

    const style = document.createElement("style");
    style.id = "lc-massapply-style";
    style.textContent =
      "#" + BTN_ID + ".lc-ma-running .lc-ma-dot { animation: lc-ma-pulse 1.2s infinite; }" +
      "@keyframes lc-ma-pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }";
    document.head.appendChild(style);
  }

  function unmountButton() {
    if (btnEl) { btnEl.remove(); btnEl = null; }
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
    if (onJobsResultsPage()) mountButton();
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
