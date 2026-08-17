import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const built = g.weapons.built.get('rifle');
  const handsRoot = built.hands.group;
  const isHand = (o) => { let p=o; while(p){ if(p===handsRoot) return true; p=p.parent; } return false; };

  const bounds = (mesh) => {
    const pos = mesh.geometry.getAttribute('position');
    let b={minX:1e9,maxX:-1e9,minY:1e9,maxY:-1e9,minZ:1e9,maxZ:-1e9};
    const V = g.camera.position.constructor;
    for(let i=0;i<pos.count;i++){
      const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i));
      mesh.updateMatrix(); v.applyMatrix4(mesh.matrix);
      b.minX=Math.min(b.minX,v.x); b.maxX=Math.max(b.maxX,v.x);
      b.minY=Math.min(b.minY,v.y); b.maxY=Math.max(b.maxY,v.y);
      b.minZ=Math.min(b.minZ,v.z); b.maxZ=Math.max(b.maxZ,v.z);
    }
    return b;
  };

  const gunParts=[], handParts=[];
  built.group.traverse(o=>{
    if(!o.isMesh) return;
    const b = bounds(o);
    (isHand(o)?handParts:gunParts).push(b);
  });

  // What is the top surface of the gun near each hand station?
  const gunTopAt = (z) => {
    let top=-1e9;
    for(const b of gunParts) if(z>=b.minZ-0.005 && z<=b.maxZ+0.005) top=Math.max(top,b.maxY);
    return top;
  };
  const gunSpanAt = (z) => {
    let minX=1e9,maxX=-1e9;
    for(const b of gunParts) if(z>=b.minZ-0.005 && z<=b.maxZ+0.005){minX=Math.min(minX,b.minX);maxX=Math.max(maxX,b.maxX);}
    return {minX,maxX};
  };

  return {
    handPartCount: handParts.length,
    fingers: handParts.map((b,i)=>({
      i,
      z:+((b.minZ+b.maxZ)/2).toFixed(4),
      topY:+b.maxY.toFixed(4),
      gunTopHere:+gunTopAt((b.minZ+b.maxZ)/2).toFixed(4),
      clearsGun: b.maxY > gunTopAt((b.minZ+b.maxZ)/2),
      xRange:[+b.minX.toFixed(4),+b.maxX.toFixed(4)],
      gunX:gunSpanAt((b.minZ+b.maxZ)/2)
    })).slice(0,20)
  };
});
console.log(JSON.stringify(d,null,2));
await browser.close();
