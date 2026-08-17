/**
 * Objective readout of a capture: how much of the frame is blown out, and what
 * hue the effect actually is.
 *
 * "It looks white" and "there is no blue" are the two notes this project keeps
 * getting, and both are measurable. Guessing at them from a thumbnail is how a
 * colour gets 'fixed' three times without moving.
 *
 *   node tools/_probe/pixels.mjs reference/ours/spell_beam.png
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const file of files) {
  const buf = await readFile(file);
  const url = `data:image/png;base64,${buf.toString('base64')}`;
  const stats = await page.evaluate(async (url) => {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;

    let blown = 0, bright = 0, total = 0;
    // Hue histogram over pixels that are actually part of an effect: bright and
    // not grey. A white beam contributes to `washed` instead of to a hue bucket.
    let washed = 0, hued = 0;
    let hr = 0, hg = 0, hb = 0;
    // Row-by-row coverage of blown pixels, to see *where* the frame is lost.
    const rows = 12;
    const rowBlown = new Array(rows).fill(0);
    const rowTotal = new Array(rows).fill(0);

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const px = (i / 4) % c.width;
      const py = Math.floor((i / 4) / c.width);
      const row = Math.min(rows - 1, Math.floor((py / c.height) * rows));
      total++; rowTotal[row]++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 248 && mn > 235) { blown++; rowBlown[row]++; }
      if (mx > 170) {
        bright++;
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        if (sat < 0.16) washed++;
        else { hued++; hr += r; hg += g; hb += b; }
      }
      void px;
    }
    return {
      size: `${c.width}x${c.height}`,
      blownPct: +(100 * blown / total).toFixed(2),
      brightPct: +(100 * bright / total).toFixed(2),
      washedOfBright: bright ? +(100 * washed / bright).toFixed(1) : 0,
      meanHuedRGB: hued ? [Math.round(hr / hued), Math.round(hg / hued), Math.round(hb / hued)] : null,
      rowBlownPct: rowBlown.map((n, i) => +(100 * n / rowTotal[i]).toFixed(1))
    };
  }, url);
  console.log(file.replace(/^.*\//, '') + '  ' + JSON.stringify(stats));
}

await browser.close();
