/* hostinger_autofill.js — fills the EMAIL + PASSWORD fields on Hostinger's
 * webmail login (mail.hostinger.com, a Vue app) when we opened the tab
 * ourselves. The user still clicks Login themselves — this never touches
 * the submit button.
 *
 * Neither value travels via this tab's URL (a URL is the wrong place for
 * either — browser history, the address bar, any Referer a page sends).
 * Both arrive the same way: hostinger_bridge.js (runs on leads.hudace.com)
 * receives them from the page via postMessage the instant the "Login"
 * button is clicked, and stages {username, password, ts} in
 * chrome.storage.local — extension-only storage, not reachable by any web
 * page. This file is the only thing that ever reads that key, and it
 * deletes it immediately on read, win or lose, so nothing lingers past one
 * use.
 *
 * Strictly scoped: if that storage entry isn't there (bridge never ran —
 * normal bookmarked/typed Hostinger visit) or it's stale (>60s old — a tab
 * reopened long after the click, or a leftover from an interrupted run),
 * this file does nothing at all. A normal Hostinger visit is byte-for-byte
 * unaffected.
 */
(() => {
  "use strict";
  if (window.__lcHostingerAutofillLoaded) return;
  window.__lcHostingerAutofillLoaded = true;

  const LOG = "[LeadCaptura Hostinger]";
  const CREDS_KEY = "lcHostingerCreds";
  const CREDS_MAX_AGE_MS = 60000;

  // Selector fallback chains — data-qa first (deliberately added by
  // Hostinger for testing, most likely to survive a redesign), then the
  // plain id, then the semantic autocomplete hint. Same "prefer multiple
  // selectors" approach used for LinkedIn's own markup drift elsewhere.
  const EMAIL_SELECTORS = [
    'input[data-qa="login-email-input-input"]',
    "input#email",
    'input[autocomplete="username"]',
  ];
  const PASSWORD_SELECTORS = [
    'input[data-qa="login-password-input-input"]',
    "input#password",
    'input[autocomplete="current-password"]',
  ];

  function find(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Setting .value directly doesn't notify Vue's reactivity (same class of
  // problem React has) — dispatch real `input`/`change` events afterwards so
  // the framework's v-model picks up the new value instead of silently
  // reverting it on the next render.
  function fill(el, value) {
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, value);
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  try {
    chrome.storage.local.get(CREDS_KEY, (res) => {
      const rec = res && res[CREDS_KEY];
      chrome.storage.local.remove(CREDS_KEY); // one-time use, win or lose

      if (!rec || !rec.username || !rec.password) return; // not a tab we opened
      if (Date.now() - (rec.ts || 0) > CREDS_MAX_AGE_MS) return; // stale — ignore

      let emailFilled = false;
      let passwordFilled = false;
      function tryFill() {
        if (!emailFilled) {
          const el = find(EMAIL_SELECTORS);
          if (el) {
            if (!el.value) fill(el, rec.username);
            emailFilled = true;
          }
        }
        if (!passwordFilled) {
          const el = find(PASSWORD_SELECTORS);
          if (el) {
            if (!el.value) fill(el, rec.password);
            passwordFilled = true;
          }
        }
        return emailFilled && passwordFilled;
      }

      if (tryFill()) {
        console.log(LOG, "email + password filled");
        return;
      }

      // The Vue app hydrates async, so poll briefly instead of assuming the
      // inputs already exist at document_idle. Give up after ~10s so a tab
      // left open forever doesn't keep a timer running.
      const start = Date.now();
      const timer = setInterval(() => {
        const done = tryFill();
        if (done) console.log(LOG, "email + password filled");
        if (done || Date.now() - start > 10000) clearInterval(timer);
      }, 200);
    });
  } catch (e) {
    // extension storage API unavailable for some reason — do nothing.
  }
})();
