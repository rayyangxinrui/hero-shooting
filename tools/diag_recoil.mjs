import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game; g.stop();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  g.weapons.select('rifle', true);
  const w = g.weapons;
  const dt = 1/120;
  for (let i=0;i<30;i++) w.update(dt, {firing:false}, g.player);
  const rest = { pos: w.root.position.toArray().map(n=>+n.toFixed(5)), rot: w.root.rotation.toArray().slice(0,3).map(n=>+n.toFixed(5)) };
  // fire a burst and sample the peak
  let peakPos=0, peakRot=0, samples=[];
  w.fireCooldown = 0;
  for (let i=0;i<48;i++){
    w.update(dt, {firing:true}, g.player);
    const dp = Math.hypot(w.root.position.x-rest.pos[0], w.root.position.y-rest.pos[1], w.root.position.z-rest.pos[2]);
    const dr = Math.abs(w.root.rotation.x-rest.rot[0]);
    peakPos=Math.max(peakPos,dp); peakRot=Math.max(peakRot,dr);
    if(i%8===0) samples.push({f:i, dPos:+dp.toFixed(4), dRotX:+dr.toFixed(4)});
  }
  return { rest, peakPosMetres:+peakPos.toFixed(4), peakRotXRad:+peakRot.toFixed(4),
           peakRotXDeg:+(peakRot*180/Math.PI).toFixed(2), samples,
           kickSetting: g.settingsRef?.rifle?.kick ?? 'n/a' };
});
console.log(JSON.stringify(d,null,2));
await browser.close();
