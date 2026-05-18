// Runs in the page's MAIN world at document_start.
// Hooks fetch / XMLHttpRequest / WebSocket and forwards every JSON
// array-of-objects payload it sees to the isolated content script,
// tagged with the source URL. The isolated script decides which
// arrays are actual leads.

(() => {
  if (window.__leadloftNetHookInstalled) return;
  window.__leadloftNetHookInstalled = true;

  const TAG = '__leadloftExporter';
  const LOG = '[LeadLoft Exporter:hook]';

  const stats = (window.__leadloftExporterCaptured = { events: 0 });

  const post = (payload) => {
    try { window.postMessage({ [TAG]: true, ...payload }, '*'); } catch (_) {}
  };

  // Unwrap GraphQL-style edges/nodes and other single-key wrappers so
  // downstream code sees flat record objects.
  const unwrap = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const v = obj[keys[0]];
      if (v && typeof v === 'object' && !Array.isArray(v)) return unwrap(v);
    }
    if ('node' in obj && obj.node && typeof obj.node === 'object') return unwrap(obj.node);
    if ('attributes' in obj && obj.attributes && typeof obj.attributes === 'object' && Object.keys(obj).length <= 3) {
      return { ...obj, ...unwrap(obj.attributes) };
    }
    return obj;
  };

  const flattenOneLevel = (obj) => {
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

  // Find every array of records in a response (depth-walk).
  const findArrays = (data) => {
    const found = [];
    const seen = new WeakSet();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 10) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length >= 1) {
          const unwrapped = node.map(unwrap).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
          if (unwrapped.length >= Math.min(1, node.length)) {
            found.push(unwrapped.map(flattenOneLevel));
          }
        }
        for (const item of node) visit(item, depth + 1);
      } else {
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return found;
  };

  const safeParse = (txt) => { try { return JSON.parse(txt); } catch (_) { return null; } };

  const dispatch = (data, url, method) => {
    const arrays = findArrays(data);
    if (!arrays.length) return;
    for (const arr of arrays) {
      if (arr.length === 0) continue;
      // Skip trivial 1-item arrays of tiny objects (often metadata).
      if (arr.length === 1 && Object.keys(arr[0]).length < 4) continue;
      stats.events++;
      post({ kind: 'CAPTURE', url: String(url || ''), method: method || 'GET', items: arr });
    }
    if (arrays.length) {
      console.log(`${LOG} captured ${arrays.length} array(s) from ${method || ''} ${url}`);
    }
  };

  // ---- fetch hook ----
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      const response = await origFetch(...args);
      try {
        const clone = response.clone();
        clone.text().then((txt) => {
          if (!txt) return;
          const data = safeParse(txt);
          if (!data) return;
          const url = response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url);
          dispatch(data, url, method);
        }).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  // ---- XMLHttpRequest hook ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__leadloftUrl = url;
    this.__leadloftMethod = method;
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
        dispatch(data, this.__leadloftUrl, this.__leadloftMethod);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---- WebSocket hook ----
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
          dispatch(data, `ws:${url}`, 'WS');
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
