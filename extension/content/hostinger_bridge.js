/* hostinger_bridge.js — runs ONLY on the LeadCaptura web app (leads.hudace.com).
 *
 * Settings -> Email Senders' "Login" button (src/app/(app)/settings/email/
 * page.tsx) needs to hand a Hostinger sender's password to the NEW tab it's
 * about to open for mail.hostinger.com — but a page script can't write to
 * chrome.storage directly (that's an extension-only API), and a password
 * has no safe way to travel via the URL it opens. This is the bridge: the
 * page dispatches a `lc:hostinger-login-creds` CustomEvent on `window`
 * (visible to us — content scripts share the DOM/event system with the
 * page even though they don't share JS globals), we stash the payload in
 * chrome.storage.local, and hostinger_autofill.js (running in the new tab)
 * reads + immediately deletes it once, seconds later.
 *
 * 100% additive: only runs on this one origin, only reacts to this one
 * event, touches nothing else on the page.
 */
(() => {
  "use strict";
  if (window.__lcHostingerBridgeLoaded) return;
  window.__lcHostingerBridgeLoaded = true;

  const LOG = "[LeadCaptura HostingerBridge]";
  const CREDS_KEY = "lcHostingerCreds";

  window.addEventListener("lc:hostinger-login-creds", (e) => {
    try {
      const detail = e && e.detail;
      const username = detail && typeof detail.username === "string" ? detail.username : "";
      const password = detail && typeof detail.password === "string" ? detail.password : "";
      if (!password) return; // nothing to bridge
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
