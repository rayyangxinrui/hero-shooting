import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 480 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.game;
  const out = {};
  for (const [id, o] of g.weapons.adsOffsets) out[id] = { x:o.x, y:o.y, z:o.z, zIsNaN: Number.isNaN(o.z) };
  return { adsOffsets: out, adsEyeRelief: g.settings?.weapons?.adsEyeRelief ?? '(undefined)' };
}), null, 2));
await b.close();
