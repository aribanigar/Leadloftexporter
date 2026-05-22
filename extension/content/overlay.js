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
      state.connectError = null;
    } catch (e) {
      console.error("[LeadCaptura] ensureOptions failed", e?.message);
      state.options = null;
      state.connectError = e?.message || String(e);
    }
    return state.options;
  }

  function flashStatus(msg, level = "info") {
    // Always log so users can grab the message from DevTools even if the
    // panel auto-clears the visible status.
    if (level === "err") console.error("[LeadCaptura]", msg);
    else if (level === "warn") console.warn("[LeadCaptura]", msg);
    else console.log("[LeadCaptura]", msg);

    const root = state.toolbar || state.profilePanel;
    if (!root) return;
    const slot = root.querySelector(".lc-status-slot");
    if (!slot) return;
    slot.textContent = "";
    slot.appendChild(el("span", { class: `lc-status lc-${level}` }, msg));
    clearTimeout(state.statusTimer);
    // Errors stay visible — they need user attention. Other statuses
    // auto-clear after 5s so the panel doesn't stay cluttered.
    if (level !== "err") {
      state.statusTimer = setTimeout(() => {
        if (slot.firstChild) slot.removeChild(slot.firstChild);
      }, 5000);
    }
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
        // Persistent banner when the workspace connection is broken. This is
        // the most common silent-failure cause: user wiped/rotated their
        // API key in Settings → API Keys but didn't paste the new one into
        // the extension Options. /extension/options call 401s, options is
        // null, Save Lead does nothing, the user has no idea why.
        !connected && state.connectError
          ? el(
              "div",
              { class: "lc-status lc-err", style: "margin:6px 0;padding:6px 8px;border-radius:6px" },
              `Not connected: ${state.connectError}`
            )
          : null,
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
  // Delegate to scraper.js's robust _findContactModal + _scrapeFromContactModal,
  // which together handle:
  //   - div[role='dialog'] popups (the modal opened on a /in/ page)
  //   - /in/<handle>/overlay/contact-info/ pages where the modal IS the
  //     page content (no role='dialog' element at all)
  //   - aria-label / aria-labelledby fingerprints
  //   - <h2>Contact info</h2> DOM-walk fallback for layouts where neither
  //     aria nor role attributes are set
  //
  // Previously this function only checked div[role='dialog'] and missed
  // modal variants — most recently visible in Syed Ali Naveed's screenshot
  // where the Contact info popup was visibly open but our harvester
  // returned empty.
  function _harvestVisibleContact() {
    const empty = { email: null, phone: null, website: null, address: null };
    try {
      const readModal = Scraper?._scrapeFromContactModal;
      if (!readModal) return empty;

      // Primary path: scraper's modal finder (uses CSS-based visibility check).
      let modal = Scraper?._findContactModal?.();

      // Fallback: the user explicitly clicked Save while the Contact info modal
      // was open, so we trust it's present. Scan the modal outlet and body for
      // any dialog that contains "Contact info" text or mailto:/tel: links,
      // without a visibility gate that might miss custom elements.
      if (!modal) {
        const candidates = document.querySelectorAll(
          "#artdeco-modal-outlet div[role='dialog']," +
          "div[role='dialog']," +
          "div.artdeco-modal__content," +
          "artdeco-modal"
        );
        for (const d of candidates) {
          const html = d.innerHTML || "";
          const text = (d.innerText || d.textContent || "").slice(0, 800);
          if (
            /contact info/i.test(text) ||
            /href=["']mailto:/i.test(html) ||
            /href=["']tel:/i.test(html)
          ) {
            modal = d;
            break;
          }
        }
      }

      if (!modal) {
        console.log("[LeadCaptura] _harvestVisibleContact: no open Contact info modal detected");
        return empty;
      }

      const result = readModal(modal) || empty;
      console.log("[LeadCaptura] _harvestVisibleContact scraped:", {
        email: result.email,
        phone: result.phone,
        address: result.address,
        website: result.website,
      });
      return result;
    } catch (e) {
      console.warn("[LeadCaptura] _harvestVisibleContact threw", e);
      return empty;
    }
  }

  async function saveCurrentProfile(profile) {
    flashStatus("Reading profile…");
    const enriched = { ...profile };

    // Step 1: refresh base profile fields (name, title, company, location,
    // avatar) from the current DOM. Pure read, no clicks, no side effects.
    try {
      if (location.pathname.startsWith("/in/") && Scraper.scrapeProfile) {
        const fresh = Scraper.scrapeProfile();
        if (fresh) {
          for (const k of [
            "linkedin_url", "full_name", "first_name", "last_name",
            "headline", "title", "company_name", "location", "avatar_url",
          ]) {
            if (fresh[k] && !enriched[k]) enriched[k] = fresh[k];
          }
        }
      }
    } catch {}

    // Snapshot the canonical identity captured BEFORE any modal interaction.
    // The pushState fallback re-enabled below temporarily navigates the URL
    // bar to /overlay/contact-info/ to force the modal to render. Without
    // these snapshots a subsequent re-scrape would read:
    //   - h1 = "LinkedIn"           (page-chrome on overlay route)
    //   - location.href = /in/<handle>/overlay/contact-info/
    // and persist BOTH as the lead's name and linkedin_url. We commit
    // these snapshots back into `enriched` right before the save so the
    // backend always receives the canonical /in/<handle>/ identity.
    const snapshot = {
      originalHref: location.href,
      linkedin_url: enriched.linkedin_url,
      full_name: enriched.full_name,
      first_name: enriched.first_name,
      last_name: enriched.last_name,
    };

    // Step 2: read any Contact info modal the user has already opened.
    // If they did, we use that data immediately — no need to re-open.
    const visible = _harvestVisibleContact();
    if (visible.email && !enriched.email) enriched.email = visible.email;
    if (visible.phone && !enriched.phone) enriched.phone = visible.phone;
    if (visible.website && !enriched.company_url) enriched.company_url = visible.website;
    if (visible.address) enriched.location = visible.address.slice(0, 200);
    console.log("[LeadCaptura] visible-modal harvest:", {
      url: location.href,
      found: !!(visible.email || visible.phone || visible.address || visible.website),
      email: visible.email,
      phone: visible.phone,
      address: visible.address,
      website: visible.website,
    });

    // Step 3: AUTO-OPEN the Contact info modal if we still don't have email
    // or phone and we're on a /in/ profile page.
    //
    // This restores the v1.0.12 behaviour where the pushState fallback
    // navigates the SPA router to /overlay/contact-info/ when the visible
    // "Contact info" anchor isn't clickable (React handler missing, link
    // not yet hydrated, etc.) — that's what makes enrichment RELIABLE.
    // Disabling it in v1.0.15 was the regression. URL-corruption
    // safeguards are: (1) the snapshot above pins name/URL to canonical,
    // (2) Step 6 below history.replaceState-restores the URL bar.
    const needsContact =
      (!enriched.email || !enriched.phone) &&
      location.pathname.startsWith("/in/") &&
      Scraper.scrapeContactInfo;
    if (needsContact) {
      flashStatus("Opening Contact info…");
      try {
        const contact = await Scraper.scrapeContactInfo({
          timeoutMs: 9000,
          settleMs: 1800,
          allowPushStateFallback: true,
        });
        console.log("[LeadCaptura] auto-opened modal scraped:", contact);
        if (contact.email && !enriched.email) enriched.email = contact.email;
        if (contact.phone && !enriched.phone) enriched.phone = contact.phone;
        if (contact.website && !enriched.company_url) enriched.company_url = contact.website;
        if (contact.address && (!enriched.location || enriched.location.length < 4)) {
          enriched.location = contact.address.slice(0, 200);
        }
      } catch (e) {
        console.warn("[LeadCaptura] auto-open Contact info failed", e?.message || e);
      }
    }

    // Step 4: fast text-scan on the visible page (no network, no clicks).
    // Catches "Reach me at john[at]acme[dot]com" patterns in About /
    // Experience / Featured. Only safe when we're physically on the
    // person's /in/ profile.
    if (
      (!enriched.email || !enriched.phone) &&
      location.pathname.startsWith("/in/") &&
      Scraper._scrapeFromProfileText
    ) {
      try {
        const fromText = Scraper._scrapeFromProfileText();
        if (!enriched.email && fromText.email) enriched.email = fromText.email;
        if (!enriched.phone && fromText.phone) enriched.phone = fromText.phone;
      } catch {}
    }

    // Step 5: COMMIT THE SNAPSHOT — overwrite any name/URL that the pushState
    // fallback above may have polluted with the canonical values captured
    // before navigation. Email/phone/website/location/etc. are kept as-is
    // (those were the WHOLE POINT of the modal-open detour).
    if (snapshot.linkedin_url) enriched.linkedin_url = snapshot.linkedin_url;
    if (snapshot.full_name) enriched.full_name = snapshot.full_name;
    if (snapshot.first_name) enriched.first_name = snapshot.first_name;
    if (snapshot.last_name) enriched.last_name = snapshot.last_name;

    // Step 6: SAFETY URL RESTORE. If _closeContactModal() in scrapeContactInfo
    // clicked the dismiss button, LinkedIn's router will navigate back on its
    // own. This replaceState is a fallback for cases where the dismiss click
    // didn't fire (modal already gone, etc.). We intentionally do NOT dispatch
    // a synthetic popstate — that was causing LinkedIn's router to double-
    // navigate and show the "Error - We could not process this request" page.
    try {
      if (
        location.href !== snapshot.originalHref &&
        location.pathname.includes("/overlay/contact-info")
      ) {
        history.replaceState({}, "", snapshot.originalHref);
      }
    } catch (e) {
      console.warn("[LeadCaptura] URL restore failed", e?.message || e);
    }

    // Step 7: SAVE with everything we have. Email/phone are already in
    // `enriched` from the auto-opened modal above — the saved row appears
    // in the pipeline already populated, no second-pass re-save needed.
    flashStatus("Saving…");
    let result;
    try {
      result = await Api.syncProfile(enriched);
      const fields = [
        enriched.email && "email",
        enriched.phone && "phone",
        enriched.location && "location",
      ].filter(Boolean);
      const fieldsLabel = fields.length ? ` (${fields.join(" + ")})` : "";
      flashStatus(
        (result.created ? "Saved new lead ✓" : "Lead updated ✓") + fieldsLabel,
        "ok"
      );
      if (result.lead?.id) state.lastSavedLeadIds = [result.lead.id];
      maybeAutoEnroll();
    } catch (e) {
      flashStatus(`Failed: ${e.message}`, "err");
      return;
    }

    // Step 6: LAST-RESORT background iframe enrichment. Only fires when
    // the foreground modal click in Step 3 yielded nothing — typically a
    // 2nd/3rd-degree profile where LinkedIn hides the Contact info link
    // entirely. The iframe loads /in/<handle>/overlay/contact-info/
    // directly which sometimes renders fields even without the link.
    const url = enriched.linkedin_url || profile.linkedin_url;
    const stillNeeds =
      !enriched.email || !enriched.phone || !enriched.location;
    if (url && url.includes("/in/") && stillNeeds && Scraper.scrapeContactInfoViaIframe) {
      try {
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
        if (!allowed) return;
        const fromIframe = await Scraper.scrapeContactInfoViaIframe(url);
        const merged = { ...enriched };
        let added = [];
        if (fromIframe.email && !merged.email) { merged.email = fromIframe.email; added.push("email"); }
        if (fromIframe.phone && !merged.phone) { merged.phone = fromIframe.phone; added.push("phone"); }
        if (fromIframe.website && !merged.company_url) { merged.company_url = fromIframe.website; added.push("site"); }
        if (fromIframe.address && (!merged.location || merged.location.length < 4)) {
          merged.location = fromIframe.address.slice(0, 200);
          added.push("address");
        }
        if (!added.length) return;
        merged.raw = { ...(merged.raw || {}), contact_info_scraped: true, contact_source: "iframe" };
        try {
          await Api.syncProfile(merged);
          flashStatus(`Enriched ✓ (${added.join(" + ")})`, "ok");
        } catch {
          /* re-save failure is best-effort; the base row is still saved */
        }
      } catch {
        /* enrichment is best-effort */
      }
    }
  }

  // ---------- Auto-save on profile open ----------

  // Tracks paths that have already been auto-saved this page session so
  // SPA back-navigation to the same profile doesn't re-trigger the save.
  const _autoSavedPaths = new Set();

  // Called by main.js after renderProfilePanel() settles.
  // Waits for LinkedIn to hydrate, then runs the full save+enrich flow
  // (name + title + company + location from DOM, email + phone from Contact
  // info modal) without any user interaction.
  async function triggerAutoSave() {
    // Guard: skip background enrichment tabs and overlay sub-routes.
    if (new URLSearchParams(location.search).has("lc_enrich")) return;
    if (location.pathname.includes("/overlay/")) return;

    const path = location.pathname;
    if (_autoSavedPaths.has(path)) return;
    _autoSavedPaths.add(path);

    try {
      const settings = await Storage.getSettings();
      if (settings.autoSaveOnOpen === false) return;

      const opts = await ensureOptions();
      if (!opts) return; // Not connected to workspace

      // Human-paced delay: wait 3–8s for LinkedIn's React to fully hydrate
      // the profile page. 15% chance of a longer 5–14s "reading" pause.
      const base = 3000 + Math.floor(Math.random() * 5000);
      const bonus = Math.random() < 0.15 ? 5000 + Math.floor(Math.random() * 9000) : 0;
      await new Promise((r) => setTimeout(r, base + bonus));

      // Re-scrape after the hydration delay so we get the fully-rendered name,
      // title, company, location, and avatar.
      const profile = Scraper.scrapeProfile?.();
      if (!profile?.linkedin_url) {
        _autoSavedPaths.delete(path); // Not scraped yet — allow retry on next nav
        return;
      }

      // Run the full save+enrich pipeline (same as clicking "Save Lead").
      await saveCurrentProfile(profile);
    } catch (e) {
      _autoSavedPaths.delete(path); // Allow retry if we hit an unexpected error
      console.warn("[LeadCaptura] triggerAutoSave failed:", e?.message);
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

    // Step 1: bulk-save all card data in one shot. Fast (single API call,
    // no LinkedIn fetches) — name/title/company/location go in immediately
    // so the user sees the leads in the pipeline within seconds.
    flashStatus(`Saving ${profiles.length}…`);
    let bulkRes;
    try {
      bulkRes = await Api.syncSearch({
        page_url: location.href,
        captured_at: new Date().toISOString(),
        profiles,
      });
      state.lastSavedLeadIds = bulkRes.lead_ids || [];
    } catch (e) {
      flashStatus(`Failed: ${e.message}`, "err");
      return;
    }
    flashStatus(`Saved ${bulkRes.created} new, ${bulkRes.updated} updated. Enriching…`);
    decorateSearchCards();
    maybeAutoEnroll();

    // Step 2: enrich each /in/ profile via the hidden iframe. We process
    // sequentially with 2-5s human-paced jitter between leads so we don't
    // hammer LinkedIn — same risk class as the per-card single Save. The
    // 20/hour + 100/day SAFE_ZONE rate limit is enforced by the service
    // worker via lc:reserveEnrich; when it returns not-allowed we stop
    // enriching but keep the bulk-saved data.
    const enrichable = profiles.filter(
      (p) => p && p.linkedin_url && p.linkedin_url.includes("/in/")
    );
    if (!enrichable.length) {
      flashStatus(
        `Done: ${bulkRes.created} new, ${bulkRes.updated} updated`,
        "ok"
      );
      return;
    }

    const settings = await Storage.getSettings();
    if (settings.autoEnrichOnSave === false) {
      flashStatus(
        `Done: ${bulkRes.created} new, ${bulkRes.updated} updated (auto-enrich off)`,
        "ok"
      );
      return;
    }

    let enriched = 0;
    let rateLimited = false;
    for (let i = 0; i < enrichable.length; i++) {
      const profile = enrichable[i];
      flashStatus(
        `Enriching ${i + 1} of ${enrichable.length}: ${profile.full_name || ""}…`
      );

      // Reserve a rate-limit slot with the service worker
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
        rateLimited = true;
        break;
      }

      try {
        const contact = await Scraper.scrapeContactInfoViaIframe(
          profile.linkedin_url
        );
        if (
          contact &&
          (contact.email || contact.phone || contact.address || contact.website)
        ) {
          const merged = { ...profile };
          if (contact.email) merged.email = contact.email;
          if (contact.phone) merged.phone = contact.phone;
          if (contact.address)
            merged.location = contact.address.slice(0, 200);
          if (contact.website) merged.company_url = contact.website;
          merged.raw = { ...(merged.raw || {}), contact_info_scraped: true };
          try {
            await Api.syncProfile(merged);
            enriched++;
          } catch {
            /* per-lead save failures shouldn't abort the batch */
          }
        }
      } catch {
        /* enrichment is best-effort */
      }

      // Human-paced delay between enrichments (2–5s, with 15% chance of
      // a 6–12s "distracted user" pause) so we don't open 25 iframes in
      // rapid succession — same UX as a person clicking save on each card.
      if (i < enrichable.length - 1) {
        const base = 2000 + Math.random() * 3000;
        const longTail =
          Math.random() < 0.15 ? 6000 + Math.random() * 6000 : 0;
        await new Promise((r) => setTimeout(r, base + longTail));
      }
    }

    const summary = rateLimited
      ? `Done: ${bulkRes.created} new, ${bulkRes.updated} updated, ${enriched} enriched (daily limit hit)`
      : `Done: ${bulkRes.created} new, ${bulkRes.updated} updated, ${enriched} enriched`;
    flashStatus(summary, rateLimited ? "warn" : "ok");
    decorateSearchCards();
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
      console.log(
        "[LeadCaptura] chip clicked — saving:",
        profile.full_name,
        profile.linkedin_url
      );
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
        if (contact.email || contact.phone || contact.website || contact.address) {
          const enriched = { ...profile };
          if (contact.email) enriched.email = contact.email;
          if (contact.phone) enriched.phone = contact.phone;
          if (contact.website) enriched.company_url = contact.website;
          if (contact.address) enriched.location = contact.address.slice(0, 200);
          enriched.raw = {
            ...(enriched.raw || {}),
            contact_info_scraped: true,
          };
          try {
            await Api.syncProfile(enriched);
            const got = [
              contact.email && "email",
              contact.phone && "phone",
              contact.address && "address",
              contact.website && "site",
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
        // Show the decorated error in the chip text AND keep it visible
        // until the user clicks again — never silently fail.
        const msg = err?.message || String(err);
        textSpan.textContent = msg.length > 40 ? "Failed — see console" : `Failed: ${msg}`;
        btn.title = msg;
        console.error("[LeadCaptura] inline save failed", err);
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

  // Mirror of scraper.js _isInsightLink — must stay in lock-step. Both the
  // bulk-save scraper AND the per-card chip injector must reject the same
  // set of links or the two paths disagree and mutual-connection chips
  // start re-appearing on insight rows.
  // Selectors here must be NARROW — anything matching the outer search
  // container would reject every link including main profile links,
  // giving "No profiles found".
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

  // Tiebreaker for card-owner dedup: does this link use LinkedIn's
  // accessible title pattern (<a><span aria-hidden="true">Name</span></a>)?
  // Mutual-strip anchors are plain <a>Name</a> with no such span.
  // When a card's first /in/ link is a mutual anchor but a later one is the
  // title link, we upgrade to the title link even though the URL differs.
  function _hasAccessibleTitle(link) {
    try {
      return !!link.querySelector("span[aria-hidden='true']");
    } catch {
      return false;
    }
  }

  function _cardFromLink(link) {
    // Walk up to the FIRST structural row root. Mutual-connection links
    // are dropped earlier by _isInsightLink (insight-container selectors
    // + text-pattern fallback), so the structural walk here only has to
    // find each profile's own row — no need to climb past nested mutual
    // <li>s.
    //
    //   - Regular People Search:  <li class="reusable-search__result-container">
    //   - Sales Nav search:       <li> or <article>
    //   - Sales Nav saved-list:   <tr> or div[role='row']  (table layout)
    //   - mynetwork:              <li> or [role='listitem']
    //
    // Must stay in lock-step with scraper.js _profileCardFromLink.
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

  // Mirror of scraper.js _cleanPersonName — keep behavior identical.
  // Two-stage strategy: (1) strip a11y / status / badge labels in-place
  // without consuming everything after them (those often appear as LEADING
  // sr-only spans inside the link/h1), (2) truncate at first degree marker.
  function _cleanCardName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, " ").trim();
    const stripLabels = [
      /\bVerified\b/gi,
      /[✓✔☑✅☒✗✘]\s*/g,
      /\bPremium\s*Member\b/gi,
      /\bOpenToWork\b/gi,
      /\bHiring\b/gi,
      /\bInfluencer\b/gi,
      /\bStatus is (online|offline|reachable)\b/gi,
      /\bView\s+\S+(?:’|’)s\s+profile\b/gi,
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

  // Reject text that's clearly an action-button label, not a person's
  // name. Without this, /search/results/people/ cards whose first /in/
  // anchor wraps a "View LinkedIn profile" / "Open in new tab" /
  // "Connect" button text leak the button text into the saved row's
  // full_name field. The user sees rows like "View LinkedIn profile" in
  // the pipeline instead of the actual person's name.
  const _ACTION_LABEL_RE = /^(view\s+\S+\s+profile|view\s+profile|view\s+in\s+sales\s+navigator|save\s+in\s+sales\s+navigator|save\s+lead|save|open|open\s+profile|open\s+in\s+new\s+tab|connect|pending|message|follow|following|invite|invited|withdraw|more|premium)$/i;
  function _isActionLabel(text) {
    if (!text) return true;
    return _ACTION_LABEL_RE.test(text.trim());
  }

  function profileFromCard(card, link) {
    const linkEl = link || card.querySelector("a[href*='/in/'], a[href*='/sales/lead/']");
    if (!linkEl) return null;

    // Build a candidate list of name sources in specific-to-generic order.
    // Reject any candidate that matches _isActionLabel (e.g. "View LinkedIn
    // profile") and move on to the next. This is what protects the
    // pipeline from action-button text leaking into full_name.
    const candidateNodes = [
      linkEl.querySelector("span[aria-hidden='true']"),
      linkEl.querySelector("strong, b"),
      card.querySelector("[data-anonymize='person-name']"),
      card.querySelector("[data-anonymize='name']"),
    ].filter(Boolean);

    let rawName = null;
    for (const node of candidateNodes) {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (_isActionLabel(t)) continue;
      if (/^linkedin member$/i.test(t)) continue;
      rawName = t;
      break;
    }

    if (!rawName) {
      // Link textContent fallback — also screened against action labels
      // and the entire-card-as-link case (long text containing degree
      // badges).
      const txt = (linkEl.textContent || "").replace(/\s+/g, " ").trim();
      if (
        txt &&
        txt.length < 80 &&
        !_isActionLabel(txt) &&
        !/[•·]\s*(1st|2nd|3rd\+?)/i.test(txt)
      ) {
        rawName = txt;
      } else if (txt) {
        const cut = txt.split(/\s*[•·]\s*(1st|2nd|3rd\+?)/i)[0].trim();
        if (cut && !_isActionLabel(cut)) rawName = cut;
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
    // Final guard: if even the cleaned name still matches an action label
    // (couldn't happen given the screening above, but defend anyway),
    // SKIP the card entirely instead of polluting the pipeline.
    if (!name || /linkedin member/i.test(name) || _isActionLabel(name)) return null;
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

    // KEY INVARIANT: one Save chip per CARD, using the FIRST /in/ link
    // inside that card as the canonical profile owner.
    //
    // LinkedIn embeds mutual-connection people's profile links INSIDE the
    // card of the person being viewed (e.g. Mohamad's card contains links
    // to Joann Deeb and Lulwa Al Qadi as "mutual connections"). The old
    // "group all /in/ anchors on the page by URL, inject one chip per
    // URL" approach injected chips for Joann and Lulwa as separate "cards"
    // — saving the wrong person when the user clicked. Now we walk cards
    // and only consider the FIRST /in/ link per card. Mutual-connection
    // links never become canonical because they're never first in DOM
    // order within their containing card.
    const allLinks = Array.from(
      document.querySelectorAll("a[href*='/in/'], a[href*='/sales/lead/']")
    ).filter((link) => !_isInsightLink(link));
    const cardOwner = new Map(); // card element -> { url, link }
    for (const link of allLinks) {
      const url = globalThis.__lcDom.normalizeProfileUrl(link.href);
      if (!url) continue;
      const card = _cardFromLink(link);
      if (!card) continue;
      if (cardOwner.has(card)) {
        const existing = cardOwner.get(card);
        if (existing.url !== url) {
          // Different URL = possible mutual-connection link embedded in this card.
          // Prefer the title link (has aria-hidden span) over a plain anchor
          // so a mutual strip that appears first in DOM order doesn't hijack
          // the card owner when the real title link appears later.
          if (_hasAccessibleTitle(link) && !_hasAccessibleTitle(existing.link)) {
            cardOwner.set(card, { url, link });
          }
          continue;
        }
        // Same URL: upgrade to the anchor with name text (photo anchor is often empty).
        const newHasText = (link.textContent || "").trim().length > 0;
        const oldHasText = (existing.link.textContent || "").trim().length > 0;
        if (newHasText && !oldHasText) {
          cardOwner.set(card, { url, link });
        }
        continue;
      }
      cardOwner.set(card, { url, link });
    }
    // Surface as the same byUrl shape the rest of the function expects.
    const byUrl = new Map();
    for (const [, { url, link }] of cardOwner) {
      byUrl.set(url, link);
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
    triggerAutoSave,
  };
})();
