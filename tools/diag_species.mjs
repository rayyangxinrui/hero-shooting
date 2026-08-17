import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  return {
    speciesCount: g.monsters.species.length,
    species: g.monsters.species.map(s => ({
      archetype: s.archetype ?? s.stats?.archetype ?? '?',
      height: +(s.stats?.height ?? 0).toFixed(2),
      legs: s.rig?.legs?.length ?? 0,
      arms: s.rig?.arms?.length ?? 0,
      tris: s.geometry?.getIndex()?.count ? s.geometry.getIndex().count/3 : (s.geometry?.getAttribute("position")?.count ?? 0)
    }))
  };
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
