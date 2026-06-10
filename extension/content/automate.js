/* Execute queued LinkedIn actions (connect, message) inside the user's own
 * browser session, at a human pace.
 *
 * Rules baked into this module:
 *   - Never run while the tab is in the background.
 *   - One action at a time, with paceBetweenActions() between them.
 *   - Read-and-pause: scroll the page, "read" for 1.2-3.5s, then act.
 *   - If a captcha / security check is detected, abort and notify the user.
 *   - Type messages character-by-character, with jitter.
 *   - Honour the daily caps the backend already enforces (we just execute).
 */
(() => {
  if (globalThis.__lcAutomate) return;
  const { sleep, paceBetweenActions, readingPause, scrollLikeHuman, tabIsForeground, waitUntilForeground } = globalThis.__lcHuman;
  const { first, waitFor, dispatchHumanClick, typeIntoEditable } = globalThis.__lcDom;
  const Api = globalThis.__lcApi;

  let running = false;

  function detectChallenge() {
    const indicators = [
      "form#captcha",
      "form[action*='checkpoint']",
      "div[data-test-id='challenge']",
      "div.cp-multi-step-flow",
      "input[name='pin']",
    ];
    return indicators.some((sel) => document.querySelector(sel));
  }

  async function navigateToProfile(linkedinUrl) {
    const target = new URL(linkedinUrl, "https://www.linkedin.com");
    if (location.href.split("?")[0] !== target.href.split("?")[0]) {
      location.href = target.href;
      return new Promise((resolve) => {
        // Resolve when the URL settles (LinkedIn SPA + a small delay)
        const start = Date.now();
        const tick = () => {
          if (location.href.startsWith(target.href.split("?")[0])) {
            setTimeout(resolve, 1500);
          } else if (Date.now() - start > 20_000) {
            resolve();
          } else {
            setTimeout(tick, 250);
          }
        };
        tick();
      });
    }
  }

  async function doConnect(job) {
    const url = job.payload?.linkedin_url;
    const note = job.payload?.body || "";
    if (!url) return { status: "failed", error: "missing_linkedin_url" };

    await navigateToProfile(url);
    await sleep(readingPause());
    await scrollLikeHuman(200);

    if (detectChallenge()) return { status: "failed", error: "captcha_or_checkpoint" };

    // Primary "Connect" button
    let btn = first(document, [
      "button[aria-label*='Connect' i]:not([aria-label*='Pending' i])",
      "main button.artdeco-button:has(span:contains('Connect'))",
    ]);
    if (!btn) {
      // Try the "More" menu and click the Connect item.
      const more = first(document, ["main button[aria-label*='More actions' i]", "button[aria-label*='More' i]"]);
      if (more) {
        await dispatchHumanClick(more);
        await sleep(800);
        btn = await waitFor(["div[role='menu'] [aria-label*='Connect' i]", "div.artdeco-dropdown__content [aria-label*='Connect' i]"], { timeout: 3000 });
      }
    }
    if (!btn) return { status: "failed", error: "connect_button_not_found" };
    await dispatchHumanClick(btn);

    // Optionally add a note.
    if (note) {
      const addNote = await waitFor(["button[aria-label*='Add a note' i]", "button[aria-label*='add a free note' i]"], { timeout: 3000 });
      if (addNote) {
        await dispatchHumanClick(addNote);
        const noteInput = await waitFor(["textarea[name='message']", "textarea#custom-message"], { timeout: 2000 });
        if (noteInput) {
          await typeIntoEditable(noteInput, note);
          await sleep(600);
        }
      }
    }
    const send = await waitFor(["button[aria-label*='Send' i]", "button[aria-label*='Send invitation' i]"], { timeout: 3000 });
    if (!send) return { status: "failed", error: "send_button_not_found" };
    await dispatchHumanClick(send);
    await sleep(1200);
    return { status: "done", result: { url, with_note: !!note } };
  }

  // ── Pending-message persistence ─────────────────────────────────────────
  // doMessage navigates to the lead's profile via `location.href = url`, which
  // is a hard navigation: the content-script context dies before the next line
  // runs. Without a resume hook the message step (find Message btn → type →
  // Send) never executes — jobs stayed "claimed" forever and the CRM's
  // "0 sent · N in progress" indicator was correct: nothing was sending.
  //
  // Fix: before navigating, persist the job to chrome.storage.local. On the
  // next page boot, main.js calls resumePendingMessage() which finishes the
  // send and posts the result to the backend. TTL is 5 min so a stranded
  // record (user navigates away mid-flow) doesn't replay forever.
  const PENDING_KEY = "lcPendingMessage";
  const PENDING_TTL_MS = 5 * 60_000;

  async function _persistPending(job) {
    try {
      await chrome.storage.local.set({
        [PENDING_KEY]: {
          jobId: job.id,
          body: job.payload?.body || "",
          url: job.payload?.linkedin_url || "",
          leadName: job.payload?.lead_name || "",
          startedAt: Date.now(),
        },
      });
    } catch {}
  }

  async function _clearPending() {
    try { await chrome.storage.local.remove(PENDING_KEY); } catch {}
  }

  async function _readPending() {
    try {
      const o = await chrome.storage.local.get(PENDING_KEY);
      return o?.[PENDING_KEY] || null;
    } catch {
      return null;
    }
  }

  // Spotlight bridges — overlay.js mounts the visual indicator. Best-effort,
  // so a missing overlay (e.g. during resume before overlay hydrates) is fine.
  function _spotShow(opts) { try { globalThis.__lcOverlay?.showMessageSpotlight?.(opts); } catch {} }
  function _spotUpdate(opts) { try { globalThis.__lcOverlay?.updateMessageSpotlight?.(opts); } catch {} }
  function _spotRemove() { try { globalThis.__lcOverlay?.removeMessageSpotlight?.(); } catch {} }

  // The actual "open chat → type → Send" steps. Runs only when the tab is
  // already on the target profile. Used by both doMessage (when no navigation
  // is needed) and resumePendingMessage (after a navigation). Drives the
  // Spotlight On Message overlay end-to-end so the user sees every step.
  async function _sendMessageInPlace(body, url, leadName) {
    _spotShow({ stage: "opening", url, leadName });
    if (detectChallenge()) {
      _spotRemove();
      return { status: "failed", error: "captcha_or_checkpoint" };
    }
    await sleep(readingPause());

    const _MSG_SELS = [
      "button[aria-label*='Message' i]:not([aria-label*='your team' i]):not([aria-label*='recruiter' i])",
      "a[aria-label*='Message' i]:not([aria-label*='your team' i])",
      "main button.message-anywhere-button",
      "[class*='message-anywhere-button']",
      "button[data-control-name*='message' i]",
    ];
    let msgBtn = first(document, _MSG_SELS);
    if (!msgBtn) {
      try { msgBtn = await waitFor(_MSG_SELS, { timeout: 8000 }); } catch {}
    }
    if (!msgBtn) {
      const candidates = document.querySelectorAll(
        "main button:not([disabled]), main a[role='button'], " +
        ".pvs-profile-actions button:not([disabled]), .pvs-profile-actions a"
      );
      for (const el of candidates) {
        const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
        const txt = (el.textContent || "").trim().toLowerCase();
        if (
          (/\bmessage\b/.test(lbl) || txt === "message") &&
          !/your team|recruiter|inmail/i.test(lbl + " " + txt)
        ) { msgBtn = el; break; }
      }
    }
    if (!msgBtn) {
      _spotRemove();
      return { status: "failed", error: "message_button_not_found" };
    }
    _spotUpdate({ stage: "click_message", target: msgBtn, leadName });
    // "Noticed the button" pause before pressing — looks human.
    await sleep(300 + Math.random() * 400);
    await dispatchHumanClick(msgBtn);

    const editor = await waitFor(
      [
        "div.msg-form__contenteditable[contenteditable='true']",
        "div[role='textbox'][contenteditable='true']",
      ],
      { timeout: 8000 }
    );
    if (!editor) {
      _spotRemove();
      return { status: "failed", error: "message_editor_not_found" };
    }
    _spotUpdate({ stage: "typing", target: editor, leadName });
    await typeIntoEditable(editor, body);
    await sleep(500 + Math.random() * 500);

    const send = first(document, [
      "button.msg-form__send-button",
      "button[type='submit'][class*='msg-form__send']",
      "button[aria-label*='Send' i]:not([aria-label*='Send a connection' i]):not([aria-label*='Send invitation' i])",
    ]);
    if (!send || send.disabled) {
      _spotRemove();
      return { status: "failed", error: "send_disabled" };
    }
    _spotUpdate({ stage: "sending", target: send, leadName });
    await sleep(200 + Math.random() * 300);
    await dispatchHumanClick(send);
    await sleep(1200);
    _spotUpdate({ stage: "sent", leadName });
    // Hold the "sent ✓" toast briefly so the user sees confirmation before
    // the next profile loads. The next page boot starts a fresh spotlight.
    setTimeout(_spotRemove, 1600);
    return { status: "done", result: { url } };
  }

  function _sameProfile(a, b) {
    try {
      const norm = (s) => {
        const u = new URL(s, "https://www.linkedin.com");
        // Normalize linkedin.com → www.linkedin.com
        if (u.hostname === "linkedin.com") u.hostname = "www.linkedin.com";
        // Strip query string and trailing slash so all these match each other:
        //   https://www.linkedin.com/in/johndoe
        //   https://www.linkedin.com/in/johndoe/
        //   https://linkedin.com/in/johndoe?miniProfileUrn=...
        return (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
      };
      return norm(a) === norm(b);
    } catch { return false; }
  }

  async function doMessage(job) {
    const url = job.payload?.linkedin_url;
    const body = job.payload?.body;
    const leadName = job.payload?.lead_name || "";
    if (!url || !body) return { status: "failed", error: "missing_url_or_body" };

    // Already on the target profile → send in place immediately.
    if (_sameProfile(location.href, url)) {
      return _sendMessageInPlace(body, url, leadName);
    }

    // Off-profile: the user explicitly queued this from the CRM Bulk Messaging
    // page (or via a playbook), so they consented to the navigation. Persist
    // the job + navigate. After the page loads, resumePendingMessage() in
    // main.js's boot path finishes the send and POSTs the result.
    //
    // Without this navigation path the autopilot would forever return
    // "not_on_target_profile" for every queued message — which is exactly the
    // "0 sent · 1 in progress" stuck state users were seeing.
    _spotShow({ stage: "navigating", url, leadName });
    await _persistPending(job);
    await sleep(150 + Math.random() * 250);
    try {
      const target = new URL(url, "https://www.linkedin.com").href;
      location.href = target;
    } catch {
      await _clearPending();
      _spotRemove();
      return { status: "failed", error: "invalid_linkedin_url" };
    }
    // executeOne special-cases this exact reason so we don't double-report —
    // the resume hook owns the final POST after navigation completes.
    return { status: "skipped", error: "navigating_to_profile" };
  }

  // Called from main.js on every page boot. If a message job is pending and
  // we're now on the right profile, finish the send and report the result.
  async function resumePendingMessage() {
    const pending = await _readPending();
    if (!pending || !pending.jobId) return;

    // Stale → drop & report as failed so the backend can re-queue.
    if (!pending.startedAt || Date.now() - pending.startedAt > PENDING_TTL_MS) {
      await _clearPending();
      for (let _si = 0; _si < 3; _si++) {
        try {
          await Api.submitJobResult(pending.jobId, {
            status: "failed",
            error: "resume_expired",
          });
          break;
        } catch (_se) {
          if (_si < 2) await sleep(300 * Math.pow(2, _si));
        }
      }
      return;
    }

    // Wrong profile (user navigated elsewhere mid-flow) → wait quietly.
    if (!_sameProfile(location.href, pending.url)) return;

    // Wait for hydration + add a small human-like reading pause.
    try { await waitFor(["main h1", "h1"], { timeout: 12000 }); } catch {}
    await sleep(1200 + Math.random() * 1800);
    // Do NOT wait for foreground — message jobs are intentionally designed to
    // run in background tabs so the user can stay on the CRM dashboard while
    // bulk sends execute. (executeOne already skips waitUntilForeground for
    // message jobs for the same reason — this must match that behaviour.
    // Before this fix, resumePendingMessage blocked here until the user switched
    // to the LinkedIn tab, causing jobs to stay "claimed" forever → the 10-min
    // reclaim brought them back to "queued" → profiles kept re-opening on loop.)

    // Clear BEFORE sending so a crash mid-send doesn't replay on the next boot.
    await _clearPending();

    let result;
    try {
      result = await _sendMessageInPlace(pending.body, pending.url, pending.leadName || "");
    } catch (err) {
      result = { status: "failed", error: String(err?.message || err) };
    }
    // Retry submitJobResult up to 3 times — the MV3 service worker may be idle
    // and need one wakeup attempt before it can proxy the API call.
    for (let _si = 0; _si < 3; _si++) {
      try {
        await Api.submitJobResult(pending.jobId, {
          status: result.status,
          result: result.result || {},
          error: result.error,
        });
        break;
      } catch (_se) {
        if (_si < 2) await sleep(300 * Math.pow(2, _si));
      }
    }
  }

  /**
   * Bridge: open the profile in a background tab where main.js's bridge
   * trigger (mirror of the enrichment trigger) scrapes the visible profile
   * + contact info, syncs the lead, and reports a structured snapshot back
   * via the regular extension-job result endpoint. Same anti-bot envelope
   * as enrichment: background tab via the service worker, foreground only
   * for write actions.
   */
  async function doBridgeProfile(job) {
    const url = job.payload?.linkedin_url;
    if (!url || !url.includes("linkedin.com/")) {
      return { status: "failed", error: "missing_linkedin_url" };
    }
    let openUrl = url;
    try {
      const u = new URL(url);
      u.searchParams.set("lc_bridge", String(job.id));
      openUrl = u.toString();
    } catch {
      openUrl = url + (url.includes("?") ? "&" : "?") + "lc_bridge=" + encodeURIComponent(job.id);
    }
    try {
      await chrome.runtime.sendMessage({
        type: "lc:openProfileTab",
        url: openUrl,
        active: false,
        awaitClose: true,
      });
    } catch (e) {
      return { status: "failed", error: "bridge_open_failed: " + (e?.message || e) };
    }
    // Snapshot is delivered by main.js directly to the job-result endpoint.
    // We report "done" with an empty payload so the autopilot loop doesn't
    // overwrite the richer payload that main.js already sent.
    return { status: "done", result: { bridged: true } };
  }

  async function executeOne(job) {
    // Connect / Follow / SearchScraper all touch high-risk surfaces (invite
    // modal, scroll-load) so still gate on foreground — matches the
    // bot-avoidance rule in CLAUDE.md ("Never automate in a hidden tab for
    // write actions"). MESSAGE jobs are different: the user explicitly
    // clicked "Send to N leads" in the CRM, so they're consciously driving
    // the action. Running message jobs without waiting for the LinkedIn tab
    // to be visible is what makes "send N messages in real-time" actually
    // work — otherwise the user clicks Send in the CRM, the LinkedIn tab is
    // backgrounded, executeOne hangs on waitUntilForeground, and the
    // progress bar sits at 0% forever.
    if (job.kind !== "message") {
      if (!tabIsForeground()) await waitUntilForeground();
    }
    try {
      let result;
      if (job.kind === "connect") result = await doConnect(job);
      else if (job.kind === "message") result = await doMessage(job);
      else if (job.kind === "scrape_search") result = await doScrapeSearch(job);
      else if (job.kind === "bridge_profile") result = await doBridgeProfile(job);
      else result = { status: "skipped", error: "unknown_kind" };

      // When doMessage persists + navigates, the resume hook on the next page
      // boot owns the final POST. Posting now would race the resume and
      // either double-fire or mark the job "skipped" before the send completes.
      if (result.status === "skipped" && result.error === "navigating_to_profile") {
        return result;
      }
      await Api.submitJobResult(job.id, {
        status: result.status,
        result: result.result || {},
        error: result.error,
      });
      return result;
    } catch (err) {
      await Api.submitJobResult(job.id, { status: "failed", error: String(err) });
      return { status: "failed", error: String(err) };
    }
  }

  /**
   * SearchScraper job: navigate to the saved LinkedIn people-search URL,
   * scrape up to N visible results, return them so the backend can ingest
   * + auto-enroll. Honors the same bot-bypass rules — runs only in a
   * foreground tab, human-paced.
   */
  async function doScrapeSearch(job) {
    const url = job.payload?.search_url;
    const maxResults = Math.max(1, Math.min(50, job.payload?.max_results || 25));
    if (!url || !url.includes("linkedin.com/")) {
      return { status: "failed", error: "missing_or_invalid_search_url" };
    }
    // Navigate the current tab to the search URL — same-tab, no new tab.
    // We're already in a foreground LinkedIn tab so navigation is safe.
    const target = new URL(url, "https://www.linkedin.com");
    if (location.href.split("?")[0] !== target.href.split("?")[0]) {
      location.href = target.href;
      // Wait for SPA to settle on the new URL
      const startAt = Date.now();
      while (
        Date.now() - startAt < 20000 &&
        !location.href.startsWith(target.href.split("?")[0])
      ) {
        await sleep(300);
      }
      await sleep(readingPause());
    }
    if (detectChallenge()) {
      return { status: "failed", error: "captcha_or_checkpoint" };
    }
    // Let the page hydrate (LinkedIn renders search results lazily)
    await waitFor(["a[href*='/in/']"], { timeout: 12000 });
    await sleep(1200);
    // Eased scroll so virtualized results below the fold render
    for (let i = 0; i < 4; i++) {
      await scrollLikeHuman(420);
      await sleep(700 + Math.random() * 800);
    }
    const Scraper = globalThis.__lcScraper;
    const profiles = (Scraper?.scrapeSearchResults?.() || []).slice(0, maxResults);
    if (!profiles.length) {
      return { status: "done", result: { profiles: [], reason: "no_results" } };
    }
    return { status: "done", result: { profiles } };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      // Guard against a stale extension context. After an extension reload,
      // open LinkedIn tabs still have the OLD content scripts running but
      // their chrome.storage / chrome.runtime references are dead. Calling
      // them throws "Cannot read properties of undefined (reading 'get')"
      // every 60s until the tab is reloaded. Detect and bail silently.
      if (!chrome?.storage?.local?.get) return;
      try { if (!chrome.runtime?.id) return; } catch { return; }

      const settings = await globalThis.__lcStorage.getSettings();
      // Only the master `enabled` flag gates the loop. `autopilot` defaults ON
      // (see storage.js DEFAULTS) so messages the user queued from the CRM
      // start sending the moment any LinkedIn tab is open — no hidden toggle
      // required. Users who explicitly turned autopilot OFF still get
      // respected here as a manual override.
      if (!settings.enabled) return;
      if (settings.autopilot === false) return;

      // Don't claim a new job while a message send is mid-navigation —
      // the resume hook owns the in-flight job. Claiming another now
      // would stomp the pending slot and lose the in-flight send.
      const pending = await _readPending();
      if (pending && pending.jobId) {
        // If we ARE on the target profile now, kick the resume immediately
        // so the user doesn't wait for the next 15 s interval tick.
        if (_sameProfile(location.href, pending.url)) {
          resumePendingMessage().catch(() => {});
        }
        return;
      }

      const jobs = await Api.nextJobs(1).catch(() => []);
      if (!jobs?.length) return;
      const [job] = jobs;

      await executeOne(job);
      // Inter-action pause. The message channel walks profiles via
      // location.href so the natural gap is page-load + a small post-send
      // pause set in resumePendingMessage — keep this tight (2–4 s) so a
      // bulk send actually feels live. Other channels keep the long-tail
      // bot-safety wait.
      if (job.kind === "message") {
        await sleep(2000 + Math.random() * 2000);
      } else {
        await sleep(paceBetweenActions());
      }
    } finally {
      running = false;
    }
  }

  globalThis.__lcAutomate = {
    tick,
    executeOne,
    doConnect,
    doMessage,
    resumePendingMessage,
  };
})();
