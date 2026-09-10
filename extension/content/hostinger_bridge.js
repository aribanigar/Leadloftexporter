/* hostinger_bridge.js — runs ONLY on the LeadCaptura web app (leads.hudace.com).
 *
 * Settings -> Email Senders' "Login" button (src/app/(app)/settings/email/
 * page.tsx) needs to hand a Hostinger sender's email + password to the NEW
 * tab it's about to open for mail.hostinger.com — but a page script can't
 * write to chrome.storage directly (that's an extension-only API), and
 * neither value belongs in the URL that tab opens with (browser history,
 * the address bar, any Referer header a page sends).
 *
 * The bridge: the page calls window.postMessage(...) with our marker type;
 * we (a content script, sharing the page's window/DOM even though we don't
 * share its JS globals) pick that up and stage the payload in
 * chrome.storage.local. hostinger_autofill.js (running in the new tab)
 * reads + immediately deletes it once, moments later.
 *
 * postMessage, not a CustomEvent — a CustomEvent's `.detail` does NOT
 * reliably survive the isolated-world/main-world boundary in Chrome
 * (a well-known gotcha); postMessage performs a real structured clone of
 * the data across that boundary, which is why it's the standard mechanism
 * for page <-> content-script communication.
 *
 * 100% additive: only runs on this one origin, only reacts to this one
 * message type FROM THIS SAME WINDOW (never from an iframe or another
 * origin), touches nothing else on the page.
 */
(() => {
  "use strict";
  if (window.__lcHostingerBridgeLoaded) return;
  window.__lcHostingerBridgeLoaded = true;

  const LOG = "[LeadCaptura HostingerBridge]";
  const CREDS_KEY = "lcHostingerCreds";
  const MSG_TYPE = "lc:hostinger-login-creds";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return; // only our own page's top-level script
    const data = event.data;
    if (!data || data.type !== MSG_TYPE) return;
    const username = typeof data.username === "string" ? data.username : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (!username || !password) return;
    try {
      chrome.storage.local.set(
        { [CREDS_KEY]: { username, password, ts: Date.now() } },
        () => {
          if (chrome.runtime.lastError) {
            console.warn(LOG, "storage set failed:", chrome.runtime.lastError.message);
          } else {
            console.log(LOG, "credentials staged for the Hostinger tab");
          }
        }
      );
    } catch (err) {
      console.warn(LOG, "failed to bridge credentials:", err && err.message);
    }
  });
})();
