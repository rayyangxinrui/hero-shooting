/** Where is the gun relative to the view camera, and at what angle do we see it? */
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
  for(let i=0;i<60;i++) g.weapons.update(1/120,{firing:false},g.player);
  g.weapons.root.updateMatrixWorld(true);
  const cam=g.fps.viewCamera; cam.updateMatrixWorld(true);
  const b=g.weapons.built.get('rifle');
  const V=g.weapons.root.position.constructor;

  const world=(o)=>o.getWorldPosition(new V());
  const toView=(p)=>p.clone().applyMatrix4(cam.matrixWorldInverse);
  const scr=(p)=>{const q=p.clone().project(cam);return{x:Math.round((q.x*.5+.5)*1920),y:Math.round((-q.y*.5+.5)*1080)};};

  const muzzleW=world(b.muzzlePoint);
  const muzzleV=toView(muzzleW);
  // grip = model origin
  const gripW=b.group.getWorldPosition(new V());
  const gripV=toView(gripW);

  // The barrel axis in VIEW space: from grip to muzzle.
  const axis=muzzleV.clone().sub(gripV).normalize();
  // Angle between barrel axis and the camera's forward (-Z in view space).
  const fwd={x:0,y:0,z:-1};
  const dot=axis.x*fwd.x+axis.y*fwd.y+axis.z*fwd.z;
  const angleToForward=Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI;
  // Yaw of the barrel in the view's horizontal plane (0 = straight away from eye)
  const yawDeg=Math.atan2(axis.x,-axis.z)*180/Math.PI;
  const pitchDeg=Math.asin(axis.y)*180/Math.PI;

  return {
    muzzleView:{x:+muzzleV.x.toFixed(3),y:+muzzleV.y.toFixed(3),z:+muzzleV.z.toFixed(3)},
    gripView:{x:+gripV.x.toFixed(3),y:+gripV.y.toFixed(3),z:+gripV.z.toFixed(3)},
    barrelYawDeg:+yawDeg.toFixed(1),
    barrelPitchDeg:+pitchDeg.toFixed(1),
    angleBetweenBarrelAndViewAxis:+angleToForward.toFixed(1),
    muzzleScreen:scr(muzzleW), gripScreen:scr(gripW),
    rootQuatEuler:(()=>{const e=new (g.weapons.root.rotation.constructor)();e.setFromQuaternion(g.weapons.root.quaternion,'YXZ');return{x:+(e.x*180/Math.PI).toFixed(1),y:+(e.y*180/Math.PI).toFixed(1),z:+(e.z*180/Math.PI).toFixed(1)};})(),
    camEuler:(()=>{const e=new (g.weapons.root.rotation.constructor)();e.setFromQuaternion(cam.quaternion,'YXZ');return{x:+(e.x*180/Math.PI).toFixed(1),y:+(e.y*180/Math.PI).toFixed(1),z:+(e.z*180/Math.PI).toFixed(1)};})()
  };
});
console.log(JSON.stringify(d,null,2));
await browser.close();
