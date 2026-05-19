// Popup orchestration: talks to the content script to detect tables,
// previews them, and triggers CSV export via the background worker.

const els = {
  status: document.getElementById('status'),
  tablesSection: document.getElementById('tables-section'),
  optionsSection: document.getElementById('options-section'),
  columnsSection: document.getElementById('columns-section'),
  columnsList: document.getElementById('columns-list'),
  columnsCount: document.getElementById('columns-count'),
  selectAll: document.getElementById('select-all'),
  selectNone: document.getElementById('select-none'),
  selectEssential: document.getElementById('select-essential'),
  tableSelect: document.getElementById('table-select'),
  rowCount: document.getElementById('row-count'),
  colCount: document.getElementById('col-count'),
  headersPreview: document.getElementById('headers-preview'),
  autoScroll: document.getElementById('auto-scroll'),
  includeHidden: document.getElementById('include-hidden'),
  filename: document.getElementById('filename'),
  rescan: document.getElementById('rescan'),
  reload: document.getElementById('reload'),
  export: document.getElementById('export'),
};

const ESSENTIAL_COLUMNS = new Set([
  'Name', 'First Name', 'Last Name', 'Email', 'Phone', 'Mobile',
  'LinkedIn URL', 'Title / Position', 'Company', 'Location', 'Stage',
  'Status', 'Owner',
  'Emails', 'Phone Number', 'Phone Numbers', // names from LeadLoft's UI
]);

let disabledColumns = new Set();
let currentTableHeaders = [];

let detectedTables = [];
let activeTabId = null;

const setStatus = (msg, level = 'info') => {
  els.status.textContent = msg;
  els.status.className = `status ${level}`;
};

const getActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const isLeadLoftUrl = (url) => /^https?:\/\/([^/]+\.)?leadloft\.com\//.test(url || '');

// Ensure content script is present — re-inject on demand for tabs that
// loaded before the extension was installed/reloaded.
const ensureContentScript = async (tabId) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  }
};

const sendToTab = (tabId, message) =>
  new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response);
    });
  });

const renderTables = (tables) => {
  els.tableSelect.innerHTML = '';
  tables.forEach((t, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    const label = `${t.label} — ${t.rowCount} rows × ${t.headers.length} cols`;
    opt.textContent = label;
    els.tableSelect.appendChild(opt);
  });
  els.tableSelect.value = '0';
  renderPreview(tables[0]);
  // If the picked table has more than one page, default Auto-scroll on
  // so the user gets the whole list, not just the first page.
  if (tables[0] && tables[0].pages && tables[0].pages > 1) {
    if (!els.autoScroll.checked) {
      els.autoScroll.checked = true;
      persist();
    }
  }
};

const renderPreview = (table) => {
  if (!table) return;
  els.rowCount.textContent = `${table.rowCount} rows`;
  els.colCount.textContent = `${table.headers.length} columns`;
  els.headersPreview.innerHTML = '';
  table.headers.forEach((h) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = h || '(blank)';
    els.headersPreview.appendChild(chip);
  });
  renderColumnPicker(table.headers);
};

const renderColumnPicker = (headers) => {
  currentTableHeaders = headers.slice();
  els.columnsList.innerHTML = '';
  headers.forEach((h) => {
    const row = document.createElement('label');
    row.className = 'column-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !disabledColumns.has(h);
    cb.dataset.name = h;
    cb.addEventListener('change', () => {
      if (cb.checked) disabledColumns.delete(h);
      else disabledColumns.add(h);
      persistDisabled();
      updateColumnsCount();
    });
    const span = document.createElement('span');
    span.className = 'col-name';
    span.textContent = h || '(blank)';
    row.appendChild(cb);
    row.appendChild(span);
    els.columnsList.appendChild(row);
  });
  els.columnsSection.hidden = false;
  updateColumnsCount();
};

const updateColumnsCount = () => {
  const enabled = currentTableHeaders.filter((h) => !disabledColumns.has(h)).length;
  els.columnsCount.textContent = `${enabled} / ${currentTableHeaders.length}`;
};

const persistDisabled = () => {
  chrome.storage.local.set({ disabledColumns: [...disabledColumns] });
};

const filterColumns = (headers, rows) => {
  const keep = headers.map((h, i) => disabledColumns.has(h) ? -1 : i).filter((i) => i >= 0);
  return {
    headers: keep.map((i) => headers[i]),
    rows: rows.map((r) => keep.map((i) => r[i])),
  };
};

const scan = async () => {
  setStatus('Scanning page for lead tables...', 'info');
  els.export.disabled = true;

  const tab = await getActiveTab();
  activeTabId = tab.id;

  if (!isLeadLoftUrl(tab.url)) {
    setStatus('Open a LeadLoft page (leadloft.com) to use this extension.', 'warn');
    els.tablesSection.hidden = true;
    els.optionsSection.hidden = true;
    return;
  }

  try {
    await ensureContentScript(tab.id);
    const response = await sendToTab(tab.id, { type: 'DETECT_TABLES' });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'Unknown error');
    }
    detectedTables = response.tables || [];
    const totalSources = response.totalSources || 0;
    const totalRecords = response.totalRecords || 0;
    const bestScore = response.bestScore || 0;
    const bestCount = response.bestCount || 0;

    if (detectedTables.length === 0) {
      setStatus('No tables detected on this page. Navigate to a lead list view and click Rescan.', 'warn');
      els.tablesSection.hidden = true;
      els.optionsSection.hidden = true;
      return;
    }

    let msg, level;
    if (bestScore >= 8) {
      msg = `Best match: ${bestCount} likely lead${bestCount === 1 ? '' : 's'} (score ${bestScore}). Picked it for you — review and Export.`;
      level = 'success';
    } else if (totalRecords > 0) {
      msg = `Captured ${totalRecords} record(s) across ${totalSources} source(s), but none look like leads. Click "Reload tab" so the hook can capture the lead list from scratch.`;
      level = 'warn';
    } else {
      msg = 'No API data captured yet. Click "Reload tab" — the hook must be active before the page makes its first request.';
      level = 'warn';
    }
    setStatus(msg, level);
    els.tablesSection.hidden = false;
    els.optionsSection.hidden = false;
    els.export.disabled = false;
    renderTables(detectedTables);
  } catch (err) {
    console.error('[LeadLoft Exporter] scan failed:', err);
    setStatus(`Couldn't scan page: ${err.message}. Try reloading the LeadLoft tab.`, 'error');
    els.tablesSection.hidden = true;
    els.optionsSection.hidden = true;
  }
};

