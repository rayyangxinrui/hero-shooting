import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
const src = readFileSync('tools/capture.mjs','utf8');
const m = src.match(/function installHarness\(\)[\s\S]*?\n\}\n/);
await p.evaluate(m[0] + '\ninstallHarness();');
console.log(JSON.stringify(await p.evaluate(async () => {
  const g = window.game;
  g.harness.reset(); g.harness.reseed();
  g.harness.place(0,14,0,-0.14);
  g.harness.cast('glacier');
  g.harness.step(0.6);
  g.harness.resume();
  // Is the rAF loop actually rendering?
  const before = g.renderer.gl.info.render.frame;
  await new Promise(r=>setTimeout(r,700));
  const after = g.renderer.gl.info.render.frame;
  return { framesRendered: after-before, paused: g.harness._paused,
           drawCalls: g.renderer.gl.info.render.calls, tris: g.renderer.gl.info.render.triangles };
}),null,2));
await b.close();
