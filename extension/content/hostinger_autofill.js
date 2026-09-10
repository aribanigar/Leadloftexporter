/* hostinger_autofill.js — fills the EMAIL + PASSWORD fields on Hostinger's
 * webmail login (mail.hostinger.com, a Vue app) when we opened the tab
 * ourselves, INCLUDING logging out a different mailbox that's already
 * signed in on this tab first, all automatically — no click from the user
 * beyond the "Login" button on Settings → Email Senders. The user still
 * clicks Hostinger's own Login button themselves; this never touches that.
 *
 * Neither value travels via this tab's URL (a URL is the wrong place for
 * either — browser history, the address bar, any Referer a page sends).
 * Both arrive the same way: hostinger_bridge.js (runs on leads.hudace.com)
 * receives them from the page via postMessage the instant the "Login"
 * button is clicked, and stages {username, password, ts} in
 * chrome.storage.local — extension-only storage, not reachable by any web
 * page. This file is the only thing that ever reads that key.
 *
 * The record is deliberately NOT deleted the moment it's read — only once
 * both fields are confirmed filled, or the poll gives up. If logging out
 * the old session causes a hard page reload (full navigation, not a Vue
 * client-side route change), this whole content script re-injects fresh
 * on the reloaded page with a clean JS context — but chrome.storage.local
 * survives navigation, so the still-present record lets the fresh
 * injection pick up right where the last one left off instead of landing
 * on a blank login form with nothing to fill.
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
  const POLL_MS = 200;
  const GIVE_UP_MS = 20000;

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
  // Confirmed live via DevTools: the account avatar that opens the profile
  // dropdown, and Log out inside it — already in the DOM once that menu is
  // open, no extra step needed there.
  const LOGOUT_SELECTOR = '[data-qa="profile-logout"]';
  const MENU_TRIGGER_SELECTOR = '[data-qa="profile-menu-trigger"]';

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

  // Plain el.click() does not reliably open Hostinger's account-menu
  // dropdown or activate its Log out item — dropdown components commonly
  // open/act on pointerdown or mousedown rather than the synthesized click
  // alone, especially when they also listen document-wide for an
  // outside-click-to-close handler. Fire a full pointer/mouse sequence
  // with real coordinates first, the same fix this codebase already
  // needed for LinkedIn's Ember-rendered buttons, then fall back to plain
  // .click() in case the target only wires the simple handler.
  function forceClick(el) {
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      const PE = window.PointerEvent || window.MouseEvent;
      el.dispatchEvent(new PE("pointerover", opts));
      el.dispatchEvent(new PE("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PE("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch (e) {
      // ignore — el.click() below still fires regardless
    }
    el.click();
  }

  try {
    chrome.storage.local.get(CREDS_KEY, (res) => {
      const rec = res && res[CREDS_KEY];
      if (!rec || !rec.username || !rec.password) return; // not a tab we opened
      if (Date.now() - (rec.ts || 0) > CREDS_MAX_AGE_MS) {
        chrome.storage.local.remove(CREDS_KEY); // stale — clear and ignore
        return;
      }

      let emailFilled = false;
      let passwordFilled = false;
      let logoutClicked = false;
      let menuOpenedAt = 0;

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

      // If a different mailbox is already logged in on this tab, the login
      // fields never appear — log that session out first so the fresh
      // login form (for the sender we actually want) shows up to fill.
      function tryLogout() {
        if (logoutClicked) return;
        const logoutBtn = find([LOGOUT_SELECTOR]);
        if (logoutBtn) {
          logoutClicked = true;
          console.log(LOG, "already logged in on this tab — logging out first");
          forceClick(logoutBtn);
          return;
        }
        const trigger = find([MENU_TRIGGER_SELECTOR]);
        if (!trigger) return; // neither login form nor account menu — not ready yet
        // Give the click ~1.5s to open the menu before retrying, instead of
        // spamming forceClick every 200ms tick.
        if (!menuOpenedAt || Date.now() - menuOpenedAt > 1500) {
          menuOpenedAt = Date.now();
          forceClick(trigger);
        }
      }

      if (tryFill()) {
        chrome.storage.local.remove(CREDS_KEY);
        console.log(LOG, "email + password filled");
        return;
      }

      // The Vue app hydrates async, and a logout may need a round trip, so
      // poll instead of assuming the inputs already exist at document_idle.
      // The record is only cleared on success or once we give up — see the
      // file header for why (surviving a hard reload mid-logout).
      const start = Date.now();
      const timer = setInterval(() => {
        const done = tryFill();
        if (!done) tryLogout();
        if (done) {
          chrome.storage.local.remove(CREDS_KEY);
          console.log(LOG, "email + password filled");
        }
        if (done || Date.now() - start > GIVE_UP_MS) {
          clearInterval(timer);
          if (!done) chrome.storage.local.remove(CREDS_KEY); // give up — don't leave it for a later, unrelated tab
        }
      }, POLL_MS);
    });
  } catch (e) {
    // extension storage API unavailable for some reason — do nothing.
  }
})();
