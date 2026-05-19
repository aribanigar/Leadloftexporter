/* Scrape LinkedIn pages by reading the rendered DOM the user already sees.
 * We never call LinkedIn's internal API and never fetch from another origin.
 *
 * Pages handled:
 *   /in/<handle>                     → profile detail
 *   /search/results/people/?...      → people search
 *   /sales/lead/<id> + /sales/search → Sales Navigator
 *
 * Implementation philosophy: LinkedIn class names are HASHED and rotate.
 * `text-heading-xlarge` / `entity-result__title-text` / `pv-top-card` only
 * work for a few weeks before they're rewritten. We avoid class selectors
 * entirely and instead use:
 *   - element type (h1, main, img, a)
 *   - href / data-* / aria-* attributes (LinkedIn keeps these stable
 *     because their own product code depends on them)
 *   - structural relationships (h1 inside main; nearest <li> ancestor of
 *     an /in/ link)
 *   - text fingerprints ("Contact info") for action affordances
 */
(() => {
  if (globalThis.__lcScraper) return;
  const { normalizeProfileUrl } = globalThis.__lcDom;

  function pageType() {
    const p = location.pathname;
    if (p.startsWith("/in/")) return "profile";
    if (p.startsWith("/sales/lead/")) return "salesnav-profile";
    // Sales Navigator has many list-type surfaces — match them all.
    if (
      p.startsWith("/sales/search") ||
      p.startsWith("/sales/people") ||
      p.startsWith("/sales/connections") ||
      p.startsWith("/sales/lists/people") ||
      p.startsWith("/sales/lists/saved-leads") ||
      p.startsWith("/sales/lists/accounts") ||
      p.startsWith("/sales/discover")
    ) return "salesnav-search";
    if (p.startsWith("/search/results/people")) return "search-people";
    // Generic /search/results/ may include people too; we'll fall through to
    // scrapeSearchResults() which simply returns [] if no /in/ links exist.
    if (p.startsWith("/search/results/")) return "search-people";
    if (p.startsWith("/mynetwork/invitation-manager") || p.startsWith("/mynetwork/invite-connect/connections")) return "search-people";
    if (p === "/" || p.startsWith("/feed")) return "feed";
    return "unknown";
  }

  const _txt = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim() || null;
  const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Profile page (/in/handle) ----------
   *
   * The top card is a <section> (or <div>) inside <main> that contains the
   * single <h1> for the page. We anchor on that h1 and walk relative to it
   * — every other field is a near neighbour.
   */

  function _findTopCard() {
    const h1 = document.querySelector("main h1") || document.querySelector("h1");
    if (!h1) return { h1: null, card: null };
    // Walk up to the nearest sectioning element that contains the photo and
    // the action buttons (Message / Connect). A reasonable proxy: the deepest
    // ancestor that still contains both the h1 and an <img>.
    let card = h1.parentElement;
    for (let i = 0; i < 8 && card; i++) {
      if (card.querySelector("img") && card.querySelector("a[href*='/overlay/']")) break;
      card = card.parentElement;
    }
    return { h1, card: card || h1.parentElement };
  }

  function _firstTextAfter(h1) {
    // Walk DOM order after the h1 and return the first sibling-ish element
    // that has text > 4 chars and is NOT the name itself. This is the
    // "headline" line LinkedIn renders directly under the name.
    const seen = new Set();
    const queue = [h1.parentElement];
    let foundH1 = false;
    while (queue.length) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      for (const child of node.children) {
        if (child === h1) {
          foundH1 = true;
          continue;
        }
        if (!foundH1) continue;
        const t = _txt(child);
        if (t && t.length > 4 && t.length < 240 && !/connect|message|follow|more/i.test(t)) {
          return t;
        }
        if (child.children?.length) queue.push(child);
      }
    }
    return null;
  }

  function _findAvatar(card) {
    if (!card) return null;
    const imgs = card.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      if (src.includes("/profile-displayphoto") || src.includes("media.licdn.com") || src.includes("profile-")) {
        return src;
      }
    }
    return imgs[0]?.getAttribute("src") || null;
  }

  function scrapeProfile() {
    const { h1, card } = _findTopCard();
    const fullName = _txt(h1);

    // Headline: the text line directly under the name. Multiple fallbacks
    // because LinkedIn sometimes wraps it in different structures.
    let headline = null;
    if (h1) {
      // Try the immediate next sibling first
      let n = h1.nextElementSibling;
      while (n && !headline) {
        const t = _txt(n);
        if (t && t.length > 4) headline = t;
        n = n.nextElementSibling;
      }
      if (!headline) headline = _firstTextAfter(h1);
    }

    // Location: typically a short string in the top card with a city/country
    // pattern, lives in a div with "text-body-small" inheritance — but we
    // match it positionally instead. Heuristic: among the text-bearing
    // descendants of the top card, the one that's NOT the name, headline,
    // or connection counts, and has a comma or short length.
    let location_ = null;
    if (card) {
      const candidates = Array.from(card.querySelectorAll("div, span"))
        .map((n) => _txt(n))
        .filter(Boolean);
      for (const t of candidates) {
        if (t === fullName || t === headline) continue;
        if (/connect|follower|mutual|message/i.test(t)) continue;
        if (t.length > 4 && t.length < 80 && (t.includes(",") || /\b(india|uae|usa|uk|qatar|emirates|states|kingdom|america|kong|saudi)\b/i.test(t))) {
          location_ = t;
          break;
        }
      }
    }

    const avatar = _findAvatar(card);

    // Company: parse from headline ("Title at Company") as a reliable
    // fallback. The Experience section's first row varies too wildly to
    // depend on without classes.
    let companyName = null;
    let title = null;
    if (headline) {
      const parts = headline.split(/\s+at\s+/i);
      if (parts.length >= 2) {
        title = parts[0].trim();
        companyName = parts.slice(1).join(" at ").trim();
      } else {
        title = headline;
      }
    }

    const linkedinUrl = normalizeProfileUrl(location.href);
    const [first_name, ...rest] = (fullName || "").split(/\s+/);

    return {
      linkedin_url: linkedinUrl,
      full_name: fullName,
      first_name: first_name || null,
      last_name: rest.join(" ") || null,
      headline,
      title,
      location: location_,
      avatar_url: avatar,
      company_name: companyName,
      company_url: null,
      raw: { source_url: location.href, page_type: "profile" },
    };
  }

  /* ---------- Contact info modal ----------
   *
   * The "Contact info" anchor on a profile has a stable URL:
   * /in/<handle>/overlay/contact-info/. We anchor on the href, not on text.
   */

  function _findContactInfoLink() {
    return (
      document.querySelector("a[href*='/overlay/contact-info/']") ||
      document.querySelector("a[id*='contact-info']") ||
      // Text fallback — slow path
      Array.from(document.querySelectorAll("a, button")).find((n) =>
        /^\s*Contact info\s*$/i.test(n.textContent || "")
      )
    );
  }

  function _findContactModal() {
    // After clicking Contact info (or navigating to the overlay URL), LinkedIn
    // renders an artdeco-modal. Multiple selectors as fallback — LinkedIn
    // occasionally changes the labelling attributes.
    return (
      document.querySelector("div[role='dialog'][aria-labelledby*='contact' i]") ||
      document.querySelector("div[role='dialog'][aria-label*='Contact' i]") ||
      document.querySelector("#artdeco-modal-outlet div[role='dialog']") ||
      // artdeco-modal is the host element; the inner dialog is what we want
      document.querySelector("artdeco-modal div[role='dialog']") ||
      document.querySelector("div.artdeco-modal__content") ||
      document.querySelector("div[role='dialog']")
    );
  }

  function _isValidContactModal(modal) {
    if (!modal) return false;
    return (
      modal.querySelector("a[href^='mailto:']") ||
      modal.querySelector("a[href^='tel:']") ||
      /contact info/i.test(modal.textContent || "")
    );
  }

  function _scrapeFromContactModal(modal) {
    if (!modal) return { email: null, phone: null, website: null };
    const emailAnchor = modal.querySelector("a[href^='mailto:']");
    const email = emailAnchor
      ? emailAnchor.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim()
      : null;

    let phone = null;
    const phoneAnchor = modal.querySelector("a[href^='tel:']");
    if (phoneAnchor) {
      phone = phoneAnchor.getAttribute("href").replace(/^tel:/, "").trim();
    } else {
      // Some profiles list the phone as plain text under a "Phone" header.
      const sections = modal.querySelectorAll("section, li, div");
      for (const s of sections) {
        const h = _txt(s.querySelector("h3, h4, span"));
        if (h && /phone/i.test(h)) {
          const m = (_txt(s) || "").match(/\+?[\d\s\-().]{7,}/);
          if (m) {
            phone = m[0].replace(/\s+/g, " ").trim();
            break;
          }
        }
      }
    }

    let website = null;
    const externalAnchors = Array.from(modal.querySelectorAll("a[href^='http']"));
    for (const a of externalAnchors) {
      const href = a.getAttribute("href") || "";
      if (
        !href.includes("linkedin.com") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:") &&
        !href.includes("/overlay/")
      ) {
        website = href;
        break;
      }
    }
    return { email, phone, website };
  }

  function _closeContactModal() {
    const dismiss =
      document.querySelector("button[aria-label='Dismiss']") ||
      document.querySelector("[data-test-modal-close-btn]");
    if (dismiss) {
      dismiss.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    }
  }

  async function scrapeContactInfo({ timeoutMs = 9000 } = {}) {
    if (!location.pathname.startsWith("/in/")) {
      return { email: null, phone: null, website: null };
    }

    // When the service worker opens a background tab at the overlay URL
    // (/in/<handle>/overlay/contact-info/), LinkedIn pre-opens the modal via
    // its SPA router — we just wait for it instead of clicking anything.
    const isOverlayUrl = location.pathname.includes("/overlay/contact-info");

    let modal = _findContactModal();
    if (!_isValidContactModal(modal)) modal = null;

    if (!modal) {
      if (!isOverlayUrl) {
        // On a regular profile page: click the Contact info link to open modal
        const link = _findContactInfoLink();
        if (!link) return { email: null, phone: null, website: null };
        link.click();
      }
      // Use MutationObserver-backed waitFor so we wake immediately when ready
      const { waitFor } = globalThis.__lcDom;
      modal = await waitFor(
        [
          "div[role='dialog'][aria-labelledby*='contact' i]",
          "div[role='dialog'][aria-label*='Contact' i]",
          "#artdeco-modal-outlet div[role='dialog']",
          "artdeco-modal div[role='dialog']",
          "div.artdeco-modal__content",
        ],
        { timeout: timeoutMs }
      );
      if (!_isValidContactModal(modal)) modal = null;
    }

    if (!modal) return { email: null, phone: null, website: null };
    await _sleep(350); // Let dynamic content settle
    const data = _scrapeFromContactModal(modal);
    if (!isOverlayUrl) _closeContactModal();
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
      /* enrichment is best-effort */
    }
    return base;
  }

  /* ---------- People search page ----------
   *
   * Class names rotate constantly here. Instead we look for every anchor
   * whose href contains "/in/" — those are the profile links — and walk
   * up to the smallest ancestor that contains an image + the link. That
   * ancestor is the card.
   */

  function _profileCardFromLink(link) {
    let node = link.parentElement;
    for (let i = 0; i < 10 && node; i++) {
      // A "card" is an element that has the profile link AND a visible
      // distinguishing block (image or action button).
      if (
        node.tagName === "LI" ||
        node.tagName === "ARTICLE" ||
        (node.querySelector("img") && node.querySelector("a[href*='/in/']"))
      ) {
        // Prefer the highest ancestor whose width spans the search column
        // (a card is usually a wide row). Walk up while the parent still
        // looks like the same card.
        let candidate = node;
        let p = node.parentElement;
        while (
          p &&
          p.querySelectorAll("a[href*='/in/']").length === 1 &&
          p.tagName !== "MAIN" &&
          p.tagName !== "BODY"
        ) {
          candidate = p;
          p = p.parentElement;
        }
        return candidate;
      }
      node = node.parentElement;
    }
    return link.parentElement;
  }

  function _profileFromCard(card, link) {
    const url = normalizeProfileUrl(link.href);
    // Name: try aria-hidden span first (LinkedIn duplicates the name there
    // for screen readers), fallback to link text. Skip cards where the name
    // is the generic "LinkedIn Member" placeholder — those have no
    // identifying data we can capture.
    let name =
      _txt(link.querySelector("span[aria-hidden='true']")) ||
      _txt(link);
    if (!name || /linkedin member/i.test(name)) return null;
    // Strip degree badges that sometimes get concatenated in
    name = name.replace(/\s*•\s*(1st|2nd|3rd\+?|3rd)\s*$/i, "").trim();

    // Headline/subtitle: the next sibling text region of the card after the
    // name link. We approximate by walking siblings of the link's container.
    let headline = null;
    let location_ = null;
    const linkBox = link.closest("div") || link.parentElement;
    if (linkBox) {
      const candidates = Array.from(card.querySelectorAll("div, p, span"))
        .map((n) => _txt(n))
        .filter(Boolean)
        .filter((t) => t !== name && !/connect|message|follow|view profile/i.test(t));
      headline = candidates[0] || null;
      // Location often contains a comma or named country
      location_ =
        candidates.find(
          (t) =>
            t !== headline &&
            t.length < 80 &&
            (t.includes(",") || /\b(india|uae|usa|uk|qatar|emirates|states|kingdom|america|saudi|hong kong)\b/i.test(t))
        ) || null;
    }
    const avatar = card.querySelector("img")?.getAttribute("src") || null;
    const [first_name, ...rest] = name.split(/\s+/);
    const sub = headline || "";
    return {
      linkedin_url: url,
      full_name: name,
      first_name,
      last_name: rest.join(" ") || null,
      headline: sub || null,
      title: sub.split(/\s+at\s+/i)[0] || null,
      company_name: sub.split(/\s+at\s+/i)[1] || null,
      location: location_,
      avatar_url: avatar,
      raw: { source_url: location.href, page_type: "search-people" },
    };
  }

  function scrapeSearchResults() {
    const results = [];
    const seen = new Set();
    // Every profile on the search page is reachable via an /in/ href.
    const links = document.querySelectorAll("a[href*='/in/']");
    for (const link of links) {
      try {
        const url = normalizeProfileUrl(link.href);
        if (!url || seen.has(url)) continue;
        // Skip anchors that live in side modules (people-also-viewed, etc.)
        // by requiring a name attached to the link.
        const card = _profileCardFromLink(link);
        const p = _profileFromCard(card, link);
        if (!p) continue;
        seen.add(url);
        results.push(p);
      } catch {
        /* skip malformed */
      }
    }
    return results;
  }

  /* ---------- Sales Navigator ---------- */

  function scrapeSalesNavProfile() {
    const fullName = _txt(
      document.querySelector("h1[data-anonymize='person-name']") ||
        document.querySelector("main h1")
    );
    const headline = _txt(
      document.querySelector("[data-anonymize='headline']") ||
        document.querySelector("main h1 + div")
    );
    const company = _txt(
      document.querySelector("a[data-anonymize='company-name']") ||
        document.querySelector("[data-anonymize='company-name']")
    );
    const title = _txt(document.querySelector("[data-anonymize='job-title']"));
    const location_ = _txt(document.querySelector("[data-anonymize='location']"));
    const liUrl =
      document.querySelector("a[data-control-name='visit_linkedin_profile']")?.href ||
      document.querySelector("a[href*='/in/']")?.href ||
      location.href;
    const url = normalizeProfileUrl(liUrl);
    const [first_name, ...rest] = (fullName || "").split(/\s+/);
    return {
      linkedin_url: url,
      full_name: fullName,
      first_name: first_name || null,
      last_name: rest.join(" ") || null,
      headline,
      title,
      company_name: company,
      location: location_,
      raw: { source_url: location.href, page_type: "salesnav-profile" },
    };
  }

  function scrapeSalesNavSearch() {
    // Sales Nav search pages may use either the lead-panel link attribute or
    // plain /sales/lead/ hrefs. Try both, dedupe by normalised URL.
    const links = document.querySelectorAll(
      "a[data-control-name='view_lead_panel_via_search_lead_name']," +
      "a[data-control-name='view_lead_panel_via_browse_map_list_lead_name']," +
      "a[href*='/sales/lead/']"
    );
    const out = [];
    const seen = new Set();
    for (const link of links) {
      try {
        const url = normalizeProfileUrl(link.href);
        if (!url || seen.has(url)) continue;
        const card = _profileCardFromLink(link);
        // data-anonymize attributes are stable in Sales Nav
        const nameEl =
          card.querySelector("[data-anonymize='person-name']") ||
          card.querySelector("[data-anonymize='name']") ||
          link.querySelector("span[aria-hidden='true']") ||
          link;
        const name = (_txt(nameEl) || "")
          .replace(/\s*•\s*(1st|2nd|3rd\+?)\s*$/i, "")
          .trim();
        if (!name || /linkedin member/i.test(name)) continue;
        const titleEl =
          card.querySelector("[data-anonymize='title']") ||
          card.querySelector("[data-anonymize='job-title']");
        const companyEl =
          card.querySelector("[data-anonymize='company-name']") ||
          card.querySelector("a[data-anonymize='company-name']");
        const locEl = card.querySelector("[data-anonymize='location']");
        const title = _txt(titleEl);
        const company = _txt(companyEl);
        const loc = _txt(locEl);
        // Prefer the /in/ URL over /sales/lead/ if Sales Nav exposes it
        const liAnchor = card.querySelector("a[href*='/in/']");
        const canonicalUrl = liAnchor
          ? normalizeProfileUrl(liAnchor.href)
          : url;
        const [first_name, ...rest] = name.split(/\s+/);
        seen.add(url);
        out.push({
          linkedin_url: canonicalUrl || url,
          full_name: name,
          first_name,
          last_name: rest.join(" ") || null,
          headline: [title, company].filter(Boolean).join(" at ") || null,
          title,
          company_name: company,
          location: loc,
          raw: { source_url: location.href, page_type: "salesnav-search" },
        });
      } catch {
        /* skip malformed */
      }
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
    scrapeProfileWithContact,
    scrapeContactInfo,
    scrapeSalesNavProfile,
    scrapeSearchResults,
    scrapeSalesNavSearch,
    scrapeCurrentPage,
  };
})();
