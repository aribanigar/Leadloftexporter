// Content script — runs on leadloft.com pages.
// Detects tabular lead lists and extracts them as { headers, rows } arrays
// when the popup asks. Supports:
//   1. Native <table> elements
//   2. ARIA grids (role="grid" / role="table" with role="row"/"cell")
//   3. Repeating-row patterns common in virtualized React/Vue lead lists

(() => {
  if (window.__leadloftExporterInstalled) return;
  window.__leadloftExporterInstalled = true;

  const MIN_ROWS_FOR_HEURISTIC = 3;
  const SCROLL_SETTLE_MS = 500;
  const SCROLL_MAX_ITERATIONS = 60;
  const SCROLL_NO_GROWTH_LIMIT = 4;

  // Track candidate tables across messages by id.
  let candidateRegistry = new Map();

  // Captured API lead objects (filled by inject.js via postMessage).
  // Keyed by a derived ID so we dedupe across paginated responses.
  const capturedLeads = new Map();           // id -> lead
  const capturedLeadsByName = new Map();     // lower-cased name -> lead
  const seenLeadIdentities = new Set();

  const PREFERRED_FIELDS = [
    'name', 'full_name', 'fullName', 'first_name', 'firstName',
    'last_name', 'lastName', 'email', 'emails', 'email_address',
    'phone', 'phones', 'phone_number', 'mobile', 'cell',
    'linkedin', 'linkedin_url', 'linkedinUrl',
    'twitter', 'twitter_url', 'website', 'site', 'url', 'domain',
    'title', 'job_title', 'jobTitle', 'position', 'role',
    'company', 'company_name', 'companyName', 'organization', 'employer',
    'stage', 'status', 'tags', 'owner', 'created_at', 'createdAt',
    'updated_at', 'updatedAt', 'last_activity', 'notes',
  ];

  const FIELD_PATTERNS = {
    Email:    /^(email|email_address|primary_email)$|emails?$/i,
    Phone:    /^(phone|phone_number|primary_phone|mobile|cell|telephone)$|phones?$/i,
    LinkedIn: /linked_?in/i,
    Twitter:  /twitter|x_url/i,
    Website:  /^(website|site|url|domain|company_url)$/i,
    Title:    /^(title|job_?title|position|role|headline)$/i,
    Company:  /^(company|company_name|organization|employer|account|business)$/i,
  };

  const leadId = (lead) => {
    if (!lead || typeof lead !== 'object') return null;
    for (const k of ['id', '_id', 'uuid', 'lead_id', 'leadId', 'contact_id', 'contactId']) {
      if (lead[k] != null) return `${k}:${lead[k]}`;
    }
    return null;
  };

  const findKey = (obj, regex) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      if (regex.test(k)) return k;
    }
    return null;
  };

  const getStr = (obj, key) => {
    if (!key) return '';
    const v = obj[key];
    return (typeof v === 'string') ? v.trim() : (v == null ? '' : String(v).trim());
  };

  const inferLeadName = (lead) => {
    if (!lead || typeof lead !== 'object') return '';
    const direct = findKey(lead, /^(full_?name|display_?name|contact_?name|lead_?name)$/i)
                || findKey(lead, /^name$/i);
    if (direct) {
      const v = getStr(lead, direct);
      if (v) return v;
    }
    const first = getStr(lead, findKey(lead, /^(first_?name|given_?name|fname)$/i));
    const last  = getStr(lead, findKey(lead, /^(last_?name|family_?name|surname|lname)$/i));
    const joined = `${first} ${last}`.trim();
    if (joined) return joined;
    // Last resort: any key containing "name".
    const looseKey = findKey(lead, /name/i);
    if (looseKey) return getStr(lead, looseKey);
    return '';
  };

  const normalizeName = (s) => {
    if (!s) return '';
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')   // strip diacritics
      .replace(/[^\w\s]/g, ' ')           // strip punctuation
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };

  const matchFieldValue = (lead, regex) => {
    const found = [];
    const visit = (node, depth) => {
      if (!node || depth > 3) return;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object') visit(item, depth + 1);
          else if (item != null && item !== '') found.push(String(item));
        }
        return;
      }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (regex.test(k)) {
            if (v == null || v === '') continue;
            if (typeof v === 'object') visit(v, depth + 1);
            else found.push(String(v));
          } else if (v && typeof v === 'object') {
            visit(v, depth + 1);
          }
        }
      }
    };
    visit(lead, 0);
    return Array.from(new Set(found)).join('; ');
  };

  const ingestCapturedLeads = (leads) => {
    let added = 0;
    for (const lead of leads) {
      if (!lead || typeof lead !== 'object') continue;
      const nm = inferLeadName(lead);
      const id = leadId(lead) || (nm ? `name:${normalizeName(nm)}` : null);
      if (!id) continue;
      if (seenLeadIdentities.has(id)) continue;
      seenLeadIdentities.add(id);
      capturedLeads.set(id, lead);
      if (nm) capturedLeadsByName.set(normalizeName(nm), lead);
      added++;
    }
    if (added) {
      const sampleKeys = capturedLeads.size
        ? Object.keys(capturedLeads.values().next().value).slice(0, 8).join(', ')
        : '';
      console.log(`[LeadLoft Exporter] +${added} leads (total ${capturedLeads.size}); fields: ${sampleKeys}`);
    }
  };

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || !data.__leadloftExporter) return;
    if (data.kind === 'LEADS' && Array.isArray(data.leads)) {
      ingestCapturedLeads(data.leads);
    }
  });

  // ---------- safety-net probe ----------
  // Hooks only catch requests fired AFTER the page loaded with the
  // extension active. If the user opens the popup on a tab that was
  // already loaded, we replay every API-looking URL the page recorded
  // in the Performance API. Browser cookies make these calls authenticate.

  const probedUrls = new Set();

  const looksLikeApiUrl = (url) => {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (/\.(png|jpe?g|gif|svg|webp|css|woff2?|ttf|ico|map|mp4|mp3)(\?|#|$)/i.test(url)) return false;
    if (/\.(js)(\?|#|$)/i.test(url) && !/api|graphql/i.test(url)) return false;
    return /api|graphql|leads?|contacts?|pipeline|prospects?|deals?|opportunit|crm|v\d+/i.test(url);
  };

  const collectArraysFromJson = (data) => {
    const out = [];
    const seen = new WeakSet();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 10) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          out.push(node);
        }
        for (const item of node) visit(item, depth + 1);
      } else {
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return out;
  };

  const probeForLeads = async () => {
    let entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch (_) {}
    const urls = Array.from(new Set(entries.map((e) => e.name).filter(looksLikeApiUrl)))
      .filter((u) => !probedUrls.has(u));
    if (!urls.length) return 0;
    console.log(`[LeadLoft Exporter] probing ${urls.length} API URLs from performance entries`);
    let added = 0;
    await Promise.all(urls.map(async (url) => {
      probedUrls.add(url);
      try {
        const res = await fetch(url, { credentials: 'include', cache: 'no-cache' });
        if (!res.ok) return;
        const ct = res.headers.get('content-type') || '';
        const txt = await res.text();
        let data = null;
        try { data = JSON.parse(txt); } catch (_) { return; }
        const arrays = collectArraysFromJson(data);
        for (const arr of arrays) {
          const before = capturedLeads.size;
          ingestCapturedLeads(arr);
          added += capturedLeads.size - before;
        }
      } catch (e) {
        // CORS or auth failures are expected for some endpoints — silent.
      }
    }));
    return added;
  };

  // Find a captured lead whose name appears inside the given row text.
  const findLeadForRow = (rowText) => {
    if (!rowText || !capturedLeadsByName.size) return null;
    const norm = normalizeName(rowText);
    let best = null;
    let bestLen = 0;
    for (const [name, lead] of capturedLeadsByName) {
      if (name.length < 3) continue;
      if (norm.includes(name) && name.length > bestLen) {
        best = lead;
        bestLen = name.length;
      }
    }
    return best;
  };

  // Merge API-derived contacts into a row's existing contact dict.
  const enrichContactsWithApi = (rowEl, contacts) => {
    const rowText = (rowEl && (rowEl.innerText || rowEl.textContent)) || '';
    const lead = findLeadForRow(rowText);
    if (!lead) return contacts;
    return {
      emails:    contacts.emails    || matchFieldValue(lead, FIELD_PATTERNS.Email),
      phones:    contacts.phones    || matchFieldValue(lead, FIELD_PATTERNS.Phone),
      linkedins: contacts.linkedins || matchFieldValue(lead, FIELD_PATTERNS.LinkedIn),
      twitters:  contacts.twitters  || matchFieldValue(lead, FIELD_PATTERNS.Twitter),
      websites:  contacts.websites  || matchFieldValue(lead, FIELD_PATTERNS.Website),
    };
  };

  const text = (el) => {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
    // Icon-only cells: fall back to aria-label, title, or contained img alt.
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const title = el.getAttribute && el.getAttribute('title');
    if (title) return title.trim();
    if (el.querySelector) {
      const img = el.querySelector('img[alt]');
      if (img && img.alt) return img.alt.trim();
    }
    return '';
  };

  // Pull contact info out of every <a href> inside the row element.
  // Runs regardless of visibility — LeadLoft hides action icons until
  // hover, but the hrefs are present in the DOM the whole time.
  const extractRowContacts = (rowEl) => {
    const emails = new Set();
    const phones = new Set();
    const linkedins = new Set();
    const twitters = new Set();
    const websites = new Set();
    if (!rowEl || !rowEl.querySelectorAll) {
      return { emails: '', phones: '', linkedins: '', twitters: '', websites: '' };
    }
    rowEl.querySelectorAll('a[href]').forEach((a) => {
      const raw = a.getAttribute('href') || '';
      if (!raw) return;
      if (/^mailto:/i.test(raw)) {
        const addr = decodeURIComponent(raw.slice(7).split('?')[0]).trim();
        if (addr) emails.add(addr);
      } else if (/^tel:/i.test(raw)) {
        const num = decodeURIComponent(raw.slice(4)).trim();
        if (num) phones.add(num);
      } else if (/linkedin\.com\//i.test(raw)) {
        linkedins.add(raw);
      } else if (/(twitter|x)\.com\//i.test(raw)) {
        twitters.add(raw);
      } else if (/^https?:\/\//i.test(raw)) {
        websites.add(raw);
      }
    });
    // Fallback: scan visible text for bare email addresses (only emails —
    // phone-shaped strings produce too many false positives like dates).
    const allText = (rowEl.innerText || rowEl.textContent || '');
    const emailMatches = allText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
    emailMatches.forEach((e) => emails.add(e));
    return {
      emails: [...emails].join('; '),
      phones: [...phones].join('; '),
      linkedins: [...linkedins].join('; '),
      twitters: [...twitters].join('; '),
      websites: [...websites].join('; '),
    };
  };

  const CONTACT_COLUMNS = ['Email', 'Phone', 'LinkedIn', 'Twitter', 'Website'];
  const contactRow = (c) => [c.emails, c.phones, c.linkedins, c.twitters, c.websites];

  // Drop columns whose header is blank AND every data row is blank.
  // Re-labels remaining anonymous headers as Column 1..N for clarity.
  const pruneEmptyColumns = (headers, rows) => {
    const keep = headers.map((h, i) => {
      if (h && h.trim()) return true;
      return rows.some((r) => (r[i] ?? '').toString().trim() !== '');
    });
    const newHeaders = [];
    const newRows = rows.map(() => []);
    let colIdx = 0;
    headers.forEach((h, i) => {
      if (!keep[i]) return;
      colIdx++;
      newHeaders.push((h && h.trim()) || `Column ${colIdx}`);
      rows.forEach((r, ri) => newRows[ri].push(r[i] ?? ''));
    });
    return { headers: newHeaders, rows: newRows };
  };

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // ---------- detection ----------

  const detectNativeTables = () => {
    const out = [];
    document.querySelectorAll('table').forEach((tbl, i) => {
      if (!isVisible(tbl)) return;
      const headers = extractNativeHeaders(tbl);
      const rows = tbl.querySelectorAll('tbody tr, tr');
      const rowCount = countDataRows(tbl);
      if (rowCount === 0) return;
      out.push({
        id: `native-${i}`,
        kind: 'native',
        element: tbl,
        label: tableLabel(tbl, `Table #${i + 1}`),
        headers,
        rowCount,
      });
    });
    return out;
  };

  const extractNativeHeaders = (tbl) => {
    const thead = tbl.querySelector('thead');
    if (thead) {
      const ths = thead.querySelectorAll('tr:last-child th, tr:last-child td');
      if (ths.length) return Array.from(ths).map(text);
    }
    const firstRowThs = tbl.querySelectorAll('tr:first-child th');
    if (firstRowThs.length) return Array.from(firstRowThs).map(text);
    const firstTr = tbl.querySelector('tr');
    if (firstTr) return Array.from(firstTr.children).map(text);
    return [];
  };

  const countDataRows = (tbl) => {
    const tbody = tbl.querySelector('tbody');
    if (tbody) return tbody.querySelectorAll('tr').length;
    const all = tbl.querySelectorAll('tr');
    return Math.max(0, all.length - 1);
  };

  const detectAriaGrids = () => {
    const out = [];
    const grids = document.querySelectorAll('[role="grid"], [role="table"]');
    grids.forEach((grid, i) => {
      if (!isVisible(grid)) return;
      const headerCells = grid.querySelectorAll('[role="columnheader"]');
      const dataRows = grid.querySelectorAll('[role="row"]');
      const headers = headerCells.length
        ? Array.from(headerCells).map(text)
        : inferHeadersFromFirstRow(dataRows);
      const rowCount = countAriaDataRows(dataRows);
      if (rowCount < MIN_ROWS_FOR_HEURISTIC && headerCells.length === 0) return;
      out.push({
        id: `aria-${i}`,
        kind: 'aria',
        element: grid,
        label: tableLabel(grid, `Grid #${i + 1}`),
        headers,
        rowCount,
      });
    });
    return out;
  };

  const inferHeadersFromFirstRow = (rows) => {
    if (!rows || !rows.length) return [];
    const firstRow = rows[0];
    const cells = firstRow.querySelectorAll('[role="cell"], [role="gridcell"], [role="rowheader"]');
    return Array.from(cells).map(text);
  };

  const countAriaDataRows = (rows) => {
    let n = 0;
    rows.forEach((r) => {
      const isHeader = r.querySelector('[role="columnheader"]');
      if (!isHeader) n++;
    });
    return n;
  };

  // Heuristic: find a container with many repeating direct children
  // sharing the same primary class signature — that's typically a lead list.
  const detectRepeatingRowLists = () => {
    const out = [];
    const all = document.querySelectorAll('body *');
    const seen = new Set();
    let idx = 0;
    for (const el of all) {
      if (seen.has(el)) continue;
      if (!isVisible(el)) continue;
      if (el.children.length < MIN_ROWS_FOR_HEURISTIC) continue;
      const sig = classSignature(el.children);
      if (!sig) continue;
      const matching = Array.from(el.children).filter((c) => primaryClass(c) === sig.cls);
      if (matching.length < MIN_ROWS_FOR_HEURISTIC) continue;
      if (matching.length / el.children.length < 0.6) continue;
      // Skip if it overlaps with already-detected native/aria tables.
      if (el.closest('table, [role="grid"], [role="table"]')) continue;
      // Cells per row must be roughly consistent and > 1.
      const cellCounts = matching.slice(0, 8).map((m) => countLeafTextCells(m));
      const avg = cellCounts.reduce((a, b) => a + b, 0) / cellCounts.length;
      if (avg < 2) continue;

      const headers = guessHeadersForRepeatingList(el, matching[0]);
      matching.forEach((m) => seen.add(m));

      out.push({
        id: `repeat-${idx++}`,
        kind: 'repeat',
        element: el,
        rowSelector: '.' + sig.cls.split(' ').join('.'),
        label: tableLabel(el, `List #${idx}`),
        headers,
        rowCount: matching.length,
      });
    }
    return out;
  };

  const classSignature = (children) => {
    const counts = new Map();
    for (const c of children) {
      const cls = primaryClass(c);
      if (!cls) continue;
      counts.set(cls, (counts.get(cls) || 0) + 1);
    }
    let best = null;
    for (const [cls, n] of counts) {
      if (!best || n > best.n) best = { cls, n };
    }
    return best && best.n >= MIN_ROWS_FOR_HEURISTIC ? best : null;
  };

  const primaryClass = (el) => {
    if (!el.classList || el.classList.length === 0) return '';
    return Array.from(el.classList).join(' ');
  };

  const countLeafTextCells = (row) => {
    let n = 0;
    const walk = (node) => {
      if (!node || !node.children) return;
      if (node.children.length === 0) {
        if (text(node)) n++;
        return;
      }
      for (const c of node.children) walk(c);
    };
    walk(row);
    return n;
  };

  const guessHeadersForRepeatingList = (container, sampleRow) => {
    // Try a sibling header bar above the list.
    const prev = container.previousElementSibling;
    if (prev) {
      const headerLike = prev.querySelectorAll('[role="columnheader"], .header, .column-header, th');
      if (headerLike.length) return Array.from(headerLike).map(text);
      const flat = Array.from(prev.children || []).map(text).filter(Boolean);
      if (flat.length >= 2 && flat.length <= 20) return flat;
    }
    // Fall back to column indices.
    const cells = leafTextCells(sampleRow);
    return cells.map((_, i) => `Column ${i + 1}`);
  };

  const leafTextCells = (row) => {
    const out = [];
    const walk = (node) => {
      if (!node || !node.children) return;
      if (node.children.length === 0) {
        out.push(node);
        return;
      }
      for (const c of node.children) walk(c);
    };
    walk(row);
    return out;
  };

  const tableLabel = (el, fallback) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const caption = el.querySelector && el.querySelector('caption');
    if (caption && text(caption)) return text(caption);
    // Look for a heading immediately preceding the table.
    let p = el.previousElementSibling;
    let hops = 0;
    while (p && hops < 3) {
      const h = p.matches && p.matches('h1,h2,h3,h4') ? p : p.querySelector && p.querySelector('h1,h2,h3,h4');
      if (h && text(h)) return text(h).slice(0, 60);
      p = p.previousElementSibling;
      hops++;
    }
    return fallback;
  };

  const buildApiCandidate = () => {
    if (capturedLeads.size === 0) return null;
    const headers = buildApiHeaders(capturedLeads);
    return {
      id: 'api-capture',
      kind: 'api',
      element: null,
      label: `API capture (${capturedLeads.size} leads)`,
      headers,
      rowCount: capturedLeads.size,
    };
  };

  const buildApiHeaders = (leadsMap) => {
    // Union of keys across all leads, preferred fields first.
    const keys = new Set();
    for (const lead of leadsMap.values()) {
      Object.keys(lead).forEach((k) => keys.add(k));
    }
    const ordered = [];
    for (const p of PREFERRED_FIELDS) {
      if (keys.has(p)) { ordered.push(p); keys.delete(p); }
    }
    // Append any remaining scalar-ish keys.
    for (const k of keys) {
      const sample = sampleValueForKey(leadsMap, k);
      if (sample === '__SKIP__') continue;
      ordered.push(k);
    }
    return ordered;
  };

  const sampleValueForKey = (leadsMap, key) => {
    for (const lead of leadsMap.values()) {
      const v = lead[key];
      if (v == null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) return '__SKIP__';
      return v;
    }
    return '';
  };

  const stringifyVal = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ');
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  const extractApi = () => {
    if (capturedLeads.size === 0) return { headers: [], rows: [] };
    const headers = buildApiHeaders(capturedLeads);
    const rows = [];
    for (const lead of capturedLeads.values()) {
      rows.push(headers.map((h) => stringifyVal(lead[h])));
    }
    return { headers, rows };
  };

  const detectAll = () => {
    candidateRegistry = new Map();
    const tables = [
      ...detectNativeTables(),
      ...detectAriaGrids(),
      ...detectRepeatingRowLists(),
    ];
    // Sort: most rows first.
    tables.sort((a, b) => b.rowCount - a.rowCount);
    const apiCandidate = buildApiCandidate();
    const all = apiCandidate ? [apiCandidate, ...tables] : tables;
    // Register and return sanitized descriptors.
    return all.map((t) => {
      candidateRegistry.set(t.id, t);
      return {
        id: t.id,
        kind: t.kind,
        label: t.label,
        headers: t.headers,
        rowCount: t.rowCount,
      };
    });
  };

  // ---------- extraction ----------

  const extractNative = (tbl, includeHidden) => {
    const headers = extractNativeHeaders(tbl);
    const visibleColIdx = headers.map((_, i) => i).filter((i) => {
      if (includeHidden) return true;
      const sampleHeader = tbl.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')[i];
      return !sampleHeader || isVisible(sampleHeader);
    });
    const bodyRows = tbl.querySelector('tbody')
      ? tbl.querySelectorAll('tbody tr')
      : Array.from(tbl.querySelectorAll('tr')).slice(1);
    const rows = [];
    bodyRows.forEach((tr) => {
      const cells = Array.from(tr.children);
      if (!cells.length) return;
      const row = visibleColIdx.map((i) => text(cells[i]));
      const contacts = enrichContactsWithApi(tr, extractRowContacts(tr));
      const full = [...row, ...contactRow(contacts)];
      if (full.some((v) => v !== '')) rows.push(full);
    });
    return {
      headers: [...visibleColIdx.map((i) => headers[i] ?? `Column ${i + 1}`), ...CONTACT_COLUMNS],
      rows,
    };
  };

  const extractAria = (grid, includeHidden) => {
    const headerCells = Array.from(grid.querySelectorAll('[role="columnheader"]'));
    const headers = headerCells.length
      ? headerCells.map(text)
      : inferHeadersFromFirstRow(grid.querySelectorAll('[role="row"]'));
    const visibleHeaderIdx = headers.map((_, i) => i).filter((i) => {
      if (includeHidden) return true;
      return !headerCells[i] || isVisible(headerCells[i]);
    });
    const rows = [];
    grid.querySelectorAll('[role="row"]').forEach((row) => {
      if (row.querySelector('[role="columnheader"]')) return;
      const cells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"], [role="rowheader"]'));
      if (!cells.length) return;
      const extracted = visibleHeaderIdx.map((i) => text(cells[i]));
      const contacts = enrichContactsWithApi(row, extractRowContacts(row));
      const full = [...extracted, ...contactRow(contacts)];
      if (full.some((v) => v !== '')) rows.push(full);
    });
    return {
      headers: [...visibleHeaderIdx.map((i) => headers[i] ?? `Column ${i + 1}`), ...CONTACT_COLUMNS],
      rows,
    };
  };

  const extractRepeating = (entry) => {
    const sig = classSignature(entry.element.children);
    const sigCls = sig ? sig.cls : null;
    const matching = Array.from(entry.element.children).filter((c) => primaryClass(c) === sigCls);
    const textRows = [];
    let maxCells = 0;
    matching.forEach((r) => {
      const cells = leafTextCells(r).map(text).filter((s) => s !== '');
      maxCells = Math.max(maxCells, cells.length);
      textRows.push({ cells, el: r });
    });
    const rows = [];
    textRows.forEach(({ cells, el }) => {
      while (cells.length < maxCells) cells.push('');
      const contacts = enrichContactsWithApi(el, extractRowContacts(el));
      const full = [...cells, ...contactRow(contacts)];
      if (full.some((v) => v !== '')) rows.push(full);
    });
    const baseHeaders = entry.headers.length === maxCells
      ? entry.headers
      : Array.from({ length: maxCells }, (_, i) => entry.headers[i] || `Column ${i + 1}`);
    return { headers: [...baseHeaders, ...CONTACT_COLUMNS], rows };
  };

  const extractFromEntry = (entry, includeHidden) => {
    let result;
    if (entry.kind === 'api') result = extractApi();
    else if (entry.kind === 'native') result = extractNative(entry.element, includeHidden);
    else if (entry.kind === 'aria') result = extractAria(entry.element, includeHidden);
    else if (entry.kind === 'repeat') result = extractRepeating(entry);
    else return { headers: [], rows: [] };
    return pruneEmptyColumns(result.headers, result.rows);
  };

  // ---------- auto-scroll ----------

  const findScrollContainer = (el) => {
    let node = el;
    while (node && node !== document.body) {
      const s = window.getComputedStyle(node);
      const overflowY = s.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const countRowsForEntry = (entry) => {
    if (entry.kind === 'api') return capturedLeads.size;
    if (entry.kind === 'native') return entry.element.querySelectorAll('tbody tr, tr').length;
    if (entry.kind === 'aria') return entry.element.querySelectorAll('[role="row"]').length;
    if (entry.kind === 'repeat') {
      const sig = classSignature(entry.element.children);
      const sigCls = sig ? sig.cls : null;
      return Array.from(entry.element.children).filter((c) => primaryClass(c) === sigCls).length;
    }
    return 0;
  };

  const autoScrollToLoad = async (entry) => {
    const container = findScrollContainer(entry.element);
    let lastCount = countRowsForEntry(entry);
    let noGrowth = 0;
    for (let i = 0; i < SCROLL_MAX_ITERATIONS; i++) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'instant' in window ? 'auto' : 'auto' });
      await sleep(SCROLL_SETTLE_MS);
      const current = countRowsForEntry(entry);
      if (current <= lastCount) {
        noGrowth++;
        if (noGrowth >= SCROLL_NO_GROWTH_LIMIT) break;
      } else {
        noGrowth = 0;
      }
      lastCount = current;
    }
    container.scrollTo({ top: 0, behavior: 'instant' in window ? 'auto' : 'auto' });
    await sleep(150);
  };

  // ---------- message handling ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (message?.type === 'PING') {
          sendResponse({ ok: true });
          return;
        }
        if (message?.type === 'DETECT_TABLES') {
          if (capturedLeads.size === 0) {
            // Tab was loaded before the hook installed — replay API URLs.
            await probeForLeads();
          }
          const tables = detectAll();
          sendResponse({ ok: true, tables, capturedCount: capturedLeads.size });
          return;
        }
        if (message?.type === 'EXTRACT_TABLE') {
          const entry = candidateRegistry.get(message.tableId);
          if (!entry) {
            sendResponse({ ok: false, error: 'Table no longer present. Click Rescan.' });
            return;
          }
          if (message.autoScroll) {
            await autoScrollToLoad(entry);
          }
          // One more probe attempt — scrolling may have triggered new
          // API requests we didn't observe live.
          await probeForLeads();
          const result = extractFromEntry(entry, !!message.includeHidden);
          sendResponse({ ok: true, headers: result.headers, rows: result.rows, capturedCount: capturedLeads.size });
          return;
        }
        sendResponse({ ok: false, error: 'Unknown message type' });
      } catch (err) {
        console.error('[LeadLoft Exporter] handler error:', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // async
  });
})();
