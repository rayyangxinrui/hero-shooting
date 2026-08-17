import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.game;
  const out = {};
  for (const el of ['ice','glacier','snare']) {
    const cfg = g.settings?.[el] ?? {};
    out[el] = {
      spikeCount: cfg.spikeCount, density: cfg.density,
      particleRates: {
        mist: cfg.mistRate, shard: cfg.shardRate, sparkle: cfg.sparkleRate,
        spark: cfg.sparkRate, updraft: cfg.updraftRate, smoke: cfg.smokeRate, debris: cfg.debrisRate
      }
    };
  }
  return out;
}), null, 2));
await b.close();
