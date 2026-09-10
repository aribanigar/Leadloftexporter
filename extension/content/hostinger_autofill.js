/* hostinger_autofill.js — fills the EMAIL + PASSWORD fields on Hostinger's
 * webmail login (mail.hostinger.com, a Vue app) when we opened the tab
 * ourselves. The user still clicks Login themselves — this never touches
 * the submit button.
 *
 * Settings -> Email Senders' "Login" button (src/app/(app)/settings/email/
 * page.tsx) opens this page as
 *   https://mail.hostinger.com/?_task=login&_user=<email>
 * — `_user` is our own marker, not a Hostinger login mechanism, and is only
 * ever the (non-secret) email address. The password can't travel the same
 * way — a URL is the wrong place for a secret (browser history, address
 * bar, any request that leaks Referer) — so it arrives separately, staged
 * in chrome.storage.local by hostinger_bridge.js (runs on leads.hudace.com,
 * receives it from the page via a CustomEvent right before this tab opens).
 * This file reads it once, fills the field, and immediately deletes it from
 * storage so it doesn't linger.
 *
 * Strictly scoped: no `_user` param -> this file does nothing at all, so a
 * normal Hostinger visit (bookmarked, typed URL, clicked from their own
 * email) is byte-for-byte unaffected. No password in storage (bridge never
 * ran, or it already got consumed) -> only the email gets filled, exactly
 * like before this version — never an error, never a blocked flow.
 */
(() => {
  "use strict";
  if (window.__lcHostingerAutofillLoaded) return;
  window.__lcHostingerAutofillLoaded = true;

  const LOG = "[LeadCaptura Hostinger]";
  const CREDS_KEY = "lcHostingerCreds";
  const CREDS_MAX_AGE_MS = 60000; // ignore anything stale — e.g. a tab reopened long after the click

  let email = "";
  try {
    email = new URLSearchParams(location.search).get("_user") || "";
  } catch (e) {}
  if (!email) return; // not a tab we opened — do nothing, ever.

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

  // Password is read (and immediately consumed) once, asynchronously, before
  // the fill loop starts — chrome.storage.local is the only place it lives,
  // and it must not survive for a second tab or a page reload to find.
  let password = "";
  let passwordReady = false; // true once we've resolved (found OR confirmed absent)
  try {
    chrome.storage.local.get(CREDS_KEY, (res) => {
      const rec = res && res[CREDS_KEY];
      chrome.storage.local.remove(CREDS_KEY); // one-time use, win or lose
      if (rec && rec.password && Date.now() - (rec.ts || 0) <= CREDS_MAX_AGE_MS) {
        password = rec.password;
      }
      passwordReady = true;
    });
  } catch (e) {
    passwordReady = true; // extension API unavailable for some reason — proceed email-only
  }

  let emailFilled = false;
  let passwordFilled = false;

  function tryFill() {
    if (!emailFilled) {
      const el = find(EMAIL_SELECTORS);
      if (el) {
        if (!el.value) fill(el, email);
        emailFilled = true;
      }
    }
    // Only attempt the password field once we know whether we HAVE a
    // password to put there — filling nothing is a valid, expected outcome
    // (bridge didn't run, or it already got consumed by another tab).
    if (!passwordFilled && passwordReady) {
      if (!password) {
        passwordFilled = true; // nothing to do — done either way
      } else {
        const el = find(PASSWORD_SELECTORS);
        if (el) {
          if (!el.value) fill(el, password);
          passwordFilled = true;
        }
      }
    }
    return emailFilled && passwordFilled;
  }

  if (tryFill()) {
    console.log(LOG, "email" + (password ? " + password" : "") + " field(s) filled");
    return;
  }

  // The Vue app hydrates async, so poll briefly instead of assuming the
  // inputs already exist at document_idle. Give up after ~10s so a tab left
  // open forever doesn't keep a timer running.
  const start = Date.now();
  const timer = setInterval(() => {
    const done = tryFill();
    if (done) console.log(LOG, "email" + (password ? " + password" : "") + " field(s) filled");
    if (done || Date.now() - start > 10000) clearInterval(timer);
  }, 200);
})();
