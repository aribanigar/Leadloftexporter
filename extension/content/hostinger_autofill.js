/* hostinger_autofill.js — fills the EMAIL field on Hostinger's webmail login
 * (mail.hostinger.com, a Vue app) when we opened the tab ourselves.
 *
 * Settings -> Email Senders' "Login" button (src/app/(app)/settings/email/
 * page.tsx) opens this page as
 *   https://mail.hostinger.com/?_task=login&_user=<email>
 * — `_user` is our own marker, not a Hostinger login mechanism. This script
 * ONLY runs when that param is present, reads the email back out, and sets
 * it into the login form's email input. It never touches the password field
 * or the submit button — the user types/pastes their own password and
 * clicks Login themselves. That's deliberate, not a shortcut we're missing:
 * a same-origin browser script can't read or submit a form on a different
 * origin for someone else, and even if it could, silently submitting a
 * login on the user's behalf is not something to build.
 *
 * Strictly additive & strictly scoped: no `_user` param -> this file does
 * nothing at all, so a normal Hostinger visit (bookmarked, typed URL,
 * clicked from their own email) is byte-for-byte unaffected.
 */
(() => {
  "use strict";
  if (window.__lcHostingerAutofillLoaded) return;
  window.__lcHostingerAutofillLoaded = true;

  const LOG = "[LeadCaptura Hostinger]";

  let email = "";
  try {
    email = new URLSearchParams(location.search).get("_user") || "";
  } catch (e) {}
  if (!email) return; // not a tab we opened — do nothing, ever.

  // Selector fallback chain — data-qa first (deliberately added by Hostinger
  // for testing, most likely to survive a redesign), then the plain id,
  // then the semantic autocomplete hint. Same "prefer multiple selectors"
  // approach used for LinkedIn's own markup drift elsewhere in this repo.
  const EMAIL_SELECTORS = [
    'input[data-qa="login-email-input-input"]',
    "input#email",
    'input[autocomplete="username"]',
  ];

  function findEmailInput() {
    for (const sel of EMAIL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Setting .value directly doesn't notify Vue's reactivity (same class of
  // problem React has) — dispatch real `input`/`change` events afterwards so
  // the framework's v-model picks up the new value instead of silently
  // reverting it on the next render.
  function fill(el) {
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, email);
    } catch (e) {
      el.value = email;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  let filled = false;
  function tryFill() {
    if (filled) return true;
    const el = findEmailInput();
    if (!el) return false;
    if (el.value) { filled = true; return true; } // user (or the page) already put something there
    fill(el);
    filled = true;
    console.log(LOG, "email field filled");
    return true;
  }

  // The Vue app hydrates async, so poll briefly instead of assuming the
  // input already exists at document_idle. Give up after ~10s so a tab left
  // open forever doesn't keep a timer running.
  const start = Date.now();
  const timer = setInterval(() => {
    if (tryFill() || Date.now() - start > 10000) clearInterval(timer);
  }, 200);
})();
