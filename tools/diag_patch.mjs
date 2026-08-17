import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
await page.waitForTimeout(1500);
const d = await page.evaluate(() => {
  const g = window.game;
  const built = g.weapons.built.get('rifle');
  const out = { gun: [], hands: null };
  const seen = new Set();
  built.group.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (seen.has(m.uuid)) return;
    seen.add(m.uuid);
    const prog = m.program;
    out.gun.push({
      uuid: m.uuid.slice(0,8),
      hasOnBeforeCompile: typeof m.onBeforeCompile === 'function',
      hasCustomCacheKey: m.customProgramCacheKey !== undefined && m.customProgramCacheKey.toString().length > 60,
      cacheKey: m.customProgramCacheKey ? String(m.customProgramCacheKey()).slice(0,40) : '(default)',
      // Did our injected uniform survive into the compiled program?
      patched: !!(prog && prog.getUniforms && prog.getUniforms().map && ('uSurface' in prog.getUniforms().map || 'uGlove' in prog.getUniforms().map)),
      programId: prog?.id ?? null
    });
  });
  return out;
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
