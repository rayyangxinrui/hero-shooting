import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });

// install the same harness capture.mjs uses
const src = (await import('node:fs')).readFileSync('tools/capture.mjs','utf8');
const m = src.match(/function installHarness\(\)[\s\S]*?\n\}\n/);
await p.evaluate(new Function('return ' + m[0].replace(/^function installHarness\(\)/,'function()'))());

const r = await p.evaluate(async () => {
  const g = window.game;
  const med = async () => { const s=[]; let last=performance.now();
    for(let i=0;i<60;i++){ await new Promise(x=>requestAnimationFrame(x)); const n=performance.now(); s.push(n-last); last=n; }
    s.sort((a,b)=>a-b); return +s[30].toFixed(2); };

  const run = async (label, mutate) => {
    g.harness.reset(); g.harness.reseed();
    g.harness.place(0,14,0,-0.14);
    if (mutate) mutate();
    g.harness.cast('glacier');
    g.harness.step(0.6);
    g.harness.resume();
    const ms = await med();
    g.stop();
    return { [label]: ms };
  };

  const out = {};
  Object.assign(out, await run('full'));
  const S = g.settings.glacier;
  const savedMist = S.mistRate, savedSpikes = S.spikeCount;
  Object.assign(out, await run('no_mist', () => { S.mistRate = 0; }));
  S.mistRate = savedMist;
  Object.assign(out, await run('half_spikes', () => { S.spikeCount = Math.floor(savedSpikes/2); }));
  S.spikeCount = savedSpikes;
  return out;
});
console.log(JSON.stringify(r,null,2));
await b.close();
