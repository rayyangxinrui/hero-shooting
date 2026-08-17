import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await p.evaluate(() => {
  const g = window.game;
  const V = g.player.position.constructor;
  const o = new V(0, 1.7, 6);
  const res = [];
  for (const dir of [[0,0,-1],[1,0,0],[-1,0,0],[0,-1,0],[0.3,0,-1]]) {
    const dd = new V(...dir).normalize();
    const h = g.collider.raycast(o, dd, 120);
    res.push(h ? { dir, n: [h.normal.x, h.normal.y, h.normal.z], lenSq: h.normal.lengthSq(), surface: h.surface, dist: +h.distance.toFixed(1) } : null);
  }
  return res;
});
console.log(JSON.stringify(d, null, 2));
await b.close();
