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
      // LinkedIn’s verified badge renders as a Unicode checkmark in textContent.
      // Strip all common checkmark codepoints so "Diala Ghazzawi ✓" → "Diala Ghazzawi".
      /[✓✔☑✅☒✗✘]\s*/g,
      /\bPremium\s*Member\b/gi,
      /\bOpenToWork\b/gi,
      /\bHiring\b/gi,
      /\bInfluencer\b/gi,
      /\bStatus is (online|offline|reachable)\b/gi,
      /\bView\s+\S+(?:’|’)s\s+profile\b/gi,
      // Sales Nav presence indicator: "<Name> is reachable" / "is online" /
      // "is offline" / "is unreachable" / "is available" / "is away" —
      // LinkedIn appends this to the name in sr-only text for accessibility.
      /\bis\s+(reachable|online|offline|unreachable|available|away)\b.*/gi,
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

    // Stage 2b — name + headline mashing. LinkedIn occasionally renders the
    // h1 as <span>Safnaz Saleem</span><span>Data-Driven Digital Marketing
    // & Social Media Strategist (B.Tech, CSE) | Doha</span>, and textContent
    // concatenates without whitespace → "SaleemData-Driven Digital Marketing
    // & Social Media Strategist (B.Tech, CSE) | Doha". The headline always
    // starts with an uppercase letter butted against the lowercase last char
    // of the surname (Saleem|Data, Khan|Senior, etc.), so we cut on that
    // single lower→Upper boundary when the remainder looks like a headline
    // (contains a vertical bar, parenthesis, or " at ", OR is > 30 chars).
    if (s && s.length > 30 && !s.includes(" ")) {
      // Pure CamelCase glob with no spaces — split at first lower→Upper
      const m = s.match(/^([A-Z][a-z]+)([A-Z].+)$/);
      if (m) s = m[1];
    } else if (s && s.length > 30) {
      // Has spaces. Find a lower→Upper boundary INSIDE a "word", and only
      // cut if what follows looks like a headline (long, has separators).
      const camelMatch = s.match(/^(.+?[a-z])([A-Z][a-z].*)$/);
      if (camelMatch) {
        const before = camelMatch[1];
        const after = camelMatch[2];
        const headlineLike =
          after.length > 12 &&
          (/[|()/]|\s+at\s+|—|–|\bmarketing\b|\bmanager\b|\bdirector\b|\bengineer\b|\bdeveloper\b|\bspecialist\b|\bconsultant\b|\bstrategist\b/i.test(after));
        if (headlineLike) s = before.trim();
      }
    }

    // Strip trailing punctuation / separators
    s = s.replace(/[\s•·,\-—|]+$/g, "").trim();

    // Stage 3 — collapse exact duplicate halves. LinkedIn Sales Nav
    // sometimes renders the name twice: once visually, once for screen
    // readers. textContent yields "Andrea Miliccia Andrea Miliccia".
    // If the string can be split into two identical halves, keep one.
    if (s) {
      const words = s.split(/\s+/);
      if (words.length >= 2 && words.length % 2 === 0) {
        const half = words.length / 2;
        const left = words.slice(0, half).join(" ");
        const right = words.slice(half).join(" ");
        if (left.toLowerCase() === right.toLowerCase()) s = left;
      }
    }

    return s || null;
  }

  // Reject text that's clearly an action button label, not a person's
  // name. Sales Nav cards expose "View LinkedIn profile" / "Open profile"
  // anchors whose text would otherwise leak into the saved name field.
  const _ACTION_LABEL_RE = /^(view\s+\S+\s+profile|view\s+profile|view\s+in\s+sales\s+navigator|save\s+in\s+sales\s+navigator|save\s+lead|save|open|open\s+profile|open\s+in\s+new\s+tab|connect|pending|message|follow|following|invite|invited|withdraw|more|premium)$/i;
  function _isActionLabel(text) {
    if (!text) return true;
    return _ACTION_LABEL_RE.test(text.trim());
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
    const t = text.trim();
    // Original feed/activity noise prefixes.
    if (/^(feed post|reposted|liked by|commented|shared|recent activity|posts|activity|see all activity|loaded \d+|show all \d+|new! )/i.test(t)) {
      return true;
    }
    // Sales Nav / accessibility noise that's been showing up as the title:
    //   "Profile details loaded for Ahmed Dergham."  — sr-only announcement
    //   "Select Ahmed Dergham"                       — checkbox a11y label
    //   "View Ahmed Dergham's profile"               — anchor a11y label
    //   "Status is online"                           — presence indicator
    //   "Open Ahmed's profile in new tab"            — action menu item
    if (/^(profile details loaded\b|select\s+\S+\s+\S+|view\s+\S+(?:'|')s\s+profile|status is\s+(online|offline|reachable)|open\s+\S+(?:'|')s\s+profile)/i.test(t)) {
      return true;
    }
    return false;
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
    let fullName = _cleanPersonName(_txt(h1));
    // Reject page-chrome h1s. When LinkedIn briefly serves the /overlay/
    // contact-info/ route as a standalone page (no profile rendered),
    // document.querySelector("main h1") falls back to the global nav h1
    // which reads literally "LinkedIn". Any save fired in that window
    // wrote name="LinkedIn" — visible in 4 of the user's pipeline rows.
    // Also catches "LinkedIn Member" (3rd-degree placeholder).
    if (fullName && /^linked\s*in(?:\s+member)?$/i.test(fullName)) {
      fullName = null;
    }

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

    // Defense-in-depth against past pushState bugs: if location.href has
    // been mutated to .../overlay/contact-info/ (or any other sub-route),
    // strip that suffix so the lead's linkedin_url field always stores
    // the canonical /in/<handle>/ form. Without this, an old buggy code
    // path on a stale tab could re-introduce the corrupted URL.
    const linkedinUrl = (() => {
      let href = location.href;
      try {
        const u = new URL(href);
        const m = u.pathname.match(/^(\/in\/[^/]+)\//);
        if (m) {
          u.pathname = m[1] + "/";
          href = u.origin + u.pathname;
        }
      } catch { /* fall through to normalize on raw href */ }
      return normalizeProfileUrl(href);
    })();
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

  // Find the element that contains the Contact info fields.
  //
  // Two render modes to handle:
  //   A) In-page modal (popup over a regular /in/<handle> URL):
  //      LinkedIn ships a <div role="dialog"> with the modal contents.
  //   B) Standalone overlay URL (/in/<handle>/overlay/contact-info/):
  //      LinkedIn renders the modal AS the page content — NO role="dialog"
  //      element. The fields live inside a section that contains a heading
  //      with text "Contact info" and a series of <div componentkey="...">
  //      blocks, each block holding one label (<p>Email</p>) and one value.
  //
  // The previous implementation only handled mode A. On mode B, the
  // returned modal was null and the scrape came back empty even though
  // the user could clearly see the email and phone on the page.
  function _findContactModal() {
    const onOverlayUrl = location.pathname.includes("/overlay/contact-info");

    // Mode A — search for a visible role="dialog". Selector also covers
    // HTML5 <dialog> elements (LinkedIn shipped some routes on these in
    // 2025) and the artdeco-modal custom element family.
    const dialogs = document.querySelectorAll(
      "dialog, div[role='dialog'], artdeco-modal, div.artdeco-modal__content"
    );

    // Snapshot the visible candidates once so we don't redo the visibility
    // computation across two passes.
    const visible = [];
    for (const d of dialogs) {
      try {
        if (d.hasAttribute("hidden")) continue;
        if (d.getAttribute("aria-hidden") === "true") continue;
        const cs = window.getComputedStyle(d);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
      } catch { /* assume visible */ }
      visible.push(d);
    }

    // First pass — STRICT match. Prefer a dialog that proves it IS the
    // Contact info modal. This runs the same way whether we're on the
    // /overlay/contact-info/ URL or popping the modal over the profile
    // page. The old code did `if (onOverlayUrl) return d;` on the first
    // visible dialog, which picked up LinkedIn's "Get 50% Off Sales Nav"
    // / InMail upsell dialog (rendered as a sibling on the overlay route)
    // and never even looked at the actual Contact info modal — saving
    // leads with empty email/phone despite the data being right there.
    for (const d of visible) {
      const aria = (d.getAttribute("aria-label") || "").toLowerCase();
      const labelledBy = (d.getAttribute("aria-labelledby") || "").toLowerCase();
      const text = (d.innerText || d.textContent || "").slice(0, 600);
      const html = d.innerHTML || "";
      if (
        aria.includes("contact") ||
        labelledBy.includes("contact") ||
        /\bcontact info\b/i.test(text) ||
        /href=["']mailto:/i.test(html) ||
        /href=["']tel:/i.test(html)
      ) {
        return d;
      }
    }

    // (No early dialog-fallback yet — Mode B's heading walk below is more
    // reliable than picking an arbitrary largest dialog. We use the
    // largest-visible-dialog as a final last resort AFTER Mode B fails.)

    // Mode B — on /overlay/contact-info/, find the "Contact info" heading
    // and walk up to the smallest container that holds both the heading
    // AND the contact fields. Labels are NOT necessarily <h3>/<h4> — they
    // can be <p>, <span>, anything — so we search broadly and key on text.
    if (onOverlayUrl) {
      // Find every element whose own text (not descendants) is exactly
      // "Contact info". This rules out container elements that happen to
      // contain a "Contact info" descendant.
      const headingNodes = [];
      const all = document.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, span, div");
      for (const el of all) {
        const ownText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => (n.textContent || "").trim())
          .join(" ")
          .trim();
        if (/^contact info$/i.test(ownText)) headingNodes.push(el);
      }

      // For each candidate heading, walk up to find a container that also
      // includes labelled fields (mailto:/tel: anchors OR text "Email"/"Phone").
      for (const heading of headingNodes) {
        let wrap = heading.parentElement;
        for (let i = 0; i < 10 && wrap; i++) {
          const hasAnchors = wrap.querySelector(
            "a[href^='mailto:'], a[href^='tel:']"
          );
          let hasLabels = false;
          // Don't iterate everything — just check if "Email" or "Phone"
          // text appears anywhere in the wrap's innerText prefix.
          const t = (wrap.innerText || wrap.textContent || "").slice(0, 2000);
          if (/\b(email|phone|address|website)\b/i.test(t)) hasLabels = true;
          if (hasAnchors || hasLabels) {
            // Sanity: don't return <body> or <html> as the modal — that
            // would let text-scan grab anything on the page.
            if (wrap.tagName !== "BODY" && wrap.tagName !== "HTML") {
              return wrap;
            }
          }
          wrap = wrap.parentElement;
        }
      }

      // Penultimate resort: largest visible dialog on the page. This
      // catches layouts where Mode A's strict-signal pass missed
      // (LinkedIn changed aria-labels) and Mode B's heading walk missed
      // (LinkedIn used a non-text element for the heading). Picking the
      // BIGGEST dialog avoids returning a narrow promo banner like
      // "Get 50% Off Sales Nav".
      if (visible.length) {
        let best = null;
        let bestArea = 0;
        for (const d of visible) {
          try {
            const r = d.getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = d; }
          } catch { /* skip */ }
        }
        if (best) return best;
      }

      // Final resort: <main>. The label-line extractor scopes to text
      // after the "Contact info" header so this is safer than nothing.
      const main = document.querySelector("main");
      if (main) return main;
    }
    return null;
  }

  function _isValidContactModal(modal) {
    if (!modal) return false;
    // URL context: when the user is on /in/<handle>/overlay/contact-info/,
    // ANY element we found IS the contact info section — _findContactModal
    // already filtered to one that contains the contact fields.
    if (location.pathname.includes("/overlay/contact-info")) return true;
    const aria = ((modal.getAttribute && modal.getAttribute("aria-label")) || "").toLowerCase();
    const labelledBy = ((modal.getAttribute && modal.getAttribute("aria-labelledby")) || "").toLowerCase();
    if (aria.includes("contact") || labelledBy.includes("contact")) return true;
    return /\bcontact info\b/i.test((modal.innerText || modal.textContent || "").slice(0, 600));
  }

  // Parse a labelled section of the Contact info modal by header text.
  // LinkedIn renders each field as roughly:
  //   <section>
  //     <h3>Address</h3>
  //     <span class="...">Doha- Qatar</span>   (or an <a> for clickable fields)
  //   </section>
  // The section/header structure stays the same across LinkedIn's class-name
  // rotations, so we anchor on the header text not classes. Returns the text
  // value (without the header itself) or null.
  function _modalSection(modal, headerPattern) {
    if (!modal) return null;
    const headers = modal.querySelectorAll("h3, h4");
    for (const h of headers) {
      const ht = (h.textContent || "").trim();
      if (!headerPattern.test(ht)) continue;
      // Walk up to the section/li/div that wraps both header and value,
      // then collect everything inside that ISN'T the header.
      let wrap = h.parentElement;
      // Climb until we have a non-header child to read — but at most 3
      // levels so we don't escape into adjacent sections.
      for (let i = 0; i < 3 && wrap; i++) {
        const value = Array.from(wrap.children)
          .filter((c) => c !== h && !c.contains(h))
          .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (value) return value;
        wrap = wrap.parentElement;
      }
    }
    return null;
  }

  // Read the modal's rendered text line-by-line and return the line that
  // appears AFTER a label that matches `labelRe`. innerText preserves the
  // visual reading order LinkedIn shipped to the user — far more robust
  // than walking the DOM, which changes with every class-name rotation.
  //
  // When the modal element is a broad container (e.g. <main> on the
  // /overlay/contact-info/ URL), the text would include the navbar/footer
  // before the actual contact info — and a stray @-pattern there would
  // win the "Email" match. We anchor the search at the "Contact info"
  // heading line (or at the start if no heading found) so labels picked
  // up are guaranteed to be inside the contact section.
  function _modalFieldAfterLabel(modal, labelRe) {
    if (!modal) return null;
    const text = modal.innerText || modal.textContent || "";
    const lines = text
      .split(/[\r\n]+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    // Find the "Contact info" heading line — anchor for the scan.
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^contact info$/i.test(lines[i])) {
        start = i + 1;
        break;
      }
    }

    const stopLabels = /^(email|phone|address|website|birthday|connected since|im|profile|i ?m|websites|emails|phones|address(es)?)\s*$/i;
    const sectionLabels = /^(see all activity|about|experience|education|skills|recommendations|posts|interests|languages|courses|honors|publications|projects|volunteering|certifications)\s*$/i;

    for (let i = start; i < lines.length - 1; i++) {
      if (!labelRe.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j];
        if (!v) continue;
        // Stop if we hit a profile-section header — we've walked out of
        // the contact-info area and shouldn't keep looking.
        if (sectionLabels.test(v)) return null;
        // Skip if this is itself another contact-field label (e.g. Email
        // immediately followed by another Email row variant).
        if (stopLabels.test(v)) continue;
        return v;
      }
    }
    return null;
  }

  // Scan the modal's innerText between the "Contact info" heading and the
  // next page-section header for any phone-shaped digit run. Used when both
  // tel: anchor and labelled-line lookup miss — happens when LinkedIn ships
  // the phone as a bare <p>+97...</p> without anchor and the label appears
  // glued to the value in a single span. Strict scope so an unrelated phone
  // somewhere else on the page can't leak in.
  function _scanModalForPhone(modal) {
    if (!modal) return null;
    const text = modal.innerText || modal.textContent || "";
    const lines = text
      .split(/[\r\n]+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^contact info$/i.test(lines[i])) { start = i + 1; break; }
    }
    const sectionLabels = /^(see all activity|about|experience|education|skills|recommendations|posts|interests|languages|courses|honors|publications|projects|volunteering|certifications|more profiles for you|promoted)\s*$/i;
    for (let i = start; i < lines.length; i++) {
      if (sectionLabels.test(lines[i])) break;
      // Skip URL-bearing lines — they contain digit runs that look like
      // phones (e.g. linkedin.com/in/khalid-basha-32604830 ends in 8 digits).
      if (
        /https?:\/\//i.test(lines[i]) ||
        /\blinkedin\.com\//i.test(lines[i]) ||
        /\.com\/\S/i.test(lines[i]) ||
        /\.net\/\S/i.test(lines[i]) ||
        /\.org\/\S/i.test(lines[i])
      ) continue;
      // Phone-shaped: must START with + or digit (not a dash from URLs).
      const m = lines[i].match(/(?:^|\s|\()(\+\d[\d\s\-().]{6,}|\d[\d\s\-().]{6,})/);
      if (!m) continue;
      // Trim trailing dangling punctuation ("+97...035 (" → "+97...035")
      // — happens when the regex stops mid-"(Mobile)" because "M" isn't
      // in its char class.
      const candidate = m[1].replace(/[\s\-().]+$/g, "").trim();
      const digits = candidate.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(candidate)) continue;
      if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(candidate)) continue;
      return candidate.replace(/\s+/g, " ").trim();
    }
    return null;
  }

  // Same scan for email — last-resort when both mailto: anchor and labelled
  // lookup miss. Scopes to the contact-info section only.
  function _scanModalForEmail(modal) {
    if (!modal) return null;
    const text = modal.innerText || modal.textContent || "";
    const lines = text
      .split(/[\r\n]+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^contact info$/i.test(lines[i])) { start = i + 1; break; }
    }
    const sectionLabels = /^(see all activity|about|experience|education|skills|recommendations|posts|interests|languages|courses|honors|publications|projects|volunteering|certifications|more profiles for you|promoted)\s*$/i;
    for (let i = start; i < lines.length; i++) {
      if (sectionLabels.test(lines[i])) break;
      const m = lines[i].match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
      if (m && !/@(linkedin|2x)\.com$/i.test(m[0])) return m[0];
    }
    return null;
  }

  function _scrapeFromContactModal(modal) {
    if (!modal) return { email: null, phone: null, website: null, address: null };

    // --- Email ---
    let email = null;
    const emailAnchor = modal.querySelector("a[href^='mailto:']");
    if (emailAnchor) {
      email = (emailAnchor.getAttribute("href") || "")
        .replace(/^mailto:/, "")
        .split("?")[0]
        .trim();
    }
    if (!email) {
      const v = _modalFieldAfterLabel(
        modal,
        /^\s*(email|email\s+address|e-?mail|emails)\s*$/i
      );
      if (v) {
        const m = v.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
        if (m) email = m[0];
      }
    }
    if (!email) email = _scanModalForEmail(modal);

    // --- Phone ---
    // LinkedIn renders phone in one of three ways:
    //   A) <a href="tel:+97466186772">  — cleanest, just read the href
    //   B) Plain text <p>00974 66186772 (Mobile)</p> — label-based lookup
    //   C) Glued to label in a single span — last-resort text scan
    //
    // The critical bug in approach B: the regex [\d\s\-().]{7,} includes "("
    // in its character class, so "00974 66186772 (Mobile)" matches as
    // "00974 66186772 (" — stopping at "M". The trailing "(" makes `phone`
    // truthy (non-null) so _scanModalForPhone is skipped, and we save garbage.
    // Fix: strip LinkedIn's "(Mobile)"/"(Home)"/"(Work)" type labels from the
    // raw field value BEFORE running the digit regex, and apply a final
    // cleanup pass after every extraction path.
    let phone = null;

    // Path A — tel: anchor
    const phoneAnchor = modal.querySelector("a[href^='tel:']");
    if (phoneAnchor) {
      phone = (phoneAnchor.getAttribute("href") || "")
        .replace(/^tel:/, "")
        .trim();
    }

    // Path B — labelled field ("Phone", "Mobile", "Tel", ...)
    if (!phone) {
      const v = _modalFieldAfterLabel(
        modal,
        /^\s*(phone|phone\s+number|phone\s+numbers|mobile|tel|telephone|cell)\s*$/i
      );
      if (v) {
        // Strip trailing type annotations such as (Mobile), (Home), (Work),
        // (Office), (Cell), (Direct) BEFORE running the digit regex so the
        // trailing "(" of an unfinished parenthetical doesn't bleed in.
        const bare = v.replace(
          /\s*\((?:mobile|home|work|cell|office|other|main|business|personal|direct|primary|secondary)\b[^)]*\)\s*/gi,
          " "
        ).trim();
        const m = (bare || v).match(/[\+\d][\d\s\-().]{5,}\d/);
        if (m) {
          phone = m[0].replace(/\s+/g, " ").trim();
        }
      }
    }

    // Path C — scoped text scan for any phone-shaped digit run
    if (!phone) {
      phone = _scanModalForPhone(modal);
    }

    // Final normalisation — runs regardless of which path succeeded.
    // Removes trailing type labels "(Mobile)" etc. and stray punctuation
    // that may survive from any extraction path.
    if (phone) {
      phone = phone
        .replace(/\s*\([A-Za-z ]+\)\s*$/, "")  // "(Mobile)", "(Home)" …
        .replace(/[\s\-().]+$/, "")              // stray trailing punct
        .replace(/\s+/g, " ")
        .trim() || null;
    }

    // --- Address ---
    let address = _modalFieldAfterLabel(
      modal,
      /^\s*(address|location|home\s+address|work\s+address)\s*$/i
    );
    if (address) {
      address = address.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
    }

    // --- Website ---
    let website = null;
    const labelled = _modalFieldAfterLabel(modal, /^\s*website\s*$/i);
    if (labelled) {
      // The labelled value can be the URL itself ("example.com (Other)") or
      // we may need to look for the anchor's href to get the full https://.
      const anchors = modal.querySelectorAll("a[href^='http']");
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const at = (a.textContent || "").trim();
        if (
          !href.includes("linkedin.com") &&
          !href.includes("/overlay/") &&
          (labelled.includes(at) || at.includes(labelled.split(" ")[0]))
        ) {
          website = href;
          break;
        }
      }
      if (!website) {
        const m = labelled.match(/https?:\/\/\S+/);
        if (m) website = m[0];
      }
    }
    if (!website) {
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

    return { email, phone, website, address };
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
    timeoutMs = 5040,
    settleMs = 840,
    allowPushStateFallback = false,
  } = {}) {
    if (!location.pathname.startsWith("/in/")) {
      return { email: null, phone: null, website: null, address: null };
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
            if (dispatchHumanClick) await dispatchHumanClick(link);
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
          // Do NOT dispatch popstate here — LinkedIn's SPA router already reacts
          // to the pushState via its own history listener. A synthetic popstate
          // immediately after confuses the router into double-navigating, which
          // produces the "Error - We could not process this request" page.
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

    if (!modal) return { email: null, phone: null, website: null, address: null };

    // Wait for modal contents to fully hydrate. The mailto: anchor is added
    // by React in a second tick after the dialog mounts — reading too early
    // returns null email even though the modal is visible.
    await _sleep(settleMs);

    let data = _scrapeFromContactModal(modal);

    // Retry up to 3 more times if the modal opened but the contents weren't
    // rendered yet. Cheap React fiddly markup — the email/phone anchors
    // can take 1-4 seconds to appear after the dialog mounts. We bail
    // early once we have something useful (email or phone), capped at
    // 6s total wait so the user doesn't sit on a hung Save button.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (data.email && data.phone && data.address) break;
      await _sleep(840);
      modal = _findContactModal() || modal;
      const next = _scrapeFromContactModal(modal);
      // Merge — preserve any field we already captured (LinkedIn sometimes
      // remounts the modal and we lose a field we had a moment ago).
      data = {
        email: data.email || next.email,
        phone: data.phone || next.phone,
        website: data.website || next.website,
        address: data.address || next.address,
      };
      if (data.email || data.phone) break;
    }

    // Always close the modal when not on the overlay URL directly.
    // When didPushState is true, clicking × triggers LinkedIn's SPA router to
    // navigate back to /in/<handle> — that's the cleanest URL restore path.
    if (!isOverlayUrl) _closeContactModal();
    return data;
  }

  // Fallback enrichment: scan visible profile text for email / phone patterns.
  // LinkedIn only shows the Contact info modal email/phone for 1st-degree
  // connections (and sometimes 2nd) — for everyone else, the modal returns
  // just the LinkedIn URL. But many users put their email or phone in their
  // About section, headline, or experience descriptions to invite outreach,
  // and that text is visible to anyone. We harvest it here.
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  // Phone regex covers:
  //   +XX XX XXX XXXX  international with separators
  //   XXXXXXXX         Gulf-style 8-digit (Qatar 30082757, Kuwait 5XXXXXXX)
  //   XXX-XXX-XXXX     US-style with dashes
  // We DO require 7+ consecutive digits when there's no leading + so we
  // don't match dates / post counts / IDs by accident.
  const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{3,4}\b|\b\d{8,12}\b/;

  // De-obfuscate the most common email-hiding patterns LinkedIn users
  // employ to evade LinkedIn's auto-link detection (which would convert
  // a real email into a clickable link and trip spam filters):
  //   john [at] company [dot] com
  //   john(at)company.com
  //   john AT company DOT com
  //   john[at]company[dot]com
  // We're conservative with lowercase " at " / " dot " — they're too
  // common in normal prose to substitute blindly.
  function _deobfuscateContact(text) {
    if (!text) return "";
    let s = String(text);
    // Bracketed and parenthesized forms — case-insensitive, safe to apply
    s = s.replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@");
    s = s.replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
    // Uppercase AT / DOT with surrounding spaces — "john AT acme DOT com"
    s = s.replace(/\s+AT\s+/g, "@");
    s = s.replace(/\s+DOT\s+/g, ".");
    // Less common but real: " plus " for + in phone numbers
    s = s.replace(/\s*[\[(]\s*plus\s*[\])]\s*/gi, "+");
    return s;
  }

  // Click "see more" buttons inside the profile's content sections so the
  // full About / Experience / Featured text becomes part of innerText.
  // LinkedIn truncates About at ~200 chars by default; the lines we care
  // about ("Reach me at ___") often live below that fold.
  async function _expandProfileSections() {
    if (!location.pathname.startsWith("/in/")) return;
    const buttons = Array.from(document.querySelectorAll("button"));
    let clicked = 0;
    for (const b of buttons) {
      const text = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      // Match common LinkedIn truncation buttons. Skip "show all" buttons
      // that navigate to another page; we only want in-place expanders.
      if (!/^(\.{3}\s*more|see more|show more|…\s*more|\.{3}more)$/i.test(text)) continue;
      // Only click if button is in main profile content (skip
      // Recommendations footer / comments / unrelated dialogs).
      const inMain = b.closest("main, section, article");
      if (!inMain) continue;
      try {
        b.click();
        clicked++;
        if (clicked >= 10) break; // safety cap — never click more than 10
      } catch {
        /* swallow — some buttons throw if disabled */
      }
    }
    if (clicked) await _sleep(400); // let LinkedIn re-render expanded sections
  }

  function _scrapeFromProfileText() {
    // Search the user-content regions of the profile. Broader than before:
    // we now include About, Experience, Featured, current-job description,
    // and the first few recent-activity posts. Each section is checked
    // independently so a stray match in one doesn't pre-empt the others.
    const candidates = [
      // About / summary
      document.querySelector("section[data-section='summary']"),
      document.querySelector("section.pv-about-section"),
      document.querySelector("section#about"),
      document.querySelector("div[data-generated-suggestion-target]"),
      // Featured (pinned posts often have "DM me at ___")
      document.querySelector("section#featured"),
      document.querySelector("section[aria-labelledby*='featured' i]"),
      document.querySelector("div[aria-labelledby*='featured' i]"),
      // Experience (current + past job descriptions sometimes hold contact)
      document.querySelector("section#experience"),
      document.querySelector("section[aria-labelledby*='experience' i]"),
      // Recent activity / posts pinned to the profile
      document.querySelector("section#content_collections"),
      document.querySelector("section[aria-labelledby*='content_collections' i]"),
      document.querySelector("section[aria-labelledby*='posts' i]"),
    ].filter(Boolean);

    // Dedupe — the same section can match multiple selectors (id + aria).
    const containers = [];
    const seen = new Set();
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      containers.push(c);
    }
    // Final fallback: scan <main>, but only if nothing more specific matched.
    if (!containers.length) {
      const main = document.querySelector("main");
      if (main) containers.push(main);
    }

    let email = null;
    let phone = null;
    for (const c of containers) {
      const rawText = (c.innerText || c.textContent || "").replace(/\s+/g, " ");
      // De-obfuscate BEFORE pattern matching so "john [at] acme [dot] com"
      // becomes a normal email and matches EMAIL_RE.
      const text = _deobfuscateContact(rawText);
      if (!email) {
        const m = text.match(EMAIL_RE);
        if (
          m &&
          !/@(linkedin|2x|licdn|gstatic)\.com$/i.test(m[0]) &&
          !/example\.(com|org)$/i.test(m[0])
        ) {
          email = m[0];
        }
      }
      if (!phone) {
        const m = text.match(PHONE_RE);
        if (m) {
          const digits = m[0].replace(/\D/g, "");
          if (digits.length >= 7 && digits.length <= 15) {
            phone = m[0].replace(/\s+/g, " ").trim();
          }
        }
      }
      if (email && phone) break;
    }
    return { email, phone };
  }

  async function scrapeProfileWithContact() {
    // Click any visible "...more" / "see more" buttons in the profile's
    // content sections BEFORE the base scrape so About/Experience text
    // is fully expanded when _scrapeFromProfileText runs. Best-effort —
    // failure just means we get the truncated text, same as before.
    try { await _expandProfileSections(); } catch {}

    const base = scrapeProfile();
    try {
      // Step 1: is the Contact info popup currently open and visible?
      // If yes, trust ONLY the popup — do not fall through to text-scan,
      // because Adam Dhorajiwala's bug showed text-scan grabbing the
      // company email "adam@tadgulf.com" from About when the popup
      // clearly displayed his personal "adamkdhorajiwala@gmail.com".
      const visibleModal = _findContactModal();
      const modalWasVisible = !!visibleModal;

      // Step 2: regular modal scrape (also opens the modal if not open).
      const contact = await scrapeContactInfo();
      if (contact.email) base.email = contact.email;
      if (contact.phone) base.phone = contact.phone;
      if (contact.website && !base.company_url) base.company_url = contact.website;
      if (contact.address) base.location = contact.address.slice(0, 200);

      // Step 3: ONLY if the modal was NOT visible at start, allow the
      // About / Experience text scan. When the user has the popup open,
      // its contents are the ground truth — never override with random
      // text on the page.
      if (!modalWasVisible && (!base.email || !base.phone)) {
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
        captured_fields: [
          base.email && "email",
          base.phone && "phone",
          base.location && contact.address && "address",
          base.company_url && "website",
        ].filter(Boolean),
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

  // Belt-and-suspenders defence against mutual-connection leak: any /in/
  // link inside a known "insight" / "mutual" / "people-also-viewed" /
  // "follow recommendations" container is REJECTED before card-owner
  // dedup even runs. Selectors here must be NARROW — anything matching
  // the outer search container (.search-results__cluster, .search-marvel-srp,
  // section.artdeco-card.pv-profile-card) would reject every link on the
  // page including main profile links, giving "No profiles found".
  const _INSIGHT_ANCESTOR_SEL = [
    ".reusable-search-simple-insight",
    ".reusable-search__simple-insight",
    ".entity-result__simple-insight",
    ".entity-result__insights",
    ".discover-entity-type-card",
    ".pv-browsemap-section",
    ".pv-recent-activity-section",
    "[data-test-people-also-viewed]",
    "[data-view-name='profile-card-mutual-connections']",
    "[data-view-name='profile-card-browsemap']",
  ].join(",");

  function _isInsightLink(link) {
    try {
      if (link.closest(_INSIGHT_ANCESTOR_SEL)) return true;
    } catch {
      /* defensive */
    }
    return false;
  }

  // Does this link look like LinkedIn's accessible profile-title pattern
  // (<a><span aria-hidden="true">Name</span>…</a>)? Used as a TIEBREAKER
  // when multiple /in/ links resolve to the same card — mutual-strip
  // anchors are plain <a>Name</a> with no aria-hidden span, so the
  // tiebreaker prefers the real title link without HARD-rejecting plain
  // anchors (which would zero out chips on cards LinkedIn renders
  // differently).
  function _hasAccessibleTitle(link) {
    try {
      return !!link.querySelector("span[aria-hidden='true']");
    } catch {
      return false;
    }
  }

  function _profileCardFromLink(link) {
    // Walk up to the FIRST structural row root. Mutual-connection links
    // are filtered out earlier by _isInsightLink, so the structural walk
    // here only needs to find each profile's own card; it does NOT need
    // to be smart about nested mutual <li>s anymore.
    //
    //   - Regular People Search:  <li class="reusable-search__result-container">
    //   - Sales Nav search:       <li> or <article>
    //   - Sales Nav saved-list:   <tr> or div[role='row']
    //   - mynetwork / other:      <li> or [role='listitem']
    //
    // Must stay in lock-step with overlay.js _cardFromLink.
    let node = link.parentElement;
    let actionFallback = null;
    let listFallback = null;
    for (let i = 0; i < 14 && node; i++) {
      if (
        node.tagName === "LI" ||
        node.tagName === "ARTICLE" ||
        node.tagName === "TR" ||
        node.getAttribute?.("role") === "row" ||
        node.getAttribute?.("role") === "listitem"
      ) {
        return node;
      }
      if (
        !actionFallback &&
        node.querySelector("img") &&
        node.querySelector(
          "button[aria-label*='Message' i], button[aria-label*='Connect' i], button[aria-label*='Follow' i]"
        )
      ) {
        actionFallback = node;
      }
      if (
        !listFallback &&
        node.querySelector("img") &&
        (node.querySelector("input[type='checkbox']") ||
          node.querySelector("[role='cell']"))
      ) {
        listFallback = node;
      }
      node = node.parentElement;
    }
    return actionFallback || listFallback || link.parentElement;
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
    // One profile per CARD using the FIRST /in/ link in DOM order as the
    // owner. Mutual-connection / people-also-viewed links embedded in
    // someone else's card NEVER appear first in their card's DOM, so
    // they're naturally excluded without fragile text-matching heuristics.
    const allLinks = Array.from(
      document.querySelectorAll("a[href*='/in/']")
    ).filter((link) => !_isInsightLink(link));
    const cardOwner = new Map(); // card → { url, link }
    for (const link of allLinks) {
      try {
        const url = normalizeProfileUrl(link.href);
        if (!url) continue;
        const card = _profileCardFromLink(link);
        if (!card) continue;
        if (cardOwner.has(card)) {
          const existing = cardOwner.get(card);
          if (existing.url !== url) {
            // Different URL = possible mutual-connection link. Prefer the title
            // link (has aria-hidden span) over a plain anchor so a mutual strip
            // that appears first in DOM order doesn't hijack the card owner.
            if (_hasAccessibleTitle(link) && !_hasAccessibleTitle(existing.link)) {
              cardOwner.set(card, { url, link });
            }
            continue;
          }
          // Same URL: upgrade to the anchor with name text (photo anchor is often empty).
          const newHasText = (link.textContent || "").trim().length > 0;
          const oldHasText = (existing.link.textContent || "").trim().length > 0;
          if (newHasText && !oldHasText) cardOwner.set(card, { url, link });
          continue;
        }
        cardOwner.set(card, { url, link });
      } catch {
        /* skip malformed */
      }
    }

    const results = [];
    const seen = new Set();
    for (const [card, { url, link }] of cardOwner.entries()) {
      try {
        if (seen.has(url)) continue;
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

        // --- Name extraction (specific → generic) ---
        // Try the data-anonymize attributes first; LinkedIn keeps these
        // stable across redesigns because their own product code depends
        // on them. Then a few fallbacks. Reject action-label text outright
        // ("View LinkedIn profile", "Connect", etc.) so we don't save a
        // button label as the person's name.
        const candidates = [
          card.querySelector("[data-anonymize='person-name']"),
          card.querySelector("[data-anonymize='name']"),
          card.querySelector("a[data-control-name='view_lead_panel_via_search_lead_name'] [aria-hidden='true']"),
          card.querySelector("a[data-control-name='view_lead_panel_via_search_lead_name']"),
          link.querySelector("span[aria-hidden='true']"),
          link.querySelector("strong, b"),
        ].filter(Boolean);

        let name = null;
        for (const el of candidates) {
          const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
          const cleaned = _cleanPersonName(raw);
          if (!cleaned) continue;
          if (_isActionLabel(cleaned)) continue;
          if (/^linkedin member$/i.test(cleaned)) continue;
          name = cleaned;
          break;
        }

        // URL-slug fallback. Sales Nav cards often also expose the /in/
        // anchor — use it. Otherwise derive from /sales/lead/<id> isn't
        // useful (it's a numeric id, not a slug).
        const liAnchor = card.querySelector("a[href*='/in/']");
        if (!name && liAnchor) {
          name = _nameFromSlug(liAnchor.href);
        }

        // No usable name → skip. This is what protects the pipeline from
        // "View LinkedIn profile" rows. Far better to drop a card than
        // pollute the table.
        if (!name) continue;

        // --- Title / company / location ---
        const titleEl =
          card.querySelector("[data-anonymize='title']") ||
          card.querySelector("[data-anonymize='job-title']");
        const companyEl =
          card.querySelector("[data-anonymize='company-name']") ||
          card.querySelector("a[data-anonymize='company-name']");
        const locEl = card.querySelector("[data-anonymize='location']");
        const cleanText = (el) => {
          const t = el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
          if (!t || _isActionLabel(t)) return null;
          return t;
        };
        const title = cleanText(titleEl);
        const company = cleanText(companyEl);
        const loc = cleanText(locEl);

        // Prefer the /in/ URL over /sales/lead/ if Sales Nav exposes it
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
        () => finish({ email: null, phone: null, website: null, address: null }),
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
          return finish({ email: null, phone: null, website: null, address: null });
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
          return finish({ email: null, phone: null, website: null, address: null });
        }

        // Reuse the same header-based extractor as the foreground modal
        // scrape so the iframe path also captures Address + label-based
        // fallbacks consistently. _scrapeFromContactModal lives in this
        // module (same global, same `doc` shouldn't matter — modal is a
        // DOM node, the helper only walks .children/.querySelectorAll).
        const data = _scrapeFromContactModal(modal);

        // If the modal is present but contents haven't hydrated yet, give
        // React a couple more polls before giving up.
        if (!data.email && !data.phone && !data.address && elapsed < 8000) return;

        // No <main>-text fallback here on purpose — the iframe loads the
        // /overlay/contact-info/ URL which can drift to a login wall, feed,
        // or unrelated content; a regex scan would pick up some other
        // person's email and attribute it to this lead. We only trust the
        // anchors inside the verified Contact info modal.
        finish(data);
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
    // Exposed so overlay.js's _harvestVisibleContact can reuse the same
    // modal-detection logic (which has more fallbacks than the
    // div[role='dialog']-only check it had before).
    _findContactModal,
    _scrapeFromContactModal,
  };
})();
