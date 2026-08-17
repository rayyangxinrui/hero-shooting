#!/usr/bin/env node
/**
 * Screenshot harness.
 *
 * Boots the game in headless Chromium, drives it into a named pose, and writes
 * a PNG. Every critic comparison depends on this being *deterministic*: the
 * same shot name must produce the same framing every time, or a critic cannot
 * tell an improvement from a different camera angle.
 *
 * Usage:
 *   node tools/capture.mjs --shot hipfire --out reference/ours/hipfire.png
 *   node tools/capture.mjs --all --outdir reference/ours
 *   node tools/capture.mjs --list
 *
 * Exit code is non-zero if the page threw, so a builder agent cannot mistake a
 * black frame for a finished feature.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const URL_BASE = process.env.GAME_URL ?? 'http://127.0.0.1:5178/';
const WIDTH = Number(process.env.SHOT_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1080);

/**
 * Every shot is a pose plus a settle time.
 *
 * `setup` runs inside the page with `game` in scope. It must leave the game in
 * a state that renders identically every time — which means: no reliance on
 * spawn RNG, no reliance on wall-clock time, and an explicit camera.
 */
const SHOTS = {
  /** The default fighting stance: rifle at the hip, arena ahead. */
  hipfire: {
    settle: 0.9,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('rifle', true);
    }
  },

  /** Down the sights. The single most-looked-at frame in a shooter. */
  ads: {
    settle: 0.9,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('rifle', true);
      game.weapons.setAiming(true);
      game.harness.step(0.4);
    }
  },

  /** Mid-burst: muzzle flash, tracer, shell in the air, recoil applied. */
  firing: {
    settle: 0.0,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('rifle', true);
      game.harness.burst(4);
    }
  },

  /** The SMG and the pistol, for the weapon-model critic. */
  smg: {
    settle: 0.9,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('smg', true);
    }
  },
  pistol: {
    settle: 0.9,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('pistol', true);
    }
  },

  /** A monster at fighting range, lit by the key. */
  monster: {
    settle: 1.2,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.harness.spawnMonsterAt(0, -6, 0);
      game.harness.step(0.6);
    }
  },

  /** Several monsters, to read the silhouette variety. */
  /**
   * One of every archetype, so the generator's variety is actually judgeable.
   *
   * Species are generated two per archetype, so indices 0/2/4/6 are one of
   * each: stalker, brute, skitter, wraith. The previous 0-3 asked for
   * stalker, stalker, brute, brute — which is why the horde read as one
   * species with size variation and the six-legged and four-armed body plans
   * never appeared in a single capture.
   */
  horde: {
    settle: 1.4,
    setup: (game) => {
      game.harness.place(0, 11, 0, 0);
      game.harness.spawnMonsterAt(-4.5, -3.5, 0); // stalker
      game.harness.spawnMonsterAt(0.5, -6.5, 2); // brute
      game.harness.spawnMonsterAt(5.0, -2.5, 4); // skitter — six legs
      game.harness.spawnMonsterAt(-2.0, -12, 6); // wraith
      game.harness.step(0.8);
    }
  },

  /** The arena itself: lighting, materials, shadows. No HUD, no weapon. */
  arena: {
    settle: 1.0,
    setup: (game) => {
      game.harness.place(-16, 18, 0.55, -0.06);
      game.harness.setHUD(false);
      game.harness.setViewmodel(false);
    }
  },

  /** The render with no interface at all — what the art critics judge. */
  clean: {
    settle: 1.0,
    setup: (game) => {
      game.harness.place(0, 6, 0, 0);
      game.weapons.select('rifle', true);
      game.harness.setHUD(false);
    }
  },

  /**
   * Bullet impacts on a wall — the surface-response critic's shot.
   *
   * Fired from close range on purpose. The north wall sits at z = -42, so
   * standing at z = -36 puts it ~6 m ahead. At 90 deg hfov and 1920 px, one
   * pixel covers 4.2 cm at 47 m: a bullet hole across the arena is under two
   * pixels and no engine can win that comparison. Every CS2 impact reference is
   * shot at 3-8 m, so ours is too.
   */
  impacts: {
    settle: 0.35,
    setup: (game) => {
      game.harness.place(0, -36, 0, 0);
      game.weapons.select('rifle', true);
      game.harness.shootWall(14);
    }
  },

  /** The same wall with no HUD and no gun — pure surface response. */
  impacts_clean: {
    settle: 0.35,
    setup: (game) => {
      game.harness.place(0, -36, 0, 0);
      game.weapons.select('rifle', true);
      game.harness.shootWall(14);
      game.harness.setHUD(false);
    }
  }
};

