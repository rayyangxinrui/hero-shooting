import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const built = g.weapons.built.get('rifle');
  const handsRoot = built.hands.group;
  const isHand=(o)=>{let p=o;while(p){if(p===handsRoot)return true;p=p.parent;}return false;};
  const V = g.camera.position.constructor;
  const parts=[];
  built.group.traverse(o=>{
    if(!o.isMesh||isHand(o))return;
    const pos=o.geometry.getAttribute('position');
    let b={minX:1e9,maxX:-1e9,minY:1e9,maxY:-1e9,minZ:1e9,maxZ:-1e9};
    o.updateMatrix();
    for(let i=0;i<pos.count;i++){
      const v=new V(pos.getX(i),pos.getY(i),pos.getZ(i)).applyMatrix4(o.matrix);
      b.minX=Math.min(b.minX,v.x);b.maxX=Math.max(b.maxX,v.x);
      b.minY=Math.min(b.minY,v.y);b.maxY=Math.max(b.maxY,v.y);
      b.minZ=Math.min(b.minZ,v.z);b.maxZ=Math.max(b.maxZ,v.z);
    }
    parts.push(b);
  });
  // profile the gun: top surface and x-span at sampled z stations
  const prof=[];
  for(let z=-0.40; z<=0.30; z+=0.02){
    let top=-1e9,minX=1e9,maxX=-1e9,bot=1e9;
    for(const b of parts) if(z>=b.minZ&&z<=b.maxZ){
      top=Math.max(top,b.maxY);bot=Math.min(bot,b.minY);
      minX=Math.min(minX,b.minX);maxX=Math.max(maxX,b.maxX);
    }
    if(top>-1e8) prof.push({z:+z.toFixed(3),top:+top.toFixed(4),bot:+bot.toFixed(4),minX:+minX.toFixed(4),maxX:+maxX.toFixed(4)});
  }
  return {prof, meshCount: parts.length, parts: parts.slice(0,8).map(b=>({z:[+b.minZ.toFixed(3),+b.maxZ.toFixed(3)],y:[+b.minY.toFixed(3),+b.maxY.toFixed(3)]}))};
});
console.log(JSON.stringify({meshCount:d.meshCount, parts:d.parts}));
await browser.close();
