/** Luminance distribution of the weapon region — how much tonal range it uses. */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const a=process.argv.slice(2); const get=(k,d)=>{const i=a.indexOf(k);return i>=0?a[i+1]:d;};
const src=resolve(get('--in','reference/ours/hipfire.png'));
const x=Number(get('--x',0)),y=Number(get('--y',0)),w=Number(get('--w',1920)),h=Number(get('--h',1080));
const b64=(await readFile(src)).toString('base64');
const br=await chromium.launch(); const p=await br.newPage();
await p.setContent(`<canvas id=c></canvas><script>
window.go=(r,b64)=>new Promise(res=>{const i=new Image();i.onload=()=>{
const c=document.getElementById('c');c.width=i.width;c.height=i.height;
const g=c.getContext('2d');g.drawImage(i,0,0);
const d=g.getImageData(r.x,r.y,r.w,r.h).data;
const bins=new Array(16).fill(0); let n=0,sum=0,mn=255,mx=0;
for(let k=0;k<d.length;k+=4){const L=0.2126*d[k]+0.7152*d[k+1]+0.0722*d[k+2];
bins[Math.min(15,Math.floor(L/16))]++;n++;sum+=L;mn=Math.min(mn,L);mx=Math.max(mx,L);}
res({bins,n,mean:sum/n,min:mn,max:mx});};i.src='data:image/png;base64,'+b64;});
</script>`);
const r=await p.evaluate(([r,b])=>window.go(r,b),[{x,y,w,h},b64]);
console.log('region',x,y,w,h,' mean lum',r.mean.toFixed(1),' min',r.min.toFixed(0),' max',r.max.toFixed(0));
r.bins.forEach((c,i)=>{const pct=c/r.n*100;
 console.log(String(i*16).padStart(3)+'-'+String(i*16+15).padStart(3), '#'.repeat(Math.round(pct/2)).padEnd(30), pct.toFixed(1)+'%');});
await br.close();
