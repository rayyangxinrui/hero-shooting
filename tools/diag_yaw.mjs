/** Probe: what does the frame look like at different rest yaws / distances?
 *  Read-only experiment - it mutates the live page, never a source file. */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});

for(const [tag,yaw,pitch,px,py,pz] of [
  ['a_current', null,null, null,null,null],
  ['b_yaw20',   0.35, 0.03, 0.20,-0.14,-0.46],
  ['c_yaw28',   0.49, 0.05, 0.23,-0.15,-0.52],
]){
  const r=await p.evaluate(({yaw,pitch,px,py,pz})=>{
    const g=window.game;
    for(const el of ['lockPrompt','loading']){const n=document.getElementById(el);if(n)n.style.display='none';}
    g.stop();
    if(yaw!==null){
      // Patch the live viewmodel transform to emulate a different rest pose.
      g.settings.weapons.viewmodelPos.x=px;
      g.settings.weapons.viewmodelPos.y=py;
      g.settings.weapons.viewmodelPos.z=pz;
      g.weapons.__restYaw=yaw; g.weapons.__restPitch=pitch;
    }
    g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0);
    g.fps.update(g.player,0);
    g.weapons.select('rifle',true);
    for(let i=0;i<60;i++) g.weapons.update(1/120,{firing:false},g.player);
    // Apply the extra yaw directly on the root, after the system posed it.
    if(yaw!==null){
      const E=g.weapons.root.rotation.constructor;
      const Q=g.weapons.root.quaternion.constructor;
      const q=new Q().setFromEuler(new E(pitch, yaw, 0,'XYZ'));
      g.weapons.root.quaternion.multiply(q);
      g.weapons.root.updateMatrixWorld(true);
    }
    g.post.sync(g.elapsed,g.flash); g.post.render();
    return true;
  },{yaw,pitch,px,py,pz});
  await p.waitForTimeout(150);
  await writeFile(`reference/ours/_yaw_${tag}.png`, await p.screenshot({type:'png'}));
  console.log('wrote reference/ours/_yaw_'+tag+'.png');
}
await b.close();
