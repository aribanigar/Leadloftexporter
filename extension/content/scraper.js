/* Scrape LinkedIn pages by reading the rendered DOM the user already sees.
 * We never call LinkedIn's internal API and never fetch from another origin.
 *
 * Pages handled:
 *   /in/<handle>                     → profile detail
 *   /search/results/people/?...      → people search
 *   /sales/lead/<id> + /sales/search → Sales Navigator
 *   /mynetwork/invite-connect/...    → invites (limited)
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

  /* ---------- Profile page (/in/handle) ---------- */

  function scrapeProfile() {
    const root = document;
    const fullName = text(
      first(root, [
        "h1.text-heading-xlarge",
        ".pv-top-card h1",
        "main h1",
        "[data-generated-suggestion-target] h1",
      ])
    );
    const headline = text(
      first(root, [
        ".text-body-medium.break-words",
        ".pv-text-details__left-panel .text-body-medium",
        "main .pv-text-details__about-this-profile-entrypoint + div .text-body-medium",
      ])
    );
    const location_ = text(
      first(root, [
        ".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words",
        ".text-body-small.inline.t-black--light.break-words",
      ])
    );
    const avatar =
      first(root, ["img.pv-top-card-profile-picture__image--show", ".pv-top-card__photo img", ".profile-photo-edit__preview"])
        ?.getAttribute("src") || null;

    // Current company can usually be read from the "experience" section's
    // first occupation or the headline annotation.
    let companyName = "";
    let companyUrl = "";
    const expSection = first(root, [
      "section[data-section='experience']",
      "section.experience",
      "section#experience",
      "section[aria-label*='experience' i]",
    ]);
    if (expSection) {
      const firstRow = first(expSection, ["li", "div.pvs-entity"]);
      if (firstRow) {
        companyName = text(
          first(firstRow, [
            ".t-14.t-normal span[aria-hidden='true']",
            ".pv-entity__secondary-title",
            "span.t-14.t-normal",
          ])
        );
        const a = first(firstRow, ["a[data-field='experience_company_logo']", "a[href*='/company/']"]);
        if (a) companyUrl = a.href;
      }
    }
    if (!companyName) {
      const headlinePart = (headline || "").split(" at ");
      if (headlinePart.length > 1) companyName = headlinePart.slice(1).join(" at ").trim();
    }

    // Title heuristic: first occupation title, or split from headline
    let title = "";
    if (expSection) {
      const firstRow = first(expSection, ["li", "div.pvs-entity"]);
      if (firstRow) {
        title = text(first(firstRow, [".t-bold span[aria-hidden='true']", ".pv-entity__summary-info h3"]));
      }
    }
    if (!title && headline) {
      title = headline.split(" at ")[0].trim();
    }

    const linkedinUrl = normalizeProfileUrl(location.href);
    const [first_name, ...rest] = (fullName || "").split(/\s+/);
    const last_name = rest.join(" ") || null;

    return {
      linkedin_url: linkedinUrl,
      full_name: fullName || null,
      first_name: first_name || null,
      last_name: last_name,
      headline: headline || null,
      title: title || null,
      location: location_ || null,
      avatar_url: avatar,
      company_name: companyName || null,
      company_url: companyUrl || null,
      raw: { source_url: location.href, page_type: "profile" },
    };
  }

  /* ---------- People search page ---------- */

  function scrapeSearchResults() {
    const cards = all(document, [
      "li.reusable-search__result-container",
      "li.search-result__occluded-item",
      "div.search-results-container li",
      "ul.reusable-search__entity-result-list > li",
    ]);
    const results = [];
    const seen = new Set();
    for (const card of cards) {
      try {
        const link = first(card, ["a[href*='/in/']"]);
        if (!link) continue;
        const url = normalizeProfileUrl(link.href);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const name = text(first(card, ["span.entity-result__title-text a span[aria-hidden='true']", ".entity-result__title-text a", "a span[aria-hidden='true']"]));
        const sub = text(first(card, [".entity-result__primary-subtitle", ".entity-result__subtitle"]));
        const loc = text(first(card, [".entity-result__secondary-subtitle"]));
        const avatar = first(card, ["img.presence-entity__image", "img.ivm-view-attr__img--centered"])?.getAttribute("src") || null;
        if (!name) continue;
        const [first_name, ...rest] = name.split(/\s+/);
        results.push({
          linkedin_url: url,
          full_name: name,
          first_name,
          last_name: rest.join(" ") || null,
          headline: sub || null,
          title: (sub || "").split(" at ")[0] || null,
          company_name: (sub || "").split(" at ")[1] || null,
          location: loc || null,
          avatar_url: avatar,
          raw: { source_url: location.href, page_type: "search-people" },
        });
      } catch {
        /* skip malformed card */
      }
    }
    return results;
  }

  /* ---------- Sales Navigator profile ---------- */

  function scrapeSalesNavProfile() {
    const fullName = text(first(document, ["h1[data-anonymize='person-name']", "main h1"]));
    const headline = text(first(document, ["[data-anonymize='headline']", "main h1 + div"]));
    const company = text(first(document, ["a[data-anonymize='company-name']", "[data-anonymize='company-name']"]));
    const title = text(first(document, ["[data-anonymize='job-title']"]));
    const location_ = text(first(document, ["[data-anonymize='location']"]));
    const liUrl = first(document, ["a[data-control-name='visit_linkedin_profile']", "a[href*='/in/']"])?.href || location.href;
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
    ]);
    const out = [];
    const seen = new Set();
    for (const card of cards) {
      const link = first(card, ["a[data-control-name='view_lead_panel_via_search_lead_name']", "a[href*='/sales/lead/']", "a[data-anonymize='person-name']"]);
      const name = text(first(card, ["[data-anonymize='person-name']", "a[data-control-name='view_lead_panel_via_search_lead_name']"]));
      if (!link || !name) continue;
      const url = normalizeProfileUrl(link.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = text(first(card, ["[data-anonymize='title']"]));
      const company = text(first(card, ["[data-anonymize='company-name']"]));
      const loc = text(first(card, ["[data-anonymize='location']"]));
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

  /* ---------- Contact info modal ----------
   *
   * On /in/<handle> there's a "Contact info" link that opens a modal exposing
   * the email + phone the profile owner has shared. This is rendered DOM —
   * not a private API — so it's safe to read by clicking the user-visible
   * affordance. We click → wait → scrape → close, same as a human would. */

  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function _findContactInfoLink() {
    const candidates = all(document, [
      "a#top-card-text-details-contact-info",
      "a[href*='/overlay/contact-info/']",
      "a[data-control-name='contact_see_more']",
      "button[aria-label*='Contact info' i]",
      "a[aria-label*='Contact info' i]",
    ]);
    for (const c of candidates) {
      const t = (c.textContent || c.getAttribute("aria-label") || "").toLowerCase();
      if (t.includes("contact info") || t.includes("contact information")) return c;
    }
    return candidates[0] || null;
  }

  function _findContactModal() {
    return first(document, [
      "div.artdeco-modal[role='dialog'][aria-labelledby*='contact' i]",
      "div[role='dialog'][aria-label*='Contact info' i]",
      "section.pv-contact-info",
      "div.artdeco-modal__content section.pv-contact-info",
      "#artdeco-modal-outlet div.artdeco-modal[role='dialog']",
    ]);
  }

  function _scrapeFromContactModal(modal) {
    const root = modal || document;
    const emailLink =
      first(root, ["a[href^='mailto:']"]) || null;
    const email = emailLink
      ? emailLink.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim()
      : null;
    // Phone numbers in LinkedIn contact-info live in a list with a section
    // header "Phone" / a phone icon. We grab anything that looks like a phone.
    let phone = null;
    const phoneAnchor = first(root, ["a[href^='tel:']"]);
    if (phoneAnchor) {
      phone = phoneAnchor.getAttribute("href").replace(/^tel:/, "").trim();
    } else {
      const liNodes = all(root, ["li", "div.pv-contact-info__contact-type", "section"]);
      for (const li of liNodes) {
        const label = (li.querySelector("h3, .pv-contact-info__header")?.textContent || "")
          .toLowerCase();
        if (!label.includes("phone")) continue;
        const span = li.querySelector("span, .pv-contact-info__contact-item, .t-14");
        const txt = (span?.textContent || "").trim();
        const m = txt.match(/\+?[\d\s\-().]{7,}/);
        if (m) {
          phone = m[0].replace(/\s+/g, " ").trim();
          break;
        }
      }
    }
    const websiteAnchor = first(root, ["a[data-control-name='contact_see_more']"]);
    // Some profiles list a personal website under contact info — surface it
    // because the email finder can use it later as the company domain.
    let website = null;
    const personalSiteAnchor = all(root, ["a[href^='http']"]).find((a) => {
      const href = a.getAttribute("href") || "";
      return (
        href &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:") &&
        !href.includes("linkedin.com") &&
        !href.includes("/overlay/")
      );
    });
    if (personalSiteAnchor) website = personalSiteAnchor.getAttribute("href");
    return { email, phone, website };
  }

  function _closeContactModal() {
    const dismiss = first(document, [
      "button[aria-label='Dismiss'][data-test-modal-close-btn]",
      "div.artdeco-modal__dismiss",
      "button.artdeco-modal__dismiss",
      "button[aria-label='Dismiss']",
    ]);
    if (dismiss) {
      dismiss.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    }
  }

  async function scrapeContactInfo({ timeoutMs = 4000 } = {}) {
    if (!location.pathname.startsWith("/in/")) {
      return { email: null, phone: null, website: null };
    }
    // If the modal is already open, just read it.
    let modal = _findContactModal();
    if (!modal) {
      const link = _findContactInfoLink();
      if (!link) return { email: null, phone: null, website: null };
      link.click();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await _sleep(150);
        modal = _findContactModal();
        if (modal) break;
      }
    }
    if (!modal) return { email: null, phone: null, website: null };
    // Give the modal one extra tick so async-rendered email links exist.
    await _sleep(250);
    const data = _scrapeFromContactModal(modal);
    _closeContactModal();
    return data;
  }

  async function scrapeProfileWithContact() {
    const base = scrapeProfile();
    try {
      const contact = await scrapeContactInfo();
      if (contact.email && !base.email) base.email = contact.email;
      if (contact.phone && !base.phone) base.phone = contact.phone;
      if (contact.website && !base.company_url) base.company_url = contact.website;
      base.raw = { ...(base.raw || {}), contact_info_scraped: true };
    } catch {
      // Contact info is best-effort. Never block a save on it.
    }
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
