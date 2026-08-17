#!/usr/bin/env node
/**
 * The progress board's data file.
 *
 * Every builder/critic pair reports through this, so the page is a live view of
 * the actual run rather than a summary written afterwards. Writes are
 * read-modify-write on a single JSON file; agents run concurrently, so the
 * write is done to a temp file and renamed, which is atomic on the same
 * filesystem and cannot leave a half-written file for the page to fetch.
 *
 * Usage:
 *   node tools/status.mjs init
 *   node tools/status.mjs set <piece> --status working
 *   node tools/status.mjs round <piece> --won false --gap "flash is 3x too long"
 *   node tools/status.mjs perf <path-to-perf.json>
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const FILE = resolve('progress/status.json');

/** The work list. Each entry names the real, fetchable thing it must beat. */
const PIECES = [
  { id: 'weapon-models', name: 'Weapon models', bar: 'CS2 AK-47 / M4A4 viewmodel' },
  { id: 'weapon-materials', name: 'Weapon materials', bar: 'CS2 viewmodel PBR at 1080p' },
  { id: 'muzzle-flash', name: 'Muzzle flash', bar: 'MW3 / CS2 rifle flash, 2 frames' },
  { id: 'recoil-feel', name: 'Recoil & viewmodel motion', bar: 'CS2 AK spray + CoD ADS kick' },
  { id: 'ads', name: 'Aim down sights', bar: 'MW3 ADS transition + sight picture' },
  { id: 'impacts', name: 'Bullet impacts', bar: 'CS2 surface impacts (concrete/metal/wood)' },
  { id: 'tracers', name: 'Tracers & shells', bar: 'MW3 tracer + brass ejection' },
  { id: 'monsters-form', name: 'Monster silhouettes', bar: 'Doom Eternal / Gears creature reads' },
  { id: 'monsters-material', name: 'Monster materials', bar: 'AAA creature skin: chitin + flesh' },
  { id: 'monsters-anim', name: 'Monster movement', bar: 'Believable multi-limb gait' },
  { id: 'arena-materials', name: 'Arena materials', bar: 'CS2 Dust II surfaces at 1080p' },
  { id: 'lighting', name: 'Lighting & grade', bar: 'CS2 Dust II lighting / MW3 grade' },
  { id: 'spell-thunder', name: 'Storm Lance VFX', bar: 'OW2 / FFXIV lightning casts' },
  { id: 'spell-ice', name: 'Frost Lance VFX', bar: 'FFXIV Blizzard / OW2 Mei' },
  { id: 'spell-meteor', name: 'Cinder Fall VFX', bar: 'FFXIV Fire IV / OW2 ults' },
  { id: 'spell-beam', name: 'Nova Beam VFX', bar: 'OW2 Zarya/Moira beams' },
  { id: 'spell-snare', name: 'Voltaic Snare VFX', bar: 'Valorant / OW2 zone abilities' },
  { id: 'spell-glacier', name: 'Glacial Crown VFX', bar: 'OW2 Mei wall / FFXIV ice' },
  { id: 'hud', name: 'HUD & crosshair', bar: 'CS2 HUD + Valorant ability bar' },
  { id: 'perf', name: 'Performance', bar: '60 fps @ 1080p in browser' }
];

async function load() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function save(data) {
  data.updated = new Date().toISOString();
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, FILE);
}

function blank() {
  return {
    phase: 'starting',
    updated: new Date().toISOString(),
    perf: null,
    pieces: PIECES.map((p) => ({ ...p, status: 'waiting', rounds: [], gap: null }))
  };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const [, , command, target, ...rest] = process.argv;
  const argv = [target, ...rest];

  let data = (await load()) ?? blank();

  // Reconcile: a piece added to PIECES after a run started should appear.
  const known = new Set(data.pieces.map((p) => p.id));
  for (const piece of PIECES) {
    if (!known.has(piece.id)) {
      data.pieces.push({ ...piece, status: 'waiting', rounds: [], gap: null });
    }
  }

  switch (command) {
    case 'init':
      data = blank();
      break;

    case 'phase':
      data.phase = argv.filter(Boolean).join(' ');
      break;

    case 'set': {
      const piece = data.pieces.find((p) => p.id === target);
      if (!piece) {
        console.error(`unknown piece: ${target}`);
        process.exit(2);
      }
      const status = argValue(argv, '--status');
      if (status) piece.status = status;
      const gap = argValue(argv, '--gap');
      if (gap !== undefined) piece.gap = gap;
      break;
    }

    case 'round': {
      const piece = data.pieces.find((p) => p.id === target);
      if (!piece) {
        console.error(`unknown piece: ${target}`);
        process.exit(2);
      }
      const won = argValue(argv, '--won') === 'true';
      const gap = argValue(argv, '--gap') ?? null;
      piece.rounds.push({ won, gap, at: new Date().toISOString() });
      piece.gap = won ? null : gap;
      piece.status = won ? 'won' : 'working';
      break;
    }

    case 'perf': {
      try {
        data.perf = JSON.parse(await readFile(resolve(target), 'utf8'));
      } catch (error) {
        console.error(`could not read perf file: ${error.message}`);
        process.exit(2);
      }
      break;
    }

    case 'show':
      console.log(JSON.stringify(data, null, 2));
      return;

    default:
      console.error(
        'usage: status.mjs init | phase <text> | set <piece> --status <s> [--gap <t>] | round <piece> --won <bool> [--gap <t>] | perf <file> | show'
      );
      process.exit(2);
  }

  await save(data);
  const won = data.pieces.filter((p) => p.status === 'won').length;
  console.log(`status: ${won}/${data.pieces.length} won · phase: ${data.phase}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
