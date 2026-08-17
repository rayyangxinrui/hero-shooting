#!/usr/bin/env node
/**
 * Blind A/B composite.
 *
 * Takes our frame and a real game's frame, scales both to the same height,
 * lays them side by side in a RANDOM order, labels them only "A" and "B", and
 * writes the answer key to a separate file the critic is told not to open until
 * it has committed to a verdict.
 *
 * This exists because a critic that knows which image is ours will grade ours
 * generously. Stripping the labels is the difference between a comparison and a
 * rubber stamp — it is the single most load-bearing part of the whole loop.
 *
 * Usage:
 *   node tools/blind.mjs --ours reference/ours/hipfire.png \
 *                        --real reference/cs2/cs2_dust2_m4_viewmodel_01.jpg \
 *                        --out  reference/blind/weapons_r1.png
 *
 * Then: read the --out image, decide, and only then read the .key.txt beside it.
 */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname, basename } from 'node:path';

function parseArgs(argv) {
  const out = { ours: null, real: null, outfile: null, height: 900, shot: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shot') out.shot = argv[++i];
    else if (arg === '--ours') out.ours = argv[++i];
    else if (arg === '--real') out.real = argv[++i];
    else if (arg === '--out') out.outfile = argv[++i];
    else if (arg === '--height') out.height = Number(argv[++i]);
  }
  return out;
}

function mimeFor(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function toDataUrl(path) {
  const buffer = await readFile(resolve(path));
  return `data:${mimeFor(path)};base64,${buffer.toString('base64')}`;
}

async function main() {
  const options = parseArgs(process.argv);
  // Re-capture first, if asked.
  //
  // ## Why this exists
  //
  // A blind critic judging a stale frame wastes the whole round: it reports
  // defects that were fixed hours ago, and its verdict describes a build nobody
  // is running. That happened — a critic spent a full pass criticising missing
  // hands and missing cast shadows, both of which had already landed, and had
  // to work out from file timestamps that it was reviewing a 52-minute-old
  // render. Passing `--shot <name>` makes the composite always describe HEAD.
  if (options.shot) {
    const { execFileSync } = await import('node:child_process');
    options.ours = options.ours ?? `reference/ours/${options.shot}.png`;
    process.stdout.write(`capturing ${options.shot} fresh...\n`);
    execFileSync(process.execPath, ['tools/capture.mjs', '--shot', options.shot, '--out', options.ours], {
      stdio: ['ignore', 'ignore', 'inherit']
    });
  }

  if (!options.ours || !options.real || !options.outfile) {
    console.error(
      'usage: blind.mjs --ours <png> --real <jpg> --out <png> [--height 900]'
    );
    process.exit(2);
  }

  const [oursUrl, realUrl] = await Promise.all([
    toDataUrl(options.ours),
    toDataUrl(options.real)
  ]);

  // The coin flip. This is the only place the ordering is decided.
  const oursIsA = Math.random() < 0.5;
  const leftUrl = oursIsA ? oursUrl : realUrl;
  const rightUrl = oursIsA ? realUrl : oursUrl;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });

  const dimensions = await page.evaluate(
    async ({ leftUrl, rightUrl, height }) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });

      const [left, right] = await Promise.all([load(leftUrl), load(rightUrl)]);

      // Match heights so neither image gets an unfair size advantage — a bigger
      // picture reads as better regardless of what is in it.
      const leftWidth = Math.round((left.naturalWidth / left.naturalHeight) * height);
      const rightWidth = Math.round((right.naturalWidth / right.naturalHeight) * height);
      const gap = 16;
      const labelBand = 40;
      const total = leftWidth + rightWidth + gap;

      const canvas = document.createElement('canvas');
      canvas.width = total;
      canvas.height = height + labelBand;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.drawImage(left, 0, labelBand, leftWidth, height);
      ctx.drawImage(right, leftWidth + gap, labelBand, rightWidth, height);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 24px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText('A', 12, labelBand / 2);
      ctx.fillText('B', leftWidth + gap + 12, labelBand / 2);

      document.body.style.margin = '0';
      document.body.appendChild(canvas);
      return { width: canvas.width, height: canvas.height };
    },
    { leftUrl, rightUrl, height: options.height }
  );

  await page.setViewportSize(dimensions);

  const outPath = resolve(options.outfile);
  await mkdir(dirname(outPath), { recursive: true });
  const buffer = await page.locator('canvas').screenshot({ type: 'png' });
  await writeFile(outPath, buffer);

  const keyPath = outPath.replace(/\.png$/, '') + '.key.txt';
  await writeFile(
    keyPath,
    `captured: ${(await import('node:fs')).statSync(options.ours).mtime.toISOString()}\n` +
    `A = ${oursIsA ? 'OURS' : 'REAL GAME'}   (${oursIsA ? options.ours : options.real})\n` +
      `B = ${oursIsA ? 'REAL GAME' : 'OURS'}   (${oursIsA ? options.real : options.ours})\n`
  );

  await browser.close();

  console.log(`blind composite → ${outPath}`);
  console.log(`answer key      → ${keyPath}  (do not read until you have decided)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
