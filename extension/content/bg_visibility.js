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
 * Fix: this content script runs at document_start on linkedin.com, sees the
 * URL params `?lc_enrich=1` / `?lc_bridge=` that mark a tab we OPENED for
 * bulk enrichment, and inline-injects a MAIN-world script that:
 *   1) Pins document.hidden = false / visibilityState = 'visible' / hasFocus
 *      → true so every reader (LinkedIn's React, IO callbacks, sched libs)
 *      believes the tab is visible-and-focused.
 *   2) Reroutes requestAnimationFrame to setTimeout(16ms) so React's
 *      scheduler runs at ~60 Hz instead of Chrome's hidden-tab 1 Hz throttle.
 *
 * Strictly additive & strictly scoped: the shim ONLY runs on URLs we ourselves
 * opened with the enrichment marker. Regular browsing — even on linkedin.com
 * — is byte-for-byte unaffected. Nothing else in the codebase is touched.
 */
(function () {
  "use strict";
  try {
    if (!/[?&](lc_enrich|lc_bridge)=/.test(location.search)) return;

    // The shim runs in MAIN world (where LinkedIn's React lives). Content
    // scripts live in an isolated world; their overrides can't influence
    // page scripts, so we inject a <script> the page evaluates as its own.
    const code = "(function(){try{" +
      "var define=function(t,p,v){try{Object.defineProperty(t,p,{configurable:true,get:function(){return v;}});}catch(e){}};" +
      // (1) Prototype-level — covers every Document accessor.
      "define(Document.prototype,'hidden',false);" +
      "define(Document.prototype,'visibilityState','visible');" +
      "define(Document.prototype,'webkitHidden',false);" +
      "define(Document.prototype,'webkitVisibilityState','visible');" +
      // (2) Instance-level — wins over prototype if anything cached an own
      //     descriptor before our prototype hook landed.
      "define(document,'hidden',false);" +
      "define(document,'visibilityState','visible');" +
      "define(document,'webkitHidden',false);" +
      "define(document,'webkitVisibilityState','visible');" +
      // (3) hasFocus — many libs check this in addition to visibilityState.
      "try{document.hasFocus=function(){return true;};}catch(e){}" +
      // (4) requestAnimationFrame reroute. Chrome throttles rAF to 1 Hz in
      //     hidden tabs at the C++ level regardless of property overrides,
      //     so we replace it with a 16 ms setTimeout. setTimeout in a hidden
      //     tab is throttled to 1 s only AFTER 5 minutes of being hidden;
      //     our enrichment tab lives ~22 s, well under that ceiling.
      "var origRAF=window.requestAnimationFrame;" +
      "window.requestAnimationFrame=function(cb){" +
        "return setTimeout(function(){try{cb(performance.now());}catch(e){}},16);" +
      "};" +
      // (5) requestIdleCallback reroute. NEVER fires in hidden tabs in
      //     Chrome. LinkedIn uses this for low-priority hydration —
      //     including the late-tick mailto:/tel: anchor population on
      //     the Contact info modal. Without this reroute the modal opens
      //     but its inner fields stay blank until the user clicks the tab.
      "if(window.requestIdleCallback){" +
        "window.requestIdleCallback=function(cb,opts){" +
          "var t=Math.max(1,Math.min(50,(opts&&opts.timeout)||16));" +
          "return setTimeout(function(){try{cb({didTimeout:false,timeRemaining:function(){return 50;}});}catch(e){}},t);" +
        "};" +
        "window.cancelIdleCallback=function(id){clearTimeout(id);};" +
      "}" +
      // (5) Suppress the inevitable initial visibilitychange→hidden event
      //     that Chrome fires when a tab opens backgrounded. We can't stop
      //     Chrome dispatching it, but our overrides make every listener
      //     that reads document.visibilityState see 'visible' anyway.
      //
      "console.log('[LeadCaptura] bg visibility shim active on',location.pathname,location.search);" +
    "}catch(e){console.warn('[LeadCaptura] bg shim main-world failed:',e&&e.message);}})();";

    const target = document.documentElement || document.head || document.body;
    if (target) {
      const s = document.createElement("script");
      s.textContent = code;
      target.appendChild(s);
      s.remove();
    } else {
      // documentElement isn't there yet — extremely rare at document_start.
      // Defer one tick; React hasn't booted yet, so we're still in time.
      const tryLater = () => {
        const t = document.documentElement;
        if (!t) { setTimeout(tryLater, 0); return; }
        const s = document.createElement("script");
        s.textContent = code;
        t.appendChild(s);
        s.remove();
      };
      tryLater();
    }
  } catch (e) {
    try { console.warn("[LeadCaptura] bg visibility shim outer failed:", e && e.message); } catch (_) {}
  }
})();
