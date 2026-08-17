import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const g = window.game;
  g.harness?.reset?.();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  const out = {};
  // measure cost of the post stack vs the scene
  const time = async (label, fn) => {
    const s=[]; let last=performance.now();
    for(let i=0;i<70;i++){ await new Promise(r=>requestAnimationFrame(r)); const n=performance.now(); s.push(n-last); last=n; }
    s.sort((a,b)=>a-b); out[label]=+s[Math.floor(s.length/2)].toFixed(2);
  };
  await time('baseline_ms');
  const post = g.post ?? g.postProcessing;
  if (post) { post.enabled = false; await time('no_post_ms'); post.enabled = true; }
  return out;
}), null, 2));
await b.close();
