#!/usr/bin/env node
/**
 * Creature close-up harness (monsters builder's private tool).
 *
 * `tools/capture.mjs` frames its monster shot at a 12 m fighting range, which
 * is the right distance to judge whether a silhouette *reads* but far too far
 * to judge whether the anatomy and the surface hold up. This drives the same
 * game into portrait framing, an orbit, a gait strip and a lineup, so the form,
 * material and animation can each be looked at on their own terms.
 *
 * Usage:
 *   node tools/monstershot.mjs --shots portrait,orbit,gait,lineup,silhouette
 *   node tools/monstershot.mjs --species 3 --dist 3.2
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const URL_BASE = process.env.GAME_URL ?? 'http://127.0.0.1:5178/';
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1600);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 900);

function parseArgs(argv) {
  const out = {
    shots: ['portrait', 'orbit', 'gait', 'lineup'],
    outdir: 'reference/ours/monsterdev',
    species: 0,
    dist: 3.4
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shots') out.shots = argv[++i].split(',');
    else if (a === '--outdir') out.outdir = argv[++i];
    else if (a === '--species') out.species = Number(argv[++i]);
    else if (a === '--dist') out.dist = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit']
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.game?.ready === true || window.__gameError, {
    timeout: 90000
  });
  const boot = await page.evaluate(() => window.__gameError ?? null);
  if (boot) {
    console.error('boot failed:\n' + boot);
    await browser.close();
    process.exit(1);
  }

  await page.evaluate(installRig);

  const shot = async (name, fn, args) => {
    await page.evaluate(
      ({ src, a }) => {
        // eslint-disable-next-line no-new-func
        new Function('rig', 'a', `(${src})(rig, a)`)(window.__mrig, a);
      },
      { src: fn.toString(), a: args ?? {} }
    );
    await page.waitForTimeout(90);
    const out = resolve(opts.outdir, `${name}.png`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await page.screenshot({ type: 'png' }));
    console.log(`  ${name} → ${out}`);
  };

  for (const which of opts.shots) {
    if (which === 'portrait') {
      await shot('portrait', (rig, a) => {
        rig.reset();
        const m = rig.put(0, 0, a.species);
        rig.step(1.2);
        rig.look(m, a.dist, 0.42, 0.62, 0.1);
        rig.draw();
      }, { species: opts.species, dist: opts.dist });

      await shot('portrait_head', (rig, a) => {
        rig.reset();
        const m = rig.put(0, 0, a.species);
        rig.step(1.2);
        rig.look(m, 1.5, 0.86, 0.5, 0.0);
        rig.draw();
      }, { species: opts.species });
    }

    if (which === 'orbit') {
      for (const [i, angle] of [0, 0.9, 1.9, 2.9, 4.0].entries()) {
        await shot(`orbit_${i}`, (rig, a) => {
          rig.reset();
          const m = rig.put(0, 0, a.species);
          rig.step(1.2);
          rig.look(m, a.dist, 0.45, a.angle, 0.08);
          rig.draw();
        }, { species: opts.species, dist: opts.dist, angle });
      }
    }

    if (which === 'gait') {
      // Walk the creature past a fixed camera, sampled through one full stride.
      for (let i = 0; i < 6; i++) {
        await shot(`gait_${i}`, (rig, a) => {
          if (a.i === 0) {
            rig.reset();
            rig.__m = rig.put(0, -14, a.species);
            rig.step(0.4);
          }
          rig.walk(rig.__m, a.i === 0 ? 1.0 : 0.19);
          rig.look(rig.__m, 5.0, 0.45, 1.15, 0.06);
          rig.draw();
        }, { species: opts.species, i });
      }
    }

    if (which === 'lineup') {
      await shot('lineup', (rig) => {
        rig.reset();
        const n = rig.speciesCount();
        for (let i = 0; i < n; i++) rig.put((i - (n - 1) / 2) * 3.1, 0, i);
        rig.step(1.2);
        rig.camera(0, 2.6, 15.5, 0, 1.5, 0);
        rig.draw();
      });
      await shot('lineup_far', (rig) => {
        rig.reset();
        const n = rig.speciesCount();
        for (let i = 0; i < n; i++) rig.put((i - (n - 1) / 2) * 3.6, 0, i);
        rig.step(1.2);
        rig.camera(0, 3.4, 26, 0, 1.4, 0);
        rig.draw();
      });
    }

    if (which === 'silhouette') {
      await shot('silhouette', (rig, a) => {
        rig.reset();
        const n = rig.speciesCount();
        for (let i = 0; i < n; i++) rig.put((i - (n - 1) / 2) * 3.1, 0, i);
        rig.step(1.2);
        rig.flatten(true);
        rig.camera(0, 2.6, 15.5, 0, 1.5, 0);
        rig.draw();
        rig.flatten(false);
      }, {});
    }

    if (which === 'horde') {
      await shot('horde_close', (rig) => {
        rig.reset();
        const spots = [
          [-3.2, -1.5, 0], [1.2, -3.4, 3], [4.4, 0.6, 1], [-1.4, 3.6, 5],
          [3.0, 5.2, 2], [-5.2, 4.0, 7], [0.4, 8.0, 4], [6.2, 7.4, 6]
        ];
        for (const [x, z, s] of spots) rig.put(x, z, s);
        rig.step(1.4);
        rig.camera(0, 2.0, -9.0, 0, 1.3, 1);
        rig.draw();
      });
    }
  }

  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 10)) console.error('  ' + e);
  }
  await browser.close();
  if (errors.length) process.exit(1);
}

/** Installed into the page: deterministic control over creatures + camera. */
function installRig() {
  const game = window.game;
  const THREE = game.THREE ?? null;
  const FIXED_DT = 1 / 120;

  const rig = {
    __m: null,
    _hidden: [],

    reset() {
      game.stop?.();
      const lock = document.getElementById('lockPrompt');
      const loading = document.getElementById('loading');
      if (lock) lock.style.display = 'none';
      if (loading) loading.style.display = 'none';
      const hud = document.getElementById('hud');
      if (hud) hud.style.display = 'none';
      game.weapons.root.visible = false;
      game.abilities.clear?.();
      game.particles.reset?.();
      game.decals.clear?.();
      for (const m of game.monsters.monsters.slice()) game.monsters.group.remove(m.mesh);
      game.monsters.monsters.length = 0;
      game.monsters.spawnTimer = 1e6;
      // Park the player far away so nothing charges into frame.
      game.player.teleport(0, 1.72, 220);
      game.player.velocity.set(0, 0, 0);
    },

    speciesCount() {
      return game.monsters.species.length;
    },

    put(x, z, speciesIndex) {
      // Face the eventual camera, which sits on +Z.
      return game.monsters.spawnAt(x, z, speciesIndex, 0);
    },

    step(seconds) {
      const steps = Math.max(1, Math.round(seconds / FIXED_DT));
      for (let i = 0; i < steps; i++) {
        game.elapsed += FIXED_DT;
        game.frameUniforms.uTime.value = game.elapsed;
        game.frameUniforms.uDelta.value = FIXED_DT;
        game.monsters.update(FIXED_DT);
        game.environment.update?.();
      }
    },

    /** Drive a creature forward at walking speed for `seconds`, gait and all. */
    walk(monster, seconds) {
      if (!monster) return;
      const steps = Math.max(1, Math.round(seconds / FIXED_DT));
      const mm = game.monsters;
      for (let i = 0; i < steps; i++) {
        game.elapsed += FIXED_DT;
        game.frameUniforms.uTime.value = game.elapsed;
        // Force a full-speed hunt straight down +Z, then animate.
        monster.facing = 0;
        monster.state = 'hunt';
        monster.velocity.set(0, 0, monster.speed);
        monster.position.z += monster.speed * FIXED_DT;
        const moved = monster.speed * FIXED_DT;
        const stride = Math.max(
          0.2,
          1.5 * monster.species.stats.strideScale * monster.scale
        );
        monster.gait += (moved / stride) * Math.PI * 2;
        monster.gaitSpeed = monster.speed;
        mm._animate(monster, FIXED_DT);
        mm._updateTransform(monster, FIXED_DT);
      }
    },

    /** Frame a creature: distance, height fraction, orbit angle, pitch. */
    look(monster, dist, heightFrac, angle, pitch) {
      if (!monster) return;
      const h = monster.height;
      const cx = monster.position.x;
      const cz = monster.position.z;
      const cy = h * heightFrac;
      this.camera(
        cx + Math.sin(angle) * dist,
        cy + dist * Math.sin(pitch),
        cz + Math.cos(angle) * dist,
        cx,
        cy,
        cz
      );
    },

    camera(px, py, pz, tx, ty, tz) {
      const cam = game.fps.viewCamera ?? game.camera;
      cam.position.set(px, py, pz);
      cam.lookAt(tx, ty, tz);
      cam.updateMatrixWorld(true);
      if (game.camera !== cam) {
        game.camera.position.copy(cam.position);
        game.camera.quaternion.copy(cam.quaternion);
        game.camera.updateMatrixWorld(true);
      }
      game.environment.setFocus?.(px, pz);
      game.environment.update?.();
    },

    /** Black-fill every creature to judge the outline alone. */
    flatten(on) {
      if (on) {
        this._saved = [];
        game.environment.scene.traverse((o) => {
          if (!o.isMesh && !o.isSkinnedMesh) return;
          this._saved.push([o, o.material]);
        });
        const black = new (game.monsters.monsters[0]?.mesh.material.constructor)({
          color: 0x000000
        });
        black.emissive?.set?.(0x000000);
        black.roughness = 1;
        black.metalness = 0;
        for (const m of game.monsters.monsters) m.mesh.material = black;
        this._black = black;
        // Blow the background out so the silhouette is unmistakable.
        this._bg = game.environment.scene.background;
        game.environment.scene.background = null;
        game.environment.scene.fog = null;
        this._fogSaved = true;
      } else {
        for (const [o, mat] of this._saved ?? []) o.material = mat;
        if (this._bg !== undefined) game.environment.scene.background = this._bg;
        this._black?.dispose?.();
      }
    },

    draw() {
      game.renderer.gl.shadowMap.needsUpdate = true;
      game.post.sync(game.elapsed, game.flash);
      game.post.render();
    }
  };

  window.__mrig = rig;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
