// Runs in the page's MAIN world at document_start.
// Hooks window.fetch and XMLHttpRequest so we can observe LeadLoft's API
// responses and forward any lead-like objects to the isolated content
// script via window.postMessage. The DOM only renders a subset of each
// lead's fields (name, stage, dates) — emails/phones/LinkedIn URLs live
// in the API JSON, which is why DOM scraping alone misses them.

(() => {
  if (window.__leadloftNetHookInstalled) return;
  window.__leadloftNetHookInstalled = true;

  const TAG = '__leadloftExporter';

  const post = (payload) => {
    try {
      window.postMessage({ [TAG]: true, ...payload }, '*');
    } catch (_) {}
  };

  // Recognise lead-shaped objects: must look like a person/company record
  // and carry at least one contact-ish field.
  const looksLikeLead = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj).map((k) => k.toLowerCase());
    if (keys.length < 3) return false;
    const hasIdentity = keys.some((k) =>
      /(^|_)(name|first_?name|last_?name|full_?name|display_?name|contact|lead|person)/.test(k)
    );
    const hasContact = keys.some((k) =>
      /(email|phone|mobile|cell|linkedin|twitter|website|url|domain|company|title|job|position)/.test(k)
    );
    return hasIdentity && hasContact;
  };

  // Walk arbitrary JSON looking for arrays of lead-shaped objects.
  const collectLeads = (data) => {
    const out = [];
    const seen = new WeakSet();
    const visit = (node, depth) => {
      if (!node || depth > 8) return;
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && looksLikeLead(node[0])) {
          for (const item of node) {
            if (looksLikeLead(item)) out.push(item);
          }
        } else {
          for (const item of node) visit(item, depth + 1);
        }
      } else {
        // Check if this single object itself is a lead (some endpoints return one).
        if (looksLikeLead(node) && Object.keys(node).length >= 5) {
          out.push(node);
        }
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return out;
  };

  const safeParse = (txt) => {
    try { return JSON.parse(txt); } catch (_) { return null; }
  };

  const handleJson = (data, url) => {
    const leads = collectLeads(data);
    if (leads.length) {
      post({ kind: 'LEADS', url: String(url || ''), leads });
    }
  };

  // --- fetch hook ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const clone = response.clone();
        const ct = (clone.headers && clone.headers.get('content-type')) || '';
        if (/json|javascript|text\/plain/i.test(ct) || ct === '') {
          clone.text().then((txt) => {
            const data = safeParse(txt);
            if (data) handleJson(data, response.url || (typeof args[0] === 'string' ? args[0] : args[0]?.url));
          }).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  // --- XMLHttpRequest hook ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__leadloftUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
        if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
          let data = null;
          if (this.responseType === 'json') {
            data = this.response;
          } else {
            const txt = this.responseText;
            if (txt && (/json|javascript/i.test(ct) || ct === '' || txt.trim().startsWith('{') || txt.trim().startsWith('['))) {
              data = safeParse(txt);
            }
          }
          if (data) handleJson(data, this.__leadloftUrl);
        }
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  post({ kind: 'HOOK_READY' });
})();
