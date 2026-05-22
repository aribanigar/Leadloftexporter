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

    // Small settling delay because LinkedIn is a heavy SPA
    setTimeout(() => {
      const isProfile = type === "profile" || type === "salesnav-profile";
      const isList = type === "search-people" || type === "salesnav-search";
      if (isProfile) {
        Overlay.renderProfilePanel();
        // Auto-save + auto-enrich (name+title+email+phone+location) without
        // any user interaction. Dedup is handled inside triggerAutoSave.
        Overlay.triggerAutoSave?.();
      }
      if (isList) {
        Overlay.renderToolbar();
        Overlay.mountSelectAllHeader?.();
        document.body.classList.add("lc-toolbar-mounted");
      }
      Overlay.decorateSearchCards();
    }, 600);
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

  // Periodically re-decorate (LinkedIn re-renders cards on scroll)
  setInterval(() => Overlay.decorateSearchCards?.(), 2500);

  // Autopilot tick: roughly every minute, but only when the tab is foreground,
  // and the actual gap between actions is enforced inside automate.js by
  // paceBetweenActions(). Self-terminates if it detects the extension was
  // reloaded (stale chrome.runtime) so we don't spam "Cannot read properties
  // of undefined (reading 'get')" errors forever.
  function startAutopilot() {
    if (autopilotInterval) return;
    autopilotInterval = setInterval(async () => {
      let runtimeAlive = false;
      try { runtimeAlive = !!chrome.runtime?.id; } catch { runtimeAlive = false; }
      if (!runtimeAlive || !chrome?.storage?.local?.get) {
        clearInterval(autopilotInterval);
        autopilotInterval = null;
        return;
      }
      if (!Human.tabIsForeground()) return;
      try {
        await Automate.tick();
      } catch (e) {
        console.warn("[LeadCaptura] autopilot tick failed", e?.message || e);
      }
    }, 60_000);
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

      try {
        await globalThis.__lcApi.syncProfile(profile);
      } catch (e) {
        console.warn("[LeadCaptura] enrichment sync failed", e?.message);
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

  // Boot
  onPathChange();
  startAutopilot();
  maybeRunEnrichmentTrigger();
})();
