#!/usr/bin/env node
/**
 * Tonal readout for a capture.
 *
 * The arena critique is a *measurement*, not an opinion: the walls were at mean
 * luma 192 with sd 30 against CS2's frame mean of 93. Eyeballing a screenshot
 * cannot tell you whether you moved that number, so this prints it.
 *
 * Bands are horizontal slices, because in every shot of this arena the sky, the
 * wall and the floor stack vertically in that order.
 *
 *   node tools/luma.mjs reference/ours/arena.png reference/cs2/cs2_...jpg
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const BANDS = [
  ['sky   ', 0.0, 0.22],
  ['wall  ', 0.24, 0.44],
  ['mid   ', 0.44, 0.62],
  ['floor ', 0.66, 1.0],
  ['FRAME ', 0.0, 1.0]
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/luma.mjs <image> [image...]');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const file of files) {
  const buffer = await readFile(file);
  const mime = extname(file) === '.png' ? 'image/png' : 'image/jpeg';
  const url = `data:${mime};base64,${buffer.toString('base64')}`;

  const stats = await page.evaluate(
    async ({ url, bands }) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const out = [];
      for (const [name, y0, y1] of bands) {
        const top = Math.floor(y0 * canvas.height);
        const bottom = Math.max(top + 1, Math.floor(y1 * canvas.height));
        const { data } = ctx.getImageData(0, top, canvas.width, bottom - top);
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        const hist = new Array(16).fill(0);
        let sat = 0;
        for (let p = 0; p < data.length; p += 4) {
          const r = data[p];
          const g = data[p + 1];
          const b = data[p + 2];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          sum += l;
          sumSq += l * l;
          hist[Math.min(15, l >> 4)]++;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          sat += mx > 0 ? (mx - mn) / mx : 0;
          n++;
        }
        const mean = sum / n;
        out.push({
          name,
          mean,
          sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
          sat: (sat / n) * 100,
          hist: hist.map((h) => h / n)
        });
      }
      return { width: canvas.width, height: canvas.height, out };
    },
    { url, bands: BANDS }
  );

  console.log(`\n${basename(file)}  (${stats.width}x${stats.height})`);
  for (const b of stats.out) {
    const spark = b.hist
      .map((v) => ' ▁▂▃▄▅▆▇█'[Math.min(8, Math.round(Math.sqrt(v / 0.25) * 8))])
      .join('');
    console.log(
      `  ${b.name} mean ${b.mean.toFixed(1).padStart(6)}  sd ${b.sd
        .toFixed(1)
        .padStart(5)}  sat ${b.sat.toFixed(1).padStart(5)}%  |${spark}|`
    );
  }
}

await browser.close();
