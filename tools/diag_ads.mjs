import { chromium } from 'playwright';
const b=await chromium.launch({args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.game?.ready===true||window.__gameError,{timeout:60000});
const d=await p.evaluate(()=>{
  const g=window.game;
  const offsets={};
  for(const [id,o] of g.weapons.adsOffsets) offsets[id]={x:o.x,y:o.y,z:o.z};
  return {adsEyeReliefSetting: g.settings?.weapons?.adsEyeRelief ?? '(undefined)',
    adsOffsets: offsets,
    viewmodelAdsPos: g.settings.weapons.viewmodelAdsPos};
});
console.log(JSON.stringify(d,null,2));
await b.close();
