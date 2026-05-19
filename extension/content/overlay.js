/* The floating overlay panel and per-card "Save" chips on search results.
 * Renders into a top-level element on linkedin.com pages. We do NOT use Shadow
 * DOM because we want to coexist with LinkedIn's modals — the CSS is locked
 * down via an `lc-` prefix and `all: initial`. */
(() => {
  if (globalThis.__lcOverlay) return;
  const Scraper = globalThis.__lcScraper;
  const Api = globalThis.__lcApi;
  const Storage = globalThis.__lcStorage;

  const state = {
    rootEl: null,
    collapsed: false,
    me: null,
  };

  async function ensureMe() {
    if (state.me) return state.me;
    try {
      state.me = await Api.me();
    } catch {
      state.me = null;
    }
    return state.me;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "onclick") node.addEventListener("click", v);
      else if (k.startsWith("data-")) node.setAttribute(k, v);
      else node[k] = v;
    }
    for (const c of children) {
      if (c == null) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  async function mount() {
    if (state.rootEl) return state.rootEl;
    const settings = await Storage.getSettings();
    if (!settings.showOverlay) return null;
    const root = el("div", { id: "lc-root" });
    document.documentElement.appendChild(root);
    state.rootEl = root;
    return root;
  }

  function unmount() {
    if (state.rootEl) {
      state.rootEl.remove();
      state.rootEl = null;
    }
  }

  function setStatus(msg, level = "info") {
    if (!state.rootEl) return;
    const slot = state.rootEl.querySelector(".lc-status-slot");
    if (!slot) return;
    slot.textContent = "";
    slot.appendChild(
      el("div", { class: `lc-status ${level === "ok" ? "lc-ok" : level === "err" ? "lc-err" : level === "warn" ? "lc-warn" : ""}` }, msg)
    );
  }

  async function renderProfilePanel() {
    const root = await mount();
    if (!root) return;
    const scraped = Scraper.scrapeCurrentPage();
    const profile = scraped.profile;
    const me = await ensureMe();
    const connected = !!me;
    const headerHtml = el(
      "div",
      { class: "lc-header", onclick: toggle },
      el("span", { class: "lc-logo" }, "L"),
      el("span", { class: "lc-title" }, "LeadCaptura"),
      el("span", { class: "lc-spacer" }),
      el("span", { class: "lc-pill" }, connected ? me.workspace?.name || "Workspace" : "Not connected")
    );

    const body = el(
      "div",
      { class: "lc-body" },
      profile
        ? el(
            "div",
            { class: "lc-row" },
            el(
              "div",
              {},
              el("div", { class: "lc-name" }, profile.full_name || "Unknown"),
              el("div", { class: "lc-sub" }, profile.headline || profile.title || "")
            )
          )
        : el("div", { class: "lc-sub" }, "Open a LinkedIn profile to capture it."),
      el(
        "div",
        { class: "lc-btns" },
        connected && profile
          ? el(
              "button",
              {
                class: "lc-btn lc-btn-primary",
                onclick: () => saveCurrentProfile(profile),
              },
              "Save Lead"
            )
          : null,
        connected && Scraper.pageType().includes("search")
          ? el(
              "button",
              {
                class: "lc-btn lc-btn-secondary",
                onclick: saveAllVisible,
              },
              "Save all on page"
            )
          : null,
        !connected
          ? el(
              "button",
              {
                class: "lc-btn lc-btn-primary",
                onclick: () => chrome.runtime.openOptionsPage(),
              },
              "Connect workspace"
            )
          : null,
        el(
          "button",
          {
            class: "lc-btn lc-btn-ghost",
            onclick: () => chrome.runtime.openOptionsPage(),
          },
          "⚙"
        )
      ),
      el("div", { class: "lc-status-slot" })
    );

    root.textContent = "";
    root.append(headerHtml, body);

    if (!connected) {
      setStatus("Paste your API key in the extension options to start syncing.", "warn");
    } else {
      const counts = state.lastSyncCounts;
      if (counts) {
        setStatus(
          counts.created > 0
            ? `Saved ${counts.created} new lead${counts.created === 1 ? "" : "s"} (${counts.updated} updated).`
            : `Updated ${counts.updated} lead${counts.updated === 1 ? "" : "s"}.`,
          "ok"
        );
      } else {
        setStatus("Ready to capture.");
      }
    }
  }

  function toggle() {
    if (!state.rootEl) return;
    state.collapsed = !state.collapsed;
    state.rootEl.classList.toggle("lc-collapsed", state.collapsed);
  }

  async function saveCurrentProfile(profile) {
    setStatus("Saving…");
    try {
      const result = await Api.syncProfile(profile);
      const created = result.created ? 1 : 0;
      state.lastSyncCounts = { created, updated: result.created ? 0 : 1 };
      setStatus(result.created ? "Saved new lead ✓" : "Lead updated ✓", "ok");
    } catch (e) {
      setStatus(`Failed: ${e.message}`, "err");
    }
  }

  async function saveAllVisible() {
    const { profiles } = Scraper.scrapeCurrentPage();
    if (!profiles?.length) {
      setStatus("No profiles found on this page.", "warn");
      return;
    }
    setStatus(`Saving ${profiles.length}…`);
    try {
      const res = await Api.syncSearch({
        page_url: location.href,
        captured_at: new Date().toISOString(),
        profiles,
      });
      state.lastSyncCounts = { created: res.created, updated: res.updated };
      setStatus(`+${res.created} new, ${res.updated} updated`, "ok");
      decorateSearchCards();
    } catch (e) {
      setStatus(`Failed: ${e.message}`, "err");
    }
  }

  /* Per-card chips on search-style pages. */

  function decorateSearchCards() {
    const type = Scraper.pageType();
    if (!type.includes("search")) return;
    const cards = document.querySelectorAll(
      "li.reusable-search__result-container, li.search-result__occluded-item, ul.reusable-search__entity-result-list > li, li.artdeco-list__item"
    );
    cards.forEach((card) => {
      if (card.querySelector(".lc-card-chip")) return;
      const linkEl = card.querySelector("a[href*='/in/'], a[href*='/sales/lead/']");
      if (!linkEl) return;
      const rect = card.getBoundingClientRect();
      if (rect.width < 100) return; // probably not a real card
      const computed = getComputedStyle(card);
      if (computed.position === "static") card.style.position = "relative";
      const chip = document.createElement("button");
      chip.className = "lc-card-chip";
      chip.textContent = "Save";
      chip.dataset.state = "ready";
      chip.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.textContent = "Saving…";
        const url = linkEl.href;
        const profile = {
          linkedin_url: globalThis.__lcDom.normalizeProfileUrl(url),
          full_name: card.querySelector("[aria-hidden='true']")?.textContent?.trim() || null,
          headline: card.querySelector(".entity-result__primary-subtitle, [data-anonymize='title']")?.textContent?.trim() || null,
          location: card.querySelector(".entity-result__secondary-subtitle, [data-anonymize='location']")?.textContent?.trim() || null,
          raw: { source_url: location.href, page_type: "card-chip" },
        };
        try {
          await Api.syncProfile(profile);
          chip.textContent = "Saved";
          chip.dataset.state = "saved";
        } catch (err) {
          chip.textContent = "Error";
          chip.dataset.state = "error";
          console.warn("[LeadCaptura] save failed", err);
        }
      });
      card.appendChild(chip);
    });
  }

  globalThis.__lcOverlay = {
    mount,
    unmount,
    renderProfilePanel,
    decorateSearchCards,
    setStatus,
  };
})();
