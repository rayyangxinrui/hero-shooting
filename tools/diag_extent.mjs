/** How much of the gun is BEHIND the near plane / behind the eye? */
import { chromium } from 'playwright';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});
const d=await p.evaluate(()=>{
  const g=window.game; g.stop();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
  g.fps.update(g.player,0);
  g.weapons.select('rifle',true);
  for(let i=0;i<60;i++) g.weapons.update(1/120,{firing:false},g.player);
  g.weapons.root.updateMatrixWorld(true);
  const cam=g.fps.viewCamera; cam.updateMatrixWorld(true);
  const built=g.weapons.built.get('rifle');
  const V=g.weapons.root.position.constructor;
  const handsRoot=built.hands?.group;

  const stat=(includeHands)=>{
    let minZ=1e9,maxZ=-1e9, behind=0, total=0, offscreen=0;
    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
    built.group.traverse(o=>{
      if(!o.isMesh||!o.visible) return;
      let q=o,isHand=false; while(q){if(q===handsRoot){isHand=true;break;}q=q.parent;}
      if(isHand!==includeHands && includeHands===false && isHand) return;
      if(includeHands===true && !isHand) return;
      const pos=o.geometry.getAttribute('position');
      const step=Math.max(1,Math.floor(pos.count/300));
      for(let i=0;i<pos.count;i+=step){
        const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i));
        o.localToWorld(v); v.applyMatrix4(cam.matrixWorldInverse);
        // view space: camera looks down -Z, so visible points have z < -near
        minZ=Math.min(minZ,v.z); maxZ=Math.max(maxZ,v.z);
        total++;
        if(v.z > -cam.near) behind++;
        const q2=v.clone(); q2.applyMatrix4(cam.projectionMatrix);
        const w=-v.z; const sx=q2.x/w, sy=q2.y/w;
        if(Math.abs(sx)>1||Math.abs(sy)>1) offscreen++;
        minX=Math.min(minX,sx);maxX=Math.max(maxX,sx);minY=Math.min(minY,sy);maxY=Math.max(maxY,sy);
      }
    });
    return {nearestZ:+maxZ.toFixed(4), farthestZ:+minZ.toFixed(4),
      pctBehindNearPlane:+(behind/total*100).toFixed(1),
      pctOffscreen:+(offscreen/total*100).toFixed(1),
      ndcX:[+minX.toFixed(2),+maxX.toFixed(2)], ndcY:[+minY.toFixed(2),+maxY.toFixed(2)], samples:total};
  };
  return {near:cam.near, gun:stat(false), hands:stat(true)};
});
console.log(JSON.stringify(d,null,2));
await b.close();
