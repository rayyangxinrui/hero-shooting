import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.game; g.stop();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  g.fps.update(g.player,0);
  g.weapons.select('rifle', true);
  // force full ADS
  for(let i=0;i<120;i++) g.weapons.update(1/120, {firing:false, aiming:true}, g.player);
  g.weapons.aimProgress = 1;
  g.weapons.update(1/120, {firing:false, aiming:true}, g.player);
  g.weapons.root.updateMatrixWorld(true);
  const cam = g.fps.viewCamera; cam.updateMatrixWorld(true);
  const built = g.weapons.built.get('rifle');
  const handsRoot = built.hands?.group;
  const isHand=(o)=>{let q=o;while(q){if(q===handsRoot)return true;q=q.parent;}return false;};
  const V = g.camera.position.constructor;
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  built.group.traverse(o=>{
    if(!o.isMesh||isHand(o))return;
    const pos=o.geometry.getAttribute('position');
    for(let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/60))){
      const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i));
      o.localToWorld(v); v.project(cam);
      const sx=(v.x*0.5+0.5)*1920, sy=(-v.y*0.5+0.5)*1080;
      minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);
    }
  });
  return { aimProgress:g.weapons.aimProgress,
    widthPct:+(100*(maxX-minX)/1920).toFixed(1), heightPct:+(100*(maxY-minY)/1080).toFixed(1),
    bbox:{minX:Math.round(minX),maxX:Math.round(maxX),minY:Math.round(minY),maxY:Math.round(maxY)} };
}), null, 2));
await b.close();
