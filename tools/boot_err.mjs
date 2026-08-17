import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message, '\n  STACK:', (e.stack||'').split('\n').slice(0,4).join('\n  ')));
page.on('console', m => { if (m.type()==='error') console.log('CONSOLE:', m.text().slice(0,600)); });
page.on('response', r => { if (!r.ok() && r.status() !== 304) console.log('HTTP', r.status(), r.url()); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
await browser.close();
