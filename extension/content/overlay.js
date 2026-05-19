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

  async function saveCurrentProfile(profile) {
    flashStatus("Reading contact info…");
    let enriched = profile;
    try {
      // On /in/ pages we open the Contact info modal and read email/phone the
      // same way a human would — opens the visible modal, scrapes, closes.
      if (location.pathname.startsWith("/in/") && Scraper.scrapeProfileWithContact) {
        enriched = await Scraper.scrapeProfileWithContact();
      }
    } catch {
      enriched = profile;
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

  /* We inject the Save button as a floating chip in the top-right of each
   * search-result card. Earlier we tried to drop it inside LinkedIn's own
   * action row next to Connect/Message, but that overlaps the native
   * buttons because their parent isn't a flex container that grows. The
   * floating chip is positioned `absolute` against the card itself, so it
   * never collides regardless of LinkedIn's CSS churn. */

  function injectInlineSave(card, profile) {
    if (card.querySelector(".lc-inline-save")) return;

    const btn = el(
      "button",
      {
        class: "lc-inline-save lc-inline-save-floating",
        type: "button",
        title: "Save to LeadCaptura",
      },
      el("span", { class: "lc-inline-save-text" }, "Save")
    );
    btn.dataset.state = "ready";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.dataset.state = "saving";
      btn.querySelector(".lc-inline-save-text").textContent = "Saving…";
      try {
        const result = await Api.syncProfile(profile);
        btn.dataset.state = "saved";
        btn.querySelector(".lc-inline-save-text").textContent = "Saved";
        if (result.lead?.id) {
          state.lastSavedLeadIds = [result.lead.id];
          maybeAutoEnroll();
        }
        // Kick off Contact-info enrichment in a background tab. The new tab's
        // content script will scrape email + phone from the modal and push an
        // update (deduped by linkedin_url), then close itself.
        const settings = await Storage.getSettings();
        if (settings.autoEnrichOnSave !== false && profile.linkedin_url) {
          try {
            chrome.runtime.sendMessage({
              type: "lc:enrichProfile",
              url: profile.linkedin_url,
            });
            btn.querySelector(".lc-inline-save-text").textContent = "Saved · enriching…";
          } catch (enrichErr) {
            console.warn("[LeadCaptura] enrichment dispatch failed", enrichErr);
          }
        }
      } catch (err) {
        btn.dataset.state = "error";
        btn.querySelector(".lc-inline-save-text").textContent = "Retry";
        console.warn("[LeadCaptura] save failed", err);
      }
    });

    // Always float in the top-right of the card so we never collide with
    // LinkedIn's native Connect/Message/Follow buttons.
    const computed = getComputedStyle(card);
    if (computed.position === "static") card.style.position = "relative";
    card.appendChild(btn);
  }

  function _cardFromLink(link) {
    let node = link.parentElement;
    for (let i = 0; i < 10 && node; i++) {
      if (
        node.tagName === "LI" ||
        node.tagName === "ARTICLE" ||
        (node.querySelector("img") &&
          node.querySelector("button[aria-label*='Message' i], button[aria-label*='Connect' i], button[aria-label*='Follow' i]"))
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return link.parentElement;
  }

  function profileFromCard(card, link) {
    const linkEl = link || card.querySelector("a[href*='/in/'], a[href*='/sales/lead/']");
    if (!linkEl) return null;
    const nameNode =
      linkEl.querySelector("span[aria-hidden='true']") ||
      card.querySelector("[data-anonymize='person-name']");
    const name = (nameNode?.textContent || linkEl.textContent || "").trim();
    if (!name || /linkedin member/i.test(name)) return null;
    // Headline is typically the first descriptive text region in the card
    // that isn't the name itself or an action label.
    const textCandidates = Array.from(card.querySelectorAll("div, p, span"))
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter(
        (t) =>
          t !== name &&
          !/connect|message|follow|view profile|premium/i.test(t) &&
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
    const avatar = card.querySelector("img")?.getAttribute("src") || null;
    const [first_name, ...rest] = name.split(/\s+/);
    return {
      linkedin_url: globalThis.__lcDom.normalizeProfileUrl(linkEl.href),
      full_name: name,
      first_name,
      last_name: rest.join(" ") || null,
      headline,
      title: (headline || "").split(/\s+at\s+/i)[0] || null,
      company_name: (headline || "").split(/\s+at\s+/i)[1] || null,
      location: location_,
      avatar_url: avatar,
      raw: { source_url: location.href, page_type: "card-inline" },
    };
  }

  function decorateSearchCards() {
    const type = Scraper.pageType();
    if (!type.includes("search") && !type.includes("sales")) return;
    // Find unique profile cards by iterating /in/ (and /sales/lead/) anchors.
    // The same approach as the scraper, kept in sync.
    const links = document.querySelectorAll(
      "a[href*='/in/'], a[href*='/sales/lead/']"
    );
    const seenCards = new Set();
    links.forEach((link) => {
      const card = _cardFromLink(link);
      if (!card || seenCards.has(card)) return;
      seenCards.add(card);
      const url = globalThis.__lcDom.normalizeProfileUrl(link.href);
      // Track decoration by the URL of the link inside the card. LinkedIn
      // recycles <li> elements on pagination / virtual scroll, so flagging
      // by element alone misses cards that got re-populated with a different
      // profile. If the stored URL no longer matches, blow away the old
      // Save button so we can re-inject for the new profile.
      if (card.dataset.lcUrl && card.dataset.lcUrl !== url) {
        card.querySelector(".lc-inline-save")?.remove();
        delete card.dataset.lcUrl;
      }
      if (card.dataset.lcUrl === url) return;
      const profile = profileFromCard(card, link);
      if (!profile?.linkedin_url) return;
      injectInlineSave(card, profile);
      card.dataset.lcUrl = url;
    });
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
