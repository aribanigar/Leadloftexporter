const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const batch = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'batch.json')));
  const emails = batch.filter(b => b.type === 'html_email');
  const localBase = 'file://' + path.join(__dirname, '..', 'public', 'email');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 640, height: 1200 } });
  const outDir = process.env.SCRATCH;
  for (const key of ['Social Media', 'SchoolOS']) {
    const em = emails.find(e => e.title.endsWith(key));
    let html = em.body.replace(/https:\/\/leadloftexporter\.vercel\.app\/email/g, localBase);
    await page.setContent(html, { waitUntil: 'networkidle' });
    const f = path.join(outDir, 'email_' + key.replace(/\s/g, '') + '.jpg');
    await page.screenshot({ path: f, fullPage: true, type: 'jpeg', quality: 80 });
    console.log('rendered', f);
  }
  await browser.close();
})();
