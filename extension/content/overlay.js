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

  // Live build version — stamped into the toolbar so the user can confirm which
  // overlay.js is actually running on the tab (updating an unpacked extension
  // does NOT re-inject scripts into already-open tabs; you must reload the tab).
  let _LC_VERSION = "?";
  try { _LC_VERSION = chrome.runtime.getManifest().version; } catch {}

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
    selection: { segmentId: null, segmentName: null, playbookId: null, userId: null },
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
    avoidDuplicates: true, // "Avoid Duplicate Outreach" toggle
    toolbarCollapsed: false, // pill ↑/↓ collapse state
  };

  // ── Contacted-URL registry ──────────────────────────────────────────────────
  // Persistent set of LinkedIn profile URLs already saved or connected.
  // Stored in chrome.storage.local so it survives tab reloads.
  // Format: { [normalizedUrl]: timestamp }
  const _contacted = new Map(); // normalized url → timestamp (in-memory mirror)

  async function _loadContacted() {
    try {
      const { lc_contacted_urls } = await new Promise((r) =>
        chrome.storage.local.get("lc_contacted_urls", r)
      );
      if (lc_contacted_urls && typeof lc_contacted_urls === "object") {
        for (const [u, t] of Object.entries(lc_contacted_urls)) {
          _contacted.set(u, t);
        }
      }
    } catch { /* non-critical */ }
  }

  function _markContacted(url) {
    if (!url) return;
    const norm = (url.split("?")[0].split("#")[0].replace(/\/$/, "")).toLowerCase();
    if (_contacted.has(norm)) return; // already recorded
    _contacted.set(norm, Date.now());
    // Persist fire-and-forget
    try {
      const patch = Object.fromEntries(_contacted);
      chrome.storage.local.set({ lc_contacted_urls: patch }).catch(() => {});
    } catch {}
  }

  function _isContacted(url) {
    if (!url) return false;
    const norm = (url.split("?")[0].split("#")[0].replace(/\/$/, "")).toLowerCase();
    return _contacted.has(norm);
  }

  // Load on boot
  _loadContacted();
  Storage.getSettings().then((s) => {
    state.avoidDuplicates = s.avoidDuplicates !== false; // default ON
  }).catch(() => {});

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
      console.log("[LeadCaptura] ensureOptions failed:", e?.message);
      state.options = null;
      state.connectError = e?.message || String(e);
    }
    return state.options;
  }

  // Self-contained on-page toast — does NOT depend on the toolbar being
  // rendered, so it works as a live signal that the auto-confirm watcher (which
  // can fire on any page state) actually executed. This is the user-visible
  // proof that the freshly-loaded build is running on the tab.
  let _lcToastEl = null;
  let _lcToastTimer = null;
  function _lcToast(msg, ms = 2600) {
    try {
      if (!_lcToastEl || !document.documentElement.contains(_lcToastEl)) {
        _lcToastEl = document.createElement("div");
        _lcToastEl.id = "lc-toast";
        _lcToastEl.style.cssText = [
          "position:fixed", "left:50%", "bottom:84px", "transform:translateX(-50%)",
          "z-index:2147483647", "background:#0a66c2", "color:#fff",
          "padding:10px 18px", "border-radius:24px",
          "font:600 13px/1.4 -apple-system,system-ui,sans-serif",
          "box-shadow:0 6px 24px rgba(0,0,0,.28)", "pointer-events:none",
          "max-width:80vw", "text-align:center",
        ].join(";");
        document.documentElement.appendChild(_lcToastEl);
      }
      _lcToastEl.textContent = msg;
      _lcToastEl.style.opacity = "1";
      clearTimeout(_lcToastTimer);
      _lcToastTimer = setTimeout(() => {
        if (_lcToastEl) _lcToastEl.style.opacity = "0";
      }, ms);
    } catch {}
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
        // Store all linked websites for the multi-URL website scraper (Step 7)
        if (contact.websites?.length) {
          enriched.raw = { ...(enriched.raw || {}), websites: contact.websites };
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
    // Tag with the segment the user picked in the toolbar, if any.
    if (state.selection.segmentName) enriched.segment = state.selection.segmentName;
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
      _markContacted(enriched.linkedin_url || profile.linkedin_url);
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

    // Step 7: Website scraping — visit all websites linked on the LinkedIn
    // profile and extract emails/phones when still missing after all LinkedIn
    // enrichment. Collects multiple URLs from the Contact Info modal (personal
    // site + company site + portfolio, etc.) and passes them all to the SW.
    const websiteUrl = enriched.company_url;
    const extraWebsites = (enriched.raw?.websites || []).filter(
      (u) => u && u !== websiteUrl
    );
    // Run when ANY of email / phone / location is still missing — we now pull
    // company location and name from the website too, not just contact emails.
    if (websiteUrl && (!enriched.email || !enriched.phone || !enriched.location)) {
      try {
        const wsSettings = await Storage.getSettings();
        if (wsSettings.webScrapeEnabled !== false) {
          _lcToast("LeadCaptura: scanning website for contact info…");
          const wsResult = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                { type: "lc:scrapeWebsite", url: websiteUrl, extraUrls: extraWebsites },
                (resp) => resolve(resp || {})
              );
            } catch { resolve({}); }
          });
          if (wsResult.error === "needs_permission") {
            _lcToast("Enable website scraping in LeadCaptura Options to auto-find emails");
          } else if (wsResult.ok && (wsResult.emails?.length || wsResult.phones?.length || wsResult.location || wsResult.name)) {
            const merged = { ...enriched };
            const added = [];
            if (wsResult.emails?.[0] && !merged.email) {
              merged.email = wsResult.emails[0];
              added.push("email");
            }
            if (wsResult.phones?.[0] && !merged.phone) {
              merged.phone = wsResult.phones[0];
              added.push("phone");
            }
            if (wsResult.location && !merged.location) {
              merged.location = wsResult.location.slice(0, 200);
              added.push("location");
            }
            if (wsResult.name && !merged.company_name) {
              merged.company_name = wsResult.name;
              added.push("company");
            }
            // Store the full list in raw for later reference
            merged.raw = {
              ...(merged.raw || {}),
              contact_source: "website_scrape",
              scraped_emails: wsResult.emails,
              scraped_phones: wsResult.phones,
              scraped_addresses: wsResult.addresses,
              scraped_company_name: wsResult.name,
            };
            if (added.length) {
              try {
                await Api.syncProfile(merged);
                flashStatus(`Website scraped ✓ (${added.join(" + ")})`, "ok");
              } catch { /* best-effort */ }
            } else {
              _lcToast("Website scanned — no new contact info found");
            }
          }
        }
      } catch { /* best-effort */ }
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
    _mountAvoidDupPanel();
    return root;
  }

  function unmountToolbar() {
    if (state.toolbar) {
      state.toolbar.remove();
      state.toolbar = null;
    }
    const p = document.getElementById("lc-avoid-dup-panel");
    if (p) p.remove();
  }

  // ── "Avoid Duplicate Outreach" floating panel ──────────────────────────────
  // Exposed so decorateSearchCards() can refresh the live skip-count whenever
  // new cards render or the contacted registry changes.
  let _renderAvoidDupPanel = () => {};

  function _mountAvoidDupPanel() {
    if (document.getElementById("lc-avoid-dup-panel")) return;
    const panel = el("div", { id: "lc-avoid-dup-panel" });

    function _persist(on) {
      Storage.getSettings().then((s) =>
        chrome.storage.local.set({ settings: { ...s, avoidDuplicates: on } })
      ).catch(() => {});
    }

    function _setOn(on) {
      if (state.avoidDuplicates === on) return;
      state.avoidDuplicates = on;
      _persist(on);
      // Realtime: re-mark every visible chip and refresh the count immediately.
      _refreshContactedVisuals();
      _render();
    }

    function _render() {
      panel.textContent = "";
      const on = state.avoidDuplicates;
      const skip = on ? _countContactedVisible() : 0;
      panel.classList.toggle("lc-ado-on", on);
      panel.append(
        el("div", { class: "lc-ado-textcol" },
          el("span", { class: "lc-ado-label" },
            "Avoid Duplicate Outreach",
            el("span", {
              class: "lc-ado-info",
              title:
                "When ON, Save All and Connect All skip profiles you have already " +
                "saved or connected with. Already-contacted cards are marked live. " +
                "The contacted list is persisted locally.",
            }, " ⓘ")
          ),
          el("span", { class: "lc-ado-count" },
            on
              ? (skip > 0
                  ? `${skip} duplicate${skip > 1 ? "s" : ""} on this page will be skipped`
                  : "No duplicates on this page")
              : "Duplicate filtering is off")
        ),
        el("div", { class: "lc-ado-btns" },
          el("button", {
            class: "lc-ado-btn" + (on ? " lc-ado-active" : ""),
            onclick: () => _setOn(true),
          }, "On"),
          el("button", {
            class: "lc-ado-btn" + (!on ? " lc-ado-active" : ""),
            onclick: () => _setOn(false),
          }, "Off")
        )
      );
    }
    _renderAvoidDupPanel = _render;
    _render();
    document.documentElement.appendChild(panel);
  }

  // Every /in/ URL that currently has a LIVE chip on the page. The injected
  // chips are the SINGLE SOURCE OF TRUTH for bulk operations — Select All,
  // Save All and Connect All all read from here, so they can never diverge
  // from what the user actually sees. (The old approach re-ran the scraper
  // independently, which under-counted real-photo cards.)
  function _allChipUrls() {
    const urls = [];
    for (const [url, wrap] of injectedSaves.entries()) {
      if (url && (url.includes("/in/") || url.includes("/sales/lead/")) && wrap && document.body.contains(wrap)) {
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

  // "+ New Segment" → prompt for a name, create it server-side, select it.
  async function createNewSegment() {
    const name = (window.prompt("Name your new segment (lead list):") || "").trim();
    if (!name) return;
    try {
      const seg = await Api.createSegment(name);
      // Refresh options so the new segment appears in the dropdown.
      state.options = null;
      await ensureOptions();
      if (seg?.id) {
        state.selection.segmentId = seg.id;
        state.selection.segmentName = seg.name || name;
      }
      flashStatus(`Segment "${seg?.name || name}" created ✓`, "ok");
    } catch (e) {
      flashStatus(`Couldn't create segment: ${e.message || e}`, "err");
    }
    renderToolbar();
  }

  async function renderToolbar() {
    const root = await mountToolbar();
    if (!root) return;

    // Always-visible branded pill handle — clicking toggles the body open/closed.
    const _toggleToolbar = () => {
      state.toolbarCollapsed = !state.toolbarCollapsed;
      renderToolbar();
    };
    const _makeHandle = () =>
      el("div", { class: "lc-toolbar-handle", onclick: _toggleToolbar },
        el("span", { class: "lc-logo" }, "L"),
        el("span", { class: "lc-tb-title" }, "LeadCaptura"),
        el("span", { class: "lc-toolbar-arrow" }, state.toolbarCollapsed ? "↑" : "↓")
      );

    const opts = await ensureOptions();

    root.textContent = "";
    root.classList.toggle("lc-collapsed", !!state.toolbarCollapsed);

    if (!opts) {
      // Jobs page: Apply All is purely local — no backend needed. Render a
      // minimal jobs toolbar so users can still auto-apply without configuring
      // a workspace.
      if (_isJobsPage()) {
        root.append(
          _makeHandle(),
          el("div", { class: "lc-toolbar-body" },
            el("div", { class: "lc-toolbar-inner" },
              state.applyActive
                ? null
                : el("button", {
                    class: "lc-btn lc-btn-ghost",
                    onclick: toggleSelectAllCurrent,
                    title: "Tick every visible job so Apply All processes them",
                  }, state.selectedJobUrls.size > 0 ? `Clear (${state.selectedJobUrls.size})` : "Select All"),
              el("span", { class: "lc-flex" }),
              (state.applyActive && state.applyProgress)
                ? el("div", { class: "lc-bulk-progress" },
                    el("span", { class: "lc-bulk-spinner" }, "⏳"),
                    el("span", { class: "lc-bulk-progress-text" },
                      `Applying ${state.applyProgress.current} of ${state.applyProgress.total}: ${state.applyProgress.name}…`),
                    el("span", { class: "lc-status-slot lc-status-slot-inline" })
                  )
                : el("div", { class: "lc-status-slot" }),
              state.applyActive
                ? el("button", {
                    class: "lc-btn lc-btn-stop",
                    onclick: () => { state.applyCancel = true; flashStatus("Stopping after current item…"); },
                  }, "Stop")
                : el("button", {
                    class: "lc-btn lc-btn-primary",
                    onclick: applyAllJobs,
                    title: "Auto-apply to selected (or all visible) Easy Apply jobs. Skips external-apply and already-applied jobs.",
                  }, state.selectedJobUrls.size > 0 ? `Apply ${state.selectedJobUrls.size}` : `Apply All (${_allJobUrls().length})`),
              el("button", {
                class: "lc-icon-btn lc-icon-btn-light",
                onclick: () => openOptions(),
                title: "Settings",
              }, "⚙")
            )
          )
        );
        return;
      }
      // Non-jobs pages: show the standard "Not connected" prompt.
      root.append(
        _makeHandle(),
        el("div", { class: "lc-toolbar-body" },
          el("div", { class: "lc-toolbar-inner" },
            el("span", { class: "lc-flex" }),
            el("span", { class: "lc-muted" }, "Not connected — "),
            el(
              "button",
              { class: "lc-btn lc-btn-primary lc-btn-sm", onclick: () => openOptions() },
              "Connect workspace"
            )
          )
        )
      );
      return;
    }

    const segmentName = (opts.segments.find((s) => s.id === state.selection.segmentId) || {}).name;
    const playbookName = (opts.playbooks.find((p) => p.id === state.selection.playbookId) || {}).name;
    const userName =
      (opts.users.find((u) => u.id === state.selection.userId) || { name: "Me" }).name;

    root.append(
      _makeHandle(),
      el("div", { class: "lc-toolbar-body" },
        el(
          "div",
          { class: "lc-toolbar-inner" },
          // Unread LinkedIn message count badge (data from interceptor.js)
          (() => {
            const counts = window.__lcMsgCounts || {};
            const unread = (counts.INBOX || 0) + (counts.MESSAGE_REQUEST_PENDING || 0);
            if (!unread) return el("span");
            const badge = el("span", {
              class: "lc-msg-badge",
              title: `${unread} unread LinkedIn message${unread > 1 ? "s" : ""}`,
              onclick: () => { location.href = "https://www.linkedin.com/messaging/"; },
            }, `✉ ${unread}`);
            return badge;
          })(),
          dropdown(
            "Segment",
            segmentName,
            [...opts.segments, { id: "__new__", name: "+ New Segment", icon: "✚" }],
            (s) => {
              if (s.id === "__new__") { createNewSegment(); return; }
              state.selection.segmentId = s.id;
              state.selection.segmentName = s.id ? s.name : null;
              renderToolbar();
            }
          ),
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
            )
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
    const { sleep } = globalThis.__lcHuman;

    // Pick the working set FROM THE INJECTED CHIPS (single source of truth):
    //   - If the user has explicitly ticked checkboxes, process EXACTLY those.
    //   - Else process every visible /in/ card that has a chip.
    // Driving off the chips (not a fresh scrape) guarantees Save All covers
    // every card the user sees — no divergence on real-photo cards.
    try { decorateSearchCards(); } catch {}

    // Auto-paginate only when NO explicit selection — "Save All" mode, not
    // "Save X Selected". When the user ticks specific cards we process exactly
    // those and stop; we don't presume they want all pages.
    const userSelected = state.selectedUrls.size > 0;
    const autoPage = !userSelected;

    let urls = userSelected
      ? Array.from(state.selectedUrls).filter((u) => u && (u.includes("/in/") || u.includes("/sales/lead/")))
      : _allChipUrls();
    if (!urls.length) {
      flashStatus("No profiles to save. Scroll the list so cards render.", "warn");
      return;
    }

    // Avoid Duplicate Outreach: skip profiles already saved/contacted.
    if (state.avoidDuplicates) {
      const before = urls.length;
      urls = urls.filter((u) => !_isContacted(u));
      const skipped = before - urls.length;
      if (skipped > 0) {
        flashStatus(`Skipped ${skipped} already-saved profile${skipped > 1 ? "s" : ""} (Avoid Duplicate Outreach)`, "ok");
      }
      if (!urls.length) {
        flashStatus("All selected profiles already saved — nothing new to enrich.", "warn");
        return;
      }
    }

    // INTENTIONAL: no syncSearch pre-save. Card-level scrapes can pick up
    // mutual-connection names embedded in the same <li> ("Suhaib" instead of
    // "Hady"). We only trust profile-page scrapes for persistence — the
    // background-tab enrichment below saves the canonical name+title+
    // company+email+phone+location pulled from the unambiguous /in/<handle>
    // DOM. We only need the URL here; the profile page yields the real name.
    let enrichable = urls.map((u) => ({
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

    let totalEnriched = 0;
    let totalProcessed = 0;
    let rateLimited = false;
    let cancelled = false;
    let pageNum = 1;

    // Outer loop: one iteration per search-results page.
    // In "Save X Selected" mode this runs exactly once.
    outerLoop: while (true) {
      for (let i = 0; i < enrichable.length; i++) {
        if (state.bulkCancel) {
          cancelled = true;
          break outerLoop;
        }
        const profile = enrichable[i];
        const label = profile.full_name || profile.linkedin_url.split("/in/")[1] || "";
        state.bulkProgress = {
          current: totalProcessed + i + 1,
          total: state.bulkProgress.total, // keep the running total across pages
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
                segment: state.selection.segmentName || null,
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
          break outerLoop;
        }
        if (resp.ok && !resp.timedOut) {
          _setChipState(profile.linkedin_url, "saved", "Saved ✓");
          totalEnriched++;
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

      totalProcessed += enrichable.length;

      // Don't paginate if: user made explicit selection, cancelled, rate-limited,
      // or no Next button exists (last page).
      if (!autoPage || cancelled || rateLimited) break;
      const nextBtn = _findNextPageButton();
      if (!nextBtn) break;

      // ── Navigate to next page ──────────────────────────────────────────
      const prevSig = _pageSignature();
      // Scroll the Next button into view so the click lands naturally
      try { nextBtn.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
      await sleep(500 + Math.random() * 400);
      nextBtn.click();
      pageNum++;
      flashStatus(`Loading page ${pageNum}…`);

      // Wait up to 15s for the page signature to change
      const changed = await (async () => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          if (state.bulkCancel) return false;
          await sleep(400);
          if (_pageSignature() !== prevSig) {
            await sleep(1800); // let the new page settle and React re-render
            return true;
          }
        }
        return false;
      })();

      if (!changed) break; // timed out or no page change
      if (state.bulkCancel) { cancelled = true; break; }

      // ── Scroll to trigger lazy card rendering ──────────────────────────
      flashStatus(`Page ${pageNum}: scanning profiles…`);
      {
        const viewH = window.innerHeight;
        let pos = 0;
        for (let i = 0; i < 12 && !state.bulkCancel; i++) {
          const pageH = document.body.scrollHeight;
          pos = Math.min(pageH - 40, pos + Math.round(viewH * (0.25 + Math.random() * 0.18)));
          window.scrollTo(0, pos);
          await sleep(280 + Math.random() * 380);
          if (pos >= pageH * 0.92) break;
        }
        await sleep(450 + Math.random() * 350);
        window.scrollTo(0, 0);
        await sleep(350 + Math.random() * 200);
      }
      if (state.bulkCancel) { cancelled = true; break; }

      // Re-inject chips on the new page so _allChipUrls() returns fresh URLs
      try { decorateSearchCards(); } catch {}
      await sleep(300 + Math.random() * 200);

      // ── Build enrichable list for this page ────────────────────────────
      const newUrls = _allChipUrls().filter(
        (u) => u && (u.includes("/in/") || u.includes("/sales/lead/"))
      );
      if (!newUrls.length) break; // no profiles on this page — stop

      let newEnrichable = newUrls.map((u) => ({
        linkedin_url: u,
        full_name: _labelFromUrl(u),
      }));

      if (state.avoidDuplicates) {
        newEnrichable = newEnrichable.filter((e) => !_isContacted(e.linkedin_url));
        if (!newEnrichable.length) {
          flashStatus(`Page ${pageNum}: all ${newUrls.length} already saved — done.`, "ok");
          break;
        }
      }

      enrichable = newEnrichable;
      // Grow the running total so the toolbar counter keeps climbing
      state.bulkProgress = {
        ...state.bulkProgress,
        total: totalProcessed + enrichable.length,
        current: totalProcessed,
      };
      flashStatus(`Page ${pageNum}: saving ${enrichable.length} profile(s)…`);
      renderToolbar();
    }

    state.bulkActive = false;
    state.bulkProgress = null;
    // Clear selections so the toolbar resets to "Save All Leads" and the top
    // pill resets to "☐ Select All" — ready for the next batch immediately.
    state.selectedUrls.clear();
    // Bring the top pill back so the user can run another batch immediately.
    mountSelectAllHeader();
    renderToolbar();

    const pageLabel = pageNum > 1 ? ` across ${pageNum} pages` : "";
    let summary;
    if (cancelled) {
      summary = `Stopped: ${totalEnriched} of ${totalProcessed} enriched${pageLabel}`;
    } else if (rateLimited) {
      summary = `Hit daily limit: ${totalEnriched} of ${totalProcessed} enriched${pageLabel}`;
    } else {
      summary = `Done: ${totalEnriched} of ${totalProcessed} enriched ✓${pageLabel}`;
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
    const buttons = Array.from(card.querySelectorAll("button, a, [role='button']"));
    for (const b of buttons) {
      const aria = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (b.classList.contains("lc-inline-save")) continue;
      if (/\bpending\b/i.test(aria) || /\bpending\b/i.test(txt)) continue;
      // Match a real Connect control by whole-word "Connect" (handles the
      // "+ Connect" rendering) or the "Invite <Name> to connect" aria-label.
      if (/\bconnect\b/i.test(txt) || /\binvite\b.*\bto connect\b/i.test(aria) || /\bconnect\b/i.test(aria)) {
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
    for (const b of card.querySelectorAll("button, a, [role='button']")) {
      if (b.classList.contains("lc-inline-save")) continue;
      const aria = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
      const hay = txt + " || " + aria;
      if (/\bpending\b/i.test(hay)) hasPending = true;
      else if (/\bconnect\b/i.test(hay) || /\binvite\b.*\bto connect\b/i.test(aria)) hasConnect = true;
      else if (/\bfollow\b/i.test(hay)) hasFollow = true; // \bfollow\b excludes "Following"
      else if (/\bmessage\b/i.test(hay)) hasMessage = true;
    }
    if (hasConnect) return "connect";
    if (hasPending) return "pending";
    if (hasFollow) return "follow";
    if (hasMessage) return "connected";
    return "unknown";
  }

  // Classify a SINGLE native button (the exact one the chip sits beside). This
  // is the authoritative signal for Connect All — no card re-scan, no chance of
  // reading a neighbouring row's button.
  function _classifyButton(btn) {
    if (!btn || btn.classList?.contains("lc-inline-save")) return "unknown";
    const aria = (btn.getAttribute("aria-label") || "").trim();
    const txt = (btn.textContent || "").replace(/\s+/g, " ").trim();
    const hay = txt + " || " + aria;
    // Whole-word matching handles the "+ Connect" / "+ Follow" rendering.
    if (/\bpending\b/i.test(hay)) return "pending";
    if (/\bconnect\b/i.test(hay) || /\binvite\b.*\bto connect\b/i.test(aria)) return "connect";
    if (/\bfollow\b/i.test(hay)) return "follow"; // excludes "Following"
    if (/\bmessage\b/i.test(hay)) return "connected";
    return "unknown";
  }

  // The native action button captured for this URL at chip-injection time,
  // only if it's still attached to the live DOM.
  function _actionBtnForUrl(url) {
    const b = chipActionBtn.get(url);
    return b && document.body.contains(b) ? b : null;
  }

  // An element the user can actually see and click (rules out the stale,
  // hidden, detached modal duplicates LinkedIn can leave in the DOM — clicking
  // one of those does nothing while the real visible modal stays open).
  function _isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    return true;
  }

  // Return the VISIBLE "Add a note to your invitation?" modal element, or null.
  function _findInvitationModal() {
    const candidates = document.querySelectorAll(
      "div[role='dialog'], .artdeco-modal, [role='alertdialog']"
    );
    for (const d of candidates) {
      if (!_isVisible(d)) continue;
      const t = (d.textContent || "").toLowerCase();
      if (/add a note to your invitation|send without a note|personalize your invitation/.test(t))
        return d;
    }
    return null;
  }

  // True while the invitation modal is on screen. We consider it open if either
  // a matching dialog node is visible OR a "Send without a note" button is
  // visible — whichever our heuristics catch first. This prevents the watcher
  // from bailing when the dialog's role attribute changes but the button is
  // clearly there.
  function _invitationModalOpen() {
    if (_findInvitationModal()) return true;
    const b = _findSendWithoutNoteButton();
    return !!(b && _isVisible(b));
  }

  // Find the "Send without a note" button. Searches the WHOLE document (not
  // scoped to the modal element — LinkedIn sometimes renders the footer buttons
  // in a sibling node or a separate portal). Prefers a visible button but falls
  // back to any match so we never silently bail when the button is found but our
  // visibility heuristic is overly strict.
  function _findSendWithoutNoteButton() {
    const all = Array.from(
      document.querySelectorAll("button, [role='button'], a[role='button']")
    ).filter((b) => !b.classList?.contains("lc-inline-save"));
    const labelOf = (b) => {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      const a = (b.getAttribute("aria-label") || "").trim();
      return { t, a };
    };
    const tests = [
      (s) => /^send without a note$/i.test(s),
      (s) => /\bsend without a note\b/i.test(s),
      (s) => /^send now$/i.test(s),
      (s) => /^send( invitation)?$/i.test(s),
    ];
    for (const test of tests) {
      const matches = all.filter((b) => {
        const { t, a } = labelOf(b);
        return test(t) || test(a);
      });
      if (!matches.length) continue;
      // Prefer a visible, enabled button; otherwise take the first match.
      const visible = matches.filter((b) => _isVisible(b) && !b.disabled);
      const pick = visible[0] || matches.find((b) => !b.disabled) || matches[0];
      if (pick) return pick;
    }
    // Fallback for redesigned modal (bare "send" CTA, primary button in modal).
    const modal = _findInvitationModal();
    if (modal) {
      for (const sel of [
        ".artdeco-button--primary",
        ".artdeco-modal__actionbar .artdeco-button",
        "[data-test-dialog-primary-btn]",
      ]) {
        try {
          const btn = modal.querySelector(sel);
          if (btn && _isVisible(btn) && !btn.disabled) {
            const { t } = labelOf(btn);
            if (!/(cancel|close|dismiss|back|add.*note|note)/i.test(t)) return btn;
          }
        } catch {}
      }
      // Bare "send" in document — only safe after confirming invite modal is open.
      const sendBtn = all.find((b) => {
        const { t, a } = labelOf(b);
        return (/^send$/i.test(t) || /^send$/i.test(a)) && _isVisible(b) && !b.disabled;
      });
      if (sendBtn) return sendBtn;
    }
    return null;
  }

  // Close any open invitation-modal dialog. Tries the modal's own dismiss button
  // first (artdeco-modal__dismiss or aria-label variations), then falls back to
  // Escape on both the modal element and document.
  function _closeAnyDialog() {
    const modal = _findInvitationModal();
    const closeSelectors =
      ".artdeco-modal__dismiss, button[aria-label='Dismiss'], " +
      "button[aria-label*='Dismiss' i], button[aria-label*='Close' i]";
    const close =
      (modal && modal.querySelector(closeSelectors)) ||
      document.querySelector(closeSelectors);
    if (close) {
      try { close.click(); } catch {}
    }
    // Also dispatch Escape on the modal itself and on document — LinkedIn's
    // focus-trap keydown handler usually lives on the modal container.
    try {
      if (modal) modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } catch {}
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {}
  }

  // Fire a full pointer/mouse event sequence on a single element at its centre.
  function _dispatchPointerSequence(el) {
    try {
      const r = el.getBoundingClientRect();
      const o = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new PointerEvent("pointerenter", o));
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
    } catch {}
  }

  // Click an element as reliably as possible. LinkedIn's button handler may be
  // bound to the <button>, to an inner <span>, or driven by keyboard activation,
  // so we try ALL of: native .click(), a pointer/mouse sequence on the button AND
  // its first child span, and an Enter/Space keydown — until something lands.
  function _forceClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
    try { el.focus(); } catch {}
    // 1. The simplest path React/Ember honour even for untrusted events.
    try { el.click(); } catch {}
    // 2. Full pointer/mouse sequence on the button itself.
    _dispatchPointerSequence(el);
    // 3. Same sequence on the inner label span (some handlers sit on the child).
    try {
      const inner = el.querySelector("span, .artdeco-button__text");
      if (inner && inner !== el) {
        inner.click?.();
        _dispatchPointerSequence(inner);
      }
    } catch {}
    // 4. Keyboard activation — buttons fire their action on Enter/Space too.
    try {
      const kopts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", kopts));
      el.dispatchEvent(new KeyboardEvent("keyup", kopts));
    } catch {}
    // 5. Direct React fiber call — bypasses the DOM event system. When LinkedIn
    // checks event.isTrusted, synthetic DOM events always fail (isTrusted=false).
    // Calling the React onClick prop directly with isTrusted=true in a plain
    // object passes that check. Walk up the fiber tree to find the handler even
    // when it's on a parent wrapper component.
    try {
      const fKey = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (fKey) {
        let fiber = el[fKey];
        for (let depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
          const onClick =
            fiber.memoizedProps?.onClick || fiber.pendingProps?.onClick;
          if (typeof onClick === "function") {
            onClick({
              type: "click", bubbles: true, cancelable: true,
              isTrusted: true, target: el, currentTarget: el,
              preventDefault: () => {}, stopPropagation: () => {},
              nativeEvent: { isTrusted: true },
            });
            break;
          }
        }
      }
    } catch {}
  }

  // The complete Connect flow for ONE card, as a plain linear sequence:
  //   STEP 1 — click the card's "Connect" button.
  //   STEP 2 — wait for the "Add a note to your invitation?" dialog to open.
  //   STEP 3 — click "Send without a note".
  //   STEP 4 — confirm the dialog closed (= the invite was actually sent).
  // This function is the SINGLE owner of the sequence during a Connect All run;
  // the global auto-confirm watcher stands down while `state.connectActive` is
  // true (see _autoConfirmInviteModal) so nothing double-clicks.
  async function _sendConnectOnCard(card, presetBtn) {
    const { dispatchHumanClick } = globalThis.__lcDom;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- STEP 1: click Connect -------------------------------------------
    const connectBtn =
      presetBtn && document.body.contains(presetBtn)
        ? presetBtn
        : _findConnectButtonInCard(card);
    if (!connectBtn) return { ok: false, reason: "no_connect_button" };
    console.log("[LeadCaptura] step 1 → click Connect");
    await dispatchHumanClick(connectBtn);

    // ---- STEP 2: wait for the invitation dialog (up to 8s) ----------------
    let dialogOpen = false;
    for (let i = 0; i < 32; i++) {
      await sleep(250);
      if (_invitationModalOpen()) { dialogOpen = true; break; }
    }
    if (!dialogOpen) {
      // No dialog appeared. Some connections (e.g. people who already follow
      // you) complete instantly with no "add a note" step — if the row no
      // longer offers Connect, treat it as done; otherwise report no-dialog.
      const cls = _classifyButton(connectBtn);
      if (cls === "pending" || cls === "connected") return { ok: true };
      console.log("[LeadCaptura] step 2 → no dialog opened after 8s");
      return { ok: false, reason: "no_dialog" };
    }
    console.log("[LeadCaptura] step 2 → dialog opened");

    // ---- STEP 3 + 4: click "Send without a note", confirm it closes -------
    // Nuclear approach: highlight the button visually, try every 200ms using
    // all click strategies including MAIN-world injection and SW executeScript.
    for (let attempt = 0; attempt < 18 && _invitationModalOpen(); attempt++) {
      const sendBtn = _findSendWithoutNoteButton();
      if (!sendBtn) {
        await sleep(200);
        continue;
      }
      if (attempt === 0) {
        _highlightSendBtn(sendBtn);
        _tryServiceWorkerMainWorldClick();
      }
      console.log("[LeadCaptura] step 3 → click Send without a note (try", attempt + 1, ")");
      _forceClick(sendBtn);
      if (attempt % 2 === 0) _tryMainWorldClick(sendBtn);
      for (let w = 0; w < 10; w++) {
        await sleep(200);
        if (!_invitationModalOpen()) {
          console.log("[LeadCaptura] step 4 → dialog closed, invitation sent ✓");
          _removeSendBtnHighlight();
          return { ok: true };
        }
      }
    }

    _removeSendBtnHighlight();
    if (!_invitationModalOpen()) return { ok: true };
    console.log("[LeadCaptura] step 3/4 → could not send, giving up");
    return { ok: false, reason: "send_failed" };
  }

  // Click a card's native "Follow" button (no modal). Used by Connect All for
  // rows where LinkedIn offers Follow instead of Connect — the user wants those
  // followed automatically rather than skipped.
  async function _sendFollowOnCard(card, presetBtn) {
    const { dispatchHumanClick } = globalThis.__lcDom;
    const { sleep } = globalThis.__lcHuman;
    const btn =
      presetBtn && document.body.contains(presetBtn)
        ? presetBtn
        : Array.from(card ? card.querySelectorAll("button") : []).find((b) => {
            if (b.classList.contains("lc-inline-save")) return false;
            const aria = (b.getAttribute("aria-label") || "").trim();
            const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
            return /^follow$/i.test(txt) || /^follow\b/i.test(aria) || /\bfollow\b/i.test(aria);
          });
    if (!btn) return { ok: false, reason: "no_follow_button" };
    await dispatchHumanClick(btn);
    await sleep(450 + Math.random() * 400);
    return { ok: true, followed: true };
  }

  function _cardForUrl(url) {
    // Prefer the exact card element captured when the chip was injected — it
    // is the authoritative single-profile card boundary the detector resolved.
    const exact = chipCardEl.get(url);
    if (exact && document.body.contains(exact)) return exact;
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
    const firstLink = document.querySelector("a[href*='/in/']");
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
      const count = document.querySelectorAll("a[href*='/in/']").length;
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

  // Bulk connect via profile-page navigation.
  //
  // Each profile is opened in the SAME tab. The actual connect flow runs in
  // main.js (maybeRunConnectQueue) which picks up from chrome.storage.local
  // after each navigation and drives the "click Connect → Send without a note"
  // sequence on the profile page. When all profiles are done, main.js
  // navigates back to this search URL automatically.
  //
  // Why profile pages instead of inline search-card buttons? The search-card
  // "Connect" button is a simplified control that does NOT always open the
  // "Add a note?" modal reliably. The full-page profile button is the one
  // LinkedIn's own UX always uses, and it consistently triggers the modal.
  // In-page gap between consecutive connect actions. Same 4-tier human-paced
  // distribution the profile-navigation queue used (5-10s / 11-19s / 21-33s /
  // 38-60s) — fast enough to feel responsive, slow + varied enough to stay
  // under LinkedIn's bot radar. Do not flatten this into a fixed delay.
  function _connectGap() {
    const r = Math.random();
    return r < 0.60 ? 5000 + Math.random() * 5000
      : r < 0.82 ? 11000 + Math.random() * 8000
      : r < 0.93 ? 21000 + Math.random() * 12000
      : 38000 + Math.random() * 22000;
  }

  async function connectAllVisible() {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick } = globalThis.__lcDom;
    const Api = globalThis.__lcApi;

    const userSelected = state.selectedUrls.size > 0;
    // Auto-paginate only in "Connect All" (no explicit selection) — when the
    // user ticked specific cards, connect exactly those and stop.
    const autoPage = !userSelected;

    let urls = (
      userSelected ? Array.from(state.selectedUrls) : _allChipUrls()
    ).filter((u) => u && (u.includes("/in/") || u.includes("/sales/lead/")));

    if (!urls.length) {
      flashStatus("No profiles selected to connect with", "warn");
      return;
    }
    urls = urls.map((u) => {
      try { return new URL(u, "https://www.linkedin.com").href; }
      catch { return u; }
    });

    state.connectActive = true;
    state.connectCancel = false;
    unmountSelectAllHeader();
    renderToolbar();

    let sent = 0, followed = 0, skipped = 0, failed = 0, processed = 0, pageNum = 1;
    const summarise = () =>
      `Connect All: ${sent} invited` +
      (followed ? `, ${followed} followed` : "") +
      `, ${skipped} skipped` +
      (failed ? `, ${failed} failed` : "");

    try {
      outer:
      while (true) {
        for (const url of urls) {
          if (state.connectCancel) break outer;

          // Avoid Duplicate Outreach: skip people already contacted.
          if (state.avoidDuplicates && _isContacted(url)) {
            skipped++;
            _setChipState(url, "saved", "Already contacted");
            continue;
          }

          const card = _cardForUrl(url);
          const presetBtn = _actionBtnForUrl(url) || (card ? _findConnectButtonInCard(card) : null);
          const cls = presetBtn ? _classifyButton(presetBtn) : (card ? _cardConnectState(card) : "unknown");

          // Already pending / connected → nothing to do.
          if (cls === "pending") { skipped++; _setChipState(url, "saved", "Pending"); continue; }
          if (cls === "connected") { skipped++; _setChipState(url, "saved", "Connected"); continue; }
          if (cls === "unknown" || !card) { skipped++; continue; }

          processed++;
          _setChipState(url, "saving", "Connecting…");

          let result;
          if (cls === "follow") {
            result = await _sendFollowOnCard(card, presetBtn);
          } else {
            // Bring the row into view so the modal's buttons get valid coordinates,
            // then run the proven click-Connect → "Send without a note" sequence.
            try { (presetBtn || card).scrollIntoView({ block: "center", inline: "center" }); } catch {}
            await sleep(300 + Math.random() * 300);
            result = await _sendConnectOnCard(card, presetBtn);
          }

          if (result.ok) {
            if (result.followed) { followed++; _setChipState(url, "saved", "Followed ✓"); }
            else { sent++; _setChipState(url, "saved", "Invited ✓"); }
            _markContacted(url);
            try { Api?.connectResult?.(url, result.followed ? "followed" : "connected").catch(() => {}); } catch {}
          } else {
            failed++;
            _setChipState(url, "error", "Skipped");
            // Make sure a leftover dialog never blocks the next card.
            if (_invitationModalOpen()) _closeAnyDialog();
          }

          flashStatus(`${summarise()} (${processed})`);
          if (state.connectCancel) break outer;
          await sleep(_connectGap());
        }

        // ---- advance to the next results page (Connect All mode only) --------
        if (!autoPage || state.connectCancel) break;
        const nextBtn = _findNextPageButton();
        if (!nextBtn) break;
        const sig = _pageSignature();
        try { nextBtn.scrollIntoView({ block: "center" }); } catch {}
        await sleep(400 + Math.random() * 400);
        await dispatchHumanClick(nextBtn);
        // Wait for the page to actually change (signature flip), up to ~12s.
        let changed = false;
        for (let i = 0; i < 40 && !state.connectCancel; i++) {
          await sleep(300);
          if (_pageSignature() !== sig) { changed = true; break; }
        }
        if (!changed || state.connectCancel) break;
        await _scrollLoadPage();
        decorateSearchCards();
        await sleep(800 + Math.random() * 600);
        pageNum++;
        urls = _allChipUrls()
          .filter((u) => u && (u.includes("/in/") || u.includes("/sales/lead/")))
          .map((u) => { try { return new URL(u, "https://www.linkedin.com").href; } catch { return u; } });
        if (!urls.length) break;
      }
    } finally {
      state.connectActive = false;
      state.connectCancel = false;
      mountSelectAllHeader();
      renderToolbar();
    }
    const pageLabel = pageNum > 1 ? ` across ${pageNum} pages` : "";
    flashStatus(`Connect All done: ${summarise()}${pageLabel} ✓`, "ok");
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

    // STRATEGY A — explicit job-id attributes + known card containers. This is
    // the most reliable detector and works identically on the collections
    // ("see all") page AND the search-box results page (origin=JOB_COLLECTION_PAGE),
    // since both set data-occludable-job-id on the list <li>. Run it ALWAYS, not
    // just as a fallback — the Dismiss-button climb below doesn't resolve the
    // card unit on every layout, so id-based detection must always participate.
    document
      .querySelectorAll(
        "li[data-occludable-job-id], li[data-job-id], div[data-job-id], " +
        "[data-occludable-job-id], " +
        "li.scaffold-layout__list-item, li.jobs-search-results__list-item, " +
        "li.discovery-templates-entity-item, " +
        "div[class*='job-card-container'], div[class*='job-card-job-posting-card'], " +
        "div[class*='jobs-job-board-list__item']"
      )
      .forEach((c) => { if (!_inDetailPane(c)) add(c); });

    // STRATEGY B — one card per Dismiss "X". Catches layouts where a card
    // exposes no job link or data-id. Climbs to the repeated card unit.
    document.querySelectorAll("button[aria-label*='Dismiss' i]").forEach((btn) => {
      if (_inDetailPane(btn)) return;
      add(_cardFromDismiss(btn));
    });

    // STRATEGY C — title links, as a last supplement for sparse layouts.
    if (boxes.length === 0) {
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
      // Clean up when: node missing, card missing, card left DOM, card is in
      // the detail pane, OR the node is no longer inside the tracked card
      // (e.g. LinkedIn re-rendered the card's inner DOM).
      if (!node || !card || !document.body.contains(card) || _inDetailPane(card) || !card.contains(node)) {
        injectedJobChips.delete(key);
        _jobChipCards.delete(key);
        _jobChipApplyUrls.delete(key);
        try { if (node) node.remove(); } catch {}
        // Also sweep any orphan chips that may have been left in the card DOM.
        if (card && document.body.contains(card)) {
          card.querySelectorAll(".lc-job-apply-row").forEach(n => { try { n.remove(); } catch {} });
        }
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
  // Chips are injected INLINE directly into the card DOM (same pattern as the
  // people-search Save chip) rather than a fixed-position portal — this is more
  // reliable across LinkedIn's many card layouts and requires no coordinate sync.
  function decorateJobCards() {
    if (!_isJobsPage()) return;
    _gcJobChips();
    const cards = _jobCardEls();
    let created = 0;
    for (const card of cards) {
      try {
        const key = _jobCardKey(card);
        if (!key) continue;

        _jobChipCards.set(key, card);
        _jobChipApplyUrls.set(key, _jobApplyUrlFromCard(card));
        if (injectedJobChips.has(key)) continue;
        // Hard-remove any orphan chips already in the card DOM before injecting
        // a fresh one — guards against LinkedIn re-rendering card internals while
        // the map entry was still live.
        card.querySelectorAll(".lc-job-apply-row").forEach(n => { try { n.remove(); } catch {} });

        const textSpan = el("span", { class: "lc-inline-save-text" }, "Auto Apply");
        const btn = el(
          "button",
          { class: "lc-inline-save", type: "button",
            title: "Auto-apply to this job — one click runs every page of the application and submits" },
          textSpan
        );
        btn.dataset.state = "ready";
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.applyActive || btn.dataset.state === "saving") return;
          await applyAllJobs([key]);
        });

        // One button per card — a single click fully automates the whole
        // multi-page Easy Apply flow for this job (no checkbox, no per-page
        // re-clicks). Bulk selection lives in the bottom toolbar's Apply All.
        const wrap = el("div", { class: "lc-job-apply-row" }, btn);
        wrap.dataset.lcKey = key;

        // Best injection point (in priority order):
        //   1. Just after the card's metadata/footer row (time posted + Easy Apply badge)
        //   2. Before the Dismiss "X" button (always present, most reliable fallback)
        //   3. Append to card as last resort
        const metaRow = card.querySelector(
          ".job-card-container__footer-wrapper, .job-card-list__footer-wrapper, " +
          ".job-card-container__metadata-wrapper, .artdeco-entity-lockup__metadata, " +
          "[class*='footer'], [class*='metadata'], .jobs-unified-top-card__job-insight"
        );
        const dismissBtn = card.querySelector("button[aria-label*='Dismiss' i]");
        if (metaRow && metaRow.parentElement) {
          metaRow.parentElement.insertBefore(wrap, metaRow.nextSibling || null);
        } else if (dismissBtn && dismissBtn.parentElement) {
          dismissBtn.parentElement.insertBefore(wrap, dismissBtn);
        } else {
          card.appendChild(wrap);
        }

        injectedJobChips.set(key, wrap);
        created++;
      } catch (e) {
        console.warn("[LeadCaptura] decorateJobCards failed", e?.message);
      }
    }
    if (cards.length || created) {
      console.log(`[LeadCaptura] jobs: ${cards.length} cards detected, ${injectedJobChips.size} chips live (+${created} new)`);
    }
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
    // 1. Dialog/modal overlay — the popup form on search-results and the
    //    inline job-view modal.
    const dialog =
      document.querySelector("div.jobs-easy-apply-modal") ||
      document.querySelector("div[data-test-modal][role='dialog']") ||
      document.querySelector(".artdeco-modal[role='dialog']") ||
      Array.from(document.querySelectorAll("div[role='dialog'], [role='alertdialog']")).find(
        (d) =>
          /easy apply|application|apply to/i.test(d.getAttribute("aria-label") || "") ||
          /easy apply|application/i.test(d.getAttribute("aria-labelledby") ? (document.getElementById(d.getAttribute("aria-labelledby"))?.innerText || "") : "") ||
          d.querySelector(".jobs-easy-apply-content, .jobs-easy-apply-form, .jobs-apply-form")
      );
    if (dialog) return dialog;

    // 2. Full-page Easy Apply (URL = /jobs/view/<id>/apply/). The form is
    //    rendered inline, NOT inside a [role='dialog'], so the checks above miss
    //    it and the stepper has nothing to click. Anchor on the apply content
    //    container's nearest layout ancestor so _modalActionButton can still
    //    reach the Next/Submit footer (which is a sibling of the form).
    const content = document.querySelector(
      ".jobs-easy-apply-content, .jobs-easy-apply-form, .jobs-apply-form, " +
      ".job-details-easy-apply-content, form.jobs-easy-apply-form-element"
    );
    if (content) {
      return content.closest("main, .scaffold-layout, .application-outlet") || content.parentElement || content;
    }
    // 3. Full-page Easy Apply (URL = /jobs/view/<id>/apply/) where the form is
    //    NOT in a dialog and uses no recognizable container class. Anchor on the
    //    visible primary action button (Next / Review / Submit application) and
    //    return a container that holds both it and the form. This is layout-
    //    agnostic — it works no matter what wrapper classes LinkedIn ships.
    const onApplyPath = /\/apply\b/.test(location.pathname);
    const actionBtn = Array.from(document.querySelectorAll("button, [role='button']")).find((b) => {
      if (!_isVisible(b)) return false;
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      return (
        /^(next|continue to next step|review|review your application|submit|submit application|done)$/i.test(t) ||
        /continue to next step|submit application|review your application/i.test(a)
      );
    });
    if (onApplyPath || actionBtn) {
      if (actionBtn) {
        return (
          actionBtn.closest(
            "form, main, .scaffold-layout, .application-outlet, [class*='easy-apply'], [class*='apply']"
          ) || document.querySelector("main") || document.body
        );
      }
      return document.querySelector("main") || document.body;
    }
    return null;
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
    const _hasLinkedInIcon = (b) =>
      !!b.querySelector(
        "li-icon[type*='linkedin' i], svg[data-test-icon*='linkedin' i], " +
        "[data-test-icon*='linkedin' i], [class*='linkedin-bug'], use[href*='linkedin' i]"
      );
    const _isExternalBtn = (b) => {
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      return /company website|apply on company website|apply externally|on company site/i.test(t) ||
             /company website|apply externally/i.test(a);
    };
    // In-app apply button. Handles BOTH the old "Easy Apply" label and the new
    // (2026) LinkedIn rename where the in-app button is just "Apply" /
    // "LinkedIn Apply". A plain "Apply" only counts as in-app when it's the real
    // apply control (class jobs-apply-button, inside a jobs-apply container, or
    // carrying the LinkedIn bug icon) so we never match the "Apply" filter chip.
    const _isEasyApplyBtn = (b) => {
      if (_isExternalBtn(b)) return false;
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      if (/easy apply|linkedin apply/i.test(t) || /easy apply|linkedin apply/i.test(a)) return true;
      const isApplyWord = /^apply$/i.test(t) || /^apply\b/i.test(a) || /^apply to /i.test(a);
      const isInApp =
        b.classList.contains("jobs-apply-button") ||
        !!b.closest(".jobs-apply-button__container, [class*='jobs-apply']") ||
        _hasLinkedInIcon(b);
      return isApplyWord && isInApp;
    };
    const _isAppliedBtn = (b) => {
      const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
      const a = b.getAttribute("aria-label") || "";
      return /\bapplied\b/i.test(t) || /\bapplied\b/i.test(a);
    };

    // Fast path: specific selectors for known LinkedIn container class names.
    const cands = Array.from(
      document.querySelectorAll(
        "button.jobs-apply-button, button[aria-label*='Easy Apply' i], " +
        "button[data-control-name*='apply' i], " +
        ".jobs-apply-button--top-card button, .jobs-s-apply button, " +
        ".jobs-unified-top-card button, .jobs-details-top-card button, " +
        "div[class*='jobs-apply'] button, div[class*='top-card-layout'] button, " +
        ".job-details-jobs-unified-top-card__container--two-pane button, " +
        ".jobs-unified-top-card__content--two-pane button, " +
        ".jobs-apply-button__container button"
      )
    ).filter(_isVisible);

    for (const b of cands) {
      if (_isEasyApplyBtn(b)) return { status: "easy", btn: b };
    }
    for (const b of cands) {
      if (_isAppliedBtn(b)) return { status: "applied", btn: null };
      if (_isExternalBtn(b)) return { status: "external", btn: null };
    }

    // Broad fallback: scan EVERY visible button in the document.
    // LinkedIn renames container classes often; the button text is stable.
    const allBtns = Array.from(document.querySelectorAll("button")).filter(_isVisible);
    for (const b of allBtns) {
      if (_isEasyApplyBtn(b)) return { status: "easy", btn: b };
    }

    // Also check static "Applied" and "External" badges that aren't buttons.
    const applied = Array.from(document.querySelectorAll(
      "button[aria-label*='Applied' i], span[class*='applied'], .jobs-apply-button--applied, " +
      "[aria-label*='Applied' i], .jobs-apply-button--applied-state"
    )).filter(_isVisible);
    if (applied.length) return { status: "applied", btn: null };

    const bodyTxt = (document.querySelector(
      ".jobs-s-apply, .jobs-details, .job-view-layout, " +
      ".job-details-jobs-unified-top-card__container--two-pane"
    )?.innerText || "");
    if (/\bapplied\b/i.test(bodyTxt) && !allBtns.some(_isEasyApplyBtn)) {
      return { status: "applied", btn: null };
    }
    for (const b of allBtns) {
      if (_isExternalBtn(b)) return { status: "external", btn: null };
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
    const match = (b, re) =>
      re.test((b.getAttribute("aria-label") || "")) ||
      re.test((b.innerText || b.textContent || "").replace(/\s+/g, " ").trim());
    const SKIP = new Set(["back", "dismiss", "discard", "cancel", "close", "previous"]);

    // Resolve the action button within a given scope. Submit/Review/Next take
    // priority (in that order); then an artdeco primary; then any non-dismiss
    // button as a last resort.
    const pick = (scope) => {
      if (!scope) return null;
      const btns = Array.from(scope.querySelectorAll("button")).filter(_isVisible);
      let b;
      if ((b = btns.find((x) => match(x, /submit application|^submit$/i)))) return { type: "submit", btn: b };
      if ((b = btns.find((x) => match(x, /review your application|^review$/i)))) return { type: "review", btn: b };
      if ((b = btns.find((x) => match(x, /continue to next step|^next$|^continue$|^done$|next step|^save$/i)))) return { type: "next", btn: b };
      const primary = btns.find((x) => {
        const t = (x.innerText || x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!t || SKIP.has(t)) return false;
        return x.classList.contains("artdeco-button--primary") || x.classList.contains("artdeco-button--3");
      });
      if (primary) return { type: "next", btn: primary };
      return null;
    };

    // Try the footer/action-bar first (tight scope), but if it yields nothing
    // actionable — which happens on the full-page apply layout where the wrong
    // [class*='footer'] can match — fall back to the whole container.
    const footer = modal.querySelector(
      "footer, .jobs-easy-apply-modal__action-bar, [class*='action-bar'], [class*='footer'], " +
      ".artdeco-modal__actionbar, [data-test-modal-footer]"
    );
    const result = pick(footer) || pick(modal);
    if (result) return result;

    // Absolute last resort: any visible non-dismiss button anywhere in the modal.
    const fallback = Array.from(modal.querySelectorAll("button")).filter(_isVisible).find((x) => {
      const t = (x.innerText || x.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return !!t && !SKIP.has(t);
    });
    return fallback ? { type: "next", btn: fallback } : null;
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

  // The "Save this application?" / "Discard application?" confirmation button.
  // LinkedIn varies the dialog's role and the button's data-control-name, so we
  // match the visible "Discard" label too.
  function _discardConfirmButton() {
    const byAttr = document.querySelector(
      "button[data-control-name='discard_application_confirm_btn']"
    );
    if (byAttr && _isVisible(byAttr)) return byAttr;
    return (
      Array.from(
        document.querySelectorAll(
          "div[role='alertdialog'] button, div[role='dialog'] button, .artdeco-modal button"
        )
      ).find(
        (b) =>
          _isVisible(b) &&
          /^discard$/i.test((b.innerText || b.textContent || "").replace(/\s+/g, " ").trim())
      ) || null
    );
  }

  // Close an in-progress Easy Apply flow and confirm the discard. Both the
  // Dismiss (X) and the "Discard" confirmation are React-controlled, so a plain
  // .click() is unreliable — use _forceClick (5 strategies) and verify the
  // dialog actually closed. If we leave a blocking "Save this application?"
  // dialog open, every subsequent job fails to open and the whole run stalls.
  async function _dismissEasyApplyModal() {
    const { sleep } = globalThis.__lcHuman;
    for (let round = 0; round < 5; round++) {
      // If the discard confirmation is already up, clear it first.
      const discard = _discardConfirmButton();
      if (discard) {
        _forceClick(discard);
        await sleep(500 + Math.random() * 400);
        continue;
      }
      // Otherwise, if the Easy Apply modal is open, click its Dismiss (X) to
      // raise the confirmation, then the next round will click Discard.
      const modalOpen = !!_easyApplyModal();
      if (modalOpen) {
        const dismiss =
          document.querySelector("button[aria-label='Dismiss']") ||
          document.querySelector("button[aria-label*='Dismiss' i]");
        if (dismiss && _isVisible(dismiss)) {
          _forceClick(dismiss);
          await sleep(500 + Math.random() * 400);
          continue;
        }
      }
      // Nothing left to dismiss — we're done.
      if (!modalOpen && !_discardConfirmButton()) return;
      await sleep(400);
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

    // LinkedIn ARIA combobox / custom dropdowns (not native <select>).
    // These render as [role='combobox'] or .artdeco-dropdown wrappers; clicking
    // the trigger opens a [role='listbox'] and each option is [role='option'].
    const combos = Array.from(modal.querySelectorAll(
      "[role='combobox']:not([type='text']):not([type='search']), " +
      ".artdeco-dropdown__trigger, [data-test-text-entity-list-form-select]"
    )).filter((el) => _isVisible(el) && !el.disabled);
    for (const trigger of combos) {
      const wrap = trigger.closest(
        ".artdeco-dropdown, [data-test-form-element], .fb-dash-form-element, " +
        ".jobs-easy-apply-form-element"
      ) || trigger.parentElement;
      const label = _fieldLabelFor(trigger) || _fieldLabelFor(wrap);
      const currentVal = (trigger.getAttribute("aria-activedescendant") ? "" :
        trigger.textContent || trigger.value || "").trim();
      const isPlaceholder = !currentVal || /^(select|choose|please|--)/.test(currentVal);
      if (!isPlaceholder) continue;
      // Collect options from any open or triggerable listbox.
      const getOptions = () => {
        const lb = document.querySelector("[role='listbox']") ||
          wrap?.querySelector("[role='listbox']");
        if (!lb) return [];
        return Array.from(lb.querySelectorAll("[role='option']"))
          .map((o) => (o.innerText || o.textContent || "").trim())
          .filter(Boolean);
      };
      try { trigger.click(); } catch {}
      await sleep(400 + Math.random() * 300);
      let opts = getOptions();
      if (!opts.length) {
        _forceClick(trigger);
        await sleep(500);
        opts = getOptions();
      }
      if (!opts.length) continue;
      let ans = _matchProfileAnswer(label, profile, "select", opts);
      if (ans == null) ans = await askGemini(label, "select", opts);
      const pick = ans ? _pickOption(opts, ans) : null;
      if (pick) {
        const lb = document.querySelector("[role='listbox']") || wrap?.querySelector("[role='listbox']");
        if (lb) {
          const opt = Array.from(lb.querySelectorAll("[role='option']"))
            .find((o) => (o.innerText || o.textContent || "").trim() === pick);
          if (opt) {
            try { opt.click(); } catch {}
            await sleep(200 + Math.random() * 200);
          }
        }
      } else {
        // Close the dropdown without selecting anything (press Escape).
        try { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch {}
        await sleep(200);
      }
    }
  }

  // Step through the open Easy Apply modal. Returns {ok, reason}.
  async function _runEasyApplyModal() {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick, waitFor } = globalThis.__lcDom;

    // Wait up to 10s for the modal — LinkedIn can be slow to open it.
    let modal = await waitFor(
      ["div.jobs-easy-apply-modal", "div[data-test-modal][role='dialog']",
       ".artdeco-modal[role='dialog']", "div[role='dialog']"],
      { timeout: 10000 }
    );
    modal = _easyApplyModal() || modal;
    if (!modal) {
      console.log("[LeadCaptura] easy-apply: form/modal not found after click — skipping job");
      return { ok: false, reason: "modal_not_found" };
    }
    // Extra settle time — LinkedIn animates the modal in.
    await sleep(600 + Math.random() * 400);

    const MAX_STEPS = 20;
    let consecutiveStuck = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (state.applyCancel) return { ok: false, reason: "cancelled" };
      if (_challengeOnPage()) return { ok: false, reason: "captcha_or_checkpoint" };
      modal = _easyApplyModal() || modal;
      if (!modal) return { ok: false, reason: "modal_closed" };

      // Keep a resume selected + don't auto-follow companies.
      _ensureResumeSelected(modal);
      _uncheckFollow(modal);
      // Auto-fill this step's questions.
      try { await _answerModalQuestions(modal); }
      catch (e) { console.warn("[LeadCaptura] question auto-fill failed", e?.message); }
      await sleep(500 + Math.random() * 500);

      const action = _modalActionButton(modal);
      console.log(`[LeadCaptura] easy-apply step ${step + 1}: page="${_modalHeading(modal) || "?"}" progress=${_modalProgress(modal)}% action=${action ? action.type : "NONE"}`);
      if (!action) {
        console.log("[LeadCaptura] easy-apply: no Next/Submit button found on this page — discarding");
        await _dismissEasyApplyModal();
        return { ok: false, reason: "no_action_button" };
      }

      // Snapshot helper — used to tell whether a click actually moved the modal.
      const snap = (m) => ({
        progress: _modalProgress(m),
        heading: _modalHeading(m),
        html: m?.querySelector("form, .jobs-easy-apply-form-section, [class*='content']")?.innerHTML?.slice(0, 300) || "",
      });

      if (action.type === "submit") {
        // Human-paced click first — this is what v1.0.47 used and what LinkedIn's
        // handlers reliably honour. Escalate to _forceClick only if it didn't land.
        await dispatchHumanClick(action.btn);
        await sleep(1800 + Math.random() * 1200);
        let after = _easyApplyModal();
        if (after && _modalActionButton(after)?.type === "submit") {
          _forceClick(action.btn);
          await sleep(1800 + Math.random() * 1200);
          after = _easyApplyModal();
        }
        if (!after) return { ok: true }; // modal closed = submitted
        const txt = (after.innerText || after.textContent || "").toLowerCase();
        const isSuccess =
          /application was sent|you.ve applied|application submitted|successfully applied|your application/i.test(txt) ||
          !!after.querySelector(
            ".jobs-easy-apply-modal--confirmation, [class*='application-confirmation'], " +
            "[class*='success-banner'], progress[value='100']"
          );
        await _dismissEasyApplyModal();
        return isSuccess ? { ok: true } : { ok: false, reason: "submit_failed" };
      }

      // Advance (next / review). Snapshot first so we can detect movement.
      const before = snap(modal);
      // Reading pause before clicking.
      await sleep(600 + Math.random() * 700);

      // Did the modal move past `before`?
      const progressed = (m) => {
        if (!m) return true; // modal gone = advanced/closed
        const act = _modalActionButton(m);
        const movedToSubmit = act && (act.type === "submit" || act.type === "review") && action.type === "next";
        const cur = snap(m);
        return (
          movedToSubmit ||
          (before.progress != null && cur.progress != null && cur.progress > before.progress) ||
          (before.heading && cur.heading && cur.heading !== before.heading) ||
          (cur.html !== before.html)
        );
      };

      // Primary: human-paced click (v1.0.47 behavior).
      await dispatchHumanClick(action.btn);
      await sleep(1300 + Math.random() * 900);
      let after = _easyApplyModal();
      if (!after) return { ok: false, reason: "modal_vanished" };

      // Fallback: if it didn't move, escalate to the 5-strategy force click.
      if (!progressed(after)) {
        _forceClick(action.btn);
        await sleep(1300 + Math.random() * 900);
        after = _easyApplyModal();
        if (!after) return { ok: false, reason: "modal_vanished" };
      }

      const errorShown = !!after.querySelector(
        ".artdeco-inline-feedback--error, [role='alert'], .fb-form-element__error-text, " +
        ".jobs-easy-apply-form-element__error, [class*='error-text']"
      );

      if (!progressed(after)) {
        // Still on the same page after both click attempts. If LinkedIn is
        // showing a validation error, or we've been stuck several times, this
        // job needs input we can't safely provide — discard and move on.
        consecutiveStuck++;
        if (errorShown || consecutiveStuck >= 3) {
          await _dismissEasyApplyModal();
          return { ok: false, reason: "needs_manual_input" };
        }
        await sleep(1000);
        continue;
      }
      consecutiveStuck = 0;
    }
    await _dismissEasyApplyModal();
    return { ok: false, reason: "too_many_steps" };
  }

  // Stable fingerprint for whatever job is currently shown in the detail pane.
  // Uses the URL's currentJobId/path first; falls back to the visible job title.
  function _detailPaneFingerprint() {
    try {
      const u = new URL(location.href);
      const cj = u.searchParams.get("currentJobId");
      if (cj) return "id:" + cj;
      const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
      if (m) return "id:" + m[1];
    } catch {}
    const h = document.querySelector(
      ".jobs-search__job-details h1, .scaffold-layout__detail h1, " +
      ".jobs-unified-top-card__job-title, [class*='top-card'] h1, " +
      ".jobs-details-top-card__job-title"
    );
    const title = (h?.innerText || "").trim();
    return title ? "title:" + title : "";
  }

  // Open one job's detail pane (clicks its card link) and wait until the detail
  // actually reflects THIS job — otherwise a slow detail-pane update could make
  // us click Easy Apply on the previously-open job.
  async function _openJobDetail(card, expectedId) {
    const { sleep } = globalThis.__lcHuman;
    const { dispatchHumanClick } = globalThis.__lcDom;
    // Prefer a real job link; otherwise click the card's title/clickable area.
    const link =
      card.querySelector("a.job-card-container__link, a.job-card-list__title, a[href*='/jobs/view/']") ||
      card.querySelector("a[href*='/jobs/']") ||
      card.querySelector("a, [class*='title'], strong, h3") ||
      card;
    try { card.scrollIntoView({ block: "center" }); } catch {}
    await sleep(400 + Math.random() * 500);

    // Snapshot what's currently in the detail pane BEFORE clicking so we can
    // tell when it actually updates to the new job. Without this, a stale
    // "Easy Apply" button from the previously-open job would make us proceed
    // immediately without waiting for the correct job to load.
    const prevFingerprint = _detailPaneFingerprint();

    // Single controlled click — do NOT double-click (dispatchHumanClick + _forceClick)
    // because two rapid clicks confuse LinkedIn's SPA router and may close the pane.
    try { await dispatchHumanClick(link); } catch { try { link.click(); } catch {} }

    const _urlMatchesJob = () => {
      if (!expectedId) return false;
      try {
        const u = new URL(location.href);
        if (u.searchParams.get("currentJobId") === expectedId) return true;
        const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
        if (m && m[1] === expectedId) return true;
      } catch {}
      return false;
    };

    const _easyApplyVisible = () =>
      Array.from(document.querySelectorAll("button")).some((b) => {
        if (!_isVisible(b)) return false;
        const t = (b.innerText || b.textContent || "").replace(/\s+/g, " ").trim();
        const a = b.getAttribute("aria-label") || "";
        return /easy apply/i.test(t) || /easy apply/i.test(a);
      });

    const start = Date.now();
    // Wait up to 8s. Accept either:
    //   - URL now references the expected job id, OR
    //   - The detail pane fingerprint changed AND an Easy Apply button is visible.
    // The fingerprint check prevents acting on the previous job's stale button.
    while (Date.now() - start < 8000) {
      if (state.applyCancel) return false;
      if (_urlMatchesJob()) break;
      const curFp = _detailPaneFingerprint();
      const paneChanged = curFp !== prevFingerprint;
      if (paneChanged && _easyApplyVisible()) break;
      // No previous pane (first job) — any Easy Apply button is fine.
      if (!prevFingerprint && _easyApplyVisible()) break;
      await sleep(300);
    }
    // Extra settle buffer for React to finish rendering.
    await sleep(600 + Math.random() * 600);
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

    // Retry classification — the detail pane may still be hydrating.
    let detail = _classifyJobDetail();
    if (detail.status === "none") {
      for (let t = 0; t < 5; t++) {
        await sleep(800);
        if (state.applyCancel) return { ok: false, reason: "cancelled" };
        detail = _classifyJobDetail();
        if (detail.status !== "none") break;
      }
    }

    if (detail.status === "applied") return { ok: false, reason: "already_applied" };
    if (detail.status === "external") return { ok: false, reason: "external_apply" };
    if (detail.status !== "easy" || !detail.btn) return { ok: false, reason: "no_easy_apply" };

    await sleep(500 + Math.random() * 700);
    // Click the apply control with a human pointer sequence (v1.0.38 wiring).
    // Load-bearing: the control is often an <a href=".../apply/"> and
    // _forceClick's native element.click() NAVIGATES to the full-page
    // /jobs/view/<id>/apply/ URL instead of opening the in-page modal, leaving
    // the stepper unable to find the form. dispatchHumanClick fires the pointer
    // events LinkedIn's SPA handler listens for, opening the modal in place.
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
    // Hide every per-card "Auto Apply" chip for the duration of the run — once
    // the automated workflow starts there's nothing for the user to click, and
    // a stray chip floating over the open Easy Apply modal looks broken. The
    // chips stay in the DOM (the engine still reads their keys); they're just
    // visually hidden via .lc-applying in overlay.css. Removed again in finally.
    try { document.documentElement.classList.add("lc-applying"); } catch {}
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

        const last = i >= keys.length - 1;
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

    let pageNum = 0;
    try {
      // Process first page
      await processPage(firstPageKeys);

      // Auto-paginate through subsequent pages (bulk mode only, not singleJob)
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
    } finally {
      state.applyActive = false;
      state.applyProgress = null;
      if (!singleJob) state.selectedJobUrls.clear();
      // Run finished — show the per-card chips again.
      try { document.documentElement.classList.remove("lc-applying"); } catch {}
      mountSelectAllHeader();
      renderToolbar();
      try { decorateJobCards(); } catch {}
    }

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
  // The EXACT card element each chip was injected into, captured at detection
  // time. Connect All reads from here so it classifies (and clicks Connect on)
  // the precise card the chip belongs to — never a re-derived `.closest()`
  // guess that can grab an adjacent row's Follow/Message button (that mismatch
  // was why visibly-connectable cards showed "Follow only" / "No Connect").
  const chipCardEl = new Map(); // canonical url -> card element
  // The EXACT native action button (Connect / Follow / Message / Pending) the
  // chip was injected beside, captured at injection time. Connect All clicks
  // THIS button directly rather than re-scanning the card for it — re-scanning
  // was returning the wrong/empty match on LinkedIn's current layout, which is
  // why connectable cards showed "No action".
  const chipActionBtn = new Map(); // canonical url -> native action button

  function _gcInjected() {
    for (const [url, node] of injectedSaves.entries()) {
      if (!node || !document.body.contains(node)) {
        injectedSaves.delete(url);
        chipCardEl.delete(url);
        chipActionBtn.delete(url);
      }
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

  // ── Avoid Duplicate Outreach: live chip visuals ─────────────────────────────
  // When the toggle is ON, every already-contacted card's Save chip flips to a
  // muted "Contacted" state so the user sees, in realtime, which profiles will
  // be skipped. Toggling OFF restores them to the normal "Save" state.
  function _applyContactedVisual(url) {
    const wrap = injectedSaves.get(url);
    if (!wrap || !document.body.contains(wrap)) return;
    const btn = wrap.querySelector(".lc-inline-save");
    const span = wrap.querySelector(".lc-inline-save-text");
    if (!btn) return;
    // Never override an in-flight or terminal save/error state.
    if (btn.dataset.state === "saving" || btn.dataset.state === "saved" || btn.dataset.state === "error") return;
    if (state.avoidDuplicates && _isContacted(url)) {
      btn.dataset.state = "contacted";
      if (span) span.textContent = "Contacted";
      btn.title = "Already contacted — skipped by Avoid Duplicate Outreach";
    } else if (btn.dataset.state === "contacted") {
      btn.dataset.state = "ready";
      if (span) span.textContent = "Save";
      btn.title = "Open this profile and auto-enrich";
    }
  }

  function _refreshContactedVisuals() {
    for (const url of injectedSaves.keys()) _applyContactedVisual(url);
  }

  // How many currently-visible cards are already contacted (= would be skipped).
  function _countContactedVisible() {
    let n = 0;
    for (const url of _allChipUrls()) if (_isContacted(url)) n++;
    return n;
  }

  function injectInlineSave(card, profile, anchorBtn) {
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
        if (!profile.linkedin_url?.includes("/in/")) {
          btn.dataset.state = "error";
          textSpan.textContent = "Need /in/ URL";
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
        _markContacted(url); // record as contacted so duplicate check knows
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

    // Placement: insert the chip INLINE, immediately before the card's native
    // action button (Connect / Follow / Message), so it flows in the same row.
    // Inline flow is immune to the absolute-position COLLAPSE that previously
    // stacked every card's chip at one screen point (top:12px;right:130px of a
    // shared positioned ancestor) — which is why only the first profile looked
    // chipped. We only fall back to a pinned placement when a card has no
    // native action button at all.
    const anchor =
      anchorBtn && anchorBtn.parentElement
        ? anchorBtn
        : Array.from(card.querySelectorAll("button")).find(_isActionButton);
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(wrap, anchor);
    } else {
      wrap.classList.add("lc-save-row-floating");
      try {
        if (getComputedStyle(card).position === "static") {
          card.style.position = "relative";
        }
      } catch {
        card.style.position = "relative";
      }
      card.appendChild(wrap);
    }
    injectedSaves.set(url, wrap);
    chipCardEl.set(url, card);
    // Reflect Avoid-Duplicate state immediately on the freshly-injected chip.
    _applyContactedVisual(url);
    // Remember the precise native button this chip sits beside (if any) so
    // Connect All can act on it directly.
    if (anchor && _isActionButton(anchor)) chipActionBtn.set(url, anchor);
    else chipActionBtn.delete(url);
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
    // Whole-word match in EITHER the visible text or the aria-label. LinkedIn
    // renders these as "+ Connect" / "+ Follow" (the leading icon contributes a
    // glyph), so a strict ^connect$ anchor misses them — that was the bug that
    // left Connect cards unrecognised. \bconnect\b matches "Connect"/"+ Connect"
    // but NOT "Connected"/"Connections" (no trailing word boundary).
    return (
      /\b(connect|follow|message|pending)\b/i.test(txt) ||
      /\binvite\b.*\bto connect\b/i.test(aria) ||
      /\b(connect|follow|pending|message)\b/i.test(aria)
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

    // ---- Robust per-row detection anchored on native action buttons ----
    // Every search result has exactly ONE action button (Connect / Follow /
    // Message / Pending). Iterating those buttons directly — instead of the old
    // owner/button-count climb that could collapse the whole list into a single
    // "card" and stack every chip at one absolute point — guarantees one chip
    // PER ROW. For each button we climb to the nearest ancestor that contains a
    // profile link without spanning a second action button; that ancestor is
    // the card, and the chip is injected inline right beside the button.
    const handled = new Set(); // canonical urls chipped this pass

    const cardFromButton = (btn) => {
      let node = btn.parentElement;
      for (
        let i = 0;
        i < 16 && node && node.tagName !== "BODY" && node.tagName !== "HTML";
        i++
      ) {
        // The FIRST ancestor (climbing from a single button) that contains a
        // profile link IS that button's own row — every result row has exactly
        // one profile link of its own. Return it directly; no button-count
        // guard needed (and the guard wrongly rejected rows once a row exposed
        // a Message icon alongside Connect).
        if (node.querySelector(linkSel)) return node;
        node = node.parentElement;
      }
      return null;
    };

    const tryInject = (card, anchorBtn) => {
      if (!card) return;
      const ownerLink = _resolveCardOwnerLink(card, linkSel);
      if (!ownerLink) return;
      const url = globalThis.__lcDom.normalizeProfileUrl(ownerLink.href);
      if (!url || !url.includes("/in/")) return;
      if (handled.has(url)) return;
      handled.add(url);

      // Live chip already present for this URL → leave it.
      const existing = injectedSaves.get(url);
      if (existing && document.body.contains(existing)) return;
      if (existing) {
        injectedSaves.delete(url);
        chipCardEl.delete(url);
      }
      // Clear a stray chip on this card (recycled <li> after pagination).
      const stray = card.querySelector(".lc-save-row");
      if (stray) {
        injectedSaves.delete(stray.dataset.lcUrl);
        chipCardEl.delete(stray.dataset.lcUrl);
        stray.remove();
      }

      // Card metadata. A missing name never blocks the chip — the canonical
      // name is scraped on the /in/ page during enrichment; fall back to slug.
      let profile = profileFromCard(card, ownerLink);
      if (!profile?.linkedin_url) {
        profile = { linkedin_url: url, full_name: _labelFromUrl(url) };
      }
      injectInlineSave(card, profile, anchorBtn);
    };

    // PRIMARY — one chip per native action button. Process in priority order
    // (Connect → Follow → Pending → Message) so that if a single row exposes
    // more than one action button, the chip anchors on the most actionable one
    // and `handled` claims the URL before a lesser button can.
    const rank = (b) => {
      const c = _classifyButton(b);
      return c === "connect" ? 0 : c === "follow" ? 1 : c === "pending" ? 2 : 3;
    };
    const actionButtons = Array.from(document.querySelectorAll("button"))
      .filter(_isActionButton)
      .sort((a, b) => rank(a) - rank(b));
    for (const btn of actionButtons) {
      try {
        tryInject(cardFromButton(btn), btn);
      } catch (e) {
        console.warn("[LeadCaptura] decorate(btn) failed", e?.message);
      }
    }

    // FALLBACK — rows with no recognised action button. Climb each owner link
    // to the nearest ancestor that still encloses exactly one distinct owner.
    for (const a of document.querySelectorAll(linkSel)) {
      if (_isInsightLink(a) || _isMutualConnectionContext(a)) continue;
      const url = globalThis.__lcDom.normalizeProfileUrl(a.href);
      if (!url || !url.includes("/in/") || handled.has(url)) continue;
      let node = a.parentElement;
      let card = null;
      for (
        let i = 0;
        i < 16 && node && node.tagName !== "BODY" && node.tagName !== "HTML";
        i++
      ) {
        const owners = new Set();
        for (const l of node.querySelectorAll(linkSel)) {
          if (_isInsightLink(l) || _isMutualConnectionContext(l)) continue;
          const u = globalThis.__lcDom.normalizeProfileUrl(l.href);
          if (u) owners.add(u);
        }
        if (owners.size > 1) break;
        if (owners.size === 1) card = node;
        node = node.parentElement;
      }
      try {
        tryInject(card, null);
      } catch (e) {
        console.warn("[LeadCaptura] decorate(link) failed", e?.message);
      }
    }

    // Refresh the Avoid-Duplicate panel's live skip-count for the cards now
    // on screen (new cards may have rendered via scroll/pagination).
    try { _renderAvoidDupPanel(); } catch {}
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

  // ── Visual overlay: glowing highlight + arrow on "Send without a note" ──
  let _sendBtnHighlightTimer = null;
  let _sendBtnArrowEl = null;

  function _highlightSendBtn(btn) {
    if (!btn) return;
    // Pulsing glow on the button itself
    try {
      btn.style.setProperty("outline", "3px solid #0a66c2", "important");
      btn.style.setProperty("outline-offset", "3px", "important");
      btn.style.setProperty("animation", "lc-pulse-ring 0.9s ease-in-out infinite", "important");
      btn.setAttribute("data-lc-highlighted", "true");
    } catch {}
    // Floating arrow panel above the button
    if (!_sendBtnArrowEl || !document.body.contains(_sendBtnArrowEl)) {
      const arrow = document.createElement("div");
      arrow.id = "lc-send-btn-arrow";
      arrow.innerHTML =
        '<div class="lc-arrow-inner">' +
        '<span class="lc-arrow-emoji">👆</span>' +
        '<span>LeadCaptura: Click &ldquo;Send without a note&rdquo;</span>' +
        "</div>" +
        '<div class="lc-arrow-tail"></div>';
      document.body.appendChild(arrow);
      _sendBtnArrowEl = arrow;
    }
    // Position arrow above the button and keep updating
    clearInterval(_sendBtnHighlightTimer);
    _sendBtnHighlightTimer = setInterval(() => {
      if (!_sendBtnArrowEl || !document.body.contains(_sendBtnArrowEl)) return;
      const target = _findSendWithoutNoteButton();
      if (!target) return;
      const r = target.getBoundingClientRect();
      if (r.width === 0) return;
      const aw = _sendBtnArrowEl.offsetWidth || 280;
      _sendBtnArrowEl.style.left =
        Math.max(8, Math.min(window.innerWidth - aw - 8, r.left + r.width / 2 - aw / 2)) + "px";
      _sendBtnArrowEl.style.top =
        Math.max(8, r.top - (_sendBtnArrowEl.offsetHeight || 56) - 12) + "px";
    }, 100);
  }

  function _removeSendBtnHighlight() {
    clearInterval(_sendBtnHighlightTimer);
    _sendBtnHighlightTimer = null;
    if (_sendBtnArrowEl) {
      try { _sendBtnArrowEl.remove(); } catch {}
      _sendBtnArrowEl = null;
    }
    try {
      const el = document.querySelector('[data-lc-highlighted="true"]');
      if (el) {
        el.style.removeProperty("outline");
        el.style.removeProperty("outline-offset");
        el.style.removeProperty("animation");
        el.removeAttribute("data-lc-highlighted");
      }
    } catch {}
  }

  // Inject a <script> tag that runs in the PAGE's MAIN world, not the extension's
  // isolated world. In MAIN world the code has access to window.jQuery and can
  // call HTMLElement.prototype methods in the same origin as the page handler —
  // the single most reliable bypass for frameworks that bind to document-level
  // listeners rather than the button element itself.
  function _tryMainWorldClick(btn) {
    try {
      // Inject into the page's MAIN world via a script tag. This is the only
      // way to reach LinkedIn's React fiber tree from a content script, since
      // React stores internal state as DOM properties set in the MAIN world.
      const code = `(function(){
var all=Array.from(document.querySelectorAll('button,[role="button"]'));
var b=all.find(function(x){
  var t=(x.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
  var a=(x.getAttribute('aria-label')||'').toLowerCase();
  return /send without a note/i.test(t)||/send without a note/i.test(a)||t==='send now'||t==='send';
});
if(!b)return;
// React fiber traversal — defer via queueMicrotask so React's concurrent
// renderer processes the update asynchronously (avoids error #418 "component
// suspended while responding to synchronous input").
try{
  var fk=Object.keys(b).find(function(k){return k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$');});
  if(fk){
    var fiber=b[fk];
    for(var d=0;fiber&&d<12;fiber=fiber.return,d++){
      var oc=fiber.memoizedProps&&fiber.memoizedProps.onClick||fiber.pendingProps&&fiber.pendingProps.onClick;
      if(typeof oc==='function'){
        var _oc=oc,_b=b;
        queueMicrotask(function(){try{_oc({type:'click',bubbles:true,cancelable:true,
            isTrusted:true,target:_b,currentTarget:_b,
            preventDefault:function(){},stopPropagation:function(){},
            nativeEvent:{isTrusted:true}});}catch(e){}});
        break;
      }
    }
  }
}catch(e){}
if(window.jQuery||window.$){try{(window.jQuery||window.$)(b).trigger('click');}catch(e){}}
HTMLElement.prototype.click.call(b);
try{
  var r=b.getBoundingClientRect();
  var cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);
  var opts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0,buttons:1};
  b.dispatchEvent(new MouseEvent('mousedown',opts));
  b.dispatchEvent(new MouseEvent('mouseup',{...opts,buttons:0}));
  b.dispatchEvent(new MouseEvent('click',{...opts,buttons:0}));
}catch(e){}
var f=b.closest('form');
if(f){try{f.requestSubmit(b);}catch(e){try{f.submit();}catch(e2){}}}
})();`;
      const s = document.createElement("script");
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch {}
  }

  // Ask the service worker to run chrome.scripting.executeScript with world:"MAIN"
  // on the current tab — the most authoritative way to fire page-context code.
  function _tryServiceWorkerMainWorldClick() {
    try {
      chrome.runtime.sendMessage({ type: "lc:clickMainWorldSend" }, () => {});
    } catch {}
  }

  // ---- Global auto-confirm of the invitation modal ----------------------
  // Fires whenever the "Add a note?" modal appears, regardless of who triggered
  // it. Nuclear strategy: visual highlight, MAIN-world injection, aggressive
  // 200ms retry, and a user-assist prompt after 5s if still stuck.
  let _inviteAutoBusy = false;
  let _inviteHighlightShown = false;

  async function _autoConfirmInviteModal() {
    if (state.connectActive) return;  // _sendConnectOnCard owns the sequence
    if (_inviteAutoBusy) return;
    if (!_invitationModalOpen()) {
      if (_inviteHighlightShown) { _removeSendBtnHighlight(); _inviteHighlightShown = false; }
      return;
    }
    let btn = _findSendWithoutNoteButton();
    if (!btn) return;
    _inviteAutoBusy = true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // Wait for the modal animation to finish before clicking.
      // LinkedIn's Ember/React mounts button handlers ~250-350ms after the dialog appears.
      await sleep(350);
      btn = _findSendWithoutNoteButton();
      if (!btn || !_invitationModalOpen()) return;

      // Show visual highlight so the user can see which button we're targeting.
      if (!_inviteHighlightShown) {
        _inviteHighlightShown = true;
        _highlightSendBtn(btn);
      }
      _lcToast("LeadCaptura: sending invitation…");
      console.log("[LeadCaptura] auto-confirm: found Send without a note", btn);

      // Fire all click strategies simultaneously on the first attempt.
      // The MAIN-world strategies (script injection + service worker executeScript)
      // have React fiber access and are the most reliable for LinkedIn's buttons.
      _forceClick(btn);
      _tryMainWorldClick(btn);
      _tryServiceWorkerMainWorldClick();

      // Aggressive retry loop: check every 300ms for up to 9s.
      // MAIN world click fires every attempt; isolated-world forceClick fires
      // on alternating attempts to avoid overwhelming LinkedIn's event queue.
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        if (!_invitationModalOpen()) {
          console.log("[LeadCaptura] auto-confirm: modal closed ✓ (attempt", i + 1, ")");
          _lcToast("LeadCaptura: invitation sent ✓");
          _removeSendBtnHighlight();
          _inviteHighlightShown = false;
          return;
        }
        const stillBtn = _findSendWithoutNoteButton();
        if (!stillBtn || stillBtn.disabled) continue;
        // Always fire the MAIN world path — it calls React fiber directly.
        _tryMainWorldClick(stillBtn);
        _tryServiceWorkerMainWorldClick();
        // Also fire isolated-world click on every other attempt.
        if (i % 2 === 0) _forceClick(stillBtn);
      }

      // 9s elapsed — still open. Prompt the user.
      if (_invitationModalOpen()) {
        _lcToast('⚠️ Please click "Send without a note" manually');
        console.log("[LeadCaptura] auto-confirm: prompting user — click blocked by LinkedIn");
      }
    } catch (e) {
      console.warn("[LeadCaptura] auto-confirm error", e);
    } finally {
      _inviteAutoBusy = false;
    }
  }

  function _startInviteAutoConfirm() {
    // Debounce the MutationObserver — LinkedIn's React app fires hundreds of
    // DOM mutations per second on a search page. Without debouncing, every
    // mutation runs a full button scan. A 120ms debounce keeps response time
    // under 200ms while eliminating the CPU spike.
    let _mutDebounce = null;
    const _debouncedAutoConfirm = () => {
      if (_mutDebounce) return;
      _mutDebounce = setTimeout(() => { _mutDebounce = null; _autoConfirmInviteModal(); }, 120);
    };
    try {
      const obs = new MutationObserver(_debouncedAutoConfirm);
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
    // Safety-net poll every 400ms (was 200ms — the debounced observer already
    // catches real-time modal appearances; the poll is a fallback for missed mutations).
    setInterval(_autoConfirmInviteModal, 400);
  }
  _startInviteAutoConfirm();

  // Apply per-URL connect results when returning to the search page after
  // a Connect All run. Updates chip states and resets the toolbar.
  function applyConnectResults(results) {
    for (const [url, status] of Object.entries(results || {})) {
      if (status === "sent" || status === "connected") {
        _setChipState(url, "saved", "Connected ✓");
        _markContacted(url);
      } else if (status === "followed") {
        _setChipState(url, "saved", "Followed ✓");
        _markContacted(url);
      } else if (
        status === "already_connected" ||
        status === "already_pending" ||
        status === "already_done"
      ) {
        _setChipState(url, "saved", "Already done ✓");
        _markContacted(url);
      } else {
        _setChipState(url, "error", "Skipped");
      }
    }
    state.connectActive = false;
    state.connectProgress = null;
    state.selectedUrls?.clear();
    try { mountSelectAllHeader(); } catch {}
    renderToolbar();
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
    toast: _lcToast,
    applyConnectResults,
  };
})();
