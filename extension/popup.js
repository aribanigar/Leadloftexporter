// Popup orchestration: talks to the content script to detect tables,
// previews them, and triggers CSV export via the background worker.

const els = {
  status: document.getElementById('status'),
  tablesSection: document.getElementById('tables-section'),
  optionsSection: document.getElementById('options-section'),
  tableSelect: document.getElementById('table-select'),
  rowCount: document.getElementById('row-count'),
  colCount: document.getElementById('col-count'),
  headersPreview: document.getElementById('headers-preview'),
  autoScroll: document.getElementById('auto-scroll'),
  includeHidden: document.getElementById('include-hidden'),
  filename: document.getElementById('filename'),
  rescan: document.getElementById('rescan'),
  export: document.getElementById('export'),
};

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

    if (detectedTables.length === 0) {
      setStatus('No tables detected on this page. Navigate to a lead list view and click Rescan.', 'warn');
      els.tablesSection.hidden = true;
      els.optionsSection.hidden = true;
      return;
    }

    setStatus(`Found ${detectedTables.length} table${detectedTables.length === 1 ? '' : 's'}. Choose one to export.`, 'success');
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
  setStatus('Extracting rows...', 'info');

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

    const { headers, rows } = response;
    setStatus(`Extracted ${rows.length} rows. Generating CSV...`, 'info');

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

    setStatus(`Exported ${rows.length} rows to ${finalName}.`, 'success');
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
chrome.storage.local.get(['autoScroll', 'includeHidden', 'filename'], (s) => {
  els.autoScroll.checked = !!s.autoScroll;
  els.includeHidden.checked = !!s.includeHidden;
  els.filename.value = s.filename || '';
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

els.rescan.addEventListener('click', scan);
els.export.addEventListener('click', exportSelected);

scan();
