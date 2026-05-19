/* Small DOM helpers used across scrapers. Kept tiny on purpose; LinkedIn's
 * markup changes often, so prefer multiple selectors and graceful fallbacks. */
(() => {
  if (globalThis.__lcDom) return;

  function text(el) {
    if (!el) return "";
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return t || el.getAttribute("aria-label") || el.getAttribute("title") || "";
  }

  function first(root, selectors) {
    if (!root) root = document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch {
        /* invalid selector — skip */
      }
    }
    return null;
  }

  function all(root, selectors) {
    if (!root) root = document;
    const out = [];
    for (const sel of selectors) {
      try {
        root.querySelectorAll(sel).forEach((n) => out.push(n));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  function waitFor(selectors, { root = document, timeout = 8_000 } = {}) {
    return new Promise((resolve) => {
      const existing = first(root, selectors);
      if (existing) {
        resolve(existing);
        return;
      }
      const obs = new MutationObserver(() => {
        const el = first(root, selectors);
        if (el) {
          obs.disconnect();
          clearTimeout(to);
          resolve(el);
        }
      });
      obs.observe(root, { childList: true, subtree: true });
      const to = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  function normalizeProfileUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.href);
      u.search = "";
      u.hash = "";
      if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
      return u.toString().toLowerCase();
    } catch {
      return url.split("?")[0].toLowerCase();
    }
  }

  function dispatchHumanClick(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * Math.min(8, rect.width / 4);
    const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * Math.min(8, rect.height / 4);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return true;
  }

  async function typeIntoEditable(el, value) {
    if (!el) return;
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    const { typingPause, sleep } = globalThis.__lcHuman;
    for (const ch of value) {
      const isContentEditable = el.isContentEditable;
      if (isContentEditable) {
        document.execCommand("insertText", false, ch);
      } else {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + ch + el.value.slice(end);
        el.setSelectionRange(start + 1, start + 1);
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      await sleep(typingPause());
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  globalThis.__lcDom = { text, first, all, waitFor, normalizeProfileUrl, dispatchHumanClick, typeIntoEditable };
})();
