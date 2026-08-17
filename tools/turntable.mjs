/**
 * Render a weapon model alone, on neutral grey, from a chosen angle.
 *
 * Separates two questions that the in-game shot conflates: "is the model any
 * good" and "is it framed well". A viewmodel can be a beautiful model badly
 * framed, and you cannot tell which you are looking at from the gameplay frame.
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const get = (k,d)=>{const i=args.indexOf(k);return i>=0?args[i+1]:d;};
const id = get('--id','rifle');
const out = resolve(get('--out',`reference/ours/_tt_${id}.png`));
const azim = Number(get('--azim', 35));   // degrees around Y
const elev = Number(get('--elev', 18));   // degrees above horizon
const hands = get('--hands','0') === '1';

const browser = await chromium.launch({ args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{ width:1600, height:900 } });
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});

await page.evaluate(({id,azim,elev,hands})=>{
  const g=window.game; g.stop();
  // The lock prompt and loading panel are full-screen overlays; a screenshot
  // with them up is a screenshot of the title card, not of the model.
  for(const el of ['lockPrompt','loading','hud']){
    const n=document.getElementById(el); if(n) n.style.display='none';
  }
  const T=window.__three ?? null;
  const built=g.weapons.built.get(id);
  const grp=built.group;

  // A private scene, so nothing from the arena leaks in.
  const S=g.scene.constructor;
  const scene=new S();
  const CTOR=g.fps.viewCamera.constructor;
  const cam=new CTOR(35, 1600/900, 0.01, 20);
  cam.layers.disableAll(); cam.layers.enable(4);

  // Neutral studio: a soft key, a fill, a rim. Deliberately plain so the model
  // is judged rather than the lighting.
  const DL=g.environment.sun.constructor;
  const AL=g.environment.ambient.constructor;
  const HL=g.environment.hemi.constructor;
  const key=new DL(0xfff2e0,3.0); key.position.set(-2,3,2.5); key.layers.set(4);
  const fill=new DL(0xc8d8ff,0.9); fill.position.set(3,0.5,1.5); fill.layers.set(4);
  const rim=new DL(0xffffff,2.0); rim.position.set(1.5,1.5,-3); rim.layers.set(4);
  const amb=new AL(0xffffff,0.35); amb.layers.set(4);
  const hemi=new HL(0x8fa8c8,0x3a3228,0.5); hemi.layers.set(4);
  scene.add(key,fill,rim,amb,hemi);
  scene.environment = g.scene.environment;
  scene.environmentIntensity = 0.5;
  const C=g.environment.ambient.color.constructor;
  scene.background=new C('#4a4a4e');

  // Detach the weapon into our scene, remembering where it came from.
  window.__ttRestore={parent:grp.parent, visible:grp.visible,
    pos:grp.position.clone(), quat:grp.quaternion.clone()};
  scene.add(grp);
  grp.visible=true;
  grp.position.set(0,0,0); grp.quaternion.identity();

  if (built.hands) built.hands.group.visible = hands;

  // Frame the model: bounding sphere, then pull back to fit.
  const B=g.weapons.root.position.constructor;
  const box=new (g.weapons.root.position.constructor.prototype.constructor===B? Object:Object)();
  // Compute bounds manually (Box3 may not be exposed).
  let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
  grp.updateMatrixWorld(true);
  grp.traverse(o=>{ if(!o.isMesh||!o.visible) return;
    const p=o.geometry.getAttribute('position');
    for(let i=0;i<p.count;i++){
      const v=new B(p.getX(i),p.getY(i),p.getZ(i)); o.localToWorld(v);
      mnx=Math.min(mnx,v.x);mny=Math.min(mny,v.y);mnz=Math.min(mnz,v.z);
      mxx=Math.max(mxx,v.x);mxy=Math.max(mxy,v.y);mxz=Math.max(mxz,v.z);
    }});
  const cx=(mnx+mxx)/2, cy=(mny+mxy)/2, cz=(mnz+mxz)/2;
  const r=Math.max(mxx-mnx,mxy-mny,mxz-mnz)/2;
  const dist=r/Math.tan(35*Math.PI/360)*1.35;
  const a=azim*Math.PI/180, e=elev*Math.PI/180;
  cam.position.set(cx+Math.sin(a)*Math.cos(e)*dist, cy+Math.sin(e)*dist, cz+Math.cos(a)*Math.cos(e)*dist);
  cam.lookAt(cx,cy,cz);
  cam.updateMatrixWorld(true);

  window.__tt={scene,cam};
},{id,azim,elev,hands});

await page.evaluate(()=>{ const g=window.game;
  g.renderer.gl.setRenderTarget(null);
  g.renderer.gl.render(window.__tt.scene, window.__tt.cam); });
await page.waitForTimeout(150);
await page.evaluate(()=>{ const g=window.game;
  g.renderer.gl.setRenderTarget(null);
  g.renderer.gl.render(window.__tt.scene, window.__tt.cam); });

await mkdir(dirname(out),{recursive:true});
await writeFile(out, await page.screenshot({type:'png'}));
console.log('turntable →', out, `(${id} azim=${azim} elev=${elev})`);
if(errs.length) console.log('page errors:', errs.slice(0,5));
await browser.close();