/** One shot per spell, captured at the moment the VFX is at its peak. */
for (const [element, delay] of [
  ['thunder', 0.16],
  ['ice', 0.42],
  ['meteor', 0.95],
  ['beam', 0.75],
  ['snare', 0.5],
  ['glacier', 0.6]
]) {
  SHOTS[`spell_${element}`] = {
    settle: 0,
    setup: (game, args) => {
      game.harness.place(0, 14, 0, -0.14);
      game.harness.cast(args.element);
      game.harness.step(args.delay);
    },
    args: { element, delay }
  };
}

function parseArgs(argv) {
  const out = { shot: null, outfile: null, outdir: 'reference/ours', all: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shot') out.shot = argv[++i];
    else if (arg === '--out') out.outfile = argv[++i];
    else if (arg === '--outdir') out.outdir = argv[++i];
    else if (arg === '--all') out.all = true;
    else if (arg === '--list') out.list = true;
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv);

  if (options.list) {
    console.log(Object.keys(SHOTS).join('\n'));
    return;
  }

  const shotNames = options.all
    ? Object.keys(SHOTS)
    : [options.shot].filter(Boolean);

  if (shotNames.length === 0) {
    console.error('Nothing to do. Pass --shot <name>, --all, or --list.');
    process.exit(2);
  }

  const browser = await chromium.launch({
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--disable-frame-rate-limit'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

  // Wait for the game to finish loading — or to report that it failed.
  await page.waitForFunction(() => window.game?.ready === true || window.__gameError, {
    timeout: 90000
  });

  const bootError = await page.evaluate(() => window.__gameError ?? null);
  if (bootError) {
    console.error('Game failed to boot:\n' + bootError);
    await browser.close();
    process.exit(1);
  }

  // Install the harness: deterministic control over the running game.
  await page.evaluate(installHarness);

  const results = [];

  for (const name of shotNames) {
    const shot = SHOTS[name];
    if (!shot) {
      console.error(`Unknown shot: ${name}`);
      continue;
    }

    await page.evaluate(
      ({ setupSource, args, settle }) => {
        const game = window.game;
        game.harness.reset();
        // Reseed before every shot, so a shot renders identically whether it
        // was captured alone or after five others.
        game.harness.reseed();
        // eslint-disable-next-line no-new-func
        const setup = new Function('game', 'args', `(${setupSource})(game, args)`);
        setup(game, args ?? {});
        if (settle > 0) game.harness.step(settle);
      },
      { setupSource: shot.setup.toString(), args: shot.args ?? {}, settle: shot.settle }
    );

    // Render a few real frames so the composer, bloom and shadow map are all
    // showing the posed state rather than the previous shot's.
    await page.evaluate(() => window.game.harness.render(3));
    await page.waitForTimeout(120);

    const outPath = options.outfile
      ? resolve(options.outfile)
      : resolve(options.outdir, `${name}.png`);
    await mkdir(dirname(outPath), { recursive: true });

    const buffer = await page.screenshot({ type: 'png' });
    await writeFile(outPath, buffer);

    results.push({ name, path: outPath, bytes: buffer.length });
    console.log(`captured ${name} → ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }

  /* ---- performance probe: the measurable half of the bar ----
   *
   * Measures the LAST SHOT THAT WAS CAPTURED, left posed on screen, rather than
   * a synthetic scene of its own.
   *
   * It used to call `reset()` and spawn 8 monsters before measuring, which meant
   * the number printed under every capture described that stock scene and not
   * the frame above it — so "glacier runs at 54 fps" was never a statement about
   * glacier. Measuring the posed shot is the only version of this number that
   * can be acted on, because it is the only one that changes when the thing
   * being judged changes.
   */
  const perf = await page.evaluate(async () => {
    const game = window.game;
    game.harness.resume();
    // `info.render.frame` is a session-wide counter (autoReset is off), so it
    // cannot tell us how many frames this probe drew. Count our own ticks.
    let _drawn = 0;
    const _origFrame = game.frame.bind(game);
    game.frame = () => { _drawn++; _origFrame(); };

    // Measure with the real rAF loop, not with forced renders.
    const samples = [];
    let last = performance.now();
    await new Promise((resolve) => {
      let frames = 0;
      const tick = () => {
        const now = performance.now();
        samples.push(now - last);
        last = now;
        frames++;
        if (frames < 140) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

    // NOTE ON WHAT THIS NUMBER IS.
    //
    // Headless Chromium runs with vsync disabled, so these are *uncapped* frame
    // times: a simple shot reports four figures of fps because nothing is
    // throttling it to the display. That makes the absolute number meaningless
    // as "what a player sees", but makes it an excellent *relative* cost metric
    // — a shot that costs 8.7 ms of GPU work is genuinely ~12x more expensive
    // than one costing 0.7 ms, and a change that moves the millisecond figure
    // has moved real work. Read the ms, not the fps.
    //
    // Drop the first 40 frames: shader compiles and buffer growth land there.
    const stable = samples.slice(40).sort((a, b) => a - b);
    const median = stable[Math.floor(stable.length / 2)] ?? 0;
    const p95 = stable[Math.floor(stable.length * 0.95)] ?? 0;
    game.frame = _origFrame;
    return {
      framesRendered: _drawn,
      medianMs: median,
      p95Ms: p95,
      fps: median > 0 ? 1000 / median : 0,
      calls: game.renderer.gl.info.render.calls,
      triangles: game.renderer.gl.info.render.triangles
    };
  });

  console.log(
    `\nperf: ${perf.medianMs.toFixed(2)} ms/frame GPU (p95 ${perf.p95Ms.toFixed(2)} ms, uncapped — vsync off) · ` +
      `${perf.calls} draw calls · ${(perf.triangles / 1000).toFixed(0)}k tris`
  );

  await writeFile(
    resolve(options.outdir, 'perf.json'),
    JSON.stringify(perf, null, 2)
  );

  if (pageErrors.length) {
    console.error(`\n${pageErrors.length} page error(s):`);
    for (const error of pageErrors.slice(0, 12)) console.error('  ' + error);
  }

  await browser.close();

  if (pageErrors.length) process.exit(1);
}

/**
 * Installed into the page. Gives the harness deterministic control:
 * stop the rAF loop, step the simulation by an exact dt, force renders.
 *
 * Stepping by a fixed dt rather than by wall time is the whole point — two
 * captures of the same shot must produce byte-identical simulation state.
 */
function installHarness() {
  const game = window.game;
  if (game.harness) return;

  const FIXED_DT = 1 / 120;

  /* ------------------------------------------------------------------ */
  /* Determinism: seed Math.random                                       */
  /* ------------------------------------------------------------------ */
  //
  // The fixed timestep alone is not enough. The simulation calls Math.random()
  // in the monster gait, the particle systems, the decals, the fissures and the
  // burst spheres — so two captures of the same shot diverge, and a critic that
  // diffs two frames numerically ends up measuring capture noise rather than
  // the change it is trying to evaluate. That is not hypothetical: a builder
  // measured "40% of pixels changed" from a shader edit, then captured the same
  // shot twice with an identical shader and got 44%.
  //
  // Replacing Math.random with a seeded generator here, in the harness, keeps
  // the game's own code untouched (it should stay genuinely random at play
  // time) while making every capture byte-reproducible. Reseeded per shot by
  // `reseed()` below, so shot order cannot affect a shot's content either.
  let _seed = 0x2f6e2b1;
  Math.random = function seededRandom() {
    // mulberry32 — small, fast, and good enough that a particle field looks
    // random to the eye while replaying identically.
    _seed = (_seed + 0x6d2b79f5) | 0;
    let t = _seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  game.harness = {
    _paused: false,

    /**
     * A screenshot is of the *game*, not of the menu. The pointer-lock prompt
     * is a full-screen dimmed panel, so leaving it up would have every critic
     * comparing a title screen against a gameplay frame.
     */
    hideMenus() {
      // display:none rather than the class, because both panels fade out over
      // 0.2-0.4 s and a capture 120 ms later would catch them mid-transition.
      const lock = document.getElementById('lockPrompt');
      const loading = document.getElementById('loading');
      if (lock) lock.style.display = 'none';
      if (loading) loading.style.display = 'none';
    },

    /** Hide the entire HUD — for shots judging the render, not the interface. */
    setHUD(visible) {
      const hud = document.getElementById('hud');
      if (hud) hud.style.display = visible ? '' : 'none';
    },

    /** Hide the first-person weapon, for shots judging the world. */
    setViewmodel(visible) {
      game.weapons.root.visible = visible;
    },

    /** Stop the real-time loop so nothing advances between our steps. */
    pause() {
      if (this._paused) return;
      game.stop();
      this._paused = true;
    },

    resume() {
      if (!this._paused) return;
      game.start();
      this._paused = false;
    },

    /** Clear transient state so shots do not contaminate each other. */
    reset() {
      this.pause();
      this.hideMenus();
      this.setHUD(true);
      this.setViewmodel(true);
      game.abilities.clear();
      game.particles.reset();
      game.decals.clear();
      game.fissures.clear();
      game.bursts.clear();
      game.lights.reset();
      game.shake.reset();
      game.flash.reset();
      for (const monster of game.monsters.monsters.slice()) {
        game.monsters.group.remove(monster.mesh);
      }
      game.monsters.monsters.length = 0;
      // Push the next natural spawn far out so nothing wanders into frame.
      game.monsters.spawnTimer = 1e6;
      game.health = 100;
      game.mana = 100;
      for (const key of game.cooldowns.keys()) game.cooldowns.set(key, 0);
      game.weapons.shotIndex = 0;
      game.weapons.spread = 0;
      game.weapons.aimProgress = 0;
      game.weapons.setAiming(false);
      game.weapons.kickOffset.set(0, 0, 0);
      game.weapons.kickVelocity.set(0, 0, 0);
      game.weapons.kickRotation.set(0, 0, 0);
      game.weapons.kickRotVelocity.set(0, 0, 0);
      game.player.recoilPitch = 0;
      game.player.recoilYaw = 0;
      game.player.bobPhase = 0;
      game.player.landDip = 0;
      game.player.landDipVel = 0;
      for (const [id, entry] of game.weapons.built) {
        game.weapons.ammo.set(id, game.harness.magazineOf(id));
        game.weapons.reserves.set(id, game.harness.reserveOf(id));
      }
    },

    /** Reset the seeded PRNG, so a shot's content is independent of shot order. */
    reseed(seed = 0x2f6e2b1) {
      _seed = seed | 0;
    },

    /** Put the player somewhere, looking somewhere. Angles in radians. */
    place(x, z, yaw, pitch) {
      game.player.teleport(x, 1.72, z);
      game.player.euler.y = yaw;
      game.player.euler.x = pitch;
      game.player.velocity.set(0, 0, 0);
      game.player.onGround = true;
      game.fps.update(game.player, 0);
      game.camera.updateMatrixWorld(true);
      game.fps.viewCamera.updateMatrixWorld(true);
    },

    /** Advance the simulation by `seconds`, in fixed steps. */
    step(seconds) {
      const steps = Math.max(1, Math.round(seconds / FIXED_DT));
      for (let i = 0; i < steps; i++) {
        this._tick(FIXED_DT);
      }
    },

    /** One simulation tick with an exact dt and no rendering. */
    _tick(dt) {
      const g = game;
      g.elapsed += dt;
      // The shared frame clock drives every VFX shader, so it has to advance
      // with our fixed step or nothing animates between captures.
      g.frameUniforms.uTime.value = g.elapsed;
      g.frameUniforms.uDelta.value = dt;

      // Mirror App.frame's simulation half, minus input and rendering.
      g.player.update(dt, {
        forward: 0,
        strafe: 0,
        jump: false,
        crouch: false,
        sprint: false,
        walk: false,
        firing: this._firing ?? false,
        aiming: false
      });
      g.fps.update(g.player, dt);
      g.environment.setFocus(g.player.position.x, g.player.position.z);
      g.environment.update();
      g.weapons.update(dt, { firing: this._firing ?? false }, g.player);
      // Must run after the weapons have placed the viewmodel and while the
      // light pool still holds this frame's flashes — the same order App.frame
      // uses. Omitting it here renders every captured gun unlit, which is a
      // harness artefact a critic would read as a material failure.
      g.viewmodelLighting?.update(g.weapons.root, dt);
      g.combat.update(dt);
      g.monsters.update(dt);
      g.abilities.update(dt);
      g.particles.flush();
      g.decals.update(dt);
      g.fissures.update(dt);
      g.bursts.update(dt);
      g.lights.update(dt);
      g.flash.update(dt);
      g.shake.update(dt);
    },

    /** Force `n` full renders of the current state. */
    render(n = 1) {
      for (let i = 0; i < n; i++) {
        game.renderer.gl.shadowMap.needsUpdate = true;
        game.post.sync(game.elapsed, game.flash);
        game.post.render();
      }
    },

    /** Fire `n` rounds, spaced by the weapon's real cycle time. */
    burst(n) {
      const rpm = game.weapons.config.rpm;
      const interval = 60 / rpm;
      for (let i = 0; i < n; i++) {
        game.weapons.fireCooldown = 0;
        game.weapons._fire(game.player);
        if (i < n - 1) this.step(interval);
      }
      // Land one short step so the flash from the last round is still up.
      this.step(0.012);
    },

    /** Empty a magazine into the nearest wall, for the impact critic. */
    shootWall(n) {
      for (let i = 0; i < n; i++) {
        game.weapons.fireCooldown = 0;
        game.weapons._fire(game.player);
        this.step(0.06);
      }
    },

    /** Cast a spell down the crosshair, ignoring cooldown. */
    cast(element) {
      game.cooldowns.set(element, 0);
      game.abilities.cast(element);
    },

    /**
     * Put a monster at an exact spot — no spawn RNG in a reference shot.
     *
     * Goes through the manager's own species-forcing spawn: a creature is a
     * rig plus geometry plus a material, and swapping one of those on a live
     * instance from out here would leave the other two mismatched.
     */
    spawnMonsterAt(x, z, speciesIndex = 0) {
      const manager = game.monsters;
      const facing = Math.atan2(game.player.position.x - x, game.player.position.z - z);
      return manager.spawnAt(x, z, speciesIndex, facing);
    }
  };

  // Magazine sizes come from the live settings block, not from a constant —
  // a builder agent retuning a weapon must not silently break the harness.
  game.harness.magazineOf = (id) => game.weapons.built.has(id)
    ? (game.settings?.[id]?.magazine ?? 30)
    : 30;
  game.harness.reserveOf = (id) => game.weapons.built.has(id)
    ? (game.settings?.[id]?.reserve ?? 90)
    : 90;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
