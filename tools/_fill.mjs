import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
const r = await p.evaluate(async () => {
  const g = window.game;
  const med = async () => { const s=[]; let last=performance.now();
    for(let i=0;i<60;i++){ await new Promise(x=>requestAnimationFrame(x)); const n=performance.now(); s.push(n-last); last=n; }
    s.sort((a,b)=>a-b); return +s[30].toFixed(2); };
  const out = {};
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  // cast glacier at the crosshair and measure with/without the particle engine
  const cast = () => { g.abilities.cast('glacier'); };
  cast(); out.with_particles = await med();
  const eng = g.particles;
  const saved = eng.systems ? [...eng.systems.keys?.() ?? []] : null;
  // hide every particle system's mesh
  let hidden = 0;
  g.scene.traverse(o => { if (o.isPoints || (o.isMesh && o.material?.transparent && o.userData?.particle)) { o.visible=false; hidden++; } });
  cast(); out.particles_hidden = await med(); out.hiddenObjects = hidden;
  return out;
});
console.log(JSON.stringify(r,null,2));
await b.close();
