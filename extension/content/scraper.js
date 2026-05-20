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
    // Sales Navigator has many list-type surfaces. `/sales/lists/*` catches
    // every saved-list / saved-search / saved-on-linkedin variant
    // ('Saved on LinkedIn.com' lives at /sales/lists/<id>/ with no
    // /people/ segment, which the old explicit allowlist missed).
    if (
      p.startsWith("/sales/search") ||
      p.startsWith("/sales/people") ||
      p.startsWith("/sales/connections") ||
      p.startsWith("/sales/lists") ||
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

  // Strip LinkedIn-rendered noise that gets concatenated into person-name
  // text by `textContent`: degree badges ("• 1st"/"· 2nd"/"3rd+"), pronouns
  // ("(He/Him)"), Premium/Influencer trailing labels, the "Status is online"
  // accessibility text, "Verified" badges, and OpenToWork frame text. Also
  // truncates at the first such marker so "Mafaz Ahmed • 3rd+Marketing
  // ProfessionalKuwait City…" (entire-card-as-link fallback) becomes just
  // "Mafaz Ahmed".
  //
  // Two-stage strategy:
  //   1. STRIP a11y / status labels WITHOUT consuming everything after them
  //      (they often appear as LEADING sr-only spans inside h1, e.g.
  //      "<span>Verified</span>Faisal AlSagoubi" → "VerifiedFaisal
  //      AlSagoubi" — we must NOT drop the name).
  //   2. TRUNCATE at the first degree marker / pronoun parenthetical —
  //      everything after these is guaranteed to be non-name noise.
  function _cleanPersonName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, " ").trim();
    // Stage 1 — remove a11y / status / badge labels in-place. We insert a
    // single space at the boundary so a glued sr-only prefix
    // ("VerifiedFaisal") doesn't collapse into one word.
    const stripLabels = [
      /\bVerified\b/gi,
      /\bPremium\s*Member\b/gi,
      /\bOpenToWork\b/gi,
      /\bHiring\b/gi,
      /\bInfluencer\b/gi,
      /\bStatus is (online|offline|reachable)\b/gi,
      /\bView\s+\S+(?:’|')s\s+profile\b/gi,
    ];
    for (const re of stripLabels) s = s.replace(re, " ");
    // Edge: glued sr-only labels without word boundary (e.g.
    // "Status is reachableArya" → "Status is reachable Arya" after gap;
    // also "VerifiedFaisal" via case-camel split).
    s = s.replace(/^(Status is (?:online|offline|reachable))/i, "$1 ")
         .replace(/^(Verified|Premium Member|OpenToWork|Hiring|Influencer)/i, "$1 ");
    s = s.replace(/\s+/g, " ").trim();
    // Re-run strips after the gap-insertion so the labels actually drop.
    for (const re of stripLabels) s = s.replace(re, " ");
    s = s.replace(/\s+/g, " ").trim();

    // Stage 2 — truncate at the first degree / pronoun marker.
    const cutMarkers = [
      /\s*[•·]\s*(1st|2nd|3rd\+?)\b.*/i,
      /\s*\b(1st|2nd|3rd\+?)\s+degree\b.*/i,
      /\s*[•·]\s*(He\/Him|She\/Her|They\/Them)\b.*/i,
      /\s*\(\s*(He|She|They)\/(Him|Her|Them)\s*\).*/i,
    ];
    for (const re of cutMarkers) s = s.replace(re, "").trim();

    // Strip trailing punctuation / separators
    s = s.replace(/[\s•·,\-—|]+$/g, "").trim();
    return s || null;
  }

  // Derive a person's name from a LinkedIn profile URL when h1 scraping
  // fails. LinkedIn slug format: "<firstname>-<lastname>[-<userid-hex>]"
  // where the optional trailing token is a stable user-id like "a742831ab"
  // or a numeric "9b" — alphanumeric, usually >=4 chars, mix of letters
  // and digits. Without dropping it, the fallback yields names like
  // "Faisal Alsagoubi A742831ab" in the pipeline. Heuristic: drop any
  // slug part that contains BOTH a letter AND a digit, OR is a pure
  // digit run, OR is shorter than 2 chars.
  function _nameFromSlug(linkedinUrl) {
    if (!linkedinUrl) return null;
    try {
      const u = new URL(linkedinUrl, location.origin);
      const slug = u.pathname.replace(/^\/in\//, "").replace(/\/$/, "");
      if (!slug || slug.includes("/")) return null;
      const parts = slug
        .split("-")
        .filter((p) => p.length >= 2)
        .filter((p) => !/^\d+$/.test(p))
        .filter((p) => !(/[a-z]/i.test(p) && /\d/.test(p))) // mixed alphanum = user-id
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      const out = parts.join(" ").trim();
      return out || null;
    } catch {
      return null;
    }
  }

  // Reject headline/location candidates that come from the profile's
  // activity / posts / recent-feed sections. Those drift in front of the
  // actual headline when LinkedIn restructures the top card wrapper and
  // poison the title field with "Feed post" / "Reposted this" / etc.
  function _isFeedNoise(text) {
    if (!text) return true;
    return /^(feed post|reposted|liked by|commented|shared|recent activity|posts|activity|see all activity|loaded \d+|show all \d+|new! )/i.test(
      text.trim()
    );
  }

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
    // SAFETY GUARD: if our walk hit <main> or <body> (no proper top card
    // wrapper found), shrink back to a small slice around h1. Otherwise the
    // headline/location scan grabs text from the Recent activity, Featured,
    // and Experience sections — leading to title="Feed post" etc.
    if (!card || card.tagName === "MAIN" || card.tagName === "BODY") {
      card = h1.parentElement?.parentElement || h1.parentElement;
    }
    return { h1, card: card || h1.parentElement };
  }

  function _firstTextAfter(h1) {
    // Walk DOM order after the h1 and return the first sibling-ish element
    // that has text > 4 chars and is NOT the name itself. This is the
    // "headline" line LinkedIn renders directly under the name.
    //
    // We DELIBERATELY stay within the same parent and one level below,
    // never recursing up to <main>. Without this bound, the walk reaches
    // the "Recent activity" / "Featured posts" sections and grabs strings
    // like "Feed post" as the headline.
    const start = h1.parentElement;
    if (!start) return null;
    let foundH1 = false;
    for (const child of start.children) {
      if (child === h1) { foundH1 = true; continue; }
      if (!foundH1) continue;
      const t = _txt(child);
      if (
        t &&
        t.length > 4 &&
        t.length < 240 &&
        !/connect|message|follow|more|premium/i.test(t) &&
        !_isFeedNoise(t)
      ) {
        return t;
      }
      // Look one level deeper for the sibling that hosts the headline span
      for (const grand of child.children || []) {
        const g = _txt(grand);
        if (
          g &&
          g.length > 4 &&
          g.length < 240 &&
          !/connect|message|follow|more|premium/i.test(g) &&
          !_isFeedNoise(g)
        ) {
          return g;
        }
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
    const fullName = _cleanPersonName(_txt(h1));

    // Headline: the text line directly under the name. Multiple fallbacks
    // because LinkedIn sometimes wraps it in different structures.
    let headline = null;
    if (h1) {
      // Try the immediate next sibling first
      let n = h1.nextElementSibling;
      while (n && !headline) {
        const t = _txt(n);
        if (
          t &&
          t.length > 4 &&
          !_isFeedNoise(t) &&
          !/connect|message|follow|more|premium/i.test(t)
        ) {
          headline = t;
        }
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
        if (_isFeedNoise(t)) continue;
        if (t.length > 4 && t.length < 80 && (t.includes(",") || /\b(india|uae|usa|uk|qatar|emirates|states|kingdom|america|kong|saudi|kuwait|bahrain|oman|jordan|lebanon|egypt|france|germany|spain|italy|brazil|mexico|canada|australia|singapore|japan|china|netherlands|belgium|switzerland|austria|norway|sweden|denmark|finland|poland|turkey|greece|portugal|ireland|scotland|wales|england|britain|south africa|nigeria|kenya|argentina|chile|colombia|peru|venezuela|new zealand|philippines|indonesia|malaysia|thailand|vietnam|korea|taiwan|pakistan|bangladesh|sri lanka)\b/i.test(t))) {
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
      // Strip pipe-separated specializations before extracting title/company.
      // "Head of Events at HEC Paris Doha | Executive Education | Aviation"
      //  → primary = "Head of Events at HEC Paris Doha"
      //  → title = "Head of Events", company = "HEC Paris Doha"
      const primary = headline.split("|")[0].trim();
      const parts = primary.split(/\s+at\s+/i);
      if (parts.length >= 2) {
        title = parts[0].trim();
        companyName = parts.slice(1).join(" at ").trim();
      } else {
        title = primary;
      }
    }

    const linkedinUrl = normalizeProfileUrl(location.href);
    // Final-mile name fallback: if h1 didn't yield a usable name, derive one
    // from the URL slug (linkedin.com/in/nathalie-richani → Nathalie Richani).
    // Better a slug-derived guess than blank rows in the pipeline.
    let resolvedName = fullName;
    if (!resolvedName && linkedinUrl) {
      resolvedName = _nameFromSlug(linkedinUrl);
    }
    const [first_name, ...rest] = (resolvedName || "").split(/\s+/);

    // LinkedIn's media CDN requires the signed-JWT query string. Strip it
    // and the image returns 403. Backend column is TEXT, so we send verbatim.
    return {
      linkedin_url: linkedinUrl,
      full_name: resolvedName ? resolvedName.slice(0, 240) : null,
      first_name: first_name ? first_name.slice(0, 120) : null,
      last_name: rest.join(" ").slice(0, 120) || null,
      headline,  // TEXT column on the backend, no cap needed
      title: title ? title.slice(0, 240) : null,
      location: location_ ? location_.slice(0, 200) : null,
      avatar_url: avatar,
      company_name: companyName ? companyName.slice(0, 200) : null,
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
    // Must contain the "Contact info" header text. Without this, any other
    // dialog that happens to contain a mailto: anchor (e.g. a profile
    // recommendation form or an inMail compose) would pass and we'd
    // attribute somebody else's email to the wrong lead.
    return /\bcontact info\b/i.test(modal.textContent || "");
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

  async function scrapeContactInfo({
    timeoutMs = 9000,
    settleMs = 1500,
    allowPushStateFallback = false,
  } = {}) {
    if (!location.pathname.startsWith("/in/")) {
      return { email: null, phone: null, website: null };
    }

    const { waitFor, dispatchHumanClick } = globalThis.__lcDom;
    const isOverlayUrl = location.pathname.includes("/overlay/contact-info");
    // Track whether the pushState fallback fired so the close-modal branch
    // can skip dismissing — the modal is bound to the URL we just navigated
    // to, and dismissing would just bounce the browser back without scrape.
    let didPushState = false;

    let modal = _findContactModal();
    if (!_isValidContactModal(modal)) modal = null;

    if (!modal) {
      if (!isOverlayUrl) {
        const link = _findContactInfoLink();
        if (link) {
          // Synthetic .click() can be no-op'd in background tabs / by React's
          // event listeners. Use a full pointer event sequence — the same
          // approach automate.js uses for connect/message — so LinkedIn's
          // React handlers actually fire.
          try { link.focus?.(); } catch {}
          await _sleep(120);
          try {
            if (dispatchHumanClick) dispatchHumanClick(link);
            else link.click();
          } catch {
            try { link.click(); } catch {}
          }
        }
      }

      modal = await waitFor(
        [
          "div[role='dialog'][aria-labelledby*='contact' i]",
          "div[role='dialog'][aria-label*='Contact' i]",
          "#artdeco-modal-outlet div[role='dialog']",
          "artdeco-modal div[role='dialog']",
          "div.artdeco-modal__content",
          "div[role='dialog']",
        ],
        { timeout: timeoutMs }
      );
      if (!_isValidContactModal(modal)) modal = null;

      // Last-resort backup: navigate the SPA router to /overlay/contact-info/.
      // GATED behind allowPushStateFallback because pushState mutates the
      // visible URL. Foreground callers (saveCurrentProfile from the floating
      // panel, maybeAutoEnrichCurrentProfile on profile-page open) must NOT
      // pass the flag — otherwise the user's URL bar would get rewritten
      // mid-browse. Only the background-tab enrichment trigger opts in.
      if (!modal && !isOverlayUrl && allowPushStateFallback) {
        try {
          const overlayPath =
            location.pathname.replace(/\/$/, "") + "/overlay/contact-info/";
          history.pushState({}, "", overlayPath + location.search);
          window.dispatchEvent(new PopStateEvent("popstate"));
          didPushState = true;
        } catch {
          /* pushState fails in some sandboxed contexts */
        }
        modal = await waitFor(
          [
            "div[role='dialog'][aria-labelledby*='contact' i]",
            "#artdeco-modal-outlet div[role='dialog']",
            "div[role='dialog']",
          ],
          { timeout: 4000 }
        );
        if (!_isValidContactModal(modal)) modal = null;
      }
    }

    if (!modal) return { email: null, phone: null, website: null };

    // Wait for modal contents to fully hydrate. The mailto: anchor is added
    // by React in a second tick after the dialog mounts — reading too early
    // returns null email even though the modal is visible.
    await _sleep(settleMs);

    let data = _scrapeFromContactModal(modal);

    // Retry once if the modal opened but contents weren't rendered yet.
    if (!data.email && !data.phone) {
      await _sleep(1500);
      // Re-query modal in case it remounted
      modal = _findContactModal() || modal;
      data = _scrapeFromContactModal(modal);
    }

    // Skip the dismiss if we navigated via pushState — the close button
    // would just send us back, not actually clean up.
    if (!isOverlayUrl && !didPushState) _closeContactModal();
    return data;
  }

  // Fallback enrichment: scan visible profile text for email / phone patterns.
  // LinkedIn only shows the Contact info modal email/phone for 1st-degree
  // connections (and sometimes 2nd) — for everyone else, the modal returns
  // just the LinkedIn URL. But many users put their email or phone in their
  // About section, headline, or experience descriptions to invite outreach,
  // and that text is visible to anyone. We harvest it here.
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  // Conservative phone regex — requires either a leading + or 8+ digits with
  // separators. Avoids matching dates, post counts, etc.
  const PHONE_RE = /\+\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{3,4}\b/;

  function _scrapeFromProfileText() {
    // Search the user-content regions of the profile only. Skip the global
    // <body> scan because LinkedIn's chrome (navbar, ads, "people you may
    // know") contains noise that would generate false positives.
    const containers = [
      document.querySelector("section[data-section='summary']"),
      document.querySelector("section.pv-about-section"),
      document.querySelector("section#about"),
      document.querySelector("div[data-generated-suggestion-target]"),
      document.querySelector("main"),
    ].filter(Boolean);
    let email = null;
    let phone = null;
    for (const c of containers) {
      const text = (c.innerText || c.textContent || "").replace(/\s+/g, " ");
      if (!email) {
        const m = text.match(EMAIL_RE);
        if (m && !/@(linkedin|2x)\.com$/i.test(m[0])) email = m[0];
      }
      if (!phone) {
        const m = text.match(PHONE_RE);
        if (m) phone = m[0].replace(/\s+/g, " ").trim();
      }
      if (email && phone) break;
    }
    return { email, phone };
  }

  async function scrapeProfileWithContact() {
    const base = scrapeProfile();
    try {
      // Primary: Contact info modal (works for 1st-degree connections).
      const contact = await scrapeContactInfo();
      if (contact.email && !base.email) base.email = contact.email;
      if (contact.phone && !base.phone) base.phone = contact.phone;
      if (contact.website && !base.company_url) base.company_url = contact.website;

      // Fallback: scan About / Experience text for any publicly-shared email
      // or phone. Reaches profiles where the modal hides contact info.
      if (!base.email || !base.phone) {
        const fromText = _scrapeFromProfileText();
        if (!base.email && fromText.email) base.email = fromText.email;
        if (!base.phone && fromText.phone) base.phone = fromText.phone;
      }

      base.raw = {
        ...(base.raw || {}),
        contact_info_scraped: true,
        contact_source:
          base.email || base.phone
            ? contact.email || contact.phone
              ? "contact_modal"
              : "profile_text"
            : "none",
      };
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
    // Name extraction — prefer the most specific source available:
    //   1. aria-hidden span (LinkedIn duplicates the name for screen readers).
    //   2. <strong>/<b> child of the link (often wraps the name).
    //   3. Link text — but ONLY if it looks like a name, not the whole card.
    //   4. URL slug as last resort (turns "/in/nathalie-richani" into
    //      "Nathalie Richani"), better than blank.
    let name = _txt(link.querySelector("span[aria-hidden='true']"));
    if (!name) name = _txt(link.querySelector("strong, b"));
    if (!name) {
      const raw = _txt(link) || "";
      // LinkedIn sometimes wraps the entire card body in the /in/ anchor.
      // In that case the link text is "Mafaz Ahmed • 3rd+Marketing
      // ProfessionalKuwait City…" — we must NOT use it as the name.
      // Heuristic: split at the first degree badge / bullet separator and
      // keep only the leading person-name segment.
      if (raw && raw.length < 80 && !/[•·]\s*(1st|2nd|3rd\+?)/i.test(raw)) {
        name = raw;
      } else if (raw) {
        // Take everything before the first degree marker / bullet.
        const cut = raw.split(/\s*[•·]\s*(1st|2nd|3rd\+?)/i)[0].trim();
        if (cut && cut.length < 80) name = cut;
      }
    }
    if (!name) name = _nameFromSlug(url);
    name = _cleanPersonName(name);
    if (!name || /linkedin member/i.test(name)) return null;

    // Headline/subtitle: the next sibling text region of the card after the
    // name link. We approximate by walking siblings of the link's container.
    let headline = null;
    let location_ = null;
    const linkBox = link.closest("div") || link.parentElement;
    if (linkBox) {
      const candidates = Array.from(card.querySelectorAll("div, p, span"))
        // Exclude elements inside or wrapping embedded profile links (mutual
        // connections / people-also-viewed rendered inside the same card <li>).
        .filter((n) => !n.closest("a[href*='/in/'], a[href*='/sales/lead/']"))
        .filter((n) => !n.querySelector("a[href*='/in/'], a[href*='/sales/lead/']"))
        .map((n) => _txt(n))
        .filter(Boolean)
        .filter(
          (t) =>
            t !== name &&
            !/connect|message|follow|view profile/i.test(t) &&
            !/•\s*(1st|2nd|3rd\+?)/i.test(t)
        );
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
    // Split on first "|" before splitting on " at " so pipe-separated
    // specializations ("Head of Events at HEC | Education | Aviation") don't
    // bleed into the company name field.
    const primarySub = sub.split("|")[0].trim();
    return {
      linkedin_url: url,
      full_name: name,
      first_name,
      last_name: rest.join(" ") || null,
      headline: sub || null,
      title: primarySub.split(/\s+at\s+/i)[0] || null,
      company_name: primarySub.split(/\s+at\s+/i).slice(1).join(" at ") || null,
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

  /* ---------- Iframe-based contact-info enrichment ----------
   *
   * Used by the per-card Save chip on search pages. We mount a hidden,
   * off-screen iframe pointing at /in/<handle>/overlay/contact-info/ —
   * LinkedIn's SPA auto-opens the Contact info modal on that URL. Because
   * the iframe is same-origin (linkedin.com → linkedin.com) we can read its
   * contentDocument directly. This replaces the previous "open a background
   * tab" approach: no new tab in the user's taskbar, faster turnaround, and
   * the user doesn't see any visible UI artefact.
   *
   * Same bot-avoidance constraints apply: rate-limited via the service
   * worker, modal-only DOM reads (no LinkedIn internal API calls).
   */
  async function scrapeContactInfoViaIframe(
    profileUrl,
    { timeoutMs = 18000 } = {}
  ) {
    let overlayUrl;
    try {
      const u = new URL(profileUrl, location.origin);
      if (!u.pathname.startsWith("/in/")) {
        return { email: null, phone: null, website: null };
      }
      const path = u.pathname.replace(/\/$/, "");
      overlayUrl = path.endsWith("/overlay/contact-info")
        ? u.origin + path + "/"
        : u.origin + path + "/overlay/contact-info/";
    } catch {
      return { email: null, phone: null, website: null };
    }

    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("title", "");
      // Off-screen, no opacity, no pointer events — the user never sees it.
      // We still give it real width/height because LinkedIn's React tree
      // sometimes refuses to render the modal in a 1x1 frame.
      iframe.style.cssText = [
        "position:fixed",
        "left:-99999px",
        "top:-99999px",
        "width:1200px",
        "height:800px",
        "border:0",
        "opacity:0",
        "pointer-events:none",
        "visibility:hidden",
      ].join(";");
      iframe.src = overlayUrl;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(pollId);
        clearTimeout(timeoutId);
        try { iframe.remove(); } catch {}
        resolve(result);
      };

      const timeoutId = setTimeout(
        () => finish({ email: null, phone: null, website: null }),
        timeoutMs
      );

      // Poll every 500ms for the modal contents to appear inside the iframe.
      // Polling beats a load-event handler here because LinkedIn's modal
      // renders asynchronously several ticks after the iframe's load fires.
      const startedAt = Date.now();
      const pollId = setInterval(() => {
        if (settled) return;
        let doc;
        try {
          doc = iframe.contentDocument;
        } catch {
          // Cross-origin error — LinkedIn redirected the iframe to a login
          // or checkpoint page on a different origin. Nothing to scrape.
          return finish({ email: null, phone: null, website: null });
        }
        if (!doc) return;

        // Look for the dialog AND wait at least 1.5s after first sighting
        // so React has time to populate mailto:/tel: anchors inside it.
        //
        // We require the dialog to be the Contact-info modal specifically
        // (header text contains "Contact info"). Without this, a login
        // wall or feed redirect inside the iframe — both also expose
        // div[role='dialog'] — would let us grab a stray mailto: anchor
        // from somewhere on the page and attribute it to this lead.
        let modal = null;
        const dialogs = doc.querySelectorAll("div[role='dialog']");
        for (const d of dialogs) {
          const t = (d.innerText || d.textContent || "").slice(0, 200);
          if (/contact info/i.test(t)) {
            modal = d;
            break;
          }
        }
        const elapsed = Date.now() - startedAt;
        if (!modal && elapsed < 6000) return;
        if (!modal) {
          // Give up cleanly rather than scrape doc-wide and risk
          // capturing somebody else's contact info.
          return finish({ email: null, phone: null, website: null });
        }

        const mailto = modal.querySelector("a[href^='mailto:']");
        const tel = modal.querySelector("a[href^='tel:']");

        // If the modal is present but no contact anchors yet, give React
        // a couple more polls to hydrate them.
        if (modal && !mailto && !tel && elapsed < 8000) return;

        const email = mailto
          ? mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim()
          : null;
        const phone = tel
          ? tel.getAttribute("href").replace(/^tel:/, "").trim()
          : null;

        let website = null;
        if (modal) {
          const externals = modal.querySelectorAll("a[href^='http']");
          for (const a of externals) {
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
        }

        // No <main>-text fallback here on purpose — the iframe loads the
        // /overlay/contact-info/ URL which can drift to a login wall, feed,
        // or unrelated content; a regex scan would pick up some other
        // person's email and attribute it to this lead. We only trust the
        // anchors inside the verified Contact info modal.
        finish({ email, phone, website });
      }, 500);

      document.body.appendChild(iframe);
    });
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
    scrapeContactInfoViaIframe,
    scrapeSalesNavProfile,
    scrapeSearchResults,
    scrapeSalesNavSearch,
    scrapeCurrentPage,
    _scrapeFromProfileText,
  };
})();
