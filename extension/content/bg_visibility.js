/* bg_visibility.js — document_start visibility shim for bulk-enrichment tabs.
 *
 * Problem: Chrome aggressively throttles backgrounded tabs:
 *   • Pages read `document.hidden` / `document.visibilityState` and DEFER
 *     React renders / IntersectionObserver callbacks until the tab is shown.
 *     LinkedIn does exactly this on the Contact Info modal — in a background
 *     tab, the modal never finishes hydrating, so scrapeContactInfo() finds
 *     no email/phone/website/location anchors.
 *   • requestAnimationFrame runs at 1 Hz in hidden tabs, choking React's
 *     scheduler so even after the modal opens the inner fields stay blank.
 *   • The only way users were getting full data was by manually clicking the
 *     enrichment tab — which flips it to visible and unjams the render.
 *
 * Fix: this content script runs at document_start on linkedin.com, in the
 * page's own MAIN world (declared via manifest "world":"MAIN", supported
 * since Chrome 111 — see manifest.json), so it can touch window/document
 * directly the same way LinkedIn's own React code does. Older versions of
 * this file ran in the isolated world (the content-script default, which
 * can't see the page's own globals) and bridged over by injecting an inline
 * `<script>` tag with the override code as its textContent — but that's
 * genuine inline page script, and LinkedIn's CSP (script-src without
 * 'unsafe-inline') now blocks it outright, silently disabling this whole
 * shim. Running natively in MAIN world sidesteps that: the extension
 * platform injects it directly, so it isn't subject to the page's
 * script-src/inline-script restrictions at all.
 *
 * On tabs we didn't open for enrichment, this file does nothing.
 *
 * Strictly additive & strictly scoped: the shim ONLY runs on URLs we ourselves
 * opened with the enrichment marker. Regular browsing — even on linkedin.com
 * — is byte-for-byte unaffected. Nothing else in the codebase is touched.
 */
(function () {
  "use strict";
  try {
    if (!/[?&](lc_enrich|lc_bridge)=/.test(location.search)) return;

    const define = function (t, p, v) {
      try {
        Object.defineProperty(t, p, { configurable: true, get: function () { return v; } });
      } catch (e) {}
    };

    // (1) Prototype-level — covers every Document accessor.
    define(Document.prototype, "hidden", false);
    define(Document.prototype, "visibilityState", "visible");
    define(Document.prototype, "webkitHidden", false);
    define(Document.prototype, "webkitVisibilityState", "visible");
    // (2) Instance-level — wins over prototype if anything cached an own
    //     descriptor before our prototype hook landed.
    define(document, "hidden", false);
    define(document, "visibilityState", "visible");
    define(document, "webkitHidden", false);
    define(document, "webkitVisibilityState", "visible");
    // (3) hasFocus — many libs check this in addition to visibilityState.
    try { document.hasFocus = function () { return true; }; } catch (e) {}

    // (4) requestAnimationFrame reroute. Chrome throttles rAF to 1 Hz in
    //     hidden tabs at the C++ level regardless of property overrides,
    //     so we replace it with a 16 ms setTimeout. setTimeout in a hidden
    //     tab is throttled to 1 s only AFTER 5 minutes of being hidden;
    //     our enrichment tab lives ~22 s, well under that ceiling.
    window.requestAnimationFrame = function (cb) {
      return setTimeout(function () { try { cb(performance.now()); } catch (e) {} }, 16);
    };

    // (5) requestIdleCallback reroute. NEVER fires in hidden tabs in
    //     Chrome. LinkedIn uses this for low-priority hydration —
    //     including the late-tick mailto:/tel: anchor population on
    //     the Contact info modal. Without this reroute the modal opens
    //     but its inner fields stay blank until the user clicks the tab.
    if (window.requestIdleCallback) {
      window.requestIdleCallback = function (cb, opts) {
        const t = Math.max(1, Math.min(50, (opts && opts.timeout) || 16));
        return setTimeout(function () {
          try { cb({ didTimeout: false, timeRemaining: function () { return 50; } }); } catch (e) {}
        }, t);
      };
      window.cancelIdleCallback = function (id) { clearTimeout(id); };
    }

    // We can't stop Chrome dispatching the inevitable initial
    // visibilitychange→hidden event when a tab opens backgrounded, but our
    // overrides above make every listener that reads document.visibilityState
    // see 'visible' anyway.

    console.log("[LeadCaptura] bg visibility shim active on", location.pathname, location.search);
  } catch (e) {
    try { console.warn("[LeadCaptura] bg visibility shim failed:", e && e.message); } catch (_) {}
  }
})();
