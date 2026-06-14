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
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + (Math.random() * 6 - 3);
      const cy = r.top + r.height / 2 + (Math.random() * 4 - 2);
      const init = { bubbles: true, cancelable: true, view: window,
                     clientX: cx, clientY: cy, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerover", init));
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.dispatchEvent(new PointerEvent("pointerup", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.dispatchEvent(new MouseEvent("click", init));
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
        cards.push({ key, title: (btn.getAttribute("aria-label") || "")
          .replace(/^Dismiss\s+/i, "").replace(/\s+job$/i, "").trim() });
      });
    return cards;
  }

  function cardElForKey(key) {
    let el = null;
    try { el = document.querySelector('div[role="button"][componentkey="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]'); } catch (_) {}
    return el;
  }

  // The in-app apply control inside the right detail pane. The external
  // "Apply on company website" anchor is intentionally excluded.
  function findInAppApply() {
    const a = document.querySelector('a[aria-label="LinkedIn Apply to this job"]');
    if (a && visible(a)) return a;
    // Fallback: an apply anchor whose href is the in-app apply path.
    const cands = Array.from(document.querySelectorAll('a[href*="/jobs/view/"][href*="/apply"]'));
    for (const c of cands) {
      if (!visible(c)) continue;
      const lbl = (c.getAttribute("aria-label") || "").toLowerCase();
      if (lbl.includes("company website")) continue;
      return c;
    }
    return null;
  }

  // ─────────────────── easy-apply modal ──────────────────────
  function easyApplyModal() {
    let m = document.querySelector(
      '[data-test-modal-id="easy-apply-modal"],' +
      'div[role="dialog"][aria-labelledby="jobs-apply-header"],' +
      '.jobs-easy-apply-modal'
    );
    if (m && visible(m)) return m;
    const region = document.querySelector('[aria-label*="job application progress" i][role="region"]');
    if (region) return region.closest('div[role="dialog"]') || region;
    if (/^\/jobs\/view\/\d+\/apply\//.test(location.pathname)) {
      const f = document.querySelector("form");
      if (f) return f.closest("main") || f;
    }
    return null;
  }

  function qIn(scope, sels) {
    for (const s of sels) {
      const e = (scope || document).querySelector(s);
      if (e && visible(e) && !e.disabled) return e;
    }
    return null;
  }

  function nextButton(scope) {
    return qIn(scope, [
      "button[data-easy-apply-next-button]",
      "button[data-live-test-easy-apply-next-button]",
      'button[aria-label="Continue to next step"]',
    ]);
  }
  function reviewButton(scope) {
    return qIn(scope, [
      "button[data-live-test-easy-apply-review-button]",
      'button[aria-label="Review your application"]',
    ]);
  }
  function submitButton(scope) {
    return qIn(scope, [
      "button[data-live-test-easy-apply-submit-button]",
      'button[aria-label="Submit application"]',
    ]);
  }

  // Progress signature so we can tell when a Next click failed to advance
  // (= a validation error we couldn't satisfy → discard + skip).
  function progressSig(modal) {
    let pct = "";
    const region = document.querySelector('[aria-label*="percent" i]');
    if (region) {
      const m = (region.getAttribute("aria-label") || "").match(/(\d+)\s*percent/i);
      if (m) pct = m[1];
    }
    return pct + "|" + (modal ? textOf(modal).length : 0);
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
    const modal = easyApplyModal();
    const x = (modal || document).querySelector('button[aria-label="Dismiss"]');
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

  // Walk the multi-step apply form. Returns "applied" | "skipped".
  async function runApplyModal() {
    // Wait for the form to mount (poll up to 12s — modal OR full-page).
    let modal = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      modal = easyApplyModal();
      if (modal) break;
      await sleep(300);
    }
    if (!modal) return "skipped";

    let stuck = 0;
    for (let step = 0; step < 14; step++) {
      if (state.cancel) { await discardAndClose(); return "skipped"; }
      if (isCheckpoint()) return "skipped";

      modal = easyApplyModal();
      if (!modal) return "skipped";

      autofill(modal);
      await sleep(rand(600, 1100));

      const before = progressSig(modal);

      // Terminal step → Submit.
      const submit = submitButton(modal);
      if (submit) {
        forceClick(submit);
        await closePostSubmit();
        return "applied";
      }
      // Otherwise Review → Next, in that order.
      const advance = reviewButton(modal) || nextButton(modal);
      if (!advance) {
        // No actionable control → can't proceed.
        await discardAndClose();
        return "skipped";
      }
      forceClick(advance);
      await sleep(rand(1400, 2400));

      // Did the form move? If not, the current step has an error we couldn't
      // satisfy. Retry autofill once; if still stuck, discard + skip.
      const after = progressSig(easyApplyModal());
      if (after === before) {
        stuck++;
        if (stuck >= 2) { await discardAndClose(); return "skipped"; }
      } else {
        stuck = 0;
      }
    }
    // Ran out of steps → give up cleanly.
    await discardAndClose();
    return "skipped";
  }

  // ─────────────── per-job flow ──────────────────────────────
  // Returns "applied" | "skipped" | "challenge".
  async function applyToCard(card) {
    if (isCheckpoint()) return "challenge";
    const el = cardElForKey(card.key);
    if (!el) return "skipped";

    // Click the card body to load the right detail pane.
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rand(900, 1600));
    humanClick(el);
    await sleep(rand(1800, 3000));   // let the detail pane render

    let apply = findInAppApply();
    if (!apply) {
      // Re-click the title once in case the first click didn't register.
      const title = el.querySelector("p, span");
      if (title) { humanClick(title); await sleep(rand(1400, 2200)); }
      apply = findInAppApply();
    }
    if (!apply) return "skipped";    // external apply / no in-app apply

    apply.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rand(600, 1100));
    humanClick(apply);

    return await runApplyModal();
  }

  // ─────────────── main loop ─────────────────────────────────
  const state = { running: false, cancel: false, applied: 0, skipped: 0 };

  async function run() {
    if (state.running) return;
    state.running = true; state.cancel = false;
    state.applied = state.skipped = 0;
    setLabel("Scanning jobs…");

    try {
      let page = 0;
      while (!state.cancel && page < 20) {
        const cards = collectJobCards();
        if (!cards.length) {
          if (page === 0) { setLabel("No job cards on page"); setTimeout(resetLabel, 4000); }
          break;
        }

        for (let i = 0; i < cards.length; i++) {
          if (state.cancel) break;
          if (isCheckpoint()) { banner("LinkedIn challenge detected — stopping."); state.cancel = true; break; }

          setLabel("Applying " + (i + 1) + "/" + cards.length + (page ? " · p" + (page + 1) : ""));
          let result = "skipped";
          try { result = await applyToCard(cards[i]); }
          catch (e) { console.warn(TAG, "job error:", e); result = "skipped"; }

          if (result === "applied") state.applied++;
          else if (result === "challenge") { banner("Challenge — stopping."); state.cancel = true; break; }
          else state.skipped++;

          // Make sure nothing is left open before the gap.
          if (easyApplyModal()) { try { await discardAndClose(); } catch (_) {} }

          if (i < cards.length - 1 && !state.cancel) {
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

        if (state.cancel) break;

        // Advance to the next results page, if any.
        const nextPage = document.querySelector(
          'button[data-testid="pagination-controls-next-button-visible"]'
        );
        if (nextPage && !nextPage.disabled && visible(nextPage)) {
          setLabel("Loading next page…");
          forceClick(nextPage);
          page++;
          await sleep(rand(2600, 4200));
        } else {
          break;
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
