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

  const Overlay = globalThis.__lcOverlay;
  const Automate = globalThis.__lcAutomate;
  const Scraper = globalThis.__lcScraper;
  const Human = globalThis.__lcHuman;
  const Storage = globalThis.__lcStorage;

  let lastPath = null;
  let autopilotInterval = null;

  // Track which profile URLs we've already auto-enriched in this page session
  // to avoid re-running on every SPA nav back to the same profile.
  const autoEnrichedUrls = new Set();

  // Auto-enrich the current profile page: after a human-paced delay, open
  // the Contact info modal and push email/phone to the backend. This runs
  // silently in the background — the user just sees the profile page.
  async function maybeAutoEnrichCurrentProfile() {
    try {
      if (Scraper.pageType() !== "profile") return;
      const params = new URLSearchParams(location.search);
      if (params.has("lc_enrich")) return; // Already in enrichment mode
      const path = location.pathname;
      if (autoEnrichedUrls.has(path)) return;
      autoEnrichedUrls.add(path);

      const settings = await Storage.getSettings();
      if (settings.autoEnrichOnSave === false) return;

      // 3–9s reading delay so it looks like the user is viewing the page.
      // 15% chance of an extra 5–12s pause ("they got distracted").
      const base = Human.rand(3000, 9000);
      const bonus = Math.random() < 0.15 ? Human.rand(5000, 12000) : 0;
      await Human.sleep(base + bonus);

      const contact = await Scraper.scrapeContactInfo();
      if (!contact.email && !contact.phone) return; // Nothing new to add

      const profile = Scraper.scrapeProfile();
      if (!profile?.linkedin_url) return;
      if (contact.email) profile.email = contact.email;
      if (contact.phone) profile.phone = contact.phone;
      if (contact.website) profile.company_url = contact.website;
      profile.raw = { ...(profile.raw || {}), contact_info_scraped: true };

      await globalThis.__lcApi.syncProfile(profile);
    } catch (e) {
      // Silently fail — enrichment is always best-effort
      console.warn("[LeadCaptura] auto-enrich failed:", e?.message);
    }
  }

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
      if (isProfile) {
        Overlay.renderProfilePanel();
        maybeAutoEnrichCurrentProfile();
      }
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
    try {
      const params = new URLSearchParams(location.search);
      if (!params.has("lc_enrich")) return;
      // Accept both the direct profile URL and the overlay sub-path
      if (!location.pathname.startsWith("/in/")) return;
      if (window.__lcEnrichmentRan) return;
      window.__lcEnrichmentRan = true;

      // Human-paced reading pause: 1.5–4s base, 12% long-tail up to 8s.
      const base = Human.rand(1500, 4000);
      const longTail = Math.random() < 0.12 ? Human.rand(2000, 8000) : 0;
      await Human.sleep(base + longTail);

      // scrapeProfileWithContact() handles both the overlay-URL (modal already
      // open) and the regular-URL (clicks the Contact info link) cases.
      const profile = await Scraper.scrapeProfileWithContact();
      try {
        await globalThis.__lcApi.syncProfile(profile);
      } catch (e) {
        console.warn("[LeadCaptura] enrichment sync failed", e?.message);
      }

      await Human.sleep(Human.rand(300, 800));
      try {
        chrome.runtime.sendMessage({ type: "lc:closeMe" });
      } catch {
        /* fall through */
      }
      setTimeout(() => {
        try { window.close(); } catch { /* sandboxed — leave tab */ }
      }, 250);
    } catch (e) {
      console.warn("[LeadCaptura] enrichment trigger failed", e?.message);
    }
  }

  // Boot
  onPathChange();
  startAutopilot();
  maybeRunEnrichmentTrigger();
})();
