/** Render ONLY the polymer mesh, big, to see what the magazine really is. */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1400,height:900}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});
await p.evaluate(()=>{
  const g=window.game; g.stop();
  for(const el of ['lockPrompt','loading','hud']){const n=document.getElementById(el);if(n)n.style.display='none';}
  const built=g.weapons.built.get('rifle');
  const S=g.scene.constructor; const scene=new S();
  const CTOR=g.fps.viewCamera.constructor;
  const cam=new CTOR(32,1400/900,0.01,20); cam.layers.disableAll(); cam.layers.enable(4);
  const DL=g.environment.sun.constructor, AL=g.environment.ambient.constructor;
  const k=new DL(0xffffff,3.0); k.position.set(-2,3,3); k.layers.set(4);
  const f=new DL(0xffffff,1.0); f.position.set(3,1,2); f.layers.set(4);
  const a=new AL(0xffffff,0.5); a.layers.set(4);
  scene.add(k,f,a);
  const C=g.environment.ambient.color.constructor; scene.background=new C('#555a60');
  // Keep only the polymer mesh (index 2 = the one spanning y -0.217).
  const meshes=[]; built.group.traverse(o=>{if(o.isMesh)meshes.push(o);});
  const poly=meshes.find(m=>{const bb=m.geometry; bb.computeBoundingBox(); return bb.boundingBox.min.y < -0.15;});
  const clone=poly.clone(); scene.add(clone);
  clone.position.set(0,0,0); clone.rotation.set(0,0,0);
  clone.geometry.computeBoundingBox(); const bb=clone.geometry.boundingBox;
  const cx=(bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz=(bb.min.z+bb.max.z)/2;
  const r=Math.max(bb.max.x-bb.min.x,bb.max.y-bb.min.y,bb.max.z-bb.min.z)/2;
  const d=r/Math.tan(32*Math.PI/360)*1.5;
  const az=1.0,el=0.25;
  cam.position.set(cx+Math.sin(az)*Math.cos(el)*d, cy+Math.sin(el)*d, cz+Math.cos(az)*Math.cos(el)*d);
  cam.lookAt(cx,cy,cz); cam.updateMatrixWorld(true);
  window.__tt={scene,cam};
  console.log('polymer bbox', JSON.stringify(bb.min), JSON.stringify(bb.max));
});
await p.evaluate(()=>{const g=window.game;g.renderer.gl.setRenderTarget(null);g.renderer.gl.render(window.__tt.scene,window.__tt.cam);});
await p.waitForTimeout(120);
await p.evaluate(()=>{const g=window.game;g.renderer.gl.setRenderTarget(null);g.renderer.gl.render(window.__tt.scene,window.__tt.cam);});
await writeFile('reference/ours/_tt_mag.png', await p.screenshot({type:'png'}));
console.log('wrote reference/ours/_tt_mag.png');
await b.close();
