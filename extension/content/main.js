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

  // Auto-enrichment trigger: when the search-card Save flow opens a profile
  // in a new tab with ?lc_enrich=1, we wait for the page to settle, open the
  // Contact info modal, scrape the email/phone, push it to the backend (which
  // dedupes by linkedin_url, so it updates the existing lead), then close the
  // tab so the user can keep working on the search page. We only do this on
  // /in/ URLs to avoid feedback loops, and we sleep a human-paced delay before
  // touching the page so it doesn't look scripted.
  async function maybeRunEnrichmentTrigger() {
    try {
      const params = new URLSearchParams(location.search);
      if (!params.has("lc_enrich")) return;
      if (!location.pathname.startsWith("/in/")) return;
      if (window.__lcEnrichmentRan) return;
      window.__lcEnrichmentRan = true;

      // 1.2-3.5s reading pause, then a small jitter, then scrape.
      await Human.sleep(Human.rand(1500, 3500));
      const profile = await Scraper.scrapeProfileWithContact();
      try {
        await globalThis.__lcApi.syncProfile(profile);
      } catch (e) {
        console.warn("[LeadCaptura] enrichment sync failed", e);
      }
      // Final small pause then close. window.close() works when the tab was
      // opened by chrome.tabs.create / window.open from our service worker.
      await Human.sleep(Human.rand(400, 900));
      try {
        chrome.runtime.sendMessage({ type: "lc:closeMe" });
      } catch {
        /* fall through */
      }
      setTimeout(() => {
        try {
          window.close();
        } catch {
          /* sandboxed, leave the tab open */
        }
      }, 300);
    } catch (e) {
      console.warn("[LeadCaptura] enrichment trigger failed", e);
    }
  }

  // Boot
  onPathChange();
  startAutopilot();
  maybeRunEnrichmentTrigger();
})();