const exportSelected = async () => {
  const idx = Number(els.tableSelect.value || '0');
  const table = detectedTables[idx];
  if (!table) return;

  els.export.disabled = true;
  const eltablePages = (detectedTables.find((t) => t.kind === 'eltable')?.pages) || 0;
  if (els.autoScroll.checked && eltablePages > 1) {
    setStatus(`Paging through ${eltablePages} pages... this may take a minute.`, 'info');
  } else {
    setStatus('Extracting rows...', 'info');
  }

  try {
    const response = await sendToTab(activeTabId, {
      type: 'EXTRACT_TABLE',
      tableId: table.id,
      autoScroll: els.autoScroll.checked,
      includeHidden: els.includeHidden.checked,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'Extraction failed');
    }

    const filtered = filterColumns(response.headers, response.rows);
    const { headers, rows } = filtered;
    setStatus(`Extracted ${rows.length} rows (${headers.length}/${response.headers.length} columns). Generating CSV...`, 'info');

    const filename = (els.filename.value.trim() || 'leadloft-leads').replace(/\.csv$/i, '');
    const finalName = `${filename}-${tsForFilename()}.csv`;

    const dl = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_CSV',
      filename: finalName,
      headers,
      rows,
    });

    if (!dl || !dl.ok) {
      throw new Error(dl?.error || 'Download failed');
    }

    const totalRecords = response.totalRecords || 0;
    const capNote = totalRecords ? ` (${totalRecords} record(s) captured across ${response.totalSources} source(s))` : '';
    setStatus(`Exported ${rows.length} rows to ${finalName}.${capNote}`, 'success');
  } catch (err) {
    console.error('[LeadLoft Exporter] export failed:', err);
    setStatus(`Export failed: ${err.message}`, 'error');
  } finally {
    els.export.disabled = false;
  }
};

const tsForFilename = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

// Restore stored options
chrome.storage.local.get(['autoScroll', 'includeHidden', 'filename', 'disabledColumns'], (s) => {
  els.autoScroll.checked = !!s.autoScroll;
  els.includeHidden.checked = !!s.includeHidden;
  els.filename.value = s.filename || '';
  if (Array.isArray(s.disabledColumns)) disabledColumns = new Set(s.disabledColumns);
});

els.selectAll.addEventListener('click', () => {
  currentTableHeaders.forEach((h) => disabledColumns.delete(h));
  persistDisabled();
  renderColumnPicker(currentTableHeaders);
});
els.selectNone.addEventListener('click', () => {
  currentTableHeaders.forEach((h) => disabledColumns.add(h));
  persistDisabled();
  renderColumnPicker(currentTableHeaders);
});
els.selectEssential.addEventListener('click', () => {
  currentTableHeaders.forEach((h) => {
    if (ESSENTIAL_COLUMNS.has(h)) disabledColumns.delete(h);
    else disabledColumns.add(h);
  });
  persistDisabled();
  renderColumnPicker(currentTableHeaders);
});

const persist = () => {
  chrome.storage.local.set({
    autoScroll: els.autoScroll.checked,
    includeHidden: els.includeHidden.checked,
    filename: els.filename.value,
  });
};

els.autoScroll.addEventListener('change', persist);
els.includeHidden.addEventListener('change', persist);
els.filename.addEventListener('change', persist);

els.tableSelect.addEventListener('change', () => {
  const idx = Number(els.tableSelect.value || '0');
  renderPreview(detectedTables[idx]);
});

const reloadTab = async () => {
  setStatus('Reloading LeadLoft tab and reinstalling capture hook…', 'info');
  els.export.disabled = true;
  els.reload.disabled = true;
  try {
    const tab = await getActiveTab();
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    // Poll until the tab is complete; cap at ~15s.
    const ready = await waitForTabComplete(tab.id, 15000);
    if (!ready) {
      setStatus('Tab did not finish loading in time. Try Rescan once it loads.', 'warn');
      return;
    }
    // Give the SPA a moment to fire its initial API calls.
    await new Promise((r) => setTimeout(r, 1500));
    await scan();
  } catch (err) {
    setStatus(`Reload failed: ${err.message}`, 'error');
  } finally {
    els.reload.disabled = false;
  }
};

const waitForTabComplete = (tabId, timeoutMs) =>
  new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(false); return; }
        if (tab.status === 'complete') { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(tick, 250);
      });
    };
    tick();
  });

els.rescan.addEventListener('click', scan);
els.reload.addEventListener('click', reloadTab);
els.export.addEventListener('click', exportSelected);

scan();
