// popup.js – JobBot popup controller

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Tab switching ───────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'history') loadHistory();
    });
  });

  async function loadProfile() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, res => {
        resolve(res?.profile || {});
      });
    });
  }

  const profile = await loadProfile();
  fillForm(profile);

  function fillForm(p) {
    const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    set('f-name',     p.personal?.name);
    set('f-email',    p.personal?.email);
    set('f-phone',    p.personal?.phone);
    set('f-location', p.personal?.location);
    set('f-gender',   p.personal?.gender);
    set('f-title',    p.professional?.currentTitle);
    set('f-company',  p.professional?.currentCompany);
    set('f-exp',      p.professional?.experience);
    set('f-edu',      p.professional?.education);
    set('f-skills',   p.professional?.skills);
    set('f-langs',    p.professional?.languages);
    set('f-curr-sal', p.professional?.currentSalary);
    set('f-exp-sal',  p.professional?.expectedSalary);
    set('f-notice',   p.professional?.noticePeriod);
    set('f-cover',    p.professional?.coverLetter);
    set('p-mode',     p.preferences?.workMode);
    set('p-travel',   p.preferences?.travelPercentage);
    chk('p-relocate', p.preferences?.willingToRelocate);
    chk('p-easyonly', p.preferences?.onlyEasyApply !== false);
    chk('p-auth',     p.preferences?.workAuth !== false);
  }

  function readForm() {
    const val = id => document.getElementById(id)?.value?.trim() || '';
    const chk = id => document.getElementById(id)?.checked || false;
    return {
      personal: {
        name:     val('f-name'),
        email:    val('f-email'),
        phone:    val('f-phone'),
        location: val('f-location'),
        gender:   val('f-gender'),
      },
      professional: {
        currentTitle:   val('f-title'),
        currentCompany: val('f-company'),
        experience:     val('f-exp') || '3',
        education:      val('f-edu'),
        skills:         val('f-skills'),
        languages:      val('f-langs') || 'English, Hindi',
        currentSalary:  val('f-curr-sal'),
        expectedSalary: val('f-exp-sal'),
        noticePeriod:   val('f-notice') || '30 days',
        coverLetter:    val('f-cover'),
      },
      preferences: {
        workMode:           val('p-mode') || 'hybrid',
        travelPercentage:   val('p-travel') || '25',
        willingToRelocate:  chk('p-relocate'),
        onlyEasyApply:      chk('p-easyonly'),
        workAuth:           chk('p-auth'),
      },
    };
  }

  document.getElementById('btn-save').addEventListener('click', () => {
    const p = readForm();
    chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: p }, () => {
      const msg = document.getElementById('save-msg');
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2500);
    });
  });

  document.getElementById('btn-save-prefs').addEventListener('click', () => {
    const p = readForm();
    chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: p }, () => {
      const msg = document.getElementById('save-prefs-msg');
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2500);
    });
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let platform = null;

  if (activeTab?.url) {
    const url = activeTab.url;
    if (url.includes('linkedin.com/jobs')) platform = 'linkedin';
    else if (url.includes('indeed.com') || url.includes('apply.indeed.com')) platform = 'indeed';
    else if (url.includes('naukri.com')) platform = 'naukri';
  }

  const badge = document.getElementById('platform-badge');
  if (platform) {
    badge.textContent = platform.charAt(0).toUpperCase() + platform.slice(1);
    badge.className   = `badge badge--${platform}`;
  } else {
    badge.textContent = 'No job site';
    badge.className   = 'badge badge--off';
    document.getElementById('status-line').textContent = 'Open LinkedIn/Indeed/Naukri jobs page first';
  }

  let isRunning = false;

  async function pingContent() {
    if (!activeTab?.id) return;
    try {
      const res = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_STATUS' });
      if (res?.running) setRunningUI(true);
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content.js'],
        });
      } catch { /* already injected */ }
    }
  }
  await pingContent();

  function updateStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, res => {
      if (!res) return;
      document.getElementById('stat-li').textContent = res.stats?.linkedin || 0;
      document.getElementById('stat-in').textContent = res.stats?.indeed   || 0;
      document.getElementById('stat-nk').textContent = res.stats?.naukri   || 0;
      document.getElementById('stat-sk').textContent = res.stats?.skipped  || 0;
    });
  }
  updateStats();
  setInterval(updateStats, 3000);

  document.getElementById('btn-start').addEventListener('click', async () => {
    if (!platform || !activeTab?.id) {
      document.getElementById('status-line').textContent = '⚠ Navigate to LinkedIn/Indeed/Naukri jobs first';
      return;
    }
    const p = readForm();
    await new Promise(r => chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: p }, r));
    setRunningUI(true);
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_AGENT', profile: p });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_AGENT', profile: p });
    }
  });

  document.getElementById('btn-stop').addEventListener('click', async () => {
    if (activeTab?.id) {
      try { await chrome.tabs.sendMessage(activeTab.id, { type: 'STOP_AGENT' }); } catch { /* ignore */ }
    }
    setRunningUI(false);
  });

  function setRunningUI(running) {
    isRunning = running;
    document.getElementById('btn-start').style.display = running ? 'none'  : '';
    document.getElementById('btn-stop') .style.display = running ? ''      : 'none';
    document.getElementById('status-line').textContent = running
      ? `🤖 Agent running on ${platform || 'page'}…`
      : 'Agent stopped';
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, res => {
      const list = document.getElementById('history-list');
      const items = res?.history || [];
      document.getElementById('hist-count').textContent = `${items.length} application${items.length !== 1 ? 's' : ''}`;
      if (!items.length) {
        list.innerHTML = '<div class="empty-state">No applications yet.<br/>Start the agent to begin.</div>';
        return;
      }
      list.innerHTML = items.map(item => {
        const t = new Date(item.ts);
        const time = t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
                     t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        return `<div class="hist-item"><span class="plat plat-${item.platform}">${item.platform}</span><span class="hist-title">${item.title || 'Applied'}</span><span class="hist-time">${time}</span></div>`;
      }).join('');
    });
  }

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Clear all application history?')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => loadHistory());
    }
  });
});
