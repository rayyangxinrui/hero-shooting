import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const worldMask = g.camera.layers.mask;
  const viewMask = g.fps.viewCamera.layers.mask;
  const lights = [];
  g.scene.traverse(o => {
    if (o.isLight) lights.push({
      type: o.type, mask: o.layers.mask,
      seenByWorldCam: (o.layers.mask & worldMask) !== 0,
      seenByViewCam:  (o.layers.mask & viewMask) !== 0,
      intensity: +o.intensity.toFixed(2)
    });
  });
  return { worldMask, viewMask, lights };
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
