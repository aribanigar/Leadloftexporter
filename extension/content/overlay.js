/* The LeadCaptura overlay system.
 *
 * Renders three things into the LinkedIn page:
 *   1. A floating profile panel on /in/<handle> pages (top-right corner).
 *   2. A persistent bottom toolbar on search / Sales Nav list pages, with
 *      Segment / Playbook / User dropdowns and a Save All Leads button —
 *      mirroring the UX of mature LinkedIn capture extensions.
 *   3. Per-card "Save" pills injected inline with LinkedIn's own action
 *      buttons (Message / Connect / Follow), styled to match the native UI.
 *
 * We never use Shadow DOM because we want our toolbar to layer above
 * LinkedIn's chat overlay. Isolation is via the `lc-` class prefix and
 * `all: initial` reset on top-level containers.
 */
(() => {
  if (globalThis.__lcOverlay) return;
  const Scraper = globalThis.__lcScraper;
  const Api = globalThis.__lcApi;
  const Storage = globalThis.__lcStorage;

  // chrome.runtime.openOptionsPage is only callable from extension pages and
  // the service worker — not from content scripts. Route through the SW.
  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: "lc:openOptions" });
    } catch (e) {
      console.warn("[LeadCaptura] could not open options page", e);
    }
  }

  const state = {
    profilePanel: null,
    toolbar: null,
    options: null, // { workspace, user, playbooks, segments, users }
    selection: { segmentId: null, playbookId: null, userId: null },
    lastSavedLeadIds: [],
    statusTimer: null,
    me: null,
  };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "onclick") node.addEventListener("click", v);
      else if (k === "onchange") node.addEventListener("change", v);
      else if (k.startsWith("data-")) node.setAttribute(k, v);
      else node[k] = v;
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  async function ensureOptions() {
    if (state.options) return state.options;
    try {
      state.options = await Api.options();
      if (state.options?.user) state.selection.userId = state.options.user.id;
    } catch {
      state.options = null;
    }
    return state.options;
  }

  function flashStatus(msg, level = "info") {
    const root = state.toolbar || state.profilePanel;
    if (!root) return;
    const slot = root.querySelector(".lc-status-slot");
    if (!slot) return;
    slot.textContent = "";
    slot.appendChild(el("span", { class: `lc-status lc-${level}` }, msg));
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      if (slot.firstChild) slot.removeChild(slot.firstChild);
    }, 5000);
  }

  // ---------- Profile panel (compact top-right card on /in/ pages) ----------

  async function mountProfilePanel() {
    if (state.profilePanel) return state.profilePanel;
    const settings = await Storage.getSettings();
    if (!settings.showOverlay) return null;
    const root = el("div", { id: "lc-profile-panel", class: "lc-card" });
    document.documentElement.appendChild(root);
    state.profilePanel = root;
    return root;
  }

  function unmountProfilePanel() {
    if (state.profilePanel) {
      state.profilePanel.remove();
      state.profilePanel = null;
    }
  }

  async function renderProfilePanel() {
    const root = await mountProfilePanel();
    if (!root) return;
    const opts = await ensureOptions();
    const connected = !!opts;
    const scraped = Scraper.scrapeCurrentPage();
    const profile = scraped.profile;
    // LinkedIn renders the top card asynchronously; the h1 sometimes
    // doesn't exist on the first onPathChange tick. If we have no name
    // yet, schedule one re-render attempt 1.2s later so the panel fills
    // in instead of staying stuck on "Open a LinkedIn profile to capture
    // it." Cap retries via a tag on the panel so we don't loop forever.
    if (
      (!profile || !profile.full_name) &&
      Number(root.dataset.lcRetries || 0) < 4
    ) {
      const n = Number(root.dataset.lcRetries || 0) + 1;
      root.dataset.lcRetries = String(n);
      setTimeout(() => renderProfilePanel(), 1200);
    } else if (profile?.full_name) {
      root.dataset.lcRetries = "0";
    }

    root.textContent = "";
    root.append(
      el(
        "div",
        { class: "lc-card-head" },
        el("span", { class: "lc-logo" }, "L"),
        el("span", { class: "lc-card-title" }, "LeadCaptura"),
        el("span", { class: "lc-flex" }),
        el("button", { class: "lc-icon-btn", onclick: () => root.classList.toggle("lc-collapsed"), title: "Collapse" }, "–")
      ),
      el(
        "div",
        { class: "lc-card-body" },
        profile
          ? el(
              "div",
              { class: "lc-profile-meta" },
              profile.avatar_url
                ? el("img", { class: "lc-avatar", src: profile.avatar_url, alt: "" })
                : el("div", { class: "lc-avatar lc-avatar-placeholder" }, (profile.full_name || "?").slice(0, 1).toUpperCase()),
              el(
                "div",
                { class: "lc-profile-text" },
                el("div", { class: "lc-profile-name" }, profile.full_name || "Unknown profile"),
                el("div", { class: "lc-profile-sub" }, profile.headline || profile.title || "")
              )
            )
          : el("div", { class: "lc-muted" }, "Open a LinkedIn profile to capture it."),
        el(
          "div",
          { class: "lc-actions" },
          connected && profile
            ? el(
                "button",
                { class: "lc-btn lc-btn-primary", onclick: () => saveCurrentProfile(profile) },
                "Save Lead"
              )
            : null,
          !connected
            ? el(
                "button",
                { class: "lc-btn lc-btn-primary", onclick: () => openOptions() },
                "Connect workspace"
              )
            : null,
          el(
            "button",
            { class: "lc-btn lc-btn-ghost", onclick: () => openOptions(), title: "Settings" },
            "⚙"
          )
        ),
        el("div", { class: "lc-status-slot" })
      )
    );
  }

  // Last-mile email/phone harvester: ONLY scans inside an open Contact info
  // modal. NEVER scans the wider /in/ page — LinkedIn renders mailto:/tel:
  // anchors all over (Recent activity, recommendations, People you may know)
  // and grabbing those would attribute another person's contact info to the
  // current lead. We restrict to elements inside `div[role='dialog']` that
  // also contains the literal "Contact info" header text — the unambiguous
  // signature of the Contact info modal.
  function _harvestVisibleContact() {
    const result = { email: null, phone: null, website: null };
    try {
      const dialogs = document.querySelectorAll("div[role='dialog']");
      let modal = null;
      for (const d of dialogs) {
        // Must be visibly rendered (has layout boxes)
        if (!d.getClientRects().length) continue;
        // Must be the CONTACT INFO modal — header text fingerprint.
        const text = (d.innerText || d.textContent || "").trim();
        if (/^contact info\b/i.test(text) || /\bcontact info\b/i.test(text.slice(0, 200))) {
          modal = d;
          break;
        }
      }
      if (!modal) return result;
      const mailto = modal.querySelector("a[href^='mailto:']");
      if (mailto) {
        const e = (mailto.getAttribute("href") || "")
          .replace(/^mailto:/, "")
          .split("?")[0]
          .trim();
        if (e && /@/.test(e)) result.email = e;
      }
      const tel = modal.querySelector("a[href^='tel:']");
      if (tel) {
        const p = (tel.getAttribute("href") || "").replace(/^tel:/, "").trim();
        if (p) result.phone = p;
      }
      const externals = modal.querySelectorAll("a[href^='http']");
      for (const a of externals) {
        const href = a.getAttribute("href") || "";
        if (
          !href.includes("linkedin.com") &&
          !href.includes("/overlay/") &&
          !href.includes("/feed/")
        ) {
          result.website = href;
          break;
        }
      }
    } catch {}
    return result;
  }

  async function saveCurrentProfile(profile) {
    flashStatus("Reading contact info…");
    let enriched = profile;
    try {
      // On /in/ pages we open the Contact info modal and read email/phone the
      // same way a human would — opens the visible modal, scrapes, closes.
      // If the user has manually opened the Contact info modal already,
      // scrapeProfileWithContact() will find it and just read it (no extra
      // click), and `enriched.email` / `enriched.phone` come back populated.
      if (location.pathname.startsWith("/in/") && Scraper.scrapeProfileWithContact) {
        enriched = await Scraper.scrapeProfileWithContact();
      }
    } catch {
      enriched = profile;
    }
    // Re-scrape the base profile so a Save click that ran after the h1
    // finally hydrated picks up the correct name/title even though the
    // initial panel render saw "Unknown profile". Without this re-scrape,
    // the click handler would send back the stale empty profile object.
    if ((!enriched.full_name || !enriched.title) && Scraper.scrapeProfile) {
      try {
        const fresh = Scraper.scrapeProfile();
        if (fresh) {
          for (const k of [
            "full_name", "first_name", "last_name", "headline",
            "title", "company_name", "location", "avatar_url",
          ]) {
            if (!enriched[k] && fresh[k]) enriched[k] = fresh[k];
          }
        }
      } catch {}
    }
    // Last-mile: if scrapeProfileWithContact didn't surface email/phone
    // (modal selectors drifted, or it timed out), do a document-wide
    // mailto:/tel: anchor scan. If the user can see the email on screen,
    // this catches it.
    if (!enriched.email || !enriched.phone || !enriched.company_url) {
      const visible = _harvestVisibleContact();
      if (!enriched.email && visible.email) enriched.email = visible.email;
      if (!enriched.phone && visible.phone) enriched.phone = visible.phone;
      if (!enriched.company_url && visible.website)
        enriched.company_url = visible.website;
    }
    flashStatus("Saving…");
    try {
      const result = await Api.syncProfile(enriched);
      const gotEmail = !!(enriched.email && !profile.email);
      const gotPhone = !!(enriched.phone && !profile.phone);
      const extras = [gotEmail && "email", gotPhone && "phone"].filter(Boolean).join(" + ");
      const msg = result.created
        ? `Saved new lead ✓${extras ? ` (${extras})` : ""}`
        : `Lead updated ✓${extras ? ` (${extras})` : ""}`;
      flashStatus(msg, "ok");
      if (result.lead?.id) state.lastSavedLeadIds = [result.lead.id];
      maybeAutoEnroll();
    } catch (e) {
      flashStatus(`Failed: ${e.message}`, "err");
    }
  }

  // ---------- Bottom toolbar (search / Sales Nav pages) ----------

  async function mountToolbar() {
    if (state.toolbar) return state.toolbar;
    const settings = await Storage.getSettings();
    if (!settings.showOverlay) return null;
    const root = el("div", { id: "lc-toolbar" });
    document.documentElement.appendChild(root);
    state.toolbar = root;
    return root;
  }

  function unmountToolbar() {
    if (state.toolbar) {
      state.toolbar.remove();
      state.toolbar = null;
    }
  }

  function dropdown(label, value, items, onPick, opts = {}) {
    const wrap = el("div", { class: "lc-dd" });
    const button = el(
      "button",
      { class: "lc-dd-btn", type: "button" },
      el("span", { class: "lc-dd-label" }, `${label}:`),
      el("span", { class: "lc-dd-value" }, value || "None"),
      el("span", { class: "lc-dd-caret" }, "▾")
    );
    const menu = el("div", { class: "lc-dd-menu" });
    const list = [...(opts.includeNone === false ? [] : [{ id: null, name: "None" }]), ...items];
    for (const it of list) {
      const item = el(
        "button",
        {
          class: "lc-dd-item",
          type: "button",
          onclick: (e) => {
            e.stopPropagation();
            menu.classList.remove("lc-open");
            onPick(it);
          },
        },
        it.icon ? el("span", { class: "lc-dd-icon" }, it.icon) : null,
        el("span", {}, it.name)
      );
      menu.append(item);
    }
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".lc-dd-menu.lc-open").forEach((m) => {
        if (m !== menu) m.classList.remove("lc-open");
      });
      menu.classList.toggle("lc-open");
    });
    document.addEventListener("click", () => menu.classList.remove("lc-open"));
    wrap.append(button, menu);
    return wrap;
  }

  async function renderToolbar() {
    const root = await mountToolbar();
    if (!root) return;
    const opts = await ensureOptions();
    if (!opts) {
      root.textContent = "";
      root.append(
        el("div", { class: "lc-toolbar-inner" },
          el("span", { class: "lc-logo" }, "L"),
          el("span", { class: "lc-tb-title" }, "LeadCaptura"),
          el("span", { class: "lc-flex" }),
          el("span", { class: "lc-muted" }, "Not connected — "),
          el(
            "button",
            { class: "lc-btn lc-btn-primary lc-btn-sm", onclick: () => openOptions() },
            "Connect workspace"
          )
        )
      );
      return;
    }

    const segmentName = (opts.segments.find((s) => s.id === state.selection.segmentId) || {}).name;
    const playbookName = (opts.playbooks.find((p) => p.id === state.selection.playbookId) || {}).name;
    const userName =
      (opts.users.find((u) => u.id === state.selection.userId) || { name: "Me" }).name;

    root.textContent = "";
    root.append(
      el(
        "div",
        { class: "lc-toolbar-inner" },
        el("span", { class: "lc-logo" }, "L"),
        el("span", { class: "lc-tb-title" }, "LeadCaptura"),
        dropdown("Segment", segmentName, opts.segments, (s) => {
          state.selection.segmentId = s.id;
          renderToolbar();
        }),
        dropdown("Playbook", playbookName, opts.playbooks, (p) => {
          state.selection.playbookId = p.id;
          renderToolbar();
        }),
        dropdown(
          "User",
          userName,
          opts.users.map((u) => ({ id: u.id, name: u.name })),
          (u) => {
            state.selection.userId = u.id;
            renderToolbar();
          },
          { includeNone: false }
        ),
        el("span", { class: "lc-flex" }),
        el("div", { class: "lc-status-slot" }),
        el(
          "button",
          { class: "lc-btn lc-btn-primary", onclick: saveAllVisible },
          "Save All Leads"
        ),
        el(
          "button",
          {
            class: "lc-icon-btn lc-icon-btn-light",
            onclick: (e) => {
              e.stopPropagation();
              const m = root.querySelector(".lc-overflow");
              m.classList.toggle("lc-open");
            },
            title: "More",
          },
          "⋮"
        ),
        el(
          "div",
          { class: "lc-overflow lc-dd-menu" },
          el(
            "button",
            {
              class: "lc-dd-item",
              type: "button",
              onclick: () => openOptions(),
            },
            "Settings"
          ),
          el(
            "button",
            {
              class: "lc-dd-item",
              type: "button",
              onclick: () => {
                state.toolbar.classList.toggle("lc-collapsed");
              },
            },
            "Hide toolbar"
          )
        )
      )
    );
  }

  async function maybeAutoEnroll() {
    const pbId = state.selection.playbookId;
    if (!pbId || !state.lastSavedLeadIds.length) return;
    try {
      const r = await Api.enrollBatch(pbId, state.lastSavedLeadIds);
      if (r?.count) flashStatus(`Enrolled ${r.count} in playbook ✓`, "ok");
    } catch (e) {
      flashStatus(`Enrollment failed: ${e.message}`, "err");
    }
  }

  async function saveAllVisible() {
    const { profiles } = Scraper.scrapeCurrentPage();
    if (!profiles?.length) {
      flashStatus("No profiles found on this page.", "warn");
      return;
    }
    flashStatus(`Saving ${profiles.length}…`);
    try {
      const res = await Api.syncSearch({
        page_url: location.href,
        captured_at: new Date().toISOString(),
        profiles,
      });
      state.lastSavedLeadIds = res.lead_ids || [];
      flashStatus(`+${res.created} new, ${res.updated} updated`, "ok");
      decorateSearchCards();
      maybeAutoEnroll();
    } catch (e) {
      flashStatus(`Failed: ${e.message}`, "err");
    }
  }

  // ---------- Inline per-card Save buttons (search + sales nav) ----------

  /* Global registry of save buttons we've injected, keyed by canonical
   * LinkedIn URL. Without this, LinkedIn's two anchors per card (photo
   * link + name link) cause us to inject twice, and pagination/virtual
   * scroll lets stale buttons linger on recycled <li>s. With it, we
   * guarantee exactly one Save chip per profile globally. */
  const injectedSaves = new Map(); // canonical url -> wrap element

  function _gcInjected() {
    for (const [url, node] of injectedSaves.entries()) {
      if (!node || !document.body.contains(node)) injectedSaves.delete(url);
    }
  }

  function injectInlineSave(card, profile) {
    // Sales Navigator cards often expose BOTH a /sales/lead/ anchor and an
    // /in/ anchor pointing at the same person. Contact-info scraping only
    // works on /in/ pages (the modal doesn't exist on Sales Nav lead pages),
    // so when both are available, swap the profile URL to the /in/ form
    // before saving. Same canonical URL = same backend lead, no duplicate.
    if (profile.linkedin_url && profile.linkedin_url.includes("/sales/lead/")) {
      const cardInLink = card.querySelector("a[href*='/in/']");
      if (cardInLink) {
        const inUrl = globalThis.__lcDom.normalizeProfileUrl(cardInLink.href);
        if (inUrl) profile.linkedin_url = inUrl;
      }
    }
    const url = profile.linkedin_url;
    if (!url) return;
    // De-dupe: if we already have a save chip for this URL still in the DOM,
    // don't add another. If the recorded element was removed (pagination,
    // SPA re-render), let it through.
    const existing = injectedSaves.get(url);
    if (existing && document.body.contains(existing)) return;
    if (existing) injectedSaves.delete(url);

    const textSpan = el("span", { class: "lc-inline-save-text" }, "Save");
    const btn = el(
      "button",
      {
        class: "lc-inline-save",
        type: "button",
        title: "Save to LeadCaptura",
      },
      textSpan
    );
    btn.dataset.state = "ready";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === "saving") return;
      btn.dataset.state = "saving";
      textSpan.textContent = "Saving…";
      try {
        // Step 1 — save the card data (name, title, company, location,
        // avatar, headline) immediately. The user gets a "Saved ✓" pill
        // even if the iframe enrichment below times out or yields nothing.
        const result = await Api.syncProfile(profile);
        if (result.lead?.id) {
          state.lastSavedLeadIds = [result.lead.id];
          maybeAutoEnroll();
        }
        btn.dataset.state = "saved";
        textSpan.textContent = "Saved ✓";

        // Step 2 — enrich email / phone / company website via a HIDDEN
        // IFRAME. No new tab, no popup, no visual artefact: we mount an
        // off-screen iframe at /in/<handle>/overlay/contact-info/ which is
        // same-origin, so we can read its DOM and pull mailto:/tel:
        // anchors directly. Only /in/ URLs are eligible — /sales/lead/
        // pages don't render the Contact info modal, and bouncing them
        // would create the duplicate-blank-lead problem.
        const settings = await Storage.getSettings();
        if (
          settings.autoEnrichOnSave === false ||
          !profile.linkedin_url?.includes("/in/")
        ) {
          return;
        }

        // Rate-limit handshake with the service worker. The SW holds the
        // 20/hr + 100/day budget shared across all open LinkedIn tabs.
        const allowed = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              { type: "lc:reserveEnrich" },
              (resp) => {
                if (chrome.runtime.lastError) return resolve(false);
                resolve(resp?.ok === true);
              }
            );
          } catch {
            resolve(false);
          }
        });
        if (!allowed) {
          textSpan.textContent = "Saved (daily limit)";
          return;
        }

        textSpan.textContent = "Saved · enriching…";
        const contact = await Scraper.scrapeContactInfoViaIframe(
          profile.linkedin_url
        );
        if (contact.email || contact.phone || contact.website) {
          const enriched = { ...profile };
          if (contact.email) enriched.email = contact.email;
          if (contact.phone) enriched.phone = contact.phone;
          if (contact.website) enriched.company_url = contact.website;
          enriched.raw = {
            ...(enriched.raw || {}),
            contact_info_scraped: true,
          };
          try {
            await Api.syncProfile(enriched);
            const got = [
              contact.email && "email",
              contact.phone && "phone",
            ]
              .filter(Boolean)
              .join(" + ");
            textSpan.textContent = got ? `Saved ✓ (${got})` : "Saved ✓";
          } catch {
            textSpan.textContent = "Saved ✓";
          }
        } else {
          textSpan.textContent = "Saved ✓";
        }
      } catch (err) {
        btn.dataset.state = "error";
        textSpan.textContent = "Retry";
        console.warn("[LeadCaptura] save failed", err);
      }
    });

    const wrap = el("div", { class: "lc-save-row" }, btn);
    wrap.dataset.lcUrl = url;

    // The chip floats absolute at the top-right of the card, just inboard of
    // LinkedIn's Connect/Pending button. The card needs position:relative
    // for the absolute child to anchor correctly.
    try {
      if (getComputedStyle(card).position === "static") {
        card.style.position = "relative";
      }
    } catch {
      card.style.position = "relative";
    }
    card.appendChild(wrap);
    injectedSaves.set(url, wrap);
  }

  function _cardFromLink(link) {
    // Walk up to find the row/card root. Different LinkedIn surfaces use
    // different element types:
    //   - Regular People Search:  <li>
    //   - Sales Nav search:       <li> or <article>
    //   - Sales Nav saved-list:   <tr> or div[role='row']  (table layout)
    //   - mynetwork:              <li> usually, sometimes <article>
    // We prefer these structural roots over any inner flex wrapper so our
    // absolutely-positioned save chip anchors to the full row instead of
    // becoming a sibling next to LinkedIn's action buttons.
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
      // Primary fallback: container that holds Connect/Message/Follow.
      if (
        !actionFallback &&
        node.querySelector("img") &&
        node.querySelector(
          "button[aria-label*='Message' i], button[aria-label*='Connect' i], button[aria-label*='Follow' i]"
        )
      ) {
        actionFallback = node;
      }
      // Secondary fallback for saved-list / leads-list views: they don't
      // expose Connect/Message buttons (the user already saved the lead).
      // Instead they have checkboxes or single profile links per row.
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

  // Mirror of scraper.js _cleanPersonName — keep behavior identical.
  // Two-stage strategy: (1) strip a11y / status / badge labels in-place
  // without consuming everything after them (those often appear as LEADING
  // sr-only spans inside the link/h1), (2) truncate at first degree marker.
  function _cleanCardName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, " ").trim();
    const stripLabels = [
      /\bVerified\b/gi,
      /\bPremium\s*Member\b/gi,
      /\bOpenToWork\b/gi,
      /\bHiring\b/gi,
      /\bInfluencer\b/gi,
      /\bStatus is (online|offline|reachable)\b/gi,
      /\bView\s+\S+(?:'|’)s\s+profile\b/gi,
    ];
    for (const re of stripLabels) s = s.replace(re, " ");
    s = s.replace(/^(Status is (?:online|offline|reachable))/i, "$1 ")
         .replace(/^(Verified|Premium Member|OpenToWork|Hiring|Influencer)/i, "$1 ");
    s = s.replace(/\s+/g, " ").trim();
    for (const re of stripLabels) s = s.replace(re, " ");
    s = s.replace(/\s+/g, " ").trim();
    const cutMarkers = [
      /\s*[•·]\s*(1st|2nd|3rd\+?)\b.*/i,
      /\s*\b(1st|2nd|3rd\+?)\s+degree\b.*/i,
      /\s*[•·]\s*(He\/Him|She\/Her|They\/Them)\b.*/i,
      /\s*\(\s*(He|She|They)\/(Him|Her|Them)\s*\).*/i,
    ];
    for (const re of cutMarkers) s = s.replace(re, "").trim();
    s = s.replace(/[\s•·,\-—|]+$/g, "").trim();
    return s || null;
  }

  function profileFromCard(card, link) {
    const linkEl = link || card.querySelector("a[href*='/in/'], a[href*='/sales/lead/']");
    if (!linkEl) return null;
    const nameNode =
      linkEl.querySelector("span[aria-hidden='true']") ||
      linkEl.querySelector("strong, b") ||
      card.querySelector("[data-anonymize='person-name']");
    let rawName = nameNode?.textContent;
    if (!rawName) {
      // Falling back to the full link text is dangerous because LinkedIn
      // sometimes wraps the entire card body in the /in/ anchor. Take only
      // the leading person-name segment by cutting at the first degree
      // badge / bullet separator.
      const txt = (linkEl.textContent || "").replace(/\s+/g, " ").trim();
      if (txt && txt.length < 80 && !/[•·]\s*(1st|2nd|3rd\+?)/i.test(txt)) {
        rawName = txt;
      } else if (txt) {
        rawName = txt.split(/\s*[•·]\s*(1st|2nd|3rd\+?)/i)[0].trim();
      }
    }
    // URL-slug fallback so a stripped/unrendered name never blocks save.
    if (!rawName) {
      try {
        const u = new URL(linkEl.href, location.origin);
        const slug = u.pathname.replace(/^\/in\//, "").replace(/\/$/, "");
        if (slug && !slug.includes("/")) {
          rawName = slug
            .split("-")
            .filter((p) => p.length >= 2)
            .filter((p) => !/^\d+$/.test(p))
            .filter((p) => !(/[a-z]/i.test(p) && /\d/.test(p)))
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(" ");
        }
      } catch {}
    }
    const name = _cleanCardName(rawName);
    if (!name || /linkedin member/i.test(name)) return null;
    // Headline is typically the first descriptive text region in the card
    // that isn't the name itself or an action label.
    const textCandidates = Array.from(card.querySelectorAll("div, p, span"))
      // Skip elements that live INSIDE a profile link — those are other
      // people's names (mutual connections, "people also viewed") embedded
      // inside the same card <li>, and their text poisons the headline.
      .filter((n) => !n.closest("a[href*='/in/'], a[href*='/sales/lead/']"))
      // Skip container elements that WRAP a profile link (same reason).
      .filter((n) => !n.querySelector("a[href*='/in/'], a[href*='/sales/lead/']"))
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter(
        (t) =>
          t !== name &&
          !/connect|message|follow|view profile|premium/i.test(t) &&
          // Drop any text that contains a LinkedIn degree badge ("• 1st",
          // "• 2nd", "• 3rd+") — those are person references, not headlines.
          !/•\s*(1st|2nd|3rd\+?)/i.test(t) &&
          // Drop activity/feed noise ("Feed post", "Reposted this",
          // "Liked by", "Recent activity") — never headlines.
          !/^(feed post|reposted|liked by|commented|shared|recent activity|posts|activity|see all activity|loaded \d+|show all \d+|new! |status is )/i.test(t) &&
          t.length > 4 &&
          t.length < 240
      );
    const headline = textCandidates[0] || null;
    const location_ =
      textCandidates.find(
        (t) =>
          t !== headline &&
          t.length < 80 &&
          (t.includes(",") ||
            /\b(india|uae|usa|uk|qatar|emirates|states|kingdom|america|saudi|hong kong)\b/i.test(t))
      ) || null;
    // LinkedIn's media CDN requires the signed-JWT query string. Storing
    // the URL without it returns a 403 placeholder. The backend column is
    // TEXT (unbounded) so we keep the URL verbatim.
    const avatar = card.querySelector("img")?.getAttribute("src") || null;
    const [first_name, ...rest] = name.split(/\s+/);
    // Many LinkedIn headlines use pipe-separated tags after the primary job:
    //   "Head of Events at HEC Paris Doha | Executive Education | Aviation"
    // We split at the first "|" to extract just the primary job segment,
    // then split that on " at " to separate title from company. Without the
    // pipe-first step, the company field becomes the entire trailing string.
    const primarySegment = (headline || "").split("|")[0].trim();
    const atParts = primarySegment.split(/\s+at\s+/i);
    const titlePart = atParts[0] || null;
    const companyPart = atParts.slice(1).join(" at ") || null;
    return {
      linkedin_url: globalThis.__lcDom.normalizeProfileUrl(linkEl.href),
      full_name: name.slice(0, 240),
      first_name: first_name ? first_name.slice(0, 120) : null,
      last_name: rest.join(" ").slice(0, 120) || null,
      headline,
      title: titlePart ? titlePart.slice(0, 240) : null,
      company_name: companyPart ? companyPart.slice(0, 200) : null,
      location: location_ ? location_.slice(0, 200) : null,
      avatar_url: avatar,
      raw: { source_url: location.href, page_type: "card-inline" },
    };
  }

  function decorateSearchCards() {
    const type = Scraper.pageType();
    if (!type.includes("search") && !type.includes("sales")) return;

    // Garbage-collect entries whose DOM nodes are gone (pagination/SPA churn)
    _gcInjected();

    // LinkedIn renders TWO /in/ anchors per card: a PHOTO anchor (no text,
    // <img> inside) and a NAME anchor (contains <span>Name</span>). DOM
    // order has the photo first. The naive "first anchor wins" dedup would
    // call profileFromCard() on the photo anchor → empty name → null
    // profile → no injection, and then skip the name anchor as a duplicate
    // URL. Result: ZERO save chips on every card. Fix: group anchors by
    // canonical URL and pick the one with actual text content per group.
    const links = document.querySelectorAll(
      "a[href*='/in/'], a[href*='/sales/lead/']"
    );
    const byUrl = new Map(); // url -> best anchor (preferring ones with text)
    for (const link of links) {
      const url = globalThis.__lcDom.normalizeProfileUrl(link.href);
      if (!url) continue;
      const current = byUrl.get(url);
      const linkHasText = (link.textContent || "").trim().length > 0;
      if (!current) {
        byUrl.set(url, link);
      } else if (linkHasText && !(current.textContent || "").trim()) {
        // Upgrade: the new candidate has the name text, the stored one didn't
        byUrl.set(url, link);
      }
    }

    for (const [url, link] of byUrl.entries()) {
      try {
        const existing = injectedSaves.get(url);
        if (existing && document.body.contains(existing)) continue;

        const card = _cardFromLink(link);
        if (!card) continue;

        const stray = card.querySelector(".lc-save-row");
        if (stray) {
          // Check by identity: if the chip is still tracked in our registry
          // it's OUR chip for this card — leave it alone. This happens when
          // a Sales Nav card has both a /sales/lead/ anchor (the byUrl key
          // here) and a /in/ anchor; injectInlineSave() stores the chip
          // under the /in/ URL, so it looks like a "stray" but isn't.
          const trackedNode = injectedSaves.get(stray.dataset.lcUrl);
          if (trackedNode === stray) continue;
          // Truly recycled <li>: LinkedIn reused this DOM node for a
          // different person. Remove the old chip before re-injecting.
          injectedSaves.delete(stray.dataset.lcUrl);
          stray.remove();
        }

        const profile = profileFromCard(card, link);
        if (!profile?.linkedin_url) continue;
        injectInlineSave(card, profile);
      } catch (e) {
        console.warn("[LeadCaptura] decorate failed", e?.message);
      }
    }
  }

  globalThis.__lcOverlay = {
    renderProfilePanel,
    renderToolbar,
    decorateSearchCards,
    unmountProfilePanel,
    unmountToolbar,
    flashStatus,
  };
})();
