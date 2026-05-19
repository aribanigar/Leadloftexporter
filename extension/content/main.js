/* Content-script entry point. Coordinates the scraper, overlay, and
 * autopilot tick on LinkedIn pages. */
(() => {
  if (window.__leadCapturaMounted) return;
  window.__leadCapturaMounted = true;

  const Overlay = globalThis.__lcOverlay;
  const Automate = globalThis.__lcAutomate;
  const Scraper = globalThis.__lcScraper;
  const Human = globalThis.__lcHuman;

  let lastPath = null;
  let autopilotInterval = null;

  function onPathChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const type = Scraper.pageType();

    // Always tear down everything before deciding what to render.
    Overlay.unmountProfilePanel();
    Overlay.unmountToolbar();
    document.body.classList.remove("lc-toolbar-mounted");

    if (type === "unknown" || type === "feed") return;

    // Small settling delay because LinkedIn is a heavy SPA
    setTimeout(() => {
      const isProfile = type === "profile" || type === "salesnav-profile";
      const isList = type === "search-people" || type === "salesnav-search";
      if (isProfile) Overlay.renderProfilePanel();
      if (isList) {
        Overlay.renderToolbar();
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
  // paceBetweenActions().
  function startAutopilot() {
    if (autopilotInterval) return;
    autopilotInterval = setInterval(async () => {
      if (!Human.tabIsForeground()) return;
      try {
        await Automate.tick();
      } catch (e) {
        console.warn("[LeadCaptura] autopilot tick failed", e);
      }
    }, 60_000);
  }

  // Listen for settings changes (autopilot toggle from popup/options)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    onPathChange();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "lc:scrape") {
      sendResponse(Scraper.scrapeCurrentPage());
      return true;
    }
    if (msg?.type === "lc:saveCurrent") {
      const scraped = Scraper.scrapeCurrentPage();
      if (scraped.kind === "profile") {
        globalThis.__lcApi
          .syncProfile(scraped.profile)
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (scraped.kind === "search") {
        globalThis.__lcApi
          .syncSearch({ page_url: location.href, captured_at: new Date().toISOString(), profiles: scraped.profiles })
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      sendResponse({ ok: false, error: "nothing_to_save" });
      return true;
    }
  });

  // Boot
  onPathChange();
  startAutopilot();
})();
