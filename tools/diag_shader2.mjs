import { chromium } from 'playwright';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text().slice(0,300));});
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});
const d=await p.evaluate(()=>{
  const g=window.game;
  const out={};
  for(const [k,v] of Object.entries(g.weapons.models.materials)){
    const m=v.material;
    out[k]={
      cacheKey: m.customProgramCacheKey ? m.customProgramCacheKey() : '(none)',
      hasProgram: !!(m.program||(m.__webglShader)),
      uniformsInjected: Object.keys(v.uniforms).length
    };
  }
  // Pull the actual compiled fragment source for the steel material.
  const gl=g.renderer.gl;
  const props=gl.properties?gl.properties.get(g.weapons.models.materials.steel.material):null;
  let frag='(unavailable)';
  const prog = props?.currentProgram ?? props?.programs?.values?.().next?.().value;
  if(prog?.fragmentShader) frag=prog.fragmentShader;
  return {out, hasEdgeLift: typeof frag==='string' ? frag.includes('gEdgeLift') : 'n/a',
    fragLen: typeof frag==='string'?frag.length:0};
});
console.log(JSON.stringify(d,null,2));
await b.close();
