// Background service worker — handles CSV generation and download.
// Uses chrome.downloads.download with a data: URL so we don't need
// blob: URLs (service workers can't create blob URLs in MV3).

const escapeField = (val) => {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s === '') return '';
  // Quote if it contains special chars; double up internal quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

const toCsv = (headers, rows) => {
  const width = headers.length;
  const lines = [];
  lines.push(headers.map(escapeField).join(','));
  for (const r of rows) {
    const cells = [];
    for (let i = 0; i < width; i++) {
      cells.push(escapeField(r[i]));
    }
    lines.push(cells.join(','));
  }
  // Prepend UTF-8 BOM so Excel opens it correctly with non-ASCII data.
  return '﻿' + lines.join('\r\n');
};

// data: URL approach (works in MV3 service workers without blob URL APIs).
const toDataUrl = (csv) => {
  // Encode UTF-8 -> base64 without using FileReader (unavailable in SW).
  const utf8 = new TextEncoder().encode(csv);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < utf8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, utf8.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  return `data:text/csv;charset=utf-8;base64,${b64}`;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'DOWNLOAD_CSV') return;

  (async () => {
    try {
      const { filename, headers, rows } = message;
      if (!Array.isArray(headers) || !Array.isArray(rows)) {
        throw new Error('Invalid payload');
      }
      const csv = toCsv(headers, rows);
      const url = toDataUrl(csv);
      const id = await chrome.downloads.download({
        url,
        filename: sanitizeFilename(filename || 'leadloft-leads.csv'),
        saveAs: false,
      });
      sendResponse({ ok: true, downloadId: id });
    } catch (err) {
      console.error('[LeadLoft Exporter] download failed:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true; // async response
});

const sanitizeFilename = (name) => {
  // Strip path separators and characters Chrome rejects.
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 200);
};
