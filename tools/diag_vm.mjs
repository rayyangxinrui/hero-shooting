import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game; g.stop();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  g.fps.update(g.player, 0);
  g.weapons.select('rifle', true);
  for(let i=0;i<40;i++) g.weapons.update(1/120, {firing:false}, g.player);
  g.weapons.root.updateMatrixWorld(true);
  const cam = g.fps.viewCamera; cam.updateMatrixWorld(true);
  const built = g.weapons.built.get('rifle');

  const V = g.weapons.root.position.constructor;
  const toScreen = (obj) => {
    const p = obj.getWorldPosition(new V());
    p.project(cam);
    return { x: Math.round((p.x*0.5+0.5)*1920), y: Math.round((-p.y*0.5+0.5)*1080), depth:+p.z.toFixed(3) };
  };
  // bounding box of the weapon group in screen space
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9, n=0;
  const handsRoot = built.hands?.group;
  built.group.traverse(o=>{
    if(!o.isMesh) return;
    // Exclude the hands: forearms are *meant* to run off the bottom of frame.
    let p=o, isHand=false;
    while(p){ if(p===handsRoot){isHand=true;break;} p=p.parent; }
    // count hands INSTEAD this time
    if(!isHand) return;
    const geo=o.geometry, pos=geo.getAttribute('position');
    for(let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/40))){
      const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i));
      o.localToWorld(v); v.project(cam);
      const sx=(v.x*0.5+0.5)*1920, sy=(-v.y*0.5+0.5)*1080;
      minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);n++;
    }
  });
  return {
    groupScale: built.group.scale.toArray(),
    rootPos: g.weapons.root.position.toArray().map(v=>+v.toFixed(3)),
    camPos: cam.position.toArray().map(v=>+v.toFixed(3)),
    vmFov: cam.fov,
    muzzleScreen: toScreen(built.muzzlePoint),
    screenBBox: { minX:Math.round(minX), maxX:Math.round(maxX), minY:Math.round(minY), maxY:Math.round(maxY) },
    widthPct: +(100*(maxX-minX)/1920).toFixed(1),
    heightPct: +(100*(maxY-minY)/1080).toFixed(1),
    sampledVerts: n
  };
});
console.log(JSON.stringify(d,null,2));
await browser.close();
