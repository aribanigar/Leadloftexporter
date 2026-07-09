/* content_hub_push.js — runs ONLY on the LeadCaptura web app (Vercel).
 *
 * Adds a prominent "📤 Push to Extension" button next to the existing
 * "Send on WhatsApp" button on Content Hub asset cards (the cards that carry a
 * photo + message). Clicking it grabs the asset's FULL text + photo and stashes
 * { text, image } in chrome.storage.local under `lcMessageAllPush`.
 *
 * The LinkedIn-side "Message All" composer (overlay.js) reads that on open and
 * pre-fills the message box + adds the photo as an attachment.
 *
 * Detection is anchored on the existing "Send on WhatsApp" button (stable
 * label), so the new button sits right beside it. Full message text comes from
 * the card's React props (fiber walk) because the visible card text is
 * truncated; a DOM fallback (longest <p> + <img src>) covers the rare case
 * where the fiber read fails.
 *
 * 100% additive: only runs on the web-app origin, never on LinkedIn, only
 * APPENDS one button. If anything fails it logs and bails — nothing breaks.
 */
(() => {
  "use strict";
  if (window.__lcContentHubPushLoaded) return;
  window.__lcContentHubPushLoaded = true;

  const LOG = "[LeadCaptura ContentHub]";
  const DONE_ATTR = "data-lc-ch-push";
  const STORAGE_KEY = "lcMessageAllPush";
  console.log(LOG, "content script loaded on", location.href);

  // ── React fiber → full asset object (untruncated text) ────────────────────
  function _fiberOf(node) {
    for (const k in node) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
        return node[k];
      }
    }
    return null;
  }
  function _looksLikeAsset(o) {
    return (
      o && typeof o === "object" &&
      typeof o.title === "string" && ("content" in o) &&
      ("image_url" in o || "platform" in o || "type" in o)
    );
  }
  function _assetFromNode(node) {
    let fiber = _fiberOf(node);
    for (let d = 0; fiber && d < 40; fiber = fiber.return, d++) {
      const mp = fiber.memoizedProps;
      if (mp) {
        if (_looksLikeAsset(mp.asset)) return mp.asset;
        if (_looksLikeAsset(mp)) return mp;
      }
      const pp = fiber.pendingProps;
      if (pp && _looksLikeAsset(pp.asset)) return pp.asset;
    }
    return null;
  }

  // ── Photo → data URL ──────────────────────────────────────────────────────
  async function _toDataUrl(url) {
    if (!url) return null;
    if (url.startsWith("data:")) return url;
    try {
      const res = await fetch(url);
      if (!res.ok) return url;
      const blob = await res.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(url);
        fr.readAsDataURL(blob);
      });
    } catch (e) { return url; }
  }
  function _imageName(title, dataUrl) {
    let ext = "png";
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || "");
    if (m) ext = m[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
    const base = String(title || "content-photo")
      .replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "photo";
    return base + "." + ext;
  }

  // ── Card root from the "Send on WhatsApp" button ──────────────────────────
  // Climb to the nearest ancestor that also contains the card's "Edit" button.
  function _cardFromButton(anchorBtn) {
    let el = anchorBtn;
    for (let i = 0; i < 14 && el; i++, el = el.parentElement) {
      const btns = el.querySelectorAll("button");
      let hasEdit = false;
      for (const b of btns) {
        if ((b.textContent || "").replace(/\s+/g, " ").trim() === "Edit") { hasEdit = true; break; }
      }
      if (hasEdit) return el;
    }
    return anchorBtn.parentElement || anchorBtn;
  }

  // Read full text + image from a card. Tries the React fiber on MULTIPLE
  // entry points (img, paragraph, every button in the card) because React
  // can attach the asset prop to any of them; falls back to the visible
  // preview text and the <img src> attribute if the fiber read ever fails.
  function _readCard(card) {
    let text = "", image = "", title = "", fromFiber = false;

    // Try every reasonable entry node — the asset prop lives somewhere in
    // the fiber tree but the exact owner element varies between renderers.
    const entryNodes = [
      card,
      card.querySelector("img[src]"),
      card.querySelector("p"),
      ...Array.from(card.querySelectorAll("button")).slice(0, 6),
      ...Array.from(card.querySelectorAll("a")).slice(0, 4),
    ].filter(Boolean);
    let asset = null;
    for (const node of entryNodes) {
      asset = _assetFromNode(node);
      if (asset) break;
    }
    if (asset) {
      text = asset.content ? String(asset.content) : "";
      image = asset.image_url ? String(asset.image_url) : "";
      title = asset.title ? String(asset.title) : "";
      fromFiber = true;
      console.log(LOG, "asset read from fiber:", { hasContent: !!text, hasImage: !!image, title });
    } else {
      console.log(LOG, "asset NOT in fiber for this card — falling back to DOM");
    }

    // DOM fallback for anything the fiber didn't give us. The card text is
    // the longest <p>; the photo is the first <img src>.
    if (!text) {
      let best = "";
      for (const p of card.querySelectorAll("p")) {
        const t = (p.textContent || "").trim();
        if (t.length > best.length) best = t;
      }
      text = best.replace(/…\s*$/, "");
    }
    if (!image) {
      const img = card.querySelector("img[src]");
      if (img) image = img.getAttribute("src") || "";
    }
    if (!title) {
      // First non-empty short text node near the top of the card.
      for (const el of card.querySelectorAll("div, span")) {
        const t = (el.textContent || "").trim();
        if (t && t.length <= 80) { title = t; break; }
      }
    }
    return { text, image, title, fromFiber };
  }

  // ── Prominent push button (styled like "Send on WhatsApp") ────────────────
  function _makePushBtn(card) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(DONE_ATTR, "btn");
    btn.textContent = "📤 Push to Extension";
    Object.assign(btn.style, {
      display: "flex", alignItems: "center", gap: "5px",
      padding: "6px 12px", borderRadius: "7px", border: "none",
      background: "#0a66c2", fontSize: "11px", fontWeight: "800",
      color: "#fff", cursor: "pointer", boxShadow: "0 2px 8px #0a66c255",
    });
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "0.85"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "1"; });

    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      // Re-resolve the card at click time — the wrapper passed at injection
      // can become stale if React rerendered the action row. Search up from
      // the button for the nearest ancestor that contains the card's <img>.
      let liveCard = card;
      try {
        let n = btn;
        for (let i = 0; i < 14 && n; i++, n = n.parentElement) {
          if (n.querySelector && n.querySelector("img[src]")) { liveCard = n; break; }
        }
      } catch (e) {}
      const data = _readCard(liveCard);
      console.log(LOG, "click read:", {
        textChars: (data.text || "").length,
        hasImage: !!data.image,
        fromFiber: data.fromFiber,
        title: data.title,
      });
      if (!data.text && !data.image) {
        btn.textContent = "Nothing to push";
        setTimeout(() => { btn.textContent = "📤 Push to Extension"; }, 2500);
        return;
      }
      btn.textContent = "Pushing…"; btn.disabled = true;
      try {
        const dataUrl = await _toDataUrl(data.image);
        const payload = {
          text: data.text,
          imageDataUrl: dataUrl || "",
          imageName: dataUrl ? _imageName(data.title, dataUrl) : "",
          title: data.title || "",
          ts: Date.now(),
        };
        await new Promise((resolve) => {
          try { chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => resolve()); }
          catch (err) { resolve(); }
        });
        btn.textContent = "✓ Pushed — open LinkedIn → Message All";
        btn.style.background = "#16a34a";
        btn.style.boxShadow = "0 2px 8px #16a34a55";
        console.log(LOG, "pushed:", { chars: data.text.length, hasImage: !!payload.imageDataUrl, fromFiber: data.fromFiber, title: payload.title });
        setTimeout(() => {
          btn.textContent = "📤 Push to Extension";
          btn.style.background = "#0a66c2";
          btn.style.boxShadow = "0 2px 8px #0a66c255";
          btn.disabled = false;
        }, 3500);
      } catch (err) {
        console.warn(LOG, "push failed:", err && err.message);
        btn.textContent = "Push failed — retry"; btn.disabled = false;
      }
    });
    return btn;
  }

  // ── Decorate: find each "Send on WhatsApp" button, inject beside it ────────
  function _decorate() {
    let injected = 0, anchors = 0;
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!/send on whatsapp/i.test(t)) continue;
      anchors++;
      const row = b.parentElement;
      if (!row) continue;
      if (row.querySelector("[" + DONE_ATTR + "='btn']")) continue; // already done
      const card = _cardFromButton(b);
      try {
        const btn = _makePushBtn(card);
        // Place immediately AFTER the "Send on WhatsApp" button.
        row.insertBefore(btn, b.nextSibling);
        injected++;
      } catch (e) { /* skip */ }
    }
    if (injected) console.log(LOG, "injected", injected, "button(s);", anchors, "WhatsApp card(s) seen");
  }

  let _timer = null;
  function _start() {
    if (_timer) return;
    _timer = setInterval(() => { try { _decorate(); } catch (e) {} }, 1500);
    try {
      const mo = new MutationObserver(() => { try { _decorate(); } catch (e) {} });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    try { _decorate(); } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _start);
  } else {
    _start();
  }
})();
