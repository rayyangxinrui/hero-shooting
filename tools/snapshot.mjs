#!/usr/bin/env node
/**
 * Build a single self-contained HTML file showing where the run stands.
 *
 * Everything is inlined — status, our latest captures, and the real reference
 * frames they are judged against, all as data: URIs — so the file can be opened
 * from anywhere (including a phone) with no server and no sibling assets.
 *
 * Usage: node tools/snapshot.mjs [outPath]
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = resolve(process.argv[2] ?? 'progress/snapshot.html');
const ROOT = resolve('.');

/** Downscale to keep the file openable on a phone. */
async function inlineImage(path, maxWidth = 760) {
  try {
    const tmp = `/tmp/_snap_${basename(path).replace(/\W/g, '_')}.jpg`;
    execFileSync('sips', ['-Z', String(maxWidth), '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '62', path, '--out', tmp], { stdio: 'ignore' });
    const buffer = await readFile(tmp);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

const status = JSON.parse(await readFile('progress/status.json', 'utf8').catch(() => '{}'));

/** Our captures paired with the reference they are judged against. */
const PAIRS = [
  ['hipfire', 'reference/ours/hipfire.png', 'reference/cs2/cs2_inferno_ak47_muzzleflash_02.jpg', 'Weapon in hand vs CS2'],
  ['firing', 'reference/ours/firing.png', 'reference/cod/cod_mw3_zombies_fps_viewmodel_muzzleflash_04.jpg', 'Muzzle flash vs CoD'],
  ['monster', 'reference/ours/monster.png', null, 'Procedural monster'],
  ['arena', 'reference/ours/arena.png', 'reference/cs2/cs2_sandstone_map_lighting_shadows_05.jpg', 'Arena vs CS2'],
  ['impacts', 'reference/ours/impacts.png', null, 'Bullet impacts'],
  ['spell_thunder', 'reference/ours/spell_thunder.png', 'reference/overwatch/ow2_kingsrow_chain_lightning_beam_vfx_07.jpg', 'Storm Lance vs OW2'],
  ['spell_ice', 'reference/ours/spell_ice.png', null, 'Frost Lance'],
  ['spell_meteor', 'reference/ours/spell_meteor.png', 'reference/ffxiv/ffxiv_fire_aoe_magic_circle_07.jpg', 'Cinder Fall vs FFXIV'],
  ['spell_beam', 'reference/ours/spell_beam.png', null, 'Nova Beam'],
  ['spell_snare', 'reference/ours/spell_snare.png', null, 'Voltaic Snare'],
  ['spell_glacier', 'reference/ours/spell_glacier.png', null, 'Glacial Crown']
];

const cards = [];
for (const [id, ours, ref, label] of PAIRS) {
  const oursData = await inlineImage(join(ROOT, ours)).catch(() => null);
  if (!oursData) continue;
  const refData = ref ? await inlineImage(join(ROOT, ref)).catch(() => null) : null;
  let mtime = '';
  try { mtime = new Date((await stat(join(ROOT, ours))).mtime).toISOString().slice(5, 16).replace('T', ' '); } catch {}
  cards.push(`
    <section class="card">
      <h2>${label}<span class="when">${mtime}</span></h2>
      <div class="pair">
        <figure><img src="${oursData}" alt="ours"><figcaption>OURS</figcaption></figure>
        ${refData ? `<figure><img src="${refData}" alt="reference"><figcaption>REAL GAME</figcaption></figure>` : ''}
      </div>
    </section>`);
}

const pieces = (status.pieces ?? []);
const won = pieces.filter((p) => p.status === 'won').length;
const rows = pieces.map((p) => {
  const rounds = (p.rounds ?? []).length;
  const cls = p.status === 'won' ? 'ok' : p.status === 'working' ? 'work' : 'wait';
  const gap = (p.gap ?? '').slice(0, 210);
  return `<tr><td class="${cls}">${p.name}</td><td class="n">${rounds}</td><td class="gap">${gap ? gap.replace(/[<>&]/g, '') : '—'}</td></tr>`;
}).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hero Shooting — snapshot</title><style>
:root{--bg:#0a0d12;--panel:#121722;--line:#1e2634;--text:#dbe4f0;--dim:#7c8ba3;--ok:#4ce0a0;--work:#ffb648;--wait:#4a5568}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,system-ui,sans-serif;padding:16px}
h1{font-size:17px;letter-spacing:.14em;margin-bottom:2px}
.sub{color:var(--dim);font-size:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;margin-bottom:22px;font-size:12px}
td{padding:6px 6px;border-bottom:1px solid var(--line);vertical-align:top}
td.ok{color:var(--ok)}td.work{color:var(--work)}td.wait{color:var(--wait)}
td.n{color:var(--dim);text-align:right;width:34px}
td.gap{color:var(--dim);font-size:11px;line-height:1.4}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:16px}
h2{font-size:13px;letter-spacing:.08em;color:var(--text);margin-bottom:9px;display:flex;justify-content:space-between}
.when{color:var(--dim);font-weight:400;font-size:11px}
.pair{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:680px){.pair{grid-template-columns:1fr 1fr}}
figure{margin:0}img{width:100%;border-radius:6px;display:block}
figcaption{color:var(--dim);font-size:10px;letter-spacing:.14em;margin-top:5px}
</style></head><body>
<h1>HERO SHOOTING</h1>
<div class="sub">${status.phase ?? ''} · ${won}/${pieces.length} pieces beating the bar · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
<table>${rows}</table>
${cards.join('')}
</body></html>`;

await writeFile(OUT, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`wrote ${OUT} (${kb} KB, ${cards.length} comparisons)`);
