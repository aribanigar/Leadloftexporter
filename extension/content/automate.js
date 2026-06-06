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

  // The actual "open chat → type → Send" steps. Runs only when the tab is
  // already on the target profile. Used by both doMessage (when no navigation
  // is needed) and resumePendingMessage (after a navigation).
  async function _sendMessageInPlace(body, url) {
    if (detectChallenge()) return { status: "failed", error: "captcha_or_checkpoint" };
    await sleep(readingPause());

    const msgBtn = first(document, [
      "button[aria-label*='Message ' i]",
      "a[aria-label*='Message ' i]",
      "main button.message-anywhere-button",
    ]);
    if (!msgBtn) return { status: "failed", error: "message_button_not_found" };
    await dispatchHumanClick(msgBtn);

    const editor = await waitFor(
      [
        "div.msg-form__contenteditable[contenteditable='true']",
        "div[role='textbox'][contenteditable='true']",
      ],
      { timeout: 6000 }
    );
    if (!editor) return { status: "failed", error: "message_editor_not_found" };

    await typeIntoEditable(editor, body);
    await sleep(400);

    const send = first(document, [
      "button.msg-form__send-button",
      "button[aria-label*='Send' i]",
    ]);
    if (!send || send.disabled) return { status: "failed", error: "send_disabled" };
    await dispatchHumanClick(send);
    await sleep(1200);
    return { status: "done", result: { url } };
  }

  function _sameProfile(a, b) {
    try {
      const ua = new URL(a, "https://www.linkedin.com").href.split("?")[0];
      const ub = new URL(b, "https://www.linkedin.com").href.split("?")[0];
      return ua === ub;
    } catch { return false; }
  }

  async function doMessage(job) {
    const url = job.payload?.linkedin_url;
    const body = job.payload?.body;
    if (!url || !body) return { status: "failed", error: "missing_url_or_body" };

    // Already on the target profile? Send in-place, no navigation required.
    if (_sameProfile(location.href, url)) {
      return _sendMessageInPlace(body, url);
    }

    // We need to navigate. Persist the job FIRST so the new page can pick it
    // up after this content-script context dies, then trigger the hard
    // navigation. The post-resolve code is never reached — by design.
    await _persistPending(job);
    try {
      const target = new URL(url, "https://www.linkedin.com");
      location.href = target.href;
    } catch {
      await _clearPending();
      return { status: "failed", error: "bad_linkedin_url" };
    }
    // Block forever — the page is unloading. resumePendingMessage() in the
    // new page context submits the result.
    await new Promise(() => {});
    return { status: "skipped", error: "navigated" }; // unreachable
  }

  // Called from main.js on every page boot. If a message job is pending and
  // we're now on the right profile, finish the send and report the result.
  async function resumePendingMessage() {
    const pending = await _readPending();
    if (!pending || !pending.jobId) return;

    // Stale → drop & report as failed so the backend can re-queue.
    if (!pending.startedAt || Date.now() - pending.startedAt > PENDING_TTL_MS) {
      await _clearPending();
      try {
        await Api.submitJobResult(pending.jobId, {
          status: "failed",
          error: "resume_expired",
        });
      } catch {}
      return;
    }

    // Wrong profile (user navigated elsewhere mid-flow) → wait quietly.
    if (!_sameProfile(location.href, pending.url)) return;

    // Wait for hydration + add a small human-like reading pause.
    try { await waitFor(["main h1", "h1"], { timeout: 12000 }); } catch {}
    await sleep(1200 + Math.random() * 1800);
    if (!tabIsForeground()) await waitUntilForeground();

    // Clear BEFORE sending so a crash mid-send doesn't replay on the next boot.
    await _clearPending();

    let result;
    try {
      result = await _sendMessageInPlace(pending.body, pending.url);
    } catch (err) {
      result = { status: "failed", error: String(err?.message || err) };
    }
    try {
      await Api.submitJobResult(pending.jobId, {
        status: result.status,
        result: result.result || {},
        error: result.error,
      });
    } catch {}
  }

  async function executeOne(job) {
    if (!tabIsForeground()) await waitUntilForeground();
    try {
      let result;
      if (job.kind === "connect") result = await doConnect(job);
      else if (job.kind === "message") result = await doMessage(job);
      else if (job.kind === "scrape_search") result = await doScrapeSearch(job);
      else result = { status: "skipped", error: "unknown_kind" };
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
      const jobs = await Api.nextJobs(1).catch(() => []);
      if (!jobs?.length) return;
      const [job] = jobs;
      await executeOne(job);
      // Human pause before next action
      await sleep(paceBetweenActions());
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
