// Background service worker — minimal; CSV download is handled in popup.js
// via Blob + URL.createObjectURL (data: URLs were blocked in Chrome 110+).

chrome.runtime.onMessage.addListener((_message, _sender, _sendResponse) => {
  // No-op: download path moved to popup.js.
});
