import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: ' + m.text()); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 40000 });
} catch(e) { errs.push('TIMEOUT waiting for ready'); }
const state = await page.evaluate(() => ({
  ready: window.game?.ready ?? null,
  err: window.__gameError ?? null,
  label: document.getElementById('loadingLabel')?.textContent
}));
console.log('STATE:', JSON.stringify(state, null, 2));
console.log('ERRORS:', errs.length);
errs.slice(0,25).forEach(e => console.log('  ' + e.slice(0,400)));
await browser.close();
