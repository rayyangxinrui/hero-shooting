/** Crop a region of a captured PNG and scale it up, so a critic can actually
 *  see the weapon rather than a 600px sliver of a 1920px frame. */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i+1] : d; };
const src = resolve(get('--in', 'reference/ours/hipfire.png'));
const out = resolve(get('--out', 'reference/ours/_zoom.png'));
const x = Number(get('--x', 1020)), y = Number(get('--y', 560));
const w = Number(get('--w', 760)), h = Number(get('--h', 560));
const scale = Number(get('--scale', 2));

const data = await readFile(src);
const b64 = data.toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.round(w*scale), height: Math.round(h*scale) } });
await page.setContent(`<body style="margin:0;background:#000">
<canvas id="c" width="${Math.round(w*scale)}" height="${Math.round(h*scale)}"></canvas>
<script>
const img=new Image();
img.onload=()=>{const c=document.getElementById('c').getContext('2d');
c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';
c.drawImage(img,${x},${y},${w},${h},0,0,${Math.round(w*scale)},${Math.round(h*scale)});
document.title='done';};
img.src='data:image/png;base64,${b64}';
</script></body>`);
await page.waitForFunction(() => document.title === 'done', { timeout: 20000 });
await writeFile(out, await page.locator('#c').screenshot());
console.log('zoom →', out, `(${w}x${h} @${scale}x from ${x},${y})`);
await browser.close();
