/* Page-world XHR hook for Google Maps — mirrors the reference scraper's
 * injected.js. Google Maps loads search results via an internal `/search` XHR;
 * we passively capture that response (the same data the page already fetched)
 * and hand it to the isolated content script via postMessage. We never call any
 * Google API ourselves — purely observational, no paid API. */
(function () {
  if (window.__lcGmapsHooked) return;
  window.__lcGmapsHooked = true;
  const XHR = XMLHttpRequest.prototype;
  const open = XHR.open;
  const send = XHR.send;
  XHR.open = function (method, url) {
    this.__lcUrl = url;
    return open.apply(this, arguments);
  };
  XHR.send = function () {
    this.addEventListener("readystatechange", function () {
      try {
        if (this.readyState === 4 && typeof this.__lcUrl === "string" && this.__lcUrl.startsWith("/search")) {
          window.postMessage({ type: "lc_gmaps_search", data: this.response }, "*");
        }
      } catch (e) { /* ignore */ }
    });
    return send.apply(this, arguments);
  };
})();
