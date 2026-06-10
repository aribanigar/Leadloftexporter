// content.js – JobBot Auto Apply Agent
// Handles LinkedIn Easy Apply, Indeed Apply, and Naukri Apply

(function () {
  'use strict';
  if (window.__jobBotInstalled) return;
  window.__jobBotInstalled = true;

  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes('linkedin.com')) return 'linkedin';
    if (h.includes('indeed.com') || h.includes('apply.indeed.com')) return 'indeed';
    if (h.includes('naukri.com')) return 'naukri';
    return null;
  })();

  if (!PLATFORM) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand  = (min, max) => min + Math.floor(Math.random() * (max - min));
  const $     = (sel, root = document) => root.querySelector(sel);
  const $$    = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isVisible = el => el && el.offsetParent !== null && !el.disabled;

  function waitFor(selector, root = document, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const found = $(selector, root);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = $(selector, root);
        if (el) { obs.disconnect(); resolve(el); }
      });
      const target = root instanceof Document ? root.body : root;
      if (target) obs.observe(target, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
    });
  }

  async function typeInto(el, text) {
    if (!el || text === null || text === undefined) return;
    el.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                                   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.value = '';
    }
    await sleep(rand(50, 150));
    for (const ch of String(text)) {
      el.value += ch;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(rand(20, 60));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  async function humanClick(el, msg = '') {
    if (!el) return false;
    if (msg) SPOTLIGHT.pulse(el, msg);
    await sleep(rand(300, 600));
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(200, 400));
    el.click();
    await sleep(rand(400, 800));
    return true;
  }

  const SPOTLIGHT = (() => {
    let bar, box;

    function ensureDOM() {
      if (bar) return;
      if (!document.getElementById('jb-css')) {
        const s = document.createElement('style');
        s.id = 'jb-css';
        s.textContent = `
          #jb-bar {
            position:fixed;top:0;left:0;right:0;z-index:2147483647;
            display:flex;align-items:center;gap:10px;
            padding:9px 18px;font-size:13px;font-weight:600;
            font-family:system-ui,-apple-system,sans-serif;
            box-shadow:0 2px 16px rgba(0,0,0,.35);
            transition:background .3s;
          }
          #jb-bar .jb-dot {
            width:8px;height:8px;border-radius:50%;background:#fff;
            animation:jb-blink 1.2s ease-in-out infinite;
          }
          #jb-bar .jb-close {
            margin-left:auto;cursor:pointer;opacity:.7;font-size:16px;
            background:none;border:none;color:inherit;
          }
          #jb-box {
            position:fixed;z-index:2147483646;pointer-events:none;
            border-radius:8px;display:none;
            transition:all .25s ease;
          }
          @keyframes jb-blink {
            0%,100%{opacity:1} 50%{opacity:.3}
          }
          @keyframes jb-glow {
            0%,100%{box-shadow:0 0 0 3px rgba(124,58,237,.4),0 0 12px rgba(124,58,237,.3)}
            50%{box-shadow:0 0 0 6px rgba(124,58,237,.6),0 0 28px rgba(124,58,237,.7)}
          }
          .jb-pulse { animation:jb-glow .8s ease-in-out 3 !important; }
        `;
        document.head.appendChild(s);
      }
      bar = document.createElement('div');
      bar.id = 'jb-bar';
      bar.innerHTML = `<span class="jb-dot"></span><span id="jb-msg">JobBot ready</span>
        <button class="jb-close" title="Stop agent">✕</button>`;
      bar.querySelector('.jb-close').addEventListener('click', stopAgent);
      document.body.appendChild(bar);
      box = document.createElement('div');
      box.id = 'jb-box';
      document.body.appendChild(box);
    }

    const COLORS = {
      info:     ['#1e40af','#fff'],
      applying: ['#7c3aed','#fff'],
      success:  ['#065f46','#fff'],
      warning:  ['#92400e','#fff'],
      error:    ['#991b1b','#fff'],
    };

    return {
      setStatus(msg, type = 'info') {
        ensureDOM();
        const [bg, fg] = COLORS[type] || COLORS.info;
        bar.style.background = bg;
        bar.style.color = fg;
        bar.style.display = 'flex';
        document.getElementById('jb-msg').textContent = `JobBot: ${msg}`;
      },
      pulse(el, msg = '') {
        ensureDOM();
        if (msg) this.setStatus(msg, 'applying');
        if (!el) return;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, {
          display:  'block',
          top:      `${r.top  - 5  + window.scrollY}px`,
          left:     `${r.left - 5  + window.scrollX}px`,
          width:    `${r.width  + 10}px`,
          height:   `${r.height + 10}px`,
          border:   '3px solid #7c3aed',
        });
        box.classList.remove('jb-pulse');
        void box.offsetWidth;
        box.classList.add('jb-pulse');
        setTimeout(() => { if (box) box.style.display = 'none'; }, 2500);
      },
      hide() {
        if (bar) bar.style.display = 'none';
        if (box) box.style.display = 'none';
      },
    };
  })();

  class SmartFiller {
    constructor(profile) { this.p = profile; }

    answer(q) {
      const t = q.toLowerCase().replace(/[*?]/g, '').trim();
      const p = this.p;
      if (/year.*(experience|exp)/i.test(t))       return p.professional?.experience || '3';
      if (/current.*(salary|ctc)/i.test(t))         return p.professional?.currentSalary || '';
      if (/expected.*(salary|ctc)|salary expectation/i.test(t)) return p.professional?.expectedSalary || '';
      if (/notice period|available to join|joining/i.test(t))   return p.professional?.noticePeriod || '30 days';
      if (/phone|mobile|contact.*(no|number)/i.test(t))         return p.personal?.phone || '';
      if (/(your )?city|current location|based in/i.test(t))    return p.personal?.location || '';
      if (/willing to.*(relocat|move)/i.test(t))   return p.preferences?.willingToRelocate ? 'Yes' : 'No';
      if (/authoriz|authoris|eligible to work|work permit|visa/i.test(t)) return 'Yes';
      if (/travel/i.test(t))                        return p.preferences?.travelPercentage || '25';
      if (/language/i.test(t))                      return p.professional?.languages || 'English, Hindi';
      if (/qualification|education|degree/i.test(t)) return p.professional?.education || "Bachelor's Degree";
      if (/cover letter|why (do you|are you|this role)/i.test(t)) {
        return p.professional?.coverLetter ||
          `I am enthusiastic about this role. With ${p.professional?.experience || '3'} years of relevant experience, I am confident I can contribute meaningfully to your team.`;
      }
      if (/remote|work from home/i.test(t))         return p.preferences?.workMode === 'remote' ? 'Yes' : 'Open to hybrid';
      if (/gender/i.test(t))                        return p.personal?.gender || '';
      if (/current.*(company|employer)/i.test(t))   return p.professional?.currentCompany || '';
      if (/current.*designation|current.*role|current.*title/i.test(t)) return p.professional?.currentTitle || '';
      if (/skill/i.test(t))                         return p.professional?.skills || '';
      if (/fresher|entry.?level/i.test(t))          return parseInt(p.professional?.experience || '0') === 0 ? 'Yes' : 'No';
      return null;
    }

    pickOption(questionText, options) {
      const ans = this.answer(questionText);
      if (!ans) return null;
      const a = String(ans).toLowerCase();
      for (const o of options) { if (o.toLowerCase() === a) return o; }
      if (/^yes/i.test(a)) { const yes = options.find(o => /^yes/i.test(o)); if (yes) return yes; }
      if (/^no/i.test(a))  { const no  = options.find(o => /^no/i.test(o));  if (no)  return no;  }
      if (/travel/i.test(questionText)) {
        const pref = parseInt(this.p.preferences?.travelPercentage || '25');
        let best = null, diff = Infinity;
        for (const o of options) {
          const m = o.match(/(\d+)/);
          if (m) { const d = Math.abs(parseInt(m[1]) - pref); if (d < diff) { diff = d; best = o; } }
        }
        if (best) return best;
      }
      return null;
    }

    getLabelFor(el) {
      if (el.id) { const lbl = $(`label[for="${CSS.escape(el.id)}"]`); if (lbl) return lbl.textContent.trim(); }
      const wrapLbl = el.closest('label');
      if (wrapLbl) return wrapLbl.textContent.replace(el.value, '').trim();
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        if (node.getAttribute('aria-label')) return node.getAttribute('aria-label');
        const lblId = node.getAttribute('aria-labelledby');
        if (lblId) { const ref = document.getElementById(lblId); if (ref) return ref.textContent.trim(); }
        const prev = node.previousElementSibling;
        if (prev && !prev.querySelector('input,textarea,select') && prev.textContent.trim().length > 2) return prev.textContent.trim();
        const lbl = $('label, legend, p, span[class*="label"], div[class*="label"], h3, h4', node);
        if (lbl && lbl !== el && lbl.textContent.trim().length > 2) return lbl.textContent.trim();
        node = node.parentElement;
      }
      return el.placeholder || el.name || '';
    }

    async fillRadios(container) {
      const groups = new Map();
      $$('input[type="radio"]', container).forEach(r => {
        const key = r.name || r.closest('fieldset')?.id || Math.random();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      for (const [, radios] of groups) {
        if (radios.some(r => r.checked)) continue;
        let question = '';
        const fs = radios[0].closest('fieldset');
        if (fs) { const leg = $('legend', fs); if (leg) question = leg.textContent.trim(); }
        if (!question) question = this.getLabelFor(radios[0]);
        const opts = radios.map(r => {
          const lbl = r.id ? $(`label[for="${CSS.escape(r.id)}"]`) : r.closest('label');
          return lbl ? lbl.textContent.trim() : r.value;
        });
        const chosen = this.pickOption(question, opts);
        const target = chosen ? radios[opts.findIndex(o => o === chosen)] : radios[0];
        if (target && !target.checked) {
          SPOTLIGHT.pulse(target, `Selecting: "${opts[radios.indexOf(target)] || target.value}"`);
          await sleep(rand(150, 300));
          target.click();
          target.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(rand(100, 200));
        }
      }
    }

    async fillTexts(container) {
      const inputs = $$('input[type="text"],input[type="number"],input[type="tel"],input[type="email"],textarea', container)
        .filter(el => isVisible(el) && !el.readOnly);
      for (const input of inputs) {
        if (input.value && input.value.trim()) continue;
        const label = this.getLabelFor(input);
        const ans = this.answer(label);
        if (ans) {
          SPOTLIGHT.pulse(input, `Filling: "${label.substring(0, 45)}…"`);
          await typeInto(input, ans);
          await sleep(rand(150, 300));
        }
      }
    }

    async fillSelects(container) {
      const selects = $$('select', container).filter(isVisible);
      for (const sel of selects) {
        if (sel.value && sel.value !== '' && sel.value !== '0') continue;
        const label = this.getLabelFor(sel);
        const ans = this.answer(label);
        if (!ans) continue;
        const opt = $$('option', sel).find(o => o.textContent.toLowerCase().includes(ans.toLowerCase()));
        if (opt) {
          SPOTLIGHT.pulse(sel, `Selecting: "${opt.textContent.trim()}"`);
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(rand(150, 300));
        }
      }
    }

    async fillCustomDropdowns(container) {
      const dropdowns = $$('[class*="dropdown"], [class*="select"]:not(select)', container)
        .filter(el => isVisible(el) && el.getAttribute('role') === 'combobox');
      for (const dd of dropdowns) {
        const label = this.getLabelFor(dd);
        const ans = this.answer(label);
        if (!ans) continue;
        dd.click();
        await sleep(rand(300, 600));
        const opts = $$('[role="option"]', document).filter(isVisible);
        const match = opts.find(o => o.textContent.toLowerCase().includes(ans.toLowerCase()));
        if (match) { SPOTLIGHT.pulse(match, `Picking: "${match.textContent.trim()}"`); match.click(); }
        else if (opts[0]) opts[0].click();
        await sleep(rand(200, 400));
      }
    }

    async fillAll(container = document.body) {
      await this.fillRadios(container);
      await this.fillTexts(container);
      await this.fillSelects(container);
      await this.fillCustomDropdowns(container);
    }
  }

  class LinkedInAgent {
    constructor(filler) { this.filler = filler; this.applied = 0; this.skipped = 0; this.running = false; }

    cards() {
      return $$('li.jobs-search-results__list-item, li[data-occludable-job-id], .job-card-container').filter(isVisible);
    }

    async openCard(card) {
      const link = $('a.job-card-list__title, a.job-card-container__link, a[data-control-id], .job-card-list__title--link', card) || $('a', card);
      if (!link) return false;
      SPOTLIGHT.pulse(link, `Viewing: ${link.textContent.trim().substring(0, 55)}`);
      link.click();
      await sleep(rand(1500, 2500));
      return true;
    }

    async clickEasyApply() {
      const btn = await waitFor('.jobs-apply-button, button[aria-label*="Easy Apply"], .jobs-s-apply button', document, 6000).catch(() => null);
      if (!btn) return false;
      const txt = btn.textContent.trim();
      if (/applied|saved/i.test(txt)) return false;
      if (!txt.toLowerCase().includes('apply')) return false;
      await humanClick(btn, 'Clicking Easy Apply…');
      return true;
    }

    async handleModalStep() {
      const modal = $('.jobs-easy-apply-content, .jobs-easy-apply-modal, [data-test-modal]');
      if (!modal) return 'no-modal';
      if ($('.artdeco-inline-feedback--success, .jobs-post-apply-nirvanaBanner, h3[aria-label*="submitted"]', document)) return 'done';
      await this.filler.fillAll(modal);
      await sleep(rand(400, 700));
      const submitBtn = $('button[aria-label="Submit application"], button[aria-label*="Submit"]', modal);
      if (submitBtn && isVisible(submitBtn)) { await humanClick(submitBtn, '🎉 Submitting application!'); await sleep(rand(2000, 3000)); return 'done'; }
      const reviewBtn = $('button[aria-label="Review your application"], button[aria-label*="Review"]', modal);
      if (reviewBtn && isVisible(reviewBtn)) { await humanClick(reviewBtn, 'Reviewing application…'); return 'continue'; }
      const nextBtn = $('button[aria-label="Continue to next step"], button[aria-label*="Continue"]', modal)
                    || $$('button', modal).find(b => /continue|next/i.test(b.textContent) && isVisible(b));
      if (nextBtn) { await humanClick(nextBtn, 'Next step…'); return 'continue'; }
      return 'stuck';
    }

    async closeModal() {
      const btn = $('button[data-test-modal-close-btn], [aria-label="Dismiss"], button[aria-label*="Discard"]');
      if (btn) { btn.click(); await sleep(rand(600, 1000)); }
    }

    async applyToCard(card) {
      if (!await this.openCard(card)) return;
      const hasApply = await this.clickEasyApply();
      if (!hasApply) { SPOTLIGHT.setStatus('No Easy Apply — skipping', 'warning'); this.skipped++; return; }
      await sleep(rand(800, 1400));
      SPOTLIGHT.setStatus('Filling Easy Apply form…', 'applying');
      let steps = 0;
      while (steps < 25 && this.running) {
        const res = await this.handleModalStep();
        if (res === 'done') {
          this.applied++;
          chrome.runtime.sendMessage({ type: 'JOB_APPLIED', platform: 'linkedin' });
          SPOTLIGHT.setStatus(`Applied! Total: ${this.applied}`, 'success');
          await sleep(rand(1500, 2500));
          return;
        }
        if (res === 'stuck' || res === 'no-modal') {
          SPOTLIGHT.setStatus('Stuck on form — skipping', 'warning');
          await this.closeModal();
          this.skipped++;
          return;
        }
        steps++;
        await sleep(rand(800, 1400));
      }
      await this.closeModal();
      this.skipped++;
    }

    async nextPage() {
      const btn = $('button[aria-label="View next page"], .artdeco-pagination__button--next')
                || $$('li.artdeco-pagination__indicator').find(li => li.getAttribute('data-test-pagination-page-btn') === 'next')?.querySelector('button');
      if (!btn || btn.disabled) return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2500, 4000));
      return true;
    }

    async run() {
      this.running = true;
      SPOTLIGHT.setStatus('LinkedIn agent started — scanning…', 'info');
      while (this.running) {
        const cards = this.cards();
        SPOTLIGHT.setStatus(`${cards.length} jobs on this page`, 'info');
        if (!cards.length) { await sleep(2000); break; }
        for (const card of cards) {
          if (!this.running) break;
          await this.applyToCard(card);
          await sleep(rand(2000, 4000));
        }
        if (!await this.nextPage()) break;
      }
      SPOTLIGHT.setStatus(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  class IndeedAgent {
    constructor(filler) { this.filler = filler; this.applied = 0; this.skipped = 0; this.running = false; }

    isApplyPage() {
      return /\/apply|apply\.indeed\.com/i.test(location.href) ||
             !!$('[data-testid="ia-continueButton"], .ia-BasePage, [data-testid="ia-Questions"]');
    }

    cards() {
      return $$('.job_seen_beacon, [data-testid="slider_item"], .resultContent, .jobsearch-SerpJobCard').filter(isVisible);
    }

    async clickApply(card) {
      let btn = $('button[id*="applyButton"], .indeedApplyButton, [data-testid="indeedApplyButton"], button[data-indeed-apply]', card);
      if (!btn) {
        const title = $('h2 a, a.jcs-JobTitle, a[data-jk]', card);
        if (title) { title.click(); await sleep(rand(1000, 1800)); }
        btn = $('button[id*="applyButton"], .indeedApplyButton, [data-testid="indeedApplyButton"]');
      }
      if (!btn) return 'none';
      const txt = (btn.textContent || '').trim();
      if (/applied/i.test(txt)) return 'already';
      await humanClick(btn, 'Opening Indeed Apply…');
      await sleep(rand(1500, 2500));
      return 'clicked';
    }

    async fillCurrentStep() {
      const container = $('.ia-Questions-main, .ia-BasePage-main, [data-testid="ia-Questions-main"], .icl-Card--application') || document.body;
      await this.filler.fillAll(container);
      await sleep(rand(400, 700));
    }

    async clickContinue() {
      const btn =
        $('[data-testid="ia-continueButton"]')      ||
        $('[data-testid="continue-button"]')         ||
        $$('button[type="submit"]').find(b => isVisible(b) && /continue/i.test(b.textContent)) ||
        $$('button').find(b => isVisible(b) && /^continue$/i.test(b.textContent.trim()));

      if (btn && isVisible(btn)) {
        SPOTLIGHT.pulse(btn, '✨ Clicking CONTINUE…');
        await sleep(rand(500, 900));
        btn.click();
        await sleep(rand(1200, 2000));
        return true;
      }

      const sub =
        $('[data-testid="ia-submitButton"]')    ||
        $$('button[type="submit"]').find(b => isVisible(b) && /submit|apply now/i.test(b.textContent));
      if (sub && isVisible(sub)) {
        SPOTLIGHT.pulse(sub, '🎉 Submitting application!');
        await sleep(rand(500, 900));
        sub.click();
        await sleep(rand(1500, 2500));
        return 'submitted';
      }
      return false;
    }

    isDone() {
      return !!$('[data-testid="ia-ThankYou"], .ia-ThankYou, [class*="ThankYou"], h2[data-testid*="thank"], [data-testid="ia-congrats"]');
    }

    async processApplication() {
      SPOTLIGHT.setStatus('Processing Indeed application…', 'applying');
      let steps = 0;
      while (steps < 35 && this.running) {
        if (this.isDone()) {
          this.applied++;
          chrome.runtime.sendMessage({ type: 'JOB_APPLIED', platform: 'indeed' });
          SPOTLIGHT.setStatus(`Applied on Indeed! Total: ${this.applied}`, 'success');
          await sleep(rand(2000, 3000));
          history.back();
          await sleep(rand(2500, 3500));
          return true;
        }
        await this.fillCurrentStep();
        const res = await this.clickContinue();
        if (res === 'submitted' || this.isDone()) {
          this.applied++;
          chrome.runtime.sendMessage({ type: 'JOB_APPLIED', platform: 'indeed' });
          SPOTLIGHT.setStatus(`Applied on Indeed! Total: ${this.applied}`, 'success');
          await sleep(rand(2000, 3000));
          history.back();
          await sleep(rand(2500, 3500));
          return true;
        }
        if (!res) {
          SPOTLIGHT.setStatus('No Continue button found — skipping', 'warning');
          this.skipped++;
          history.back();
          await sleep(2000);
          return false;
        }
        steps++;
        await sleep(rand(800, 1500));
      }
      history.back();
      await sleep(2000);
      return false;
    }

    async nextPage() {
      const btn = $('[data-testid="pagination-page-next"], a[aria-label="Next Page"], a.np') ||
                  $$('a[data-testid*="pagination"]').find(a => /next/i.test(a.textContent));
      if (!btn) return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2500, 4000));
      return true;
    }

    async run() {
      this.running = true;
      if (this.isApplyPage()) { await this.processApplication(); return; }
      SPOTLIGHT.setStatus('Indeed agent started — scanning…', 'info');
      while (this.running) {
        const cards = this.cards();
        SPOTLIGHT.setStatus(`${cards.length} jobs on this page`, 'info');
        if (!cards.length) { await sleep(2000); break; }
        for (const card of cards) {
          if (!this.running) break;
          const jk = $('a[data-jk]', card)?.getAttribute('data-jk') || $('a.jcs-JobTitle', card)?.href;
          if (jk && appliedSet.has(jk)) continue;
          if (jk) appliedSet.add(jk);
          const res = await this.clickApply(card);
          if (res === 'clicked') await this.processApplication();
          else this.skipped++;
          await sleep(rand(2000, 4000));
        }
        if (!await this.nextPage()) break;
      }
      SPOTLIGHT.setStatus(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  class NaukriAgent {
    constructor(filler) { this.filler = filler; this.applied = 0; this.skipped = 0; this.running = false; }

    cards() {
      return $$('.jobTuple, article.jobTupleHeader, .srp-jobtuple-wrapper, .cust-job-tuple, [class*="JobTuple"]').filter(isVisible);
    }

    async openJob(card) {
      const link = $('a.title, a.jobTitle, a[class*="title"], h2 a', card);
      if (!link) return false;
      SPOTLIGHT.pulse(link, `Opening: ${link.textContent.trim().substring(0, 55)}`);
      link.setAttribute('target', '_self');
      link.click();
      await sleep(rand(2500, 4000));
      return true;
    }

    async clickApply() {
      const btn = $('button#apply-button, button.apply-button, a.apply-button, [id*="applyBtn"], [class*="applyBtn"]') ||
                  $$('button').find(b => isVisible(b) && /^apply( now)?$/i.test(b.textContent.trim()));
      if (!btn) return false;
      await humanClick(btn, 'Applying on Naukri…');
      await sleep(rand(1000, 1800));
      return true;
    }

    async handleForm() {
      const popup = $('.apply-popup, .qapply-popup, [class*="apply-popup"], .chatbot_DrawerContent, [class*="chatbot"]');
      const container = popup || document.body;
      if ($('[class*="thankYou"], [class*="success-message"], .success-container', popup || document)) return 'done';
      await this.filler.fillAll(container);
      await sleep(rand(400, 700));
      const sub = $('button[type="submit"], button#submit-apply, button.submit-btn', container) ||
                  $$('button', container).find(b => isVisible(b) && /submit|apply now|send/i.test(b.textContent));
      if (sub && isVisible(sub)) {
        await humanClick(sub, 'Submitting Naukri application…');
        await sleep(rand(1500, 2500));
        if ($('[class*="thankYou"], [class*="success"]')) return 'done';
      }
      const nxt = $('[class*="nextBtn"], [data-id="nextbtn"], .chatbot_NextButton') ||
                  $$('button', container).find(b => isVisible(b) && /^(next|continue|proceed)$/i.test(b.textContent.trim()));
      if (nxt && isVisible(nxt)) { await humanClick(nxt, 'Next step…'); return 'continue'; }
      return 'stuck';
    }

    async nextPage() {
      const btn = $('a[title="Next"], a[class*="fright"][class*="arr"], .pagination .nextBtn') ||
                  $$('a').find(a => /next page|next >/i.test(a.textContent));
      if (!btn) return false;
      await humanClick(btn, 'Next page…');
      await sleep(rand(2500, 4000));
      return true;
    }

    async run() {
      this.running = true;
      SPOTLIGHT.setStatus('Naukri agent started — scanning…', 'info');
      while (this.running) {
        const cards = this.cards();
        SPOTLIGHT.setStatus(`${cards.length} jobs on this page`, 'info');
        if (!cards.length) { await sleep(2000); break; }
        for (const card of cards) {
          if (!this.running) break;
          const link = $('a.title, a.jobTitle', card);
          const jid = link?.href;
          if (jid && appliedSet.has(jid)) continue;
          if (jid) appliedSet.add(jid);
          if (!await this.openJob(card)) { this.skipped++; continue; }
          if (!await this.clickApply())   { this.skipped++; history.back(); await sleep(2000); continue; }
          let steps = 0;
          while (steps < 20 && this.running) {
            const res = await this.handleForm();
            if (res === 'done') {
              this.applied++;
              chrome.runtime.sendMessage({ type: 'JOB_APPLIED', platform: 'naukri' });
              SPOTLIGHT.setStatus(`Applied on Naukri! Total: ${this.applied}`, 'success');
              await sleep(rand(1500, 2500));
              history.back();
              await sleep(rand(2500, 3500));
              break;
            }
            if (res === 'stuck') { this.skipped++; history.back(); await sleep(2000); break; }
            steps++;
            await sleep(rand(800, 1500));
          }
          await sleep(rand(2000, 4000));
        }
        if (!await this.nextPage()) break;
      }
      SPOTLIGHT.setStatus(`Done ✓ Applied: ${this.applied} | Skipped: ${this.skipped}`, 'success');
      this.running = false;
    }

    stop() { this.running = false; }
  }

  const appliedSet = new Set();
  let activeAgent  = null;

  async function startAgent(profile, settings) {
    if (activeAgent?.running) return;
    const filler = new SmartFiller(profile);
    switch (PLATFORM) {
      case 'linkedin': activeAgent = new LinkedInAgent(filler); break;
      case 'indeed':   activeAgent = new IndeedAgent(filler);   break;
      case 'naukri':   activeAgent = new NaukriAgent(filler);   break;
      default: SPOTLIGHT.setStatus('Unsupported page', 'error'); return;
    }
    chrome.storage.local.set({ jobbot_running: true });
    try { await activeAgent.run(); } finally {
      chrome.storage.local.set({ jobbot_running: false });
      activeAgent = null;
    }
  }

  function stopAgent() {
    if (activeAgent) { activeAgent.stop(); activeAgent = null; }
    chrome.storage.local.set({ jobbot_running: false });
    SPOTLIGHT.setStatus('Agent stopped', 'warning');
    setTimeout(() => SPOTLIGHT.hide(), 4000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'PING':         reply({ ok: true, platform: PLATFORM }); break;
      case 'START_AGENT':  startAgent(msg.profile, msg.settings || {}); reply({ ok: true }); break;
      case 'STOP_AGENT':   stopAgent(); reply({ ok: true }); break;
      case 'GET_STATUS':   reply({ running: !!activeAgent?.running, platform: PLATFORM, applied: activeAgent?.applied || 0, skipped: activeAgent?.skipped || 0 }); break;
    }
    return true;
  });

  chrome.storage.local.get(['jobbot_running', 'jobbot_profile'], data => {
    if (data.jobbot_running && data.jobbot_profile) {
      const filler = new SmartFiller(data.jobbot_profile);
      if (PLATFORM === 'indeed') {
        const agent = new IndeedAgent(filler);
        activeAgent = agent;
        if (agent.isApplyPage()) agent.run();
      }
    }
  });

})();
