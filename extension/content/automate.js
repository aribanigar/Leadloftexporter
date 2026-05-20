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
        dispatchHumanClick(more);
        await sleep(800);
        btn = await waitFor(["div[role='menu'] [aria-label*='Connect' i]", "div.artdeco-dropdown__content [aria-label*='Connect' i]"], { timeout: 3000 });
      }
    }
    if (!btn) return { status: "failed", error: "connect_button_not_found" };
    dispatchHumanClick(btn);

    // Optionally add a note.
    if (note) {
      const addNote = await waitFor(["button[aria-label*='Add a note' i]", "button[aria-label*='add a free note' i]"], { timeout: 3000 });
      if (addNote) {
        dispatchHumanClick(addNote);
        const noteInput = await waitFor(["textarea[name='message']", "textarea#custom-message"], { timeout: 2000 });
        if (noteInput) {
          await typeIntoEditable(noteInput, note);
          await sleep(600);
        }
      }
    }
    const send = await waitFor(["button[aria-label*='Send' i]", "button[aria-label*='Send invitation' i]"], { timeout: 3000 });
    if (!send) return { status: "failed", error: "send_button_not_found" };
    dispatchHumanClick(send);
    await sleep(1200);
    return { status: "done", result: { url, with_note: !!note } };
  }

  async function doMessage(job) {
    const url = job.payload?.linkedin_url;
    const body = job.payload?.body;
    if (!url || !body) return { status: "failed", error: "missing_url_or_body" };

    await navigateToProfile(url);
    await sleep(readingPause());

    if (detectChallenge()) return { status: "failed", error: "captcha_or_checkpoint" };

    const msgBtn = first(document, [
      "button[aria-label*='Message ' i]",
      "a[aria-label*='Message ' i]",
      "main button.message-anywhere-button",
    ]);
    if (!msgBtn) return { status: "failed", error: "message_button_not_found" };
    dispatchHumanClick(msgBtn);

    const editor = await waitFor(
      [
        "div.msg-form__contenteditable[contenteditable='true']",
        "div[role='textbox'][contenteditable='true']",
      ],
      { timeout: 4000 }
    );
    if (!editor) return { status: "failed", error: "message_editor_not_found" };

    await typeIntoEditable(editor, body);
    await sleep(400);

    const send = first(document, [
      "button.msg-form__send-button",
      "button[aria-label*='Send' i]",
    ]);
    if (!send || send.disabled) return { status: "failed", error: "send_disabled" };
    dispatchHumanClick(send);
    await sleep(1200);
    return { status: "done", result: { url } };
  }

  async function executeOne(job) {
    if (!tabIsForeground()) await waitUntilForeground();
    try {
      let result;
      if (job.kind === "connect") result = await doConnect(job);
      else if (job.kind === "message") result = await doMessage(job);
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
      if (!settings.enabled || !settings.autopilot) return;
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

  globalThis.__lcAutomate = { tick, executeOne, doConnect, doMessage };
})();
