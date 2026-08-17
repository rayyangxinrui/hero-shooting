/** Do the four gun materials actually get their OWN uniform values on the GPU? */
import { chromium } from 'playwright';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});
const d=await p.evaluate(()=>{
  const g=window.game;
  // Force a render so programs are compiled and materialProperties populated.
  g.weapons.select('rifle',true);
  g.post.render();
  const gl=g.renderer.gl;
  const res={};
  for(const [k,v] of Object.entries(g.weapons.models.materials)){
    const m=v.material;
    const props=gl.properties.get(m);
    const bound=props?.uniforms;
    res[k]={
      ownSurface: v.uniforms.uSurface.value,
      ownBase: '#'+v.uniforms.uBase.value.getHexString(),
      // What is actually in the uniform block three will upload for this material:
      boundSurface: bound?.uSurface ? bound.uSurface.value : '(absent)',
      boundBase: bound?.uBase ? '#'+bound.uBase.value.getHexString() : '(absent)',
      sameObjectAsOwn: bound?.uSurface === v.uniforms.uSurface
    };
  }
  return res;
});
console.log(JSON.stringify(d,null,2));
await b.close();
