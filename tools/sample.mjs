/** Average colour of a region of a PNG — so colour calls are measured, not eyeballed. */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const args=process.argv.slice(2);
const get=(k,d)=>{const i=args.indexOf(k);return i>=0?args[i+1]:d;};
const src=resolve(get('--in','reference/ours/hipfire.png'));
const regions=JSON.parse(get('--regions','[]')); // [{name,x,y,w,h}]
const b64=(await readFile(src)).toString('base64');
const browser=await chromium.launch();
const page=await browser.newPage();
await page.setContent(`<canvas id=c></canvas><script>
window.go=(regions,b64)=>new Promise(res=>{const img=new Image();img.onload=()=>{
const c=document.getElementById('c');c.width=img.width;c.height=img.height;
const x=c.getContext('2d');x.drawImage(img,0,0);
res(regions.map(r=>{const d=x.getImageData(r.x,r.y,r.w,r.h).data;
let R=0,G=0,B=0,n=0;for(let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];n++;}
R=Math.round(R/n);G=Math.round(G/n);B=Math.round(B/n);
const mx=Math.max(R,G,B),mn=Math.min(R,G,B);
const sat=mx===0?0:(mx-mn)/mx;
return {name:r.name,rgb:[R,G,B],hex:'#'+[R,G,B].map(v=>v.toString(16).padStart(2,'0')).join(''),
 lum:Math.round(0.2126*R+0.7152*G+0.0722*B),sat:+sat.toFixed(2)};}));};
img.src='data:image/png;base64,'+b64;});
</script>`);
const out=await page.evaluate(([r,b])=>window.go(r,b),[regions,b64]);
for(const o of out) console.log(o.name.padEnd(20), o.hex, 'lum',String(o.lum).padStart(3), 'sat',o.sat, 'rgb',o.rgb.join(','));
await browser.close();
