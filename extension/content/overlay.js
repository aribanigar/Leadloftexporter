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
    bulkActive: false,
    bulkCancel: false,
    // URLs that the user has explicitly ticked for bulk processing. When
    // non-empty, Save All Leads ONLY processes these; when empty, it falls
    // back to every visible /in/ card so the legacy one-click bulk still
    // works for users who don't care about selection.
    selectedUrls: new Set(),
    bulkProgress: null, // { current, total, name } during a bulk run
    // Bulk-connect run state — mirrors the bulk-save flags but drives the
    // native LinkedIn "Connect" button on each selected card instead.
    connectActive: false,
    connectCancel: false,
    connectProgress: null,
    // Auto-apply (LinkedIn Jobs) run state. Jobs are tracked separately from
    // people because the Jobs page is a wholly different surface.
    selectedJobUrls: new Set(),
    applyActive: false,
    applyCancel: false,
    applyProgress: null,
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
    // Re-use the panel only if it's still attached. If a previous reference is
    // detached (SPA churn), fall through and mount a fresh one — otherwise we'd
    // render into an orphan node and the user would see nothing.
    if (state.profilePanel && document.documentElement.contains(state.profilePanel)) {
      return state.profilePanel;
    }
    state.profilePanel = null;
    const settings = await Storage.getSettings();
    if (!settings.showOverlay) return null;
    const root = el("div", { id: "lc-profile-panel", class: "lc-card" });
    document.documentElement.appendChild(root);
    state.profilePanel = root;
    return root;
  }

  function unmountProfilePanel() {
    _stopProfileNameObserver();
    if (state.profilePanel) {
      state.profilePanel.remove();
      state.profilePanel = null;
    }
  }

  // Watches the profile h1 for DOM mutations and re-renders the panel the
  // moment LinkedIn hydrates the correct person's name — so the panel never
  // stays stuck on a stale name from the previous profile visit.
  let _profileNameObserver = null;
  let _profileNameObserverPath = null;
  let _profileNameObserverTimer = null;

  function _stopProfileNameObserver() {
    if (_profileNameObserver) {
      _profileNameObserver.disconnect();
      _profileNameObserver = null;
    }
    if (_profileNameObserverTimer) {
      clearTimeout(_profileNameObserverTimer);
      _profileNameObserverTimer = null;
    }
    _profileNameObserverPath = null;
  }

  function _startProfileNameObserver(expectedPath, knownName) {
    _stopProfileNameObserver();
    _profileNameObserverPath = expectedPath;
    const target = document.querySelector("main") || document.body;
    let debounce = null;
    let lastSeen = knownName || "";

    _profileNameObserver = new MutationObserver(() => {
      if (location.pathname !== _profileNameObserverPath) {
        _stopProfileNameObserver();
        return;
      }
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        try {
          const fresh = Scraper.scrapeProfile?.();
          const freshName = fresh?.full_name || "";
          if (freshName && freshName !== lastSeen) {
            _stopProfileNameObserver();
            renderProfilePanel();
          }
        } catch {}
      }, 120);
    });

    _profileNameObserver.observe(target, { childList: true, subtree: true });
    // Safety cutoff: stop observing after 12s regardless
    _profileNameObserverTimer = setTimeout(_stopProfileNameObserver, 12000);
  }

  async function renderProfilePanel() {
    const root = await mountProfilePanel();
    if (!root) return;
    const opts = await ensureOptions();
    const connected = !!opts;
    const scraped = Scraper.scrapeCurrentPage();
    const profile = scraped.profile;
    // LinkedIn hydrates the profile h1 asynchronously. Start a
    // MutationObserver on the main element so the panel re-renders the
    // instant the correct name appears in the DOM — no fixed retry delays.
    // Keep the timed retry as a belt-and-suspenders fallback for cases
    // where mutations fire before LinkedIn writes the final name.
    if (!profile?.full_name) {
      _startProfileNameObserver(location.pathname, "");
      if (Number(root.dataset.lcRetries || 0) < 4) {
        const n = Number(root.dataset.lcRetries || 0) + 1;
        root.dataset.lcRetries = String(n);
        setTimeout(() => renderProfilePanel(), 1200);
      }
    } else {
      _stopProfileNameObserver();
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
          timeoutMs: 3000,
          settleMs: 400,
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
    //
    // Tag the payload with name_authority="profile_page": this scrape came
    // from the canonical /in/<handle> <h1>, which is unambiguous. If the
    // backend has a stale row with a mutual-connection name from an earlier
    // card-level save, this flag signals it to overwrite without needing
    // the slug-token heuristic to second-guess us.
    enriched.raw = {
      ...(enriched.raw || {}),
      name_authority: "profile_page",
      scraped_from: "h1",
    };
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

      // v1.0.23 aggressive cut: 0.4–1.2s base, 8% chance of 0.8–2.0s
      // long-tail. Target avg per-profile time ≤5s end-to-end.
      const base = 400 + Math.floor(Math.random() * 800);
      const bonus = Math.random() < 0.08 ? 800 + Math.floor(Math.random() * 1200) : 0;
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

  // Every /in/ URL that currently has a LIVE chip on the page. The injected
  // chips are the SINGLE SOURCE OF TRUTH for bulk operations — Select All,
  // Save All and Connect All all read from here, so they can never diverge
  // from what the user actually sees. (The old approach re-ran the scraper
  // independently, which under-counted real-photo cards.)
  // A capture-able profile URL — regular LinkedIn (/in/) OR Sales Navigator
  // (/sales/lead/). Both configurations must flow through Save / Save All /
  // Connect All identically.
  function _isCapUrl(u) {
    return !!u && (u.includes("/in/") || u.includes("/sales/lead/"));
  }

  function _allChipUrls() {
    const urls = [];
    for (const [url, wrap] of injectedSaves.entries()) {
      if (_isCapUrl(url) && wrap && document.body.contains(wrap)) {
        urls.push(url);
      }
    }
    return urls;
  }

  // Human-ish label from an /in/ URL slug, for progress display only. The
  // real name is scraped on the profile page during enrichment.
  function _labelFromUrl(url) {
    try {
      const slug = decodeURIComponent(url.split("/in/")[1] || "")
        .replace(/\/.*$/, "")
        .replace(/-[0-9a-f]{6,}$/i, "");
      if (!slug) return url;
      return slug
        .split("-")
        .filter((p) => p && !/^\d+$/.test(p))
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ");
    } catch {
      return url;
    }
  }

  // Single source of truth for "Select All" / "Clear" toggle. Called by BOTH
  // the top floating pill and the bottom toolbar's Select All button so they
  // stay in lock-step. When called with no selection it ticks every visible
  // /in/ card; when there's any selection it clears the set.
  // True when we're on a LinkedIn Jobs surface (search / collections / view).
  function _isJobsPage() {
    try { return Scraper.pageType() === "jobs"; } catch { return false; }
  }

  // Select-all dispatcher used by the top pill + toolbar button: routes to the
  // jobs selection on Jobs pages, the people selection everywhere else.
  function toggleSelectAllCurrent() {
    if (_isJobsPage()) toggleSelectAllJobs();
    else toggleSelectAll();
  }

  function toggleSelectAll() {
    if (state.selectedUrls.size > 0) {
      state.selectedUrls.clear();
    } else {
      // Make sure every visible card has a chip, THEN select exactly those
      // chips. Using the chips (not a fresh scrape) guarantees Select All
      // matches what the user sees one-for-one.
      try { decorateSearchCards(); } catch {}
      for (const url of _allChipUrls()) state.selectedUrls.add(url);
    }
    // Mirror selection state across all three surfaces: per-card checkboxes,
    // top pill, bottom toolbar counter. Without this, ticking one place would
    // leave the others showing stale state.
    decorateSearchCards();
    for (const wrap of injectedSaves.values()) {
      const url = wrap?.dataset?.lcUrl;
      const check = wrap?.querySelector(".lc-inline-check");
      if (!url || !check) continue;
      const on = state.selectedUrls.has(url);
      check.textContent = on ? "☑" : "☐";
      check.classList.toggle("lc-inline-check-on", on);
    }
    refreshSelectAllHeader();
    renderToolbar();
  }

  // Floating Select-All pill at the top of list pages — gives the user a
  // one-click select-everything affordance without scrolling to the bottom
  // toolbar. Position is fixed top-right so it doesn't fight LinkedIn's
  // hashed-class header layout.
  function mountSelectAllHeader() {
    if (state.bulkActive || state.connectActive || state.applyActive) {
      unmountSelectAllHeader();
      return null;
    }
    let pill = document.getElementById("lc-select-all-top");
    if (pill) {
      refreshSelectAllHeader();
      return pill;
    }
    pill = el("button", {
      id: "lc-select-all-top",
      type: "button",
      title: "Select every visible profile for bulk save",
    });
    pill.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSelectAllCurrent();
    });
    document.documentElement.appendChild(pill);
    refreshSelectAllHeader();
    return pill;
  }

  function unmountSelectAllHeader() {
    const pill = document.getElementById("lc-select-all-top");
    if (pill) pill.remove();
  }

  function refreshSelectAllHeader() {
    const pill = document.getElementById("lc-select-all-top");
    if (!pill) return;
    const n = _isJobsPage() ? state.selectedJobUrls.size : state.selectedUrls.size;
    pill.textContent = n > 0 ? `☑ Clear (${n})` : "☐ Select All";
    pill.classList.toggle("lc-active", n > 0);
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
        // Select-all toggle: when no cards are selected, click ticks every
        // visible card; when ANY are selected, click clears the set. The label
        // flips so the user always sees the action that'll happen next. On Jobs
        // pages it operates on the job selection instead of the people set.
        (state.bulkActive || state.connectActive || state.applyActive)
          ? null
          : el(
              "button",
              {
                class: "lc-btn lc-btn-ghost",
                onclick: toggleSelectAllCurrent,
                title: _isJobsPage()
                  ? "Tick every visible job so Apply All processes them"
                  : "Tick every visible /in/ card so Save All processes them",
              },
              (() => {
                const n = _isJobsPage()
                  ? state.selectedJobUrls.size
                  : state.selectedUrls.size;
                return n > 0 ? `Clear (${n})` : "Select All";
              })()
            ),
        el("span", { class: "lc-flex" }),
        // Realtime bulk progress: shown only during a Save-All run. Always
        // names the profile currently being scraped so the user can verify
        // automation is alive and on-track. The hidden .lc-status-slot child
        // keeps flashStatus() working (e.g. "Stopping after current profile…"
        // when the user clicks Stop mid-run).
        (state.bulkActive && state.bulkProgress) ||
        (state.connectActive && state.connectProgress) ||
        (state.applyActive && state.applyProgress)
          ? el(
              "div",
              { class: "lc-bulk-progress" },
              el("span", { class: "lc-bulk-spinner" }, "⏳"),
              el(
                "span",
                { class: "lc-bulk-progress-text" },
                (() => {
                  const p =
                    state.applyProgress ||
                    state.connectProgress ||
                    state.bulkProgress;
                  const verb = state.applyActive
                    ? "Applying"
                    : state.connectActive
                    ? "Connecting"
                    : "Enriching";
                  return `${verb} ${p.current} of ${p.total}: ${p.name}…`;
                })()
              ),
              el("span", { class: "lc-status-slot lc-status-slot-inline" })
            )
          : el("div", { class: "lc-status-slot" }),
        // Connect Selected — people pages only, hidden during any active run.
        _isJobsPage() || state.bulkActive || state.connectActive || state.applyActive
          ? null
          : el(
              "button",
              {
                class: "lc-btn lc-btn-connect",
                onclick: connectAllVisible,
                title:
                  "Send connection requests to selected (or all visible) profiles. Auto-advances pages, skips already-sent/connected. Human-paced; LinkedIn weekly invite caps still apply.",
              },
              state.selectedUrls.size > 0
                ? `Connect ${state.selectedUrls.size}`
                : "Connect All"
            ),
        // Primary action. During any run → Stop. Otherwise → Apply All on Jobs
        // pages, Save All Leads on people pages.
        state.bulkActive || state.connectActive || state.applyActive
          ? el(
              "button",
              {
                class: "lc-btn lc-btn-stop",
                onclick: () => {
                  if (state.bulkActive) state.bulkCancel = true;
                  if (state.connectActive) state.connectCancel = true;
                  if (state.applyActive) state.applyCancel = true;
                  flashStatus("Stopping after current item…");
                },
              },
              "Stop"
            )
          : _isJobsPage()
          ? el(
              "button",
              {
                class: "lc-btn lc-btn-primary",
                onclick: applyAllJobs,
                title:
                  "Auto-apply to selected (or all visible) Easy Apply jobs. Human-paced; skips external-apply jobs, already-applied jobs, and any that need extra screening answers.",
              },
              state.selectedJobUrls.size > 0
                ? `Apply ${state.selectedJobUrls.size}`
                : `Apply All (${_allJobUrls().length})`
            )
          : el(
              "button",
              { class: "lc-btn lc-btn-primary", onclick: saveAllVisible },
              state.selectedUrls.size > 0
                ? `Save ${state.selectedUrls.size} Selected`
                : "Save All Leads"
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
    // Pick the working set FROM THE INJECTED CHIPS (single source of truth):
    //   - If the user has explicitly ticked checkboxes, process EXACTLY those.
    //   - Else process every visible /in/ card that has a chip.
    // Driving off the chips (not a fresh scrape) guarantees Save All covers
    // every card the user sees — no divergence on real-photo cards.
    try { decorateSearchCards(); } catch {}
    const urls =
      state.selectedUrls.size > 0
        ? Array.from(state.selectedUrls).filter(_isCapUrl)
        : _allChipUrls();
    if (!urls.length) {
      flashStatus("No profiles to save. Scroll the list so cards render.", "warn");
      return;
    }

    // INTENTIONAL: no syncSearch pre-save. Card-level scrapes can pick up
    // mutual-connection names embedded in the same <li> ("Suhaib" instead of
    // "Hady"). We only trust profile-page scrapes for persistence — the
    // background-tab enrichment below saves the canonical name+title+
    // company+email+phone+location pulled from the unambiguous /in/<handle>
    // DOM. We only need the URL here; the profile page yields the real name.
    const enrichable = urls.map((u) => ({
      linkedin_url: u,
      full_name: _labelFromUrl(u),
    }));
    if (!enrichable.length) {
      flashStatus("No /in/ profiles to enrich.", "warn");
      return;
    }

    // SEQUENTIAL background-tab enrichment. For each profile we open
    // /in/<handle>/?lc_enrich=1 in a hidden tab; the content script there
    // runs maybeRunEnrichmentTrigger() which scrapes name+title+company+
    // location from DOM and email+phone+website from the Contact info modal,
    // syncs the canonical row, then self-closes via lc:closeMe. The service
    // worker resolves our message ONLY when the tab actually closes — so the
    // next iteration can't start until the previous profile is fully done.
    state.bulkActive = true;
    state.bulkCancel = false;
    state.bulkProgress = { current: 0, total: enrichable.length, name: "", url: "" };
    // Hide the top Select-All pill during a run — it can't be used while
    // enrichment is in progress and would just clutter the screen.
    unmountSelectAllHeader();
    renderToolbar();
    let enriched = 0;
    let rateLimited = false;
    let cancelled = false;
    for (let i = 0; i < enrichable.length; i++) {
      if (state.bulkCancel) {
        cancelled = true;
        break;
      }
      const profile = enrichable[i];
      const label = profile.full_name || profile.linkedin_url.split("/in/")[1] || "";
      state.bulkProgress = {
        current: i + 1,
        total: enrichable.length,
        name: label,
        url: profile.linkedin_url,
      };
      // Drive the per-card chip into "Enriching…" state so the user sees
      // live progress on the exact card being processed — no more guessing
      // which lead the toolbar status refers to.
      _setChipState(profile.linkedin_url, "saving", "Enriching…");
      renderToolbar();

      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            {
              type: "lc:openProfileTab",
              url: profile.linkedin_url,
              active: false,        // background tab — silent automation
              awaitClose: true,     // resolve only when the tab self-closes
              enrichFlag: true,     // adds ?lc_enrich=1 → triggers enrichment
            },
            (r) => {
              if (chrome.runtime.lastError) {
                return resolve({ ok: false, error: chrome.runtime.lastError.message });
              }
              resolve(r || { ok: false });
            }
          );
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });

      if (!resp.ok && resp.error === "safe_zone_limit_reached") {
        _setChipState(profile.linkedin_url, "error", "Rate limited");
        rateLimited = true;
        break;
      }
      if (resp.ok && !resp.timedOut) {
        _setChipState(profile.linkedin_url, "saved", "Saved ✓");
        enriched++;
      } else {
        _setChipState(profile.linkedin_url, "error", resp.timedOut ? "Timed out" : "Failed");
      }

      // Gap between enrichment tabs. Keeps ≤5s end-to-end target while
      // avoiding perfectly uniform bursts that look scripted.
      if (i < enrichable.length - 1 && !state.bulkCancel) {
        const r = Math.random();
        const base = r < 0.70
          ? 700 + Math.random() * 900     // 0.7-1.6s (70%)
          : r < 0.92
          ? 1800 + Math.random() * 1400   // 1.8-3.2s (22%)
          : 3500 + Math.random() * 1500;  // 3.5-5s   (8%)
        await new Promise((resolve) => setTimeout(resolve, base));
      }
    }
    state.bulkActive = false;
    state.bulkProgress = null;
    // Clear selections so the toolbar resets to "Save All Leads" and the top
    // pill resets to "☐ Select All" — ready for the next batch immediately.
    state.selectedUrls.clear();
    // Bring the top pill back so the user can run another batch immediately.
    mountSelectAllHeader();
    renderToolbar();

    let summary;
    if (cancelled) {
      summary = `Stopped: ${enriched} of ${enrichable.length} enriched`;
    } else if (rateLimited) {
      summary = `Hit daily limit: ${enriched} of ${enrichable.length} enriched`;
    } else {
      summary = `Done: ${enriched} of ${enrichable.length} enriched ✓`;
    }
    flashStatus(summary, rateLimited ? "warn" : "ok");
    decorateSearchCards();
  }

  // ---------- Bulk Connect ----------
  // Sends connection requests by clicking each selected card's OWN native
  // "Connect" button — no new tab, no navigation. Every action happens in the
  // visible foreground tab, honoring the bot-avoidance rule that write actions
  // never run hidden.
  //
  // Bot-avoidance timing: 4-tier gap distribution (4-8.5s / 9-17s / 19-32s /
  // 38-60s) with micro-breaks every 12-16 invites (22-42s). Scroll pattern is
  // incremental (not jump-to-bottom). All distributions are smooth, not bimodal,
  // to avoid statistical fingerprinting.
  //
  // NOTE: LinkedIn caps weekly invites (~100-200). This automates the clicking;
  // it cannot bypass that cap.
  function _findConnectButtonInCard(card) {
    const buttons = Array.from(card.querySelectorAll("button"));
    for (const b of buttons) {
      const aria = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (b.classList.contains("lc-inline-save")) continue;
      if (/pending/i.test(aria) || /pending/i.test(txt)) continue;
      // Match a real Connect button by visible text ("Connect") or aria-label
      // ("Invite <Name> to connect"). Skip Follow / Message / Save.
      if (/^connect$/i.test(txt) || /\binvite\b.*\bto connect\b/i.test(aria) || /^connect$/i.test(aria)) {
        return b;
      }
    }
    return null;
  }

  // Classify a card's connection state from its native buttons so the bulk
  // connector can SKIP people already contacted/connected:
  //   "connect"   → a real Connect button is present → send an invite
  //   "pending"   → request already sent → skip
  //   "connected" → Message but no Connect → already a connection → skip
  //   "follow"    → only Follow available → can't connect → skip
  //   "unknown"   → no recognisable action button
  function _cardConnectState(card) {
    let hasConnect = false, hasPending = false, hasMessage = false, hasFollow = false;
    for (const b of card.querySelectorAll("button")) {
      if (b.classList.contains("lc-inline-save")) continue;
      const aria = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (/^pending$/i.test(txt) || /\bpending\b/i.test(aria)) hasPending = true;
      else if (
        /^connect$/i.test(txt) ||
        /\binvite\b.*\bto connect\b/i.test(aria) ||
        /^connect$/i.test(aria)
      ) hasConnect = true;
      else if (/^message\b/i.test(txt) || /^message\b/i.test(aria)) hasMessage = true;
      else if (/^follow$/i.test(txt) || /^follow$/i.test(aria)) hasFollow = true;
    }
    if (hasConnect) return "connect";
    if (hasPending) return "pending";
    // Sales Navigator EVERY lead shows a Message button and the Connect action
    // lives inside the "…" overflow menu — so "Message present" must NOT be
    // read as already-connected (that was skipping everyone). On Sales Nav we
    // always attempt Connect unless pending; _openOverflowConnect returns null
    // for genuine 1st-degree leads (no Connect item) and they're skipped then.
    let isSalesNav = false;
    try { isSalesNav = Scraper.pageType() === "salesnav-search"; } catch {}
    if (isSalesNav) return "connect";
    if (hasMessage) return "connected";
    if (hasFollow) return "follow";
    return "unknown";
  }

  // Sales Navigator tucks "Connect" inside the "…" overflow menu. Open it and
  // return the Connect item so the normal send flow can click it.
  async function _openOverflowConnect(card) {
    const { dispatchHumanClick } = globalThis.__lcDom;
    const { sleep } = globalThis.__lcHuman;
    const moreBtn = Array.from(card.querySelectorAll("button, [role='button']")).find((b) => {
      if (b.classList?.contains("lc-inline-save")) return false;
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      return (
        /\bmore\b|overflow|more actions|other actions/.test(a) ||
        b.classList?.contains("artdeco-dropdown__trigger")
      );
    });
    if (!moreBtn) return null;
    try { await dispatchHumanClick(moreBtn); } catch { try { moreBtn.click(); } catch {} }
    await sleep(450 + Math.random() * 400);
    // Menu items render in an open dropdown/portal, often outside the card.
    const items = Array.from(
      document.querySelectorAll(
        "div.artdeco-dropdown__content--is-open [role='button'], " +
        "div.artdeco-dropdown__content--is-open button, " +
        "div.artdeco-dropdown__content--is-open li, " +
        "div[role='menu'] [role='menuitem'], div[role='menu'] [role='button'], " +
        "div[role='menu'] button, ul[role='menu'] li, " +
        ".artdeco-dropdown__content button, .artdeco-dropdown__content [role='button']"
      )
    );
    return (
      items.find((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        const a = el.getAttribute("aria-label") || "";
        return /^connect\b/i.test(t) || /\binvite\b.*\bto connect\b/i.test(a) || /^connect$/i.test(a);
      }) || null
    );
  }

  async function _sendConnectOnCard(card) {
    const { dispatchHumanClick, waitFor } = globalThis.__lcDom;
    const { sleep } = globalThis.__lcHuman;
    let btn = _findConnectButtonInCard(card);
    // Sales Nav: Connect lives behind the "…" menu — open it and grab Connect.
    if (!btn) btn = await _openOverflowConnect(card);
    if (!btn) return { ok: false, reason: "no_connect_button" };
    await dispatchHumanClick(btn);
    await sleep(700 + Math.random() * 500);
    // A modal usually appears with "Send without a note" / "Send". When the
    // tab is BACKGROUNDED, LinkedIn can defer rendering the modal, so poll a
    // few times (longer overall) rather than a single short wait.
    const sendSel = [
      "button[aria-label*='Send without a note' i]",
      "button[aria-label='Send now']",
      "button[aria-label*='Send invitation' i]",
      "button[aria-label*='Send' i]",
      "div[role='dialog'] button.artdeco-button--primary",
    ];
    let sendBtn = null;
    for (let attempt = 0; attempt < 4 && !sendBtn; attempt++) {
      sendBtn = await waitFor(sendSel, { timeout: 2500 });
      // Text fallback: Sales Nav's confirm button is "Send Invitation" with no
      // matching aria-label, so the selector list above misses it.
      if (!sendBtn) {
        sendBtn = Array.from(
          document.querySelectorAll(
            "div[role='dialog'] button, .artdeco-modal button, [role='alertdialog'] button"
          )
        ).find((b) => {
          const t = (b.textContent || "").replace(/\s+/g, " ").trim();
          return /^send( invitation| now| without a note)?$/i.test(t);
        }) || null;
      }
      if (!sendBtn) await sleep(600);
    }
    if (sendBtn) {
      await dispatchHumanClick(sendBtn);
      await sleep(600 + Math.random() * 500); // modal dismiss animation
      return { ok: true };
    }
    // No modal — LinkedIn may have sent directly, OR an email-verify wall
    // surfaced. Dismiss any lingering dialog so the next card isn't blocked.
    const dismiss = document.querySelector("button[aria-label='Dismiss']");
    if (dismiss) { try { dismiss.click(); } catch {} }
    return { ok: true, note: "no_modal" };
  }

  function _cardForUrl(url) {
    const wrap = injectedSaves.get(url);
    if (wrap && document.body.contains(wrap)) {
      return wrap.closest("li, article, [role='listitem'], [role='row']") || wrap.parentElement;
    }
    const a = Array.from(document.querySelectorAll("a[href*='/in/']")).find(
      (l) => globalThis.__lcDom.normalizeProfileUrl(l.href) === url
    );
    return a ? _cardFromLink(a) : null;
  }

  // LinkedIn's "Next" pagination button (disabled on the last page).
  function _findNextPageButton() {
    const cands = [
      document.querySelector("button[aria-label='Next']"),
      document.querySelector("button.artdeco-pagination__button--next"),
    ].filter(Boolean);
    for (const b of cands) {
      if (!b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
    }
    const byText = Array.from(document.querySelectorAll("button")).find(
      (b) =>
        /^next\b/i.test((b.textContent || "").replace(/\s+/g, " ").trim()) &&
        !b.disabled &&
        b.getAttribute("aria-disabled") !== "true"
    );
    return byText || null;
  }

  // A signature of the current results page — changes when we paginate.
  function _pageSignature() {
    let pageParam = "";
    try {
      pageParam = new URL(location.href).searchParams.get("page") || "";
    } catch {}
    const active = document.querySelector(
      "li.artdeco-pagination__indicator--number.active button, button[aria-current='true'], .artdeco-pagination__indicator.active"
    );
    const firstLink = document.querySelector("a[href*='/in/'], a[href*='/sales/lead/']");
    return [pageParam, active?.textContent?.trim() || "", firstLink?.href || ""].join("|");
  }

  async function _waitForPageChange(prevSig) {
    const { sleep } = globalThis.__lcHuman;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (state.connectCancel) return false;
      await sleep(500);
      if (_pageSignature() !== prevSig) {
        await sleep(1500); // let the new page settle
        return true;
      }
    }
    return false;
  }

  // Scroll through the page so LinkedIn renders every (lazy) result card,
  // then re-decorate so chips exist for newly rendered cards.
  // Scrolls incrementally (not jump-to-bottom) so the motion pattern matches
  // how a human reads down a list, then scrolls back to the top.
  async function _scrollLoadPage() {
    const { sleep } = globalThis.__lcHuman;
    const viewH = window.innerHeight;
    let pos = window.scrollY;
    let prevCount = -1;
    let stableRounds = 0;
    // Phase 1: scroll down in variable-size steps
    for (let i = 0; i < 16 && !state.connectCancel; i++) {
      const pageH = document.body.scrollHeight;
      // 22-38% of viewport per step — mimics reading speed variation
      const stepPx = Math.round(viewH * (0.22 + Math.random() * 0.16));
      pos = Math.min(pageH - 40, pos + stepPx);
      window.scrollTo(0, pos);
      await sleep(260 + Math.random() * 420); // 260-680ms between steps
      const count = document.querySelectorAll("a[href*='/in/'], a[href*='/sales/lead/']").length;
      if (count === prevCount) {
        stableRounds++;
        if (stableRounds >= 2 && pos >= pageH * 0.88) break;
      } else {
        stableRounds = 0;
      }
      prevCount = count;
      if (pos >= document.body.scrollHeight * 0.96) break;
    }
    // Brief pause at the bottom (like finishing reading the page)
    await sleep(420 + Math.random() * 480);
    // Phase 2: scroll back up in steps — faster but not instant
    while (pos > 80 && !state.connectCancel) {
      pos = Math.max(0, pos - Math.round(viewH * (0.38 + Math.random() * 0.22)));
      window.scrollTo(0, pos);
      await sleep(50 + Math.random() * 80);
    }
    window.scrollTo(0, 0);
    await sleep(320 + Math.random() * 320);
    try { decorateSearchCards(); } catch {}
  }

  // Bulk connect, AUTO-ADVANCING across result pages. After every card on a
  // page is invited it clicks "Next", waits for the new page, and continues —
  // until the last page, the safety cap, or the user clicks Stop.
  //
  // SAFETY CAP: LinkedIn restricts accounts that exceed ~100-200 invites/week.
  // We hard-stop a single run at MAX_INVITES_PER_RUN so the auto-advance can't
  // silently blow past the weekly budget across 100 pages.
  async function connectAllVisible() {
    const { sleep } = globalThis.__lcHuman;
    const MAX_INVITES_PER_RUN = 100;

    // Page 1 honours an explicit selection (if any). Later pages process every
    // visible card — the page-1 ticks don't apply to other pages.
    const page1Selection =
      state.selectedUrls.size > 0 ? new Set(state.selectedUrls) : null;

    state.connectActive = true;
    state.connectCancel = false;
    state.connectProgress = { current: 0, total: MAX_INVITES_PER_RUN, name: "" };
    unmountSelectAllHeader();
    renderToolbar();

    let sent = 0;
    let skipped = 0;
    let alreadyDone = 0; // already invited / already connected — skipped
    let pageNum = 1;
    let cancelled = false;
    let hitCap = false;
    // Periodic micro-break counter: every 12-16 actual invites, insert a
    // longer pause (22-42s) to break any detectable rhythmic pattern.
    let invitesSinceBreak = 0;
    let nextBreakAt = 12 + Math.floor(Math.random() * 5);

    while (!state.connectCancel) {
      // Render all cards on this page, then read them.
      await _scrollLoadPage();
      if (state.connectCancel) { cancelled = true; break; }

      // Targets from the CHIPS (single source of truth). Page 1 honours the
      // user's tick selection; later pages take every chip on the page.
      let urls =
        pageNum === 1 && page1Selection
          ? Array.from(page1Selection).filter(_isCapUrl)
          : _allChipUrls();

      for (let i = 0; i < urls.length; i++) {
        if (state.connectCancel) { cancelled = true; break; }
        if (sent >= MAX_INVITES_PER_RUN) { hitCap = true; break; }
        const url = urls[i];
        state.connectProgress = {
          current: sent + 1,
          total: MAX_INVITES_PER_RUN,
          name: `p${pageNum}: ${_labelFromUrl(url)}`,
        };
        _setChipState(url, "saving", "Connecting…");
        renderToolbar();

        const card = _cardForUrl(url);
        if (!card) { skipped++; continue; }

        // SKIP people we've already contacted or are already connected to —
        // don't waste the daily invite quota. The native button state is the
        // source of truth: Pending = request already sent, Message-without-
        // Connect = already a connection, Follow-only = can't connect.
        const cstate = _cardConnectState(card);
        if (cstate === "pending") {
          alreadyDone++;
          _setChipState(url, "saved", "Already sent ✓");
          continue;
        }
        if (cstate === "connected") {
          alreadyDone++;
          _setChipState(url, "saved", "Connected ✓");
          continue;
        }
        if (cstate !== "connect") {
          skipped++;
          _setChipState(url, "error", cstate === "follow" ? "Follow only" : "No Connect");
          continue;
        }

        // Instant (not "smooth") — smooth scroll relies on the rendering
        // pipeline which Chrome pauses in a backgrounded tab; instant keeps
        // the run working when the user switches to another tab.
        try { card.scrollIntoView({ block: "center" }); } catch {}
        // Variable reading pause: glance at the card before clicking.
        // 15% chance of a longer "reconsidering" pause (reads the headline).
        const readMs = 600 + Math.random() * 800;
        const readBonus = Math.random() < 0.15 ? 900 + Math.random() * 1100 : 0;
        await sleep(readMs + readBonus);

        let res;
        try {
          res = await _sendConnectOnCard(card);
        } catch (e) {
          res = { ok: false, reason: String(e) };
        }
        if (res.ok) {
          sent++;
          invitesSinceBreak++;
          _setChipState(url, "saved", "Invited ✓");
        } else {
          skipped++;
          _setChipState(url, "error", "No Connect");
        }

        // Pace only after an ACTUAL invite — skipped/already-done cards cost
        // no quota, so don't burn the human-pacing delay on them.
        if (res.ok && i < urls.length - 1 && !state.connectCancel && sent < MAX_INVITES_PER_RUN) {
          let gap;
          // Micro-break: every 12-16 invites take a genuine longer pause.
          // Breaks any statistical fingerprint across a session.
          if (invitesSinceBreak >= nextBreakAt) {
            invitesSinceBreak = 0;
            nextBreakAt = 12 + Math.floor(Math.random() * 5);
            gap = 22000 + Math.random() * 20000; // 22-42s break
            flashStatus(`Short break… (${sent} invites sent)`);
          } else {
            // 4-tier smooth distribution — avoids the detectable bimodal pattern
            // of a fixed base + occasional long-tail that ML can fingerprint.
            const r = Math.random();
            if (r < 0.60) {
              gap = 4000 + Math.random() * 4500;    // 4-8.5s  (60%)
            } else if (r < 0.82) {
              gap = 9000 + Math.random() * 8000;    // 9-17s   (22%)
            } else if (r < 0.93) {
              gap = 19000 + Math.random() * 13000;  // 19-32s  (11%)
            } else {
              gap = 38000 + Math.random() * 22000;  // 38-60s  (7%)
            }
          }
          await sleep(gap);
        }
      }

      if (state.connectCancel) { cancelled = true; break; }
      if (hitCap) break;

      // Advance to the next page.
      const nextBtn = _findNextPageButton();
      if (!nextBtn) break; // last page reached
      flashStatus(`Page ${pageNum} done — ${sent} sent. Moving to next page…`);
      const sig = _pageSignature();
      // Inter-page pause: variable base + occasional "deciding if it's worth
      // continuing" hesitation. Breaks the always-same-gap-between-pages pattern.
      const pageGapBase = 8000 + Math.random() * 12000; // 8-20s
      const pageGapBonus = Math.random() < 0.25 ? 12000 + Math.random() * 18000 : 0; // 25% → +12-30s
      await sleep(pageGapBase + pageGapBonus);
      if (state.connectCancel) { cancelled = true; break; }
      try { nextBtn.scrollIntoView({ block: "center" }); } catch {}
      await sleep(600);
      try {
        await globalThis.__lcDom.dispatchHumanClick(nextBtn);
      } catch {
        try { nextBtn.click(); } catch {}
      }
      const changed = await _waitForPageChange(sig);
      if (!changed) break; // page didn't advance — stop cleanly
      pageNum++;
    }

    state.connectActive = false;
    state.connectProgress = null;
    state.selectedUrls.clear();
    mountSelectAllHeader();
    renderToolbar();

    const extra = [
      alreadyDone ? `${alreadyDone} already contacted` : "",
      skipped ? `${skipped} skipped` : "",
    ].filter(Boolean).join(", ");
    const tail = extra ? ` (${extra})` : "";
    let msg;
    if (cancelled) {
      msg = `Stopped: ${sent} invites sent across ${pageNum} page(s)${tail}`;
    } else if (hitCap) {
      msg = `Reached ${MAX_INVITES_PER_RUN}-invite cap: ${sent} sent${tail}. Run again later.`;
    } else {
      msg = `Done: ${sent} invites sent across ${pageNum} page(s)${tail} ✓`;
    }
    flashStatus(msg, hitCap ? "warn" : "ok");
  }

  // ====================================================================
  // LinkedIn Jobs — auto Easy-Apply
  // --------------------------------------------------------------------
  // Self-contained subsystem. Mirrors the people-search UX (per-card tick +
  // Select All + a bulk action) but drives LinkedIn's native Easy Apply modal:
  //   1. open a job's detail pane
  //   2. click "Easy Apply"
  //   3. step through the modal (Contact info → Next, pick the uploaded resume
  //      → Next, … → Review → Submit application)
  //   4. close the confirmation
  //
  // SAFETY: never submits an incomplete application. If a step has screening
  // questions we can't fill (the modal won't advance), we discard that job and
  // move on. External-apply jobs (company website) and already-applied jobs are
  // skipped. Human-paced throughout; a per-run cap protects the account.
  // ====================================================================

  const injectedJobChips = new Map();   // cardKey -> wrap element
  const _jobChipCards = new Map();      // cardKey -> source card element
  const _jobChipApplyUrls = new Map();  // cardKey -> apply url (or null = click card)

  // Portal root — chips appended here as position:fixed, bypassing LinkedIn's
  // overflow:hidden scroll containers. Mounted on <html> (not <body>) with an
  // explicit max z-index so it layers ABOVE LinkedIn's positioned content —
  // the same pattern the visible toolbar + Select-All pill already use. A
  // position:fixed element creates its own stacking context, so WITHOUT a high
  // z-index the chips get trapped at body level and painted under the page.
  let _portalRoot = null;
  function _ensurePortalRoot() {
    if (_portalRoot && document.documentElement.contains(_portalRoot)) return _portalRoot;
    _portalRoot = document.createElement("div");
    _portalRoot.id = "lc-job-portal";
    _portalRoot.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483640;pointer-events:none;";
    document.documentElement.appendChild(_portalRoot);
    return _portalRoot;
  }

  // RAF-throttled position sync — recalculates each chip's fixed coords from
  // its source card's getBoundingClientRect(). Fires on scroll + resize.
  let _jobChipSyncRaf = null;
  function _syncJobChipPositions() {
    _jobChipSyncRaf = null;
    // While a LinkedIn modal is open (Easy Apply, share, etc.) hide EVERY chip.
    // Chips are position:fixed with a near-max z-index, so otherwise they bleed
    // over the modal's form fields and look like stray "Auto Apply" buttons.
    const modalOpen = !!document.querySelector(
      "div.jobs-easy-apply-modal, div[data-test-modal][role='dialog'], " +
      "div[role='dialog'], [role='alertdialog'], .artdeco-modal[role='dialog']"
    );
    for (const [url, wrap] of injectedJobChips.entries()) {
      if (modalOpen) {
        if (wrap) wrap.style.setProperty("visibility", "hidden", "important");
        continue;
      }
      const card = _jobChipCards.get(url);
      if (!wrap || !card || !document.body.contains(card)) {
        if (wrap) wrap.style.setProperty("visibility", "hidden", "important");
        continue;
      }
      // Anchor to the always-visible Dismiss "X". The card box returned by
      // _cardFromDismiss can be a zero-size wrapper on the search-results
      // layout, which (with the old width<2 guard) hid EVERY chip. The X is a
      // real, painted button with a stable rect, so we anchor to it and place
      // the chip just to its left — i.e. the card's top-right, like screen 1.
      const dismiss = card.querySelector("button[aria-label*='Dismiss' i]");
      const anchor = dismiss || card;
      const r = anchor.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight || (r.width < 2 && r.height < 2)) {
        wrap.style.setProperty("visibility", "hidden", "important");
        continue;
      }
      const chipW = wrap.getBoundingClientRect().width || 150;
      const top = Math.max(4, r.top + 1);
      // If anchored on the X, sit to its left; if on the card box, bottom-right.
      const left = dismiss
        ? Math.max(4, r.left - chipW - 8)
        : Math.max(4, r.right - 184);
      wrap.style.setProperty("top", `${top}px`, "important");
      wrap.style.setProperty("left", `${left}px`, "important");
      wrap.style.setProperty("visibility", "visible", "important");
    }
  }
  function _scheduleJobChipSync() {
    if (!_jobChipSyncRaf) _jobChipSyncRaf = requestAnimationFrame(_syncJobChipPositions);
  }

  let _jobChipScrollBound = false;
  function _bindJobChipScroll() {
    if (_jobChipScrollBound) return;
    // capture:true catches scroll on LinkedIn's inner results container (the
    // jobs list scrolls independently of the window), not just window scroll.
    window.addEventListener("scroll", _scheduleJobChipSync, { passive: true, capture: true });
    window.addEventListener("resize", _scheduleJobChipSync, { passive: true });
    // Safety-net poll: cards reflow as LinkedIn lazily hydrates / the detail
    // pane resizes the list column. A cheap 400ms reposition keeps every chip
    // glued to its card even if a scroll/resize event is missed.
    setInterval(() => {
      if (injectedJobChips.size) _syncJobChipPositions();
    }, 400);
    _jobChipScrollBound = true;
  }

  function _isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    } catch {
      return true;
    }
  }

  function _jobIdFromHref(href) {
    if (!href) return null;
    const m = href.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    try {
      const u = new URL(href, location.href);
      const cj = u.searchParams.get("currentJobId");
      if (cj && /^\d+$/.test(cj)) return cj;
    } catch {}
    return null;
  }

  function _jobIdFromCard(card) {
    const direct =
      card.getAttribute?.("data-occludable-job-id") ||
      card.getAttribute?.("data-job-id");
    if (direct && /^\d+$/.test(direct)) return direct;
    const attrEl = card.querySelector?.("[data-occludable-job-id], [data-job-id]");
    const attr =
      attrEl?.getAttribute("data-occludable-job-id") ||
      attrEl?.getAttribute("data-job-id");
    if (attr && /^\d+$/.test(attr)) return attr;
    const links = card.querySelectorAll?.("a[href*='/jobs/view/'], a[href*='currentJobId=']") || [];
    for (const link of links) {
      const id = _jobIdFromHref(link.getAttribute("href"));
      if (id) return id;
    }
    return null;
  }

  function _jobUrlFromId(id) {
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
  }

  function _jobLabel(card) {
    const dis = card.querySelector("button[aria-label*='Dismiss' i]");
    const aria = (dis?.getAttribute("aria-label") || "")
      .replace(/^dismiss\s+/i, "")
      .replace(/\s+job$/i, "")
      .trim();
    if (aria) return aria.slice(0, 60);
    const t =
      card.querySelector(
        "a.job-card-list__title, a.job-card-container__link, .artdeco-entity-lockup__title, " +
        ".job-card-list__title--link, [class*='title'], a, strong, h3"
      )?.innerText ||
      "";
    return (t || "Job").replace(/\s+/g, " ").trim().slice(0, 60) || "Job";
  }

  // The repeated card unit for a Dismiss "X": climb until the node's PARENT
  // holds 2+ dismiss buttons (i.e. the parent is the list and the node is one
  // card among siblings). Works with NO job links or data-ids on the card —
  // which is exactly the search-results layout LinkedIn now ships.
  function _cardFromDismiss(btn) {
    let node = btn;
    for (let i = 0; i < 16 && node && node.tagName !== "BODY" && node.tagName !== "HTML"; i++) {
      const parent = node.parentElement;
      if (
        parent &&
        parent.querySelectorAll("button[aria-label*='Dismiss' i]").length >= 2
      ) {
        return node;
      }
      node = parent;
    }
    return btn.closest("li") || btn.parentElement;
  }

  // ----- Card detection -----

  const _TITLE_LINK_SEL =
    "a.job-card-list__title, a.job-card-container__link, " +
    "a.job-card-job-posting-card-wrapper__card-link, a[href*='/jobs/view/'], " +
    "a[href*='/jobs/search-results/'][href*='currentJobId=']";

  function _countContained(node, nodeList) {
    let n = 0;
    for (const el of nodeList) {
      if (node.contains(el)) { n++; if (n > 1) return n; }
    }
    return n;
  }

  // Climb until the box would hold 2+ title links — the single-card boundary.
  function _climbByLinkCount(seed, links) {
    let node = seed;
    let best = seed;
    for (let i = 0; i < 14 && node && node.tagName !== "BODY" && node.tagName !== "HTML"; i++) {
      if (_countContained(node, links) > 1) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  // One box per visible job card. Prefers the enclosing <li>; if that <li> spans
  // multiple cards (i.e. it's actually the list), climbs by title-link count.
  // True when a node lives inside the right-hand JOB DETAIL pane (the open
  // job's description + apply buttons), NOT the left results list. The detail
  // pane contains its own job-title/apply links, which were getting chips of
  // their own (duplicated + mis-positioned over the pane). We anchor chips on
  // the left list only.
  function _inDetailPane(node) {
    try {
      return !!node.closest(
        ".jobs-search__job-details, .jobs-search__job-details--container, " +
        ".jobs-search__job-details--wrapper, .jobs-details, .job-view-layout, " +
        ".scaffold-layout__detail, [class*='jobs-search__job-details'], " +
        "[class*='job-details']"
      );
    } catch {
      return false;
    }
  }

  // Smallest ancestor of a node that encloses a job link — used to climb from
  // a card's Dismiss "X" up to the card container.
  function _climbToJobBox(node) {
    let n = node.parentElement;
    for (let i = 0; i < 10 && n && n.tagName !== "BODY" && n.tagName !== "HTML"; i++) {
      if (n.querySelector("a[href*='/jobs/']")) return n;
      n = n.parentElement;
    }
    return null;
  }

  function _jobCardEls() {
    const seen = new Set();
    const boxes = [];
    // No /jobs/ anchor requirement: modern LinkedIn cards navigate via the
    // whole-card click / data-job-id and may not expose a job <a> inside, so
    // requiring one rejected every card but the open one. We trust the
    // strategy selectors instead and just dedupe + exclude the detail pane.
    const add = (box) => {
      if (box && !seen.has(box) && !_inDetailPane(box)) {
        seen.add(box);
        boxes.push(box);
      }
    };

    // PRIMARY: one card per Dismiss "X". Robust even when cards expose no job
    // link or data-id (the current search-results layout). Climbs to the
    // repeated card unit via _cardFromDismiss.
    document.querySelectorAll("button[aria-label*='Dismiss' i]").forEach((btn) => {
      if (_inDetailPane(btn)) return;
      add(_cardFromDismiss(btn));
    });

    // SUPPLEMENTS — only when no dismiss buttons exist on the surface.
    if (boxes.length === 0) {
      document
        .querySelectorAll(
          "li[data-occludable-job-id], li[data-job-id], div[data-job-id], " +
          "[data-occludable-job-id], " +
          "li.scaffold-layout__list-item, li.jobs-search-results__list-item, " +
          "li.discovery-templates-entity-item, " +
          "div[class*='job-card-container'], div[class*='job-card-job-posting-card'], " +
          "div[class*='jobs-job-board-list__item']"
        )
        .forEach(add);
      const titleLinks = Array.from(
        document.querySelectorAll(
          "a[href*='/jobs/view/'], a[href*='currentJobId='], a.job-card-list__title, " +
          "a.job-card-container__link, a.job-card-job-posting-card-wrapper__card-link"
        )
      ).filter((l) => !_inDetailPane(l));
      titleLinks.forEach((link) => {
        add(link.closest("li") || _climbByLinkCount(link, titleLinks));
      });
    }

    // Keep the innermost when a parent and child both got detected.
    return boxes.filter((c) => !boxes.some((o) => o !== c && c.contains(o)));
  }

  // Real LinkedIn job id from a card, when one is actually present (data attr
  // or /jobs/view/<id> link). NOT currentJobId — that collides across cards.
  function _realJobId(card) {
    const direct = card.getAttribute?.("data-occludable-job-id") || card.getAttribute?.("data-job-id");
    if (direct && /^\d+$/.test(direct)) return direct;
    const attrEl = card.querySelector?.("[data-occludable-job-id], [data-job-id]");
    const attr = attrEl?.getAttribute("data-occludable-job-id") || attrEl?.getAttribute("data-job-id");
    if (attr && /^\d+$/.test(attr)) return attr;
    const view = card.querySelector?.("a[href*='/jobs/view/']");
    const vm = (view?.getAttribute("href") || "").match(/\/jobs\/view\/(\d+)/);
    if (vm) return vm[1];
    return null;
  }

  // Stable per-card key — unique even when cards share one page-level
  // currentJobId (falls back to the job title text).
  function _jobCardKey(card) {
    const real = _realJobId(card);
    if (real) return "job:" + real;
    return "card:" + _jobLabel(card).toLowerCase();
  }

  // Apply URL for a card, when a real job id is known; else null (we open the
  // job by clicking the card element directly).
  function _jobApplyUrlFromCard(card) {
    const id = _realJobId(card);
    return id ? _jobUrlFromId(id) : null;
  }

  function _gcJobChips() {
    for (const [key, node] of injectedJobChips.entries()) {
      const card = _jobChipCards.get(key);
      if (!node || !card || !document.body.contains(card) || _inDetailPane(card)) {
        injectedJobChips.delete(key);
        _jobChipCards.delete(key);
        _jobChipApplyUrls.delete(key);
        try { if (node) node.remove(); } catch {}
      }
    }
  }

  // Live card keys (the single source of truth for selection + Apply All).
  function _allJobUrls() {
    const keys = [];
    for (const [key] of injectedJobChips.entries()) {
      const card = _jobChipCards.get(key);
      if (key && card && document.body.contains(card)) keys.push(key);
    }
    return keys;
  }

  function _setJobChipState(key, st, text) {
    const wrap = injectedJobChips.get(key);
    if (!wrap) return;
    const btn = wrap.querySelector(".lc-inline-save");
    const span = wrap.querySelector(".lc-inline-save-text");
    if (btn) btn.dataset.state = st;
    if (span) span.textContent = text;
  }

  // The live card element for a given key.
  function _jobCardForKey(key) {
    const card = _jobChipCards.get(key);
    if (card && document.body.contains(card)) return card;
    for (const c of _jobCardEls()) {
      if (_jobCardKey(c) === key) return c;
    }
    return null;
  }

  // Inject a select-tick + Apply chip onto every visible job card.
  // Chips are mounted in a fixed-position portal on document.body, completely
  // bypassing LinkedIn's overflow:hidden scroll containers. Positions are
  // recalculated each animation frame via _syncJobChipPositions().
  function decorateJobCards() {
    if (!_isJobsPage()) return;
    _gcJobChips();
    const portal = _ensurePortalRoot();
    const cards = _jobCardEls();
    let created = 0;
    for (const card of cards) {
      try {
        const key = _jobCardKey(card);
        if (!key) continue;

        // Prevent DUPLICATE chips on one card: if a live chip is already
        // anchored to this exact card element (under this OR a changed key —
        // e.g. the open card gains a /jobs/view link mid-session and its key
        // flips from "card:title" to "job:id"), don't create a second one.
        let dup = false;
        for (const [k] of injectedJobChips) {
          if (_jobChipCards.get(k) === card) { dup = true; break; }
        }
        if (dup) continue;

        // Keep our tracking pointed at the freshest card element for this key
        // (LinkedIn recycles card nodes on scroll/pagination).
        _jobChipCards.set(key, card);
        _jobChipApplyUrls.set(key, _jobApplyUrlFromCard(card));
        if (injectedJobChips.has(key)) continue;

        const checkSpan = el(
          "span",
          { class: "lc-inline-check", title: "Select this job for Apply All" },
          state.selectedJobUrls.has(key) ? "☑" : "☐"
        );
        if (state.selectedJobUrls.has(key)) checkSpan.classList.add("lc-inline-check-on");
        checkSpan.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.selectedJobUrls.has(key)) {
            state.selectedJobUrls.delete(key);
            checkSpan.textContent = "☐";
            checkSpan.classList.remove("lc-inline-check-on");
          } else {
            state.selectedJobUrls.add(key);
            checkSpan.textContent = "☑";
            checkSpan.classList.add("lc-inline-check-on");
          }
          refreshSelectAllHeader();
          renderToolbar();
        });

        const textSpan = el("span", { class: "lc-inline-save-text" }, "Auto Apply");
        const btn = el(
          "button",
          { class: "lc-inline-save", type: "button", title: "Auto-apply to this job" },
          textSpan
        );
        btn.dataset.state = "ready";
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.applyActive || btn.dataset.state === "saving") return;
          await applyAllJobs([key]);
        });

        const wrap = el("div", { class: "lc-job-row" }, checkSpan, btn);
        wrap.dataset.lcKey = key;
        portal.appendChild(wrap);
        injectedJobChips.set(key, wrap);
        created++;
      } catch (e) {
        console.warn("[LeadCaptura] decorateJobCards failed", e?.message);
      }
    }
    if (cards.length || created) {
      console.log(`[LeadCaptura] jobs: ${cards.length} cards, ${injectedJobChips.size} chips (+${created} new)`);
    }
    _bindJobChipScroll();
    // Position immediately (synchronously) so chips are visible on this frame —
    // not only on the next requestAnimationFrame, which can be delayed.
    try { _syncJobChipPositions(); } catch {}
    _scheduleJobChipSync();
    // Surface the live count on the toolbar's Apply button the moment new
    // chips appear, so the user can confirm detection at a glance.
    if (created > 0) { try { renderToolbar(); } catch {} }
  }

  function toggleSelectAllJobs() {
    if (state.selectedJobUrls.size > 0) {
      state.selectedJobUrls.clear();
    } else {
      try { decorateJobCards(); } catch {}
      for (const url of _allJobUrls()) state.selectedJobUrls.add(url);
    }
    decorateJobCards();
    for (const wrap of injectedJobChips.values()) {
      const key = wrap?.dataset?.lcKey;
      const check = wrap?.querySelector(".lc-inline-check");
      if (!key || !check) continue;
      const on = state.selectedJobUrls.has(key);
      check.textContent = on ? "☑" : "☐";
      check.classList.toggle("lc-inline-check-on", on);
    }
    refreshSelectAllHeader();
    renderToolbar();
  }

  // Always-select (never toggles off) — used by Apply All when it lands on a
  // fresh page so the user sees every new card get ticked before applying.
  function _selectAllVisibleJobs() {
    try { decorateJobCards(); } catch {}
    for (const url of _allJobUrls()) state.selectedJobUrls.add(url);
    for (const wrap of injectedJobChips.values()) {
      const key = wrap?.dataset?.lcKey;
      const check = wrap?.querySelector(".lc-inline-check");
      if (!key || !check) continue;
      const on = state.selectedJobUrls.has(key);
      check.textContent = on ? "☑" : "☐";
      check.classList.toggle("lc-inline-check-on", on);
    }
    refreshSelectAllHeader();
  }

  // ---- Easy Apply modal driving ----

  function _easyApplyModal() {
    return (
      document.querySelector("div.jobs-easy-apply-modal") ||
      document.querySelector("div[data-test-modal][role='dialog']") ||
      document.querySelector(".artdeco-modal[role='dialog']") ||
      Array.from(document.querySelectorAll("div[role='dialog'], [role='alertdialog']")).find(
        (d) =>
          /easy apply|application|apply to/i.test(d.getAttribute("aria-label") || "") ||
          /easy apply|application/i.test(d.getAttribute("aria-labelledby") ? (document.getElementById(d.getAttribute("aria-labelledby"))?.innerText || "") : "") ||
          d.querySelector(".jobs-easy-apply-content, .jobs-easy-apply-form, .jobs-apply-form")
      ) ||
      null
    );
  }

  function _challengeOnPage() {
    return [
      "form#captcha",
      "form[action*='checkpoint']",
      "div[data-test-id='challenge']",
      "input[name='pin']",
    ].some((s) => document.querySelector(s));
  }

  // The job detail's apply control + its classification.
  function _classifyJobDetail() {
    const cands = Array.from(
      document.querySelectorAll(
        "button.jobs-apply-button, button[aria-label*='Easy Apply' i], " +
        "button[data-control-name*='apply' i], " +
        ".jobs-apply-button--top-card button, .jobs-s-apply button, " +
        ".jobs-unified-top-card button, .jobs-details-top-card button, " +
        "div[class*='jobs-apply'] button, div[class*='top-card-layout'] button"
      )
    ).filter(_isVisible);
    for (const b of cands) {
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (/easy apply/i.test(t) || /easy apply/i.test(a)) return { status: "easy", btn: b };
    }
    // Check for "Applied" badge / button (already submitted)
    const applied = Array.from(document.querySelectorAll(
      "button[aria-label*='Applied' i], span[class*='applied'], .jobs-apply-button--applied"
    )).filter(_isVisible);
    if (applied.length) return { status: "applied", btn: null };
    const bodyTxt = (document.querySelector(".jobs-s-apply, .jobs-details, .job-view-layout")?.innerText || "");
    if (/\bapplied\b/i.test(bodyTxt) && !cands.length) return { status: "applied", btn: null };
    for (const b of cands) {
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (/company website|apply\b/i.test(t) || /company website/i.test(a)) {
        return { status: "external", btn: null };
      }
    }
    return { status: "none", btn: null };
  }

  function _modalProgress(modal) {
    if (!modal) return null;
    const prog = modal.querySelector("progress");
    if (prog && prog.max) return Math.round((Number(prog.value) / Number(prog.max)) * 100);
    const bar = modal.querySelector("[role='progressbar'][aria-valuenow]");
    if (bar) return Number(bar.getAttribute("aria-valuenow"));
    return null;
  }

  function _modalHeading(modal) {
    if (!modal) return "";
    return (modal.querySelector("h2, h3")?.innerText || "").replace(/\s+/g, " ").trim();
  }

  // Find the footer action button + its kind. Order matters: submit/review are
  // terminal-ish; "next/continue" advances.
  function _modalActionButton(modal) {
    if (!modal) return null;
    // Prefer footer buttons but fall back to all visible buttons
    const footer = modal.querySelector("footer, .jobs-easy-apply-modal__action-bar, [class*='action-bar'], [class*='footer']");
    const btns = Array.from((footer || modal).querySelectorAll("button")).filter(_isVisible);
    const match = (b, re) =>
      re.test((b.getAttribute("aria-label") || "")) ||
      re.test((b.innerText || b.textContent || "").replace(/\s+/g, " ").trim());
    let b;
    if ((b = btns.find((x) => match(x, /submit application|^submit$/i)))) return { type: "submit", btn: b };
    if ((b = btns.find((x) => match(x, /review your application|^review$/i)))) return { type: "review", btn: b };
    if ((b = btns.find((x) => match(x, /continue to next step|^next$|^continue$|^done$/i)))) return { type: "next", btn: b };
    // Last resort: any non-dismiss, non-back primary button in the modal footer
    const primaryBtn = btns.find((x) => {
      const t = (x.innerText || x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return !["back", "dismiss", "discard", "cancel", "close"].includes(t) && t.length > 0;
    });
    if (primaryBtn) return { type: "next", btn: primaryBtn };
    return null;
  }

  // If a resume picker is present, make sure one resume is selected. LinkedIn
  // usually pre-selects the most recent upload; we only act if none is chosen.
  function _ensureResumeSelected(modal) {
    if (!modal) return;
    const cards = Array.from(
      modal.querySelectorAll(
        ".jobs-document-upload-redesign-card__container, .jobs-resume-picker__resume, .ui-attachment"
      )
    );
    if (!cards.length) return;
    const isSelected = (c) =>
      c.classList.contains("jobs-document-upload-redesign-card__container--selected") ||
      c.querySelector("input[type='radio']:checked") ||
      c.getAttribute("aria-selected") === "true";
    if (cards.some(isSelected)) return;
    const firstCard = cards[0];
    const target =
      firstCard.querySelector("input[type='radio'], button, [role='button']") || firstCard;
    try { target.click(); } catch {}
  }

  // Uncheck the "Follow <company>" box that some submit steps pre-tick, so we
  // don't silently follow every company we apply to.
  function _uncheckFollow(modal) {
    if (!modal) return;
    const boxes = Array.from(modal.querySelectorAll("input[type='checkbox']"));
    for (const cb of boxes) {
      const id = cb.id || "";
      const lbl = modal.querySelector(`label[for='${id}']`);
      const txt = (lbl?.innerText || cb.getAttribute("aria-label") || "").toLowerCase();
      if (/follow/i.test(txt) && cb.checked) {
        try { cb.click(); } catch {}
      }
    }
  }

  async function _dismissEasyApplyModal() {
    const { sleep } = globalThis.__lcHuman;
    const dismiss =
      document.querySelector("button[aria-label='Dismiss']") ||
      document.querySelector("button[aria-label*='Dismiss' i]");
    if (dismiss) {
      try { dismiss.click(); } catch {}
      await sleep(500 + Math.random() * 400);
    }
    // A "Discard application?" confirmation may appear.
    const discard =
      document.querySelector("button[data-control-name='discard_application_confirm_btn']") ||
      Array.from(document.querySelectorAll("div[role='alertdialog'] button, div[role='dialog'] button"))
        .find((b) => /^discard$/i.test((b.innerText || b.textContent || "").trim()));
    if (discard) {
      try { discard.click(); } catch {}
      await sleep(400 + Math.random() * 300);
    }
  }

  // ---- Auto-fill Easy Apply form questions (Option A profile + Option B Gemini) ----

  async function _getAutoApplyConfig() {
    const s = await Storage.getSettings();
    const provider = s.aiProvider || "gemini";
    const hasKey = provider === "claude" ? !!s.claudeApiKey : !!s.geminiApiKey;
    return {
      profile: s.applicationProfile || {},
      aiEnabled: !!s.aiEnabled && hasKey,
    };
  }

  // React-aware value setter so LinkedIn's controlled inputs register the change.
  function _setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    try {
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch { el.value = value; }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function _fieldLabelFor(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const id = el.id;
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) { const t = (lbl.innerText || lbl.textContent || "").trim(); if (t) return t; }
      } catch {}
    }
    const lblby = el.getAttribute("aria-labelledby");
    if (lblby) {
      const t = lblby.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ").trim();
      if (t) return t;
    }
    const group = el.closest(".fb-dash-form-element, [data-test-form-element], .jobs-easy-apply-form-element, fieldset");
    if (group) {
      const lbl = group.querySelector("label, legend, .fb-dash-form-element__label, .artdeco-text-input--label");
      if (lbl) { const t = (lbl.innerText || lbl.textContent || "").trim(); if (t) return t; }
    }
    return "";
  }

  function _yesNoOption(boolish, options) {
    const want = /^y/i.test(boolish || "") ? "yes" : "no";
    if (!options || !options.length) return boolish;
    const found =
      options.find((o) => o.toLowerCase().trim() === want) ||
      options.find((o) => new RegExp(`^${want}`, "i").test(o.trim()));
    return found || boolish;
  }

  // Option A: deterministic answers from the user's saved profile.
  function _matchProfileAnswer(label, profile, kind, options) {
    const l = (label || "").toLowerCase();
    if (!l) return null;
    const p = profile || {};
    if (/(years|yrs)[^a-z]{0,20}(experience|exp)|how many years|experience[^a-z]{0,10}(do you have|in)/i.test(l)) return p.years || null;
    if (/phone|mobile|cell|contact number|whatsapp/i.test(l)) return p.phone || null;
    if (/e-?mail/i.test(l)) return p.email || null;
    if (/full name|your name/i.test(l)) return p.fullName || null;
    if (/first name/i.test(l)) return (p.fullName || "").split(" ")[0] || null;
    if (/last name|surname|family name/i.test(l)) return (p.fullName || "").split(" ").slice(1).join(" ") || null;
    if (/expected[^a-z]{0,10}(salary|compensation|ctc|pay)|salary[^a-z]{0,10}expectation|desired[^a-z]{0,10}salary/i.test(l)) return p.expectedSalary || null;
    if (/current[^a-z]{0,10}(salary|compensation|ctc)/i.test(l)) return p.currentSalary || null;
    if (/notice period|when can you (start|join)|availability|available to start|earliest start/i.test(l)) return p.notice || null;
    if (/relocat/i.test(l)) return _yesNoOption(p.relocate || "Yes", options);
    if (/sponsor|require[^a-z]{0,10}visa|visa sponsor/i.test(l)) return _yesNoOption(p.sponsorship || "No", options);
    if (/authoriz|authoris|right to work|legally[^a-z]{0,15}work|eligible to work|work permit/i.test(l)) return _yesNoOption(p.workAuth || "Yes", options);
    if (/\bcity\b|current location|where are you (based|located)|^location$/i.test(l)) return p.city || null;
    if (/\bcountry\b/i.test(l)) return p.country || null;
    // Generic Yes/No leaning positive when only Yes/No options exist
    if (options && options.length && options.length <= 3) {
      const lo = options.map((o) => o.toLowerCase().trim());
      if (lo.includes("yes") && lo.includes("no") && /(do you|are you|have you|can you|will you|willing|comfortable|able to)/i.test(l)) {
        return _yesNoOption("Yes", options);
      }
    }
    return null;
  }

  function _pickOption(options, desired) {
    if (!desired) return null;
    const d = String(desired).toLowerCase().trim();
    let m = options.find((o) => o.toLowerCase().trim() === d);
    if (m) return m;
    m = options.find((o) => o.toLowerCase().trim().startsWith(d) || d.startsWith(o.toLowerCase().trim()));
    if (m) return m;
    m = options.find((o) => o.toLowerCase().includes(d) || d.includes(o.toLowerCase().trim()));
    if (m) return m;
    return null;
  }

  function _radioLabel(r) {
    if (r.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        if (lbl) return (lbl.innerText || lbl.textContent || "").trim();
      } catch {}
    }
    const wrap = r.closest("label");
    if (wrap) return (wrap.innerText || wrap.textContent || "").trim();
    return (r.value || "").trim();
  }

  function _groupRadios(modal) {
    const radios = Array.from(modal.querySelectorAll("input[type='radio']")).filter(_isVisible);
    const byKey = new Map();
    let anon = 0;
    for (const r of radios) {
      const key = r.name || r.closest("fieldset")?.id || `anon${anon++}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const groups = [];
    for (const rs of byKey.values()) {
      const fs = rs[0].closest("fieldset, .fb-dash-form-element, [data-test-form-element]");
      const legend = fs?.querySelector("legend, .fb-dash-form-element__label, label");
      const question = (legend?.innerText || legend?.textContent || "").replace(/\s+/g, " ").trim();
      groups.push({ question, radios: rs });
    }
    return groups;
  }

  // Fill every empty field in the modal. Profile first, then Gemini for the rest.
  async function _answerModalQuestions(modal) {
    if (!modal) return;
    const { sleep } = globalThis.__lcHuman;
    const { profile, aiEnabled } = await _getAutoApplyConfig();
    const askGemini = async (question, kind, options) => {
      if (!aiEnabled || !question) return null;
      try {
        const r = await Api.geminiAnswer({ question, kind, options: options || [] });
        return r && r.ok && r.answer ? r.answer : null;
      } catch { return null; }
    };

    // Text / number / tel / email / textarea
    const textInputs = Array.from(modal.querySelectorAll(
      "input[type='text'], input[type='tel'], input[type='email'], input[type='number'], input:not([type]), textarea"
    )).filter((el) => _isVisible(el) && !el.disabled && !el.readOnly);
    for (const inp of textInputs) {
      if (inp.value && inp.value.trim()) continue;
      const label = _fieldLabelFor(inp);
      if (!label) continue;
      const isNumber = inp.type === "number" || /\b(year|years|salary|number|how many|amount|ctc|experience)\b/i.test(label);
      let ans = _matchProfileAnswer(label, profile, isNumber ? "number" : "text", null);
      if (ans == null) ans = await askGemini(label, isNumber ? "number" : "text", null);
      if (ans != null && String(ans).trim()) {
        let val = String(ans).trim();
        if (isNumber) { const num = val.match(/-?\d+(\.\d+)?/); if (num) val = num[0]; }
        _setNativeValue(inp, val);
        await sleep(150 + Math.random() * 250);
      }
    }

    // Select dropdowns
    const selects = Array.from(modal.querySelectorAll("select")).filter((el) => _isVisible(el) && !el.disabled);
    for (const sel of selects) {
      const curTxt = (sel.options[sel.selectedIndex]?.text || "").toLowerCase().trim();
      const answered = sel.value && curTxt && !/^(select|choose|please|--)/.test(curTxt);
      if (answered) continue;
      const label = _fieldLabelFor(sel);
      const options = Array.from(sel.options).map((o) => o.text.trim())
        .filter((t) => t && !/^(select|choose|please|--)/i.test(t));
      if (!options.length) continue;
      let ans = _matchProfileAnswer(label, profile, "select", options);
      if (ans == null) ans = await askGemini(label, "select", options);
      const pick = ans ? _pickOption(options, ans) : null;
      if (pick) {
        const opt = Array.from(sel.options).find((o) => o.text.trim() === pick);
        if (opt) { _setNativeValue(sel, opt.value); await sleep(150 + Math.random() * 250); }
      }
    }

    // Radio groups
    for (const group of _groupRadios(modal)) {
      if (group.radios.some((r) => r.checked)) continue;
      const options = group.radios.map((r) => _radioLabel(r));
      let ans = _matchProfileAnswer(group.question, profile, "radio", options);
      if (ans == null) ans = await askGemini(group.question, "radio", options);
      const pick = ans ? _pickOption(options, ans) : null;
      if (pick) {
        const idx = options.findIndex((o) => o === pick);
        const radio = group.radios[idx];
        if (radio) {
          let lbl = null;
          if (radio.id) { try { lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`); } catch {} }
          try { (lbl || radio).click(); }
          catch { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
          await sleep(150 + Math.random() * 250);
        }
      }
    }
  }

  // Step through the open Easy Apply modal. Returns {ok, reason}.
  async function _runEasyApplyModal() {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick, waitFor } = globalThis.__lcDom;

    let modal = await waitFor(
      ["div.jobs-easy-apply-modal", "div[data-test-modal][role='dialog']", "div[role='dialog']"],
      { timeout: 6000 }
    );
    modal = _easyApplyModal() || modal;
    if (!modal) return { ok: false, reason: "modal_not_found" };

    const MAX_STEPS = 14;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (state.applyCancel) return { ok: false, reason: "cancelled" };
      if (_challengeOnPage()) return { ok: false, reason: "captcha_or_checkpoint" };
      modal = _easyApplyModal() || modal;
      if (!modal) return { ok: false, reason: "modal_closed" };

      // Keep a resume selected + don't auto-follow companies.
      _ensureResumeSelected(modal);
      _uncheckFollow(modal);
      // Auto-fill this step's questions (profile answers + Gemini fallback)
      // before trying to advance.
      try { await _answerModalQuestions(modal); }
      catch (e) { console.warn("[LeadCaptura] question auto-fill failed", e?.message); }
      await sleep(500 + Math.random() * 500);

      const action = _modalActionButton(modal);
      if (!action) {
        await _dismissEasyApplyModal();
        return { ok: false, reason: "no_action_button" };
      }

      if (action.type === "submit") {
        await dispatchHumanClick(action.btn);
        await sleep(1400 + Math.random() * 1200);
        // Close the "application sent" confirmation.
        await _dismissEasyApplyModal();
        return { ok: true };
      }

      // Advance (next / review) and verify the modal actually moved on.
      const before = { progress: _modalProgress(modal), heading: _modalHeading(modal) };
      // Reading pause before clicking — looks like a human checking the form.
      await sleep(600 + Math.random() * 900);
      await dispatchHumanClick(action.btn);
      await sleep(1100 + Math.random() * 1000);

      const after = _easyApplyModal();
      if (!after) return { ok: false, reason: "modal_vanished" }; // unexpected
      const act2 = _modalActionButton(after);
      const progressedByButton = act2 && (act2.type === "submit" || act2.type === "review") && action.type === "next";
      const progAfter = _modalProgress(after);
      const headAfter = _modalHeading(after);
      const errorShown = !!after.querySelector(
        ".artdeco-inline-feedback--error, [role='alert'], .fb-form-element__error-text"
      );
      const progressed =
        progressedByButton ||
        (before.progress != null && progAfter != null && progAfter > before.progress) ||
        (before.heading && headAfter && headAfter !== before.heading);

      if (!progressed && (errorShown || (progAfter === before.progress && headAfter === before.heading))) {
        // Stuck — this job needs answers we can't safely fill. Discard.
        await _dismissEasyApplyModal();
        return { ok: false, reason: "needs_manual_input" };
      }
    }
    await _dismissEasyApplyModal();
    return { ok: false, reason: "too_many_steps" };
  }

  // Open one job's detail pane (clicks its card link) and wait until the detail
  // actually reflects THIS job — otherwise a slow detail-pane update could make
  // us click Easy Apply on the previously-open job.
  async function _openJobDetail(card, expectedId) {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick } = globalThis.__lcDom;
    // Prefer a real job link; otherwise click the card's title/clickable area
    // (current search-results cards open on card click, not via a job <a>).
    const link =
      card.querySelector("a.job-card-container__link, a.job-card-list__title, a[href*='/jobs/view/']") ||
      card.querySelector("a[href*='/jobs/']") ||
      card.querySelector("a, [class*='title'], strong, h3") ||
      card;
    try { card.scrollIntoView({ block: "center" }); } catch {}
    await sleep(400 + Math.random() * 500);
    try { await dispatchHumanClick(link); } catch { try { link.click(); } catch {} }

    // When we know the job's real id, wait until the detail pane reflects THIS
    // job before clicking Easy Apply (so a slow pane swap can't apply to the
    // previously-open job). When we don't (cards expose only a shared
    // currentJobId), just give the pane time to settle after the click.
    if (!expectedId) {
      await sleep(1400 + Math.random() * 1000);
      return true;
    }
    const matches = () => {
      try {
        const u = new URL(location.href);
        if (u.searchParams.get("currentJobId") === expectedId) return true;
        const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
        if (m && m[1] === expectedId) return true;
      } catch {}
      return false;
    };
    const start = Date.now();
    while (Date.now() - start < 6000 && !matches()) {
      if (state.applyCancel) return false;
      await sleep(300);
    }
    // Let the detail pane finish hydrating its apply button.
    await sleep(900 + Math.random() * 1000);
    // Even if the URL never matched (LinkedIn sometimes doesn't reflect the id
    // for search-results cards), proceed — the click opened the pane.
    return true;
  }

  // Apply to one job (its card is already in the list). Returns {ok, reason}.
  async function _applyToJob(card) {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick } = globalThis.__lcDom;
    const id = _realJobId(card);
    const onRightJob = await _openJobDetail(card, id);
    if (state.applyCancel) return { ok: false, reason: "cancelled" };
    if (!onRightJob) return { ok: false, reason: "detail_mismatch" };
    if (_challengeOnPage()) return { ok: false, reason: "captcha_or_checkpoint" };

    const detail = _classifyJobDetail();
    if (detail.status === "applied") return { ok: false, reason: "already_applied" };
    if (detail.status === "external") return { ok: false, reason: "external_apply" };
    if (detail.status !== "easy" || !detail.btn) return { ok: false, reason: "no_easy_apply" };

    await sleep(500 + Math.random() * 700);
    await dispatchHumanClick(detail.btn);
    return await _runEasyApplyModal();
  }

  // Pacing between job applications: paced but not glacial. 4-tier + periodic
  // micro-break, same anti-pattern philosophy as bulk Connect.
  // Navigate to the next page of job results (SPA pagination).
  // Returns true if we successfully moved to a new page.
  async function _goToNextJobsPage() {
    const { sleep } = globalThis.__lcHuman;

    // Try multiple pagination button selectors
    let nextBtn =
      document.querySelector("button[aria-label='View next page']") ||
      document.querySelector("button[aria-label*='next page' i]") ||
      document.querySelector(".artdeco-pagination__button--next:not([disabled])") ||
      null;

    if (!nextBtn) {
      // Walk pagination indicators: find active → click next sibling
      const indicators = Array.from(
        document.querySelectorAll("li.artdeco-pagination__indicator--number")
      );
      const activeIdx = indicators.findIndex(
        (li) =>
          li.classList.contains("active") ||
          li.querySelector("[aria-current]") ||
          li.getAttribute("aria-current") === "true"
      );
      if (activeIdx >= 0 && activeIdx < indicators.length - 1) {
        nextBtn = indicators[activeIdx + 1].querySelector("button");
      }
    }

    if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true") {
      return false; // No next page available
    }

    const prevSearch = location.search;
    try { nextBtn.scrollIntoView({ block: "center" }); } catch {}
    await sleep(700 + Math.random() * 500);
    try { nextBtn.click(); } catch { return false; }

    // Wait for the URL query string to update (LinkedIn uses SPA pushState for pagination)
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      if (location.search !== prevSearch) break;
      await sleep(300);
    }
    if (location.search === prevSearch) return false; // Navigation didn't happen

    // Wait for new cards to hydrate then re-decorate. Tear down the old page's
    // chips (remove the portal nodes + clear all tracking) so the new page
    // gets a clean set.
    await sleep(2200 + Math.random() * 1000);
    for (const node of injectedJobChips.values()) { try { node.remove(); } catch {} }
    injectedJobChips.clear();
    _jobChipCards.clear();
    _jobChipApplyUrls.clear();
    try { decorateJobCards(); } catch {}
    await sleep(700);
    try { decorateJobCards(); } catch {}

    return true;
  }

  function _applyGap(doneCount) {
    const r = Math.random();
    let gap;
    if (r < 0.62) gap = 4000 + Math.random() * 4000;     // 4-8s
    else if (r < 0.85) gap = 8000 + Math.random() * 7000; // 8-15s
    else if (r < 0.95) gap = 16000 + Math.random() * 10000; // 16-26s
    else gap = 30000 + Math.random() * 20000;             // 30-50s
    return gap;
  }

  // Bulk auto-apply. `onlyKeys` (optional) restricts to specific cards (used by
  // the per-card Auto Apply button); otherwise it uses the tick selection, or
  // every visible job when nothing is ticked. Automatically pages through results.
  async function applyAllJobs(onlyKeys = null) {
    if (state.applyActive) return;
    const { sleep } = globalThis.__lcHuman;
    const MAX_APPLIES_PER_RUN = 50;
    const singleJob = Array.isArray(onlyKeys) && onlyKeys.length > 0;

    try { decorateJobCards(); } catch {}
    // Bulk "Apply All" with no explicit tick selection → select every visible
    // job first so the user sees the whole page get ticked before we start.
    if (!singleJob && state.selectedJobUrls.size === 0) {
      _selectAllVisibleJobs();
    }
    let firstPageKeys = singleJob
      ? onlyKeys
      : state.selectedJobUrls.size > 0
      ? Array.from(state.selectedJobUrls)
      : _allJobUrls();
    firstPageKeys = firstPageKeys.filter(Boolean);
    if (!firstPageKeys.length) {
      flashStatus("No jobs to apply to — tick some jobs or open a jobs search.", "warn");
      return;
    }

    state.applyActive = true;
    state.applyCancel = false;
    state.applyProgress = { current: 0, total: Math.min(firstPageKeys.length, MAX_APPLIES_PER_RUN), name: "" };
    unmountSelectAllHeader();
    renderToolbar();

    let applied = 0, skipped = 0, manual = 0, failed = 0, cancelled = false;
    let sinceBreak = 0;
    let nextBreakAt = 8 + Math.floor(Math.random() * 5);

    // Process a list of card keys. Returns false if cancelled/limit hit.
    const processPage = async (keys) => {
      for (let i = 0; i < keys.length; i++) {
        if (state.applyCancel) { cancelled = true; return false; }
        if (applied >= MAX_APPLIES_PER_RUN) return false;
        const key = keys[i];
        const card = _jobCardForKey(key);
        state.applyProgress = {
          current: applied + 1,
          total: Math.min(keys.length + applied, MAX_APPLIES_PER_RUN),
          name: card ? _jobLabel(card) : "job",
        };
        _setJobChipState(key, "saving", "Applying…");
        renderToolbar();

        if (!card) { skipped++; _setJobChipState(key, "error", "Not visible"); continue; }

        let res;
        try {
          res = await _applyToJob(card);
        } catch (e) {
          res = { ok: false, reason: String(e) };
        }

        if (res.ok) {
          applied++; sinceBreak++;
          _setJobChipState(key, "saved", "Applied ✓");
        } else if (res.reason === "already_applied") {
          skipped++; _setJobChipState(key, "saved", "Already applied ✓");
        } else if (res.reason === "external_apply") {
          skipped++; _setJobChipState(key, "error", "External apply");
        } else if (res.reason === "needs_manual_input") {
          manual++; _setJobChipState(key, "error", "Needs answers");
        } else if (res.reason === "captcha_or_checkpoint") {
          _setJobChipState(key, "error", "Security check");
          flashStatus("LinkedIn security check detected — stopping auto-apply.", "err");
          cancelled = true;
          return false;
        } else {
          failed++; _setJobChipState(key, "error", "Couldn't apply");
        }

        // Make sure any leftover dialog is gone before the next job.
        await _dismissEasyApplyModal();

        const last = i >= urls.length - 1;
        if (!last && !state.applyCancel && applied < MAX_APPLIES_PER_RUN) {
          let gap;
          if (sinceBreak >= nextBreakAt) {
            sinceBreak = 0;
            nextBreakAt = 8 + Math.floor(Math.random() * 5);
            gap = 25000 + Math.random() * 20000;
            flashStatus(`Short break… (${applied} applied)`);
          } else {
            gap = _applyGap(applied);
          }
          await sleep(gap);
        }
      }
      return true; // Completed page without cancellation
    };

    // Process first page
    await processPage(firstPageKeys);

    // Auto-paginate through subsequent pages (bulk mode only, not singleJob)
    let pageNum = 0;
    while (!singleJob && !cancelled && !state.applyCancel && applied < MAX_APPLIES_PER_RUN) {
      const moved = await _goToNextJobsPage();
      if (!moved) break; // No more pages
      pageNum++;
      // Visibly select every job on the fresh page, then apply them all —
      // matching the requested "next page → select all → apply all" loop.
      _selectAllVisibleJobs();
      flashStatus(`Page ${pageNum + 1} — selected all, applying… (${applied} done)`);
      const nextKeys = _allJobUrls();
      if (!nextKeys.length) break;
      state.applyProgress = { current: applied + 1, total: applied + nextKeys.length, name: "" };
      renderToolbar();
      const cont = await processPage(nextKeys);
      if (!cont) break;
    }

    state.applyActive = false;
    state.applyProgress = null;
    if (!singleJob) state.selectedJobUrls.clear();
    mountSelectAllHeader();
    renderToolbar();
    try { decorateJobCards(); } catch {}

    const extra = [
      skipped ? `${skipped} skipped` : "",
      manual ? `${manual} need answers` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean).join(", ");
    const tail = extra ? ` (${extra})` : "";
    const pages = pageNum > 0 ? `, ${pageNum + 1} pages` : "";
    const msg = cancelled
      ? `Stopped: ${applied} applied${tail}`
      : `Done: ${applied} applied${tail}${pages} ✓`;
    flashStatus(msg, applied ? "ok" : "warn");
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

  // Drive a per-card chip into a specific state from external code (the
  // bulk Save loop). Looks the chip up by URL in the global registry; if
  // the card has scrolled out of view and the chip is gone, this is a
  // no-op (no error).
  function _setChipState(url, lcState, text) {
    if (!url) return;
    const wrap = injectedSaves.get(url);
    if (!wrap || !document.body.contains(wrap)) return;
    const btn = wrap.querySelector(".lc-inline-save");
    const span = wrap.querySelector(".lc-inline-save-text");
    if (btn) btn.dataset.state = lcState;
    if (span) span.textContent = text;
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

    // Selection checkbox — toggles inclusion of this URL in the bulk
    // selection set. Clicking it never opens a tab; it's a pure selection
    // primitive. The Save chip next to it does the open-and-enrich action.
    const checkSpan = el(
      "span",
      { class: "lc-inline-check", title: "Select for bulk save" },
      state.selectedUrls.has(url) ? "☑" : "☐"
    );
    if (state.selectedUrls.has(url)) checkSpan.classList.add("lc-inline-check-on");
    checkSpan.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.selectedUrls.has(url)) {
        state.selectedUrls.delete(url);
        checkSpan.textContent = "☐";
        checkSpan.classList.remove("lc-inline-check-on");
      } else {
        state.selectedUrls.add(url);
        checkSpan.textContent = "☑";
        checkSpan.classList.add("lc-inline-check-on");
      }
      // Re-render toolbar so the "Save N Selected" counter updates live.
      // Also update the top pill so its counter stays in sync.
      refreshSelectAllHeader();
      renderToolbar();
    });

    const textSpan = el("span", { class: "lc-inline-save-text" }, "Save");
    const btn = el(
      "button",
      {
        class: "lc-inline-save",
        type: "button",
        title: "Open this profile and auto-enrich",
      },
      textSpan
    );
    btn.dataset.state = "ready";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === "saving") return;
      btn.dataset.state = "saving";
      textSpan.textContent = "Opening…";
      // INTENTIONAL: no card-level pre-save. The card-level scrape can
      // pick up mutual-connection names embedded in the same <li> (the
      // "Suhaib instead of Hady" bug); we don't trust it for persistence
      // anymore. The profile page's triggerAutoSave() scrapes the
      // unambiguous <h1> on /in/<handle> and saves the canonical row.
      console.log(
        "[LeadCaptura] chip clicked — opening profile:",
        profile.linkedin_url
      );
      try {
        if (!_isCapUrl(profile.linkedin_url)) {
          btn.dataset.state = "error";
          textSpan.textContent = "Need profile URL";
          return;
        }
        await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              {
                type: "lc:openProfileTab",
                url: profile.linkedin_url,
                active: true,
                awaitClose: false,
                enrichFlag: false,
              },
              (resp) => {
                if (chrome.runtime.lastError || !resp?.ok) {
                  console.warn(
                    "[LeadCaptura] openProfileTab failed",
                    chrome.runtime.lastError?.message || resp?.error
                  );
                }
                resolve();
              }
            );
          } catch (err) {
            console.warn("[LeadCaptura] openProfileTab threw", err?.message);
            resolve();
          }
        });
        btn.dataset.state = "saved";
        textSpan.textContent = "Opened ✓";
      } catch (err) {
        btn.dataset.state = "error";
        const msg = err?.message || String(err);
        textSpan.textContent = msg.length > 40 ? "Failed — see console" : `Failed: ${msg}`;
        btn.title = msg;
        console.error("[LeadCaptura] per-card open failed", err);
      }
    });

    const wrap = el("div", { class: "lc-save-row" }, checkSpan, btn);
    wrap.dataset.lcUrl = url;

    // Insert the chip INLINE, right before the card's native action button
    // (Message / Connect / Follow), so it flows next to them in normal layout.
    // The previous absolute-positioned approach stacked every chip at one spot
    // (or got clipped) on LinkedIn's newer card markup — only the first card
    // appeared to have a chip. Inline placement is immune to that.
    const actionBtn = Array.from(card.querySelectorAll("button")).find(_isActionButton);
    if (actionBtn && actionBtn.parentElement) {
      // Place the Save chip at the LEFT of the action-button row (the open
      // space before Connect/Message), not crammed against the button.
      const container = actionBtn.parentElement;
      container.insertBefore(wrap, container.firstChild);
    } else {
      // No native action button (e.g. some Sales Nav rows) — fall back to a
      // pinned top-right placement inside the card.
      try {
        if (getComputedStyle(card).position === "static") {
          card.style.setProperty("position", "relative", "important");
        }
        card.style.setProperty("overflow", "visible", "important");
      } catch {
        card.style.position = "relative";
      }
      wrap.style.setProperty("position", "absolute", "important");
      wrap.style.setProperty("top", "12px", "important");
      wrap.style.setProperty("right", "12px", "important");
      card.appendChild(wrap);
    }
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

  // Text-pattern fallback for mutual-connection rows when LinkedIn rotates
  // class names. Mirrors scraper.js _isMutualConnectionContext — keep in
  // lock-step or the two paths disagree.
  function _isMutualConnectionContext(link) {
    try {
      let node = link.parentElement;
      for (let i = 0; i < 2 && node; i++) {
        const txt = (node.textContent || "").toLowerCase();
        if (txt.length < 120) {
          if (
            /\bmutual connection|\bshared connection|\bpeople also (view|follow)/i.test(txt)
          ) {
            return true;
          }
        }
        node = node.parentElement;
      }
    } catch {
      /* defensive */
    }
    return false;
  }

  function _imgArea(img) {
    try {
      const r = img.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      return 0;
    }
  }

  // Is this a native LinkedIn per-card action button (Connect/Follow/Message/
  // Pending)? Used to anchor card detection — there's exactly one per card.
  function _isActionButton(b) {
    if (!b || b.classList?.contains("lc-inline-save")) return false;
    const aria = b.getAttribute?.("aria-label") || "";
    const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
    return (
      /^(connect|follow|message|pending)$/i.test(txt) ||
      /\binvite\b.*\bto connect\b/i.test(aria) ||
      /^(connect|follow|pending)$/i.test(aria) ||
      /^message\b/i.test(aria) ||
      /\bfollow\b/i.test(aria)
    );
  }

  // Mirror of scraper.js _findAvatarLink — keep in lock-step.
  function _findAvatarLink(card) {
    const imgs = Array.from(card.querySelectorAll("img"));
    if (!imgs.length) return null;
    let bestImg = null;
    let bestArea = 0;
    for (const img of imgs) {
      const a = _imgArea(img);
      if (a > bestArea) {
        bestArea = a;
        bestImg = img;
      }
    }
    if (!bestImg || bestArea < 100) return null;
    let node = bestImg.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      if (
        node.tagName === "A" &&
        /\/in\//.test(node.getAttribute("href") || "")
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
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

    const linkSel = "a[href*='/in/'], a[href*='/sales/lead/']";

    // How many DISTINCT profile owners does this node enclose? Used as the
    // card boundary: a node holding ≤1 owner is still a single card; the
    // moment it holds 2+ it has grown into a multi-card container and we stop.
    // Insight / mutual-connection links don't count — they belong to OTHER
    // people referenced inside a card, not the card's own owner.
    const ownerCount = (node) => {
      const set = new Set();
      for (const a of node.querySelectorAll(linkSel)) {
        if (_isInsightLink(a) || _isMutualConnectionContext(a)) continue;
        const u = globalThis.__lcDom.normalizeProfileUrl(a.href);
        if (u) set.add(u);
      }
      return set.size;
    };

    // Climb from a seed node (an action button or a profile link) to the
    // LARGEST ancestor that still represents a SINGLE profile card. Tag-
    // agnostic on purpose — LinkedIn wraps cards in <li>, <article>, <div>,
    // <tr> etc. depending on surface, and requiring a specific tag is exactly
    // what made earlier versions miss cards.
    //
    // Boundary uses BOTH signals: a container spanning two cards has 2+ native
    // action buttons (every result has exactly one) AND/OR 2+ distinct owners.
    // When the action-button count is still ≤1 but the owner count jumped to
    // 2, the extra "owner" is almost always a mutual-connection link embedded
    // inside ONE card — so we trust the button count, accept that node as the
    // full card, then stop.
    const climbToCard = (seed) => {
      let node = seed.parentElement;
      let best = null;
      for (
        let i = 0;
        i < 16 && node && node.tagName !== "BODY" && node.tagName !== "HTML";
        i++
      ) {
        const actionBtns = Array.from(node.querySelectorAll("button")).filter(
          _isActionButton
        ).length;
        const owners = ownerCount(node);
        if (actionBtns > 1 || owners > 1) {
          if (actionBtns <= 1 && node.querySelector(linkSel)) best = node;
          break; // crossed into a multi-card container → stop
        }
        if (node.querySelector(linkSel)) best = node;
        node = node.parentElement;
      }
      return best;
    };

    const cards = new Set();

    // PASS 1 — anchor on the native action button (Connect/Follow/Message/
    // Pending). Stable card boundary when present.
    for (const b of document.querySelectorAll("button")) {
      if (!_isActionButton(b)) continue;
      const card = climbToCard(b);
      if (card) cards.add(card);
    }

    // PASS 2 — anchor on EVERY profile link. This is the safety net that
    // guarantees a chip even when a card has no recognised action button
    // (already-following rows, icon-only buttons, markup LinkedIn just
    // changed). Insight/mutual links are skipped so we never chip a mutual-
    // connection avatar.
    for (const a of document.querySelectorAll(linkSel)) {
      if (_isInsightLink(a) || _isMutualConnectionContext(a)) continue;
      const card = climbToCard(a);
      if (card) cards.add(card);
    }

    // PASS 3 — repeated-unit detection (robust to LinkedIn's 2026 layout where
    // the owner/button-count boundary in climbToCard can miss cards). For each
    // native action button, climb to the element whose PARENT holds 2+ action
    // buttons — that element is one card among sibling cards. This is the same
    // proven technique used for job cards (parent-holds-2+-of-the-signal).
    const _allActionBtns = Array.from(document.querySelectorAll("button")).filter(_isActionButton);
    if (_allActionBtns.length >= 2) {
      for (const b of _allActionBtns) {
        let node = b;
        for (let i = 0; i < 16 && node && node.tagName !== "BODY" && node.tagName !== "HTML"; i++) {
          const parent = node.parentElement;
          if (
            parent &&
            Array.from(parent.querySelectorAll("button")).filter(_isActionButton).length >= 2
          ) {
            if (node.querySelector(linkSel)) cards.add(node);
            break;
          }
          node = parent;
        }
      }
    }

    // Both passes converge on the same "largest single-owner ancestor", but if
    // any outer container slipped in, drop it in favour of the inner card it
    // contains — one chip per profile row, never a wrapper spanning a card.
    const cardList = Array.from(cards);
    const finalCards = cardList.filter(
      (c) => !cardList.some((o) => o !== c && c.contains(o))
    );

    for (const card of finalCards) {
      try {
        const ownerLink = _resolveCardOwnerLink(card, linkSel);
        if (!ownerLink) continue;
        const url = globalThis.__lcDom.normalizeProfileUrl(ownerLink.href);
        if (!_isCapUrl(url)) continue; // accept /in/ AND Sales Nav /sales/lead/

        // Already have a live chip for this URL → nothing to do.
        const existing = injectedSaves.get(url);
        if (existing && document.body.contains(existing)) continue;

        // A stray chip on this card (recycled <li>, or a Sales Nav card whose
        // chip is keyed under its /in/ URL). If it's our tracked chip for the
        // SAME url, leave it; otherwise remove and re-inject for the new owner.
        const stray = card.querySelector(".lc-save-row");
        if (stray) {
          const trackedNode = injectedSaves.get(stray.dataset.lcUrl);
          if (trackedNode === stray && stray.dataset.lcUrl === url) continue;
          injectedSaves.delete(stray.dataset.lcUrl);
          stray.remove();
        }

        // Build full card metadata (name/title/company/location). If the name
        // can't be resolved we DON'T drop the card — the chip's core job is to
        // open the profile by URL, and the canonical name is scraped on the
        // /in/ page during enrichment anyway. Fall back to a slug-derived label.
        let profile = profileFromCard(card, ownerLink);
        if (!profile?.linkedin_url) {
          profile = { linkedin_url: url, full_name: _labelFromUrl(url) };
        }
        injectInlineSave(card, profile);
      } catch (e) {
        console.warn("[LeadCaptura] decorate failed", e?.message);
      }
    }

    // Self-hiding diagnostic: only shows if detection is failing (fewer than 2
    // chips). Disappears the moment it's working, so no clutter when healthy.
    try {
      const liveChips = _allChipUrls().length;
      let badge = document.getElementById("lc-search-diag");
      if (liveChips < 2 && (type.includes("search") || type.includes("sales"))) {
        const txt =
          "LeadCaptura: " + liveChips + " chip(s) · " + finalCards.length + " cards · " +
          Array.from(document.querySelectorAll("button")).filter(_isActionButton).length + " action-btns · " +
          document.querySelectorAll("a[href*='/in/']").length + " in · " +
          document.querySelectorAll("a[href*='/sales/lead/']").length + " sales";
        if (!badge) {
          badge = document.createElement("div");
          badge.id = "lc-search-diag";
          badge.style.cssText =
            "position:fixed;bottom:72px;left:8px;z-index:2147483647;background:#111;color:#0f0;" +
            "font:11px/1.4 monospace;padding:5px 8px;border-radius:6px;max-width:92vw;" +
            "white-space:pre-wrap;pointer-events:none;opacity:.85";
          document.documentElement.appendChild(badge);
        }
        badge.textContent = txt;
      } else if (badge) {
        badge.remove();
      }
    } catch {
      /* diag best-effort */
    }
  }

  // Resolve the canonical profile-owner link for a card. Preference order:
  //   1. The /in/ link wrapping the LARGEST image (avatar proximity) — this
  //      is the most reliable owner signal and beats mutual-connection rows
  //      whose avatars are always smaller stacked thumbnails.
  //   2. A clean (non-insight, non-mutual) link that has an accessible title.
  //   3. Any clean link.
  //   4. LAST RESORT: any link at all — a chip on the right card beats no chip.
  //      Steps 1-2 already guard against mutual hijack in the common case.
  function _resolveCardOwnerLink(card, linkSel) {
    let avatar = _findAvatarLink(card);
    if (avatar && !_isInsightLink(avatar) && !_isMutualConnectionContext(avatar)) {
      return avatar;
    }
    const links = Array.from(card.querySelectorAll(linkSel));
    const clean = links.filter(
      (l) => !_isInsightLink(l) && !_isMutualConnectionContext(l)
    );
    return (
      clean.find((l) => _hasAccessibleTitle(l)) ||
      clean[0] ||
      links.find((l) => _hasAccessibleTitle(l)) ||
      links[0] ||
      null
    );
  }

  globalThis.__lcOverlay = {
    renderProfilePanel,
    renderToolbar,
    decorateSearchCards,
    decorateJobCards,
    unmountProfilePanel,
    unmountToolbar,
    flashStatus,
    triggerAutoSave,
    mountSelectAllHeader,
    unmountSelectAllHeader,
  };
})();
