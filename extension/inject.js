// Runs in the page's MAIN world at document_start.
// Hooks fetch / XMLHttpRequest / WebSocket so we observe LeadLoft's
// API responses and forward arrays of objects to the isolated content
// script via window.postMessage. The heuristic is intentionally
// permissive: we'd rather capture too much (and dedupe later) than miss
// the real lead payload because field names don't match expectations.

(() => {
  if (window.__leadloftNetHookInstalled) return;
  window.__leadloftNetHookInstalled = true;

  const TAG = '__leadloftExporter';
  const LOG = '[LeadLoft Exporter:hook]';

  const stats = (window.__leadloftExporterCaptured = {
    urls: [],
    arrays: 0,
    objects: 0,
  });

  const post = (payload) => {
    try { window.postMessage({ [TAG]: true, ...payload }, '*'); } catch (_) {}
  };

  const NAMEY = /(^|_|\.|-)((full|first|last|display|given|family)_?name|name|contact|person|lead|prospect|account|company|organization|owner|email|phone|mobile|linkedin|twitter|title|job|role|stage|status)/i;

  const objectSharesKeys = (sample) => {
    if (!sample.length) return false;
    const keysOfFirst = new Set(Object.keys(sample[0] || {}));
    if (keysOfFirst.size < 3) return false;
    let consistent = 0;
    for (const obj of sample) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const ks = Object.keys(obj);
      const overlap = ks.filter((k) => keysOfFirst.has(k)).length;
      if (overlap >= Math.min(3, keysOfFirst.size)) consistent++;
    }
    return consistent / sample.length >= 0.6;
  };

  const looksLikeRecordArray = (arr) => {
    if (!Array.isArray(arr) || arr.length < 1) return false;
    const sample = arr.slice(0, 5).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (sample.length === 0) return false;
    if (!objectSharesKeys(sample)) return false;
    // Must look at least vaguely "people-shaped".
    const keys = Object.keys(sample[0]).map((k) => k.toLowerCase());
    return keys.some((k) => NAMEY.test(k)) || keys.length >= 5;
  };

  // Walk any JSON-ish value, collecting arrays of record objects.
  const collectArrays = (data) => {
    const found = [];
    const seen = new WeakSet();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 10) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (looksLikeRecordArray(node)) {
          found.push(node);
        }
        for (const item of node) visit(item, depth + 1);
      } else {
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return found;
  };

  const flattenOneLevel = (obj) => {
    // Promote primitive fields from nested "lead.contact" or "person" objects
    // up to the top level so downstream code can find them by simple key match.
    if (!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (v2 == null || typeof v2 === 'object') continue;
          const composite = `${k}.${k2}`;
          if (!(composite in out)) out[composite] = v2;
          if (!(k2 in out)) out[k2] = v2;
        }
      }
    }
    return out;
  };

  const handleJson = (data, url) => {
    let totalObjects = 0;
    for (const arr of collectArrays(data)) {
      const flattened = arr.map(flattenOneLevel);
      totalObjects += flattened.length;
      stats.arrays++;
      stats.objects += flattened.length;
      post({ kind: 'LEADS', url: String(url || ''), leads: flattened });
    }
    if (totalObjects) {
      stats.urls.push({ url: String(url || ''), count: totalObjects });
      console.log(`${LOG} captured ${totalObjects} record(s) from`, url);
    }
  };

  const safeParse = (txt) => { try { return JSON.parse(txt); } catch (_) { return null; } };

  // ---- fetch hook ----
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const response = await origFetch(...args);
      try {
        const clone = response.clone();
        clone.text().then((txt) => {
          if (!txt) return;
          const data = safeParse(txt);
          if (!data) return;
          const url = response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url);
          handleJson(data, url);
        }).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  // ---- XMLHttpRequest hook ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__leadloftUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const txt = (this.responseType === '' || this.responseType === 'text') ? this.responseText
                  : (this.responseType === 'json') ? JSON.stringify(this.response)
                  : '';
        if (!txt) return;
        const data = safeParse(txt);
        if (!data) return;
        handleJson(data, this.__leadloftUrl);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---- WebSocket hook (some CRMs push updates this way) ----
  if (typeof WebSocket === 'function') {
    const OrigWS = window.WebSocket;
    function HookedWS(url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      ws.addEventListener('message', (ev) => {
        try {
          const txt = typeof ev.data === 'string' ? ev.data : null;
          if (!txt) return;
          const data = safeParse(txt);
          if (!data) return;
          handleJson(data, `ws:${url}`);
        } catch (_) {}
      });
      return ws;
    }
    HookedWS.prototype = OrigWS.prototype;
    HookedWS.CONNECTING = OrigWS.CONNECTING;
    HookedWS.OPEN = OrigWS.OPEN;
    HookedWS.CLOSING = OrigWS.CLOSING;
    HookedWS.CLOSED = OrigWS.CLOSED;
    try { window.WebSocket = HookedWS; } catch (_) {}
  }

  console.log(`${LOG} hooks installed at`, location.href);
  post({ kind: 'HOOK_READY' });
})();
