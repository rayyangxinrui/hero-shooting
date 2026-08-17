import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const out = {};
  for (const [id, built] of g.weapons.built) {
    let tris=0, meshes=0, handTris=0, handMeshes=0;
    const handsRoot = built.hands?.group;
    built.group.traverse(o => {
      if (!o.isMesh) return;
      const idx=o.geometry.getIndex();
      const t = idx ? idx.count/3 : o.geometry.getAttribute('position').count/3;
      let p=o,isHand=false; while(p){if(p===handsRoot){isHand=true;break;}p=p.parent;}
      if(isHand){handTris+=t;handMeshes++;}else{tris+=t;meshes++;}
    });
    out[id]={gunTris:Math.round(tris),gunMeshes:meshes,handTris:Math.round(handTris),handMeshes};
  }
  const mats={};
  for (const [k,v] of Object.entries(g.weapons.models.materials)) {
    mats[k]={rough:v.material.roughness,metal:v.material.metalness,env:v.material.envMapIntensity,base:'#'+v.uniforms.uBase.value.getHexString()};
  }
  const vl = g.viewmodelLighting ?? g.vmLighting;
  const lights = vl ? {key:vl.key.intensity,keyColor:'#'+vl.key.color.getHexString(),hemi:vl.hemi.intensity,amb:vl.ambient.intensity,dyn:vl.dynamic.intensity} : 'not found';
  return {out, mats, lights, envInt:g.scene.environmentIntensity, hasEnv:!!g.scene.environment, exposure:g.renderer.gl.toneMappingExposure};
});
console.log(JSON.stringify(d,null,2));
await browser.close();
