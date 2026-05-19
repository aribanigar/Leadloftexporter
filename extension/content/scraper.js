/* Scrape LinkedIn pages by reading the rendered DOM.
 * Strategy: avoid class-name selectors entirely — LinkedIn hashes them.
 * Instead use structural selectors, aria attributes, data-* attrs, and
 * href patterns that have been stable across LinkedIn redesigns.
 */
(() => {
  if (globalThis.__lcScraper) return;
  const { text, first, all, normalizeProfileUrl } = globalThis.__lcDom;

  function pageType() {
    const p = location.pathname;
    if (p.startsWith("/in/")) return "profile";
    if (p.startsWith("/sales/lead/")) return "salesnav-profile";
    if (p.startsWith("/sales/search")) return "salesnav-search";
    if (p.startsWith("/sales/people") || p.startsWith("/sales/connections")) return "salesnav-search";
    if (p.startsWith("/search/results/people")) return "search-people";
    if (p === "/" || p.startsWith("/feed")) return "feed";
    return "unknown";
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  // First non-empty text from a list of selector attempts
  function tryText(...selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) { const t = text(el); if (t) return t; }
      } catch { /* skip */ }
    }
    return "";
  }

  // Find ALL li elements that contain a /in/ profile link (search cards)
  function findProfileCards() {
    const seen = new Set();
    const out = [];
    // Cast wide net: any li anywhere that links to a profile
    document.querySelectorAll("li").forEach((li) => {
      if (li.dataset.lcCard) return; // already processed
      const link = li.querySelector("a[href*='/in/']");
      if (!link) return;
      const url = normalizeProfileUrl(link.href);
      if (!url || seen.has(url)) return;
      // Must have at least 80px height — skips nav items, footer links
      const rect = li.getBoundingClientRect();
      if (rect.height < 60) return;
      seen.add(url);
      out.push({ li, url });
    });
    return out;
  }

  // Extract name from a card li. LinkedIn always puts the name in an
  // aria-hidden span inside the profile link so screen readers get it once.
  function nameFromCard(li) {
    // Most reliable: aria-hidden span inside the /in/ anchor
    const link = li.querySelector("a[href*='/in/']");
    if (link) {
      const span = link.querySelector("span[aria-hidden='true']");
      if (span) { const t = text(span); if (t && t.length > 1) return t; }
      // Fallback: first span with visible text
      const spans = [...link.querySelectorAll("span")];
      for (const s of spans) {
        const t = text(s);
        if (t && t.length > 1 && !t.includes("LinkedIn") && !t.includes("View")) return t;
      }
    }
    return "";
  }

  // ── Profile page (/in/handle) ─────────────────────────────────────────────

  function scrapeProfile() {
    // Name: h1 is always the profile name on /in/ pages — no class needed
    const fullName =
      tryText("main h1", "h1") ||
      tryText("[data-generated-suggestion-target] h1", "section h1");

    // Headline: first element with role="heading" level 2, or the div/span
    // directly following the h1, or the element with "at" in its text near top
    let headline = "";
    const h1 = document.querySelector("main h1") || document.querySelector("h1");
    if (h1) {
      // Walk siblings/parents to find the subtitle element below the name
      let el = h1.nextElementSibling;
      for (let i = 0; i < 5 && el; i++) {
        const t = text(el);
        if (t && t.length > 3 && t.length < 300 && !t.match(/^\d+/)) {
          headline = t;
          break;
        }
        el = el.nextElementSibling;
      }
      // If not found as sibling, try parent's next sibling
      if (!headline && h1.parentElement) {
        let p = h1.parentElement.nextElementSibling;
        for (let i = 0; i < 3 && p; i++) {
          const t = text(p);
          if (t && t.length > 3 && t.length < 300) { headline = t; break; }
          p = p.nextElementSibling;
        }
      }
    }
    // Fallback: aria-label'd headline element or any short text block near top
    if (!headline) {
      headline = tryText(
        "[aria-label*='headline' i]",
        ".pv-text-details__left-panel .text-body-medium",
        ".text-body-medium.break-words"
      );
    }

    // Location: look for span/div with location-like content after headline
    const location_ = tryText(
      "[aria-label*='location' i]",
      ".pv-text-details__left-panel .text-body-small",
      ".text-body-small.inline"
    );

    // Avatar: profile photo img
    const avatar =
      document.querySelector("img.pv-top-card-profile-picture__image--show")?.src ||
      document.querySelector(".pv-top-card__photo img")?.src ||
      document.querySelector("img[alt*='profile' i][src*='licdn']")?.src ||
      document.querySelector("main img[src*='licdn']")?.src ||
      null;

    // Company + title: try experience section first, then split headline
    let companyName = "";
    let companyUrl = "";
    let title = "";

    const expSection = document.querySelector(
      "section[data-section='experience'], section[aria-label*='experience' i], #experience ~ div section, section#experience"
    );
    if (expSection) {
      const firstItem = expSection.querySelector("li, div[data-view-name='profile-component-entity']");
      if (firstItem) {
        const spans = [...firstItem.querySelectorAll("span[aria-hidden='true']")];
        if (spans[0]) title = text(spans[0]);
        if (spans[1]) companyName = text(spans[1]);
        const compLink = firstItem.querySelector("a[href*='/company/']");
        if (compLink) companyUrl = compLink.href;
      }
    }
    if (!title && headline) title = headline.split(" at ")[0].trim();
    if (!companyName && headline) {
      const parts = headline.split(" at ");
      if (parts.length > 1) companyName = parts.slice(1).join(" at ").trim();
    }

    const linkedinUrl = normalizeProfileUrl(location.href);
    const [first_name, ...rest] = (fullName || "").split(/\s+/);

    return {
      linkedin_url: linkedinUrl,
      full_name: fullName || null,
      first_name: first_name || null,
      last_name: rest.join(" ") || null,
      headline: headline || null,
      title: title || null,
      location: location_ || null,
      avatar_url: avatar,
      company_name: companyName || null,
      company_url: companyUrl || null,
      raw: { source_url: location.href, page_type: "profile" },
    };
  }

  // ── People search (/search/results/people) ────────────────────────────────

  function scrapeSearchResults() {
    const cards = findProfileCards();
    const results = [];
    for (const { li, url } of cards) {
      try {
        const name = nameFromCard(li);
        if (!name) continue;

        // Headline/subtitle: look for spans after the name link that have
        // meaningful text (not "2nd", "3rd+", mutual connections, etc.)
        let sub = "";
        let loc = "";
        const allSpans = [...li.querySelectorAll("span[aria-hidden='true'], div[aria-hidden='true']")];
        for (const s of allSpans) {
          const t = text(s);
          if (!t || t === name || t.match(/^\d+(st|nd|rd|th)\+?$/) || t.length < 3) continue;
          if (t.match(/mutual connection|follower/i)) continue;
          if (!sub && t.includes(" at ") || t.length > 15) { sub = t; continue; }
          if (!loc && t.match(/,| Area$| Region$/i) && t.length > 3) { loc = t; }
        }

        const avatar =
          li.querySelector("img[src*='licdn']")?.src ||
          li.querySelector("img[src*='media.licdn']")?.src ||
          null;

        const [first_name, ...rest] = name.split(/\s+/);
        results.push({
          linkedin_url: url,
          full_name: name,
          first_name,
          last_name: rest.join(" ") || null,
          headline: sub || null,
          title: sub ? sub.split(" at ")[0].trim() : null,
          company_name: sub ? (sub.split(" at ")[1] || "").trim() || null : null,
          location: loc || null,
          avatar_url: avatar,
          raw: { source_url: location.href, page_type: "search-people" },
        });
      } catch { /* skip malformed card */ }
    }
    return results;
  }

  // ── Sales Navigator profile ───────────────────────────────────────────────

  function scrapeSalesNavProfile() {
    const fullName = tryText(
      "h1[data-anonymize='person-name']",
      "main h1",
      "h1"
    );
    const headline = tryText("[data-anonymize='headline']", "[data-anonymize='job-title']");
    const company = tryText("a[data-anonymize='company-name']", "[data-anonymize='company-name']");
    const title = tryText("[data-anonymize='job-title']");
    const location_ = tryText("[data-anonymize='location']");
    const liUrl =
      document.querySelector("a[data-control-name='visit_linkedin_profile']")?.href ||
      document.querySelector("a[href*='/in/']")?.href ||
      location.href;
    const url = normalizeProfileUrl(liUrl);
    const [first_name, ...rest] = (fullName || "").split(/\s+/);
    return {
      linkedin_url: url,
      full_name: fullName || null,
      first_name: first_name || null,
      last_name: rest.join(" ") || null,
      headline: headline || null,
      title: title || null,
      company_name: company || null,
      location: location_ || null,
      raw: { source_url: location.href, page_type: "salesnav-profile" },
    };
  }

  function scrapeSalesNavSearch() {
    const cards = all(document, [
      "li.artdeco-list__item",
      "li.search-results__result-item",
      "li[data-x-search-result]",
      "li[id^='ember']",
    ]);
    const out = [];
    const seen = new Set();
    for (const card of cards) {
      const link = first(card, [
        "a[data-control-name='view_lead_panel_via_search_lead_name']",
        "a[href*='/sales/lead/']",
        "a[data-anonymize='person-name']",
      ]);
      const name = text(first(card, ["[data-anonymize='person-name']"])) || nameFromCard(card);
      if (!link || !name) continue;
      const url = normalizeProfileUrl(link.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = tryText("[data-anonymize='title']");
      const company = tryText("[data-anonymize='company-name']");
      const loc = tryText("[data-anonymize='location']");
      const [first_name, ...rest] = name.split(/\s+/);
      out.push({
        linkedin_url: url,
        full_name: name,
        first_name,
        last_name: rest.join(" ") || null,
        title: title || null,
        company_name: company || null,
        location: loc || null,
        raw: { source_url: location.href, page_type: "salesnav-search" },
      });
    }
    return out;
  }

  // ── Contact info modal (DOM fallback when Voyager unavailable) ───────────

  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function _findContactInfoLink() {
    return (
      document.querySelector("a[href*='/overlay/contact-info/']") ||
      document.querySelector("a#top-card-text-details-contact-info") ||
      [...document.querySelectorAll("a, button")].find((el) =>
        (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().includes("contact info")
      ) || null
    );
  }

  function _findContactModal() {
    return (
      document.querySelector("div[role='dialog'][aria-label*='contact' i]") ||
      document.querySelector("#artdeco-modal-outlet div[role='dialog']") ||
      document.querySelector("section.pv-contact-info") ||
      null
    );
  }

  function _scrapeFromModal(modal) {
    const root = modal || document;
    const emailEl = root.querySelector("a[href^='mailto:']");
    const email = emailEl ? emailEl.href.replace("mailto:", "").split("?")[0].trim() : null;
    const phoneEl = root.querySelector("a[href^='tel:']");
    let phone = phoneEl ? phoneEl.href.replace("tel:", "").trim() : null;
    if (!phone) {
      [...root.querySelectorAll("span, li")].forEach((el) => {
        if (phone) return;
        const t = text(el);
        if (t && t.match(/\+?[\d\s\-().]{7,}/)) phone = t.match(/\+?[\d\s\-().]{7,}/)[0].trim();
      });
    }
    return { email, phone };
  }

  async function scrapeContactInfo({ timeoutMs = 5000 } = {}) {
    if (!location.pathname.startsWith("/in/")) return { email: null, phone: null };
    let modal = _findContactModal();
    if (!modal) {
      const link = _findContactInfoLink();
      if (!link) return { email: null, phone: null };
      link.click();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await _sleep(150);
        modal = _findContactModal();
        if (modal) break;
      }
    }
    if (!modal) return { email: null, phone: null };
    await _sleep(300);
    const data = _scrapeFromModal(modal);
    // Close modal
    const dismiss = document.querySelector(
      "button[aria-label='Dismiss'], .artdeco-modal__dismiss, button.artdeco-modal__dismiss"
    );
    if (dismiss) dismiss.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return data;
  }

  async function scrapeProfileWithContact() {
    const base = scrapeProfile();
    try {
      const contact = await scrapeContactInfo();
      if (contact.email && !base.email) base.email = contact.email;
      if (contact.phone && !base.phone) base.phone = contact.phone;
    } catch { /* best-effort */ }
    return base;
  }

  function scrapeCurrentPage() {
    switch (pageType()) {
      case "profile":
        return { kind: "profile", profile: scrapeProfile() };
      case "salesnav-profile":
        return { kind: "profile", profile: scrapeSalesNavProfile() };
      case "search-people":
        return { kind: "search", profiles: scrapeSearchResults() };
      case "salesnav-search":
        return { kind: "search", profiles: scrapeSalesNavSearch() };
      default:
        return { kind: "none" };
    }
  }

  globalThis.__lcScraper = {
    pageType,
    scrapeProfile,
    scrapeProfileWithContact,
    scrapeContactInfo,
    scrapeSalesNavProfile,
    scrapeSearchResults,
    scrapeSalesNavSearch,
    scrapeCurrentPage,
  };
})();
