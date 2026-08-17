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
  const V = g.camera.position.constructor;
  const built = g.weapons.built.get('rifle');
  const handsRoot = built.hands?.group;
  const isHand=(o)=>{let q=o;while(q){if(q===handsRoot)return true;q=q.parent;}return false;};
  const cam = g.fps.viewCamera;

  const measure = () => {
    g.weapons.root.updateMatrixWorld(true); cam.updateMatrixWorld(true);
    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,onscreen=0,total=0;
    built.group.traverse(o=>{
      if(!o.isMesh||isHand(o))return;
      const pos=o.geometry.getAttribute('position');
      for(let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/80))){
        const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i));
        o.localToWorld(v); v.project(cam);
        const sx=(v.x*0.5+0.5)*1920, sy=(-v.y*0.5+0.5)*1080;
        total++;
        if(sx>=0&&sx<=1920&&sy>=0&&sy<=1080) onscreen++;
        minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);
      }
    });
    return { widthPct:+(100*(maxX-minX)/1920).toFixed(1), onscreenPct:+(100*onscreen/total).toFixed(1) };
  };

  const out = {};
  for (const yaw of [0.075, 0.15, 0.22, 0.30, 0.35, 0.42]) {
    g.weapons._restYawOverride = yaw;
    for(let i=0;i<10;i++) g.weapons.update(1/120, {firing:false}, g.player);
    out['yaw_'+yaw] = measure();
  }
  return out;
}), null, 2));
await b.close();
