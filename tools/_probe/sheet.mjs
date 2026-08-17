/**
 * Contact sheet: tile several PNGs into one labelled grid so a whole isolation
 * sweep can be read in a single look instead of one image per tool call.
 *
 *   node tools/_probe/sheet.mjs out.png cols  a.png b.png c.png ...
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const out = process.argv[2];
const cols = Number(process.argv[3] ?? 3);
const files = process.argv.slice(4);
const CELL_W = 620;

const images = [];
for (const file of files) {
  const buf = await readFile(file);
  images.push({ label: basename(file, '.png'), url: `data:image/png;base64,${buf.toString('base64')}` });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
const dim = await page.evaluate(async ({ images, cols, CELL_W }) => {
  const loaded = await Promise.all(images.map((im) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res({ img: i, label: im.label }); i.onerror = rej; i.src = im.url;
  })));
  const ar = loaded[0].img.height / loaded[0].img.width;
  const cellH = Math.round(CELL_W * ar) + 22;
  const rows = Math.ceil(loaded.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * CELL_W; c.height = rows * cellH;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  loaded.forEach((entry, i) => {
    const cx = (i % cols) * CELL_W;
    const cy = Math.floor(i / cols) * cellH;
    x.drawImage(entry.img, cx, cy + 22, CELL_W, cellH - 22);
    x.fillStyle = '#000'; x.fillRect(cx, cy, CELL_W, 22);
    x.fillStyle = '#0f0'; x.font = 'bold 16px monospace';
    x.fillText(entry.label, cx + 6, cy + 16);
    x.strokeStyle = '#333'; x.strokeRect(cx, cy, CELL_W, cellH);
  });
  document.body.style.margin = '0'; document.body.appendChild(c);
  return { width: c.width, height: c.height };
}, { images, cols, CELL_W });

await page.setViewportSize(dim);
await writeFile(out, await page.locator('canvas').screenshot({ type: 'png' }));
await browser.close();
console.log('wrote ' + out, dim);
