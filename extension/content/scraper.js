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
    scrapeSalesNavProfile,
    scrapeSearchResults,
    scrapeSalesNavSearch,
    scrapeCurrentPage,
  };
})();
