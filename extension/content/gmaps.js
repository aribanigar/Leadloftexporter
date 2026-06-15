/* Company Finder — Google Maps capture (isolated world).
 *
 * Injects the page-world XHR hook (gmaps_inject.js), then parses each Google
 * Maps `/search` response into businesses (name, phone, website, address,
 * lat/lng, category, rating, hours) using the SAME nested-array field paths as
 * the reference scraper, dedupes by place_id/cid, and POSTs batches to the
 * backend (/company-finder/ingest) via the service worker. Auto-scroll loads
 * every result so no business is missed.
 *
 * Email enrichment from business websites is intentionally NOT done here (it
 * needs broad host permissions); the website is captured and the email is
 * filled by the dedicated scraper's CSV/JSON import, or left blank.
 */
(() => {
  if (window.__lcGmapsLoaded) return;
  window.__lcGmapsLoaded = true;

  const seen = new Set(); // place_id|cid dedupe within this session
  let buffer = [];
  let captured = 0;
  let auto = false;

  // ── inject the page-world hook ──
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/gmaps_inject.js");
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }

  // ── status pill ──
  let pill;
  function ui() {
    if (pill && document.body.contains(pill)) return;
    pill = document.createElement("div");
    pill.style.cssText =
      "position:fixed;z-index:99999;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;" +
      "background:#0c5d52;color:#fff;font:600 12px system-ui;padding:8px 10px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    const label = document.createElement("span");
    label.id = "lc_cf_label";
    label.textContent = "Company Finder: 0 captured";
    const btn = document.createElement("button");
    btn.textContent = "Auto-scrape";
    btn.style.cssText = "background:#f4a300;color:#1b1b1f;border:0;border-radius:7px;padding:5px 9px;font-weight:700;cursor:pointer";
    btn.onclick = () => (auto ? stopAuto() : startAuto(btn));
    btn.id = "lc_cf_btn";
    pill.append(label, btn);
    document.body && document.body.appendChild(pill);
  }
  function setLabel(t) { const l = document.getElementById("lc_cf_label"); if (l) l.textContent = t; }
  setInterval(ui, 4000);
  ui();

  // ── auto-scroll the results feed so every business loads ──
  async function startAuto(btn) {
    auto = true; if (btn) { btn.textContent = "Stop"; btn.style.background = "#ea4335"; btn.style.color = "#fff"; }
    const feed = document.querySelector('[role="feed"]');
    if (!feed) { setLabel("Open a Maps search results list first"); stopAuto(); return; }
    let stale = 0, lastH = -1;
    while (auto) {
      feed.scrollTop = feed.scrollHeight;
      await sleep(1000 + Math.random() * 2500);
      if (document.getElementsByClassName("HlvSq").length > 0) { setLabel(`Done — ${captured} captured`); break; }
      if (lastH === feed.scrollHeight) { if (++stale >= 20) break; } else { stale = 0; lastH = feed.scrollHeight; }
    }
    stopAuto();
  }
  function stopAuto() {
    auto = false;
    const b = document.getElementById("lc_cf_btn");
    if (b) { b.textContent = "Auto-scrape"; b.style.background = "#f4a300"; b.style.color = "#1b1b1f"; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── parse the /search payload (same field paths as the reference scraper) ──
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.type !== "lc_gmaps_search" || !ev.data.data) return;
    let feed64;
    try {
      const outer = JSON.parse(String(ev.data.data).replace('/*""*/', ""));
      const inner = JSON.parse(outer.d.slice(5)); // strip )]}' XSSI guard
      feed64 = inner[64];
    } catch (e) { return; }
    if (!Array.isArray(feed64)) return;

    const out = [];
    for (const item of feed64) {
      try {
        if (!item || !Array.isArray(item)) continue;
        const c = item[item.length - 1];
        if (!c) continue;
        const name = c[11] || "";
        if (!name) continue;
        const place_id = c[78] || "";
        const cid = c[37] && c[37][0] && c[37][0][0] && c[37][0][0][29] ? c[37][0][0][29][1] || "" : "";
        const key = place_id || cid || name;
        if (seen.has(key)) continue;
        seen.add(key);
        const website = (c[7] && c[7][0]) || "";
        const phone = (c[178] && c[178][0] && c[178][0][0]) || "";
        const category = Array.isArray(c[13]) ? c[13].join("; ") : "";
        const ratingCount = (c[4] && c[4][8]) || "";
        const rating = (c[4] && c[4][7]) || "";
        const address = Array.isArray(c[2]) ? c[2].join(", ") : "";
        const latitude = c[9] && c[9][2] != null ? c[9][2] : null;
        const longitude = c[9] && c[9][3] != null ? c[9][3] : null;
        // opening hours (c[203][0] → [{day, hours, weekDay}])
        const hours = {};
        try {
          const hn = c[203] && c[203][0];
          if (Array.isArray(hn)) {
            for (const u of hn) {
              if (!u) continue;
              const day = u[0] || "";
              const hrs = Array.isArray(u[3]) ? u[3].map((x) => (x && x[0]) || "").filter(Boolean).join(", ") : "";
              if (day) hours[day] = hrs;
            }
          }
        } catch (e) { /* ignore */ }
        out.push({
          name, phone, website, address, category,
          rating: String(rating || ""), rating_count: String(ratingCount || ""),
          latitude, longitude, place_id, cid,
          profile_url: cid ? `https://www.google.com/maps?cid=${cid}` : "",
          hours,
        });
      } catch (e) { /* skip bad item */ }
    }
    if (out.length) flush(out);
  });

  let flushTimer = null;
  function flush(items) {
    buffer.push(...items);
    captured += items.length;
    setLabel(`Company Finder: ${captured} captured`);
    if (flushTimer) clearTimeout(flushTimer);
    // small debounce so rapid /search bursts batch into one POST
    flushTimer = setTimeout(() => {
      const batch = buffer.splice(0, buffer.length);
      if (!batch.length) return;
      try {
        chrome.runtime.sendMessage({ type: "lc_cf_ingest", businesses: batch }, (resp) => {
          if (chrome.runtime.lastError) { setLabel(`Captured ${captured} (sync pending)`); return; }
          if (resp && resp.ok) setLabel(`Company Finder: ${captured} captured → synced`);
        });
      } catch (e) { /* context invalidated; ignore */ }
    }, 1200);
  }
})();
