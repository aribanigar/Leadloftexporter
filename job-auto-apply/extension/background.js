// background.js – JobBot service worker

const DEFAULT_PROFILE = {
  personal: { name: '', email: '', phone: '', location: '', gender: '' },
  professional: {
    currentTitle: '', currentCompany: '', experience: '3',
    currentSalary: '', expectedSalary: '', noticePeriod: '30 days',
    skills: '', education: "Bachelor's Degree", languages: 'English, Hindi',
    coverLetter: ''
  },
  preferences: {
    jobTitles: [], locations: [], workMode: 'hybrid',
    willingToRelocate: false, travelPercentage: '25',
    onlyEasyApply: true
  }
};

const stats = { linkedin: 0, indeed: 0, naukri: 0, skipped: 0 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_PROFILE':
      chrome.storage.local.get('jobbot_profile', d => {
        sendResponse({ profile: d.jobbot_profile || DEFAULT_PROFILE });
      });
      return true;

    case 'SAVE_PROFILE':
      chrome.storage.local.set({ jobbot_profile: msg.profile }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'GET_STATS':
      sendResponse({ stats });
      break;

    case 'JOB_APPLIED':
      stats[msg.platform] = (stats[msg.platform] || 0) + 1;
      chrome.storage.local.get('jobbot_history', d => {
        const h = d.jobbot_history || [];
        h.unshift({ platform: msg.platform, title: msg.title || '', ts: Date.now() });
        chrome.storage.local.set({ jobbot_history: h.slice(0, 500) });
      });
      // Badge count
      const total = stats.linkedin + stats.indeed + stats.naukri;
      chrome.action.setBadgeText({ text: String(total) });
      chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
      break;

    case 'JOB_SKIPPED':
      stats.skipped++;
      break;

    case 'GET_HISTORY':
      chrome.storage.local.get('jobbot_history', d => {
        sendResponse({ history: d.jobbot_history || [] });
      });
      return true;

    case 'CLEAR_HISTORY':
      chrome.storage.local.remove('jobbot_history', () => {
        Object.keys(stats).forEach(k => { stats[k] = 0; });
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      });
      return true;
  }
});
