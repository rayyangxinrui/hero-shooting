/**
 * Where a spell's particles actually are.
 *
 * "Floating in open sky 30 m from the spell" is a claim about world positions,
 * and reading it off a screenshot is guesswork — a big near chip and a small far
 * one look the same. This dumps, per system, how far each live particle has got
 * from the cast and how high, so a spread can be tuned against numbers.
 *
 *   node tools/_probe/parts.mjs ice
 */
import { chromium } from 'playwright';

const ELEMENT = process.argv[2] ?? 'ice';
const DELAYS = { thunder: 0.16, ice: 0.42, meteor: 0.95, beam: 0.75, snare: 0.5, glacier: 0.6 };
const DELAY = Number(process.argv[3] ?? DELAYS[ELEMENT] ?? 0.6);

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

const out = await page.evaluate(({ element, delay }) => {
  const g = window.game;
  g.stop();
  const tick = (dt) => {
    g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
    g.player.update(dt, { forward: 0, strafe: 0, jump: false, crouch: false, sprint: false, walk: false, firing: false, aiming: false });
    g.fps.update(g.player, dt);
    g.environment.setFocus(g.player.position.x, g.player.position.z); g.environment.update();
    g.weapons.update(dt, { firing: false }, g.player);
    g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
    g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
    g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
  };

  g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
  g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
  g.monsters.spawnTimer = 1e6;
  for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
  g.player.teleport(0, 1.72, 14); g.player.euler.y = 0; g.player.euler.x = -0.14;
  g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true);
  g.cooldowns.set(element, 0);
  const ability = g.abilities.cast(element);
  const n = Math.max(1, Math.round(delay / (1 / 120)));
  for (let i = 0; i < n; i++) tick(1 / 120);

  const impact = { x: ability.origin.x + ability.direction.x * ability.length,
                   z: ability.origin.z + ability.direction.z * ability.length };
  const report = {};

  for (const [name, sys] of g.particles.systems.entries()) {
    if (!name.startsWith(element + '.')) continue;
    // The simulation is on the GPU, so the CPU only has spawn state. Re-integrate
    // it with the same constant-acceleration model the vertex shader uses.
    const a = sys.geometry.attributes;
    const start = a.aStart?.array, vel = a.aVelocity?.array;
    const spawn = a.aSpawn?.array, life = a.aLife?.array, size = a.aSize?.array;
    if (!start || !vel || !spawn || !life) { report[name] = 'no attributes'; continue; }
    const now = g.elapsed;
    const gravY = sys.uniforms.uGravity?.value?.y ?? 0;
    const speedScale = sys.uniforms.uSpeedScale?.value ?? 1;
    const lifeScale = sys.uniforms.uLifeScale?.value ?? 1;
    const sizeScale = sys.uniforms.uSizeScale?.value ?? 1;
    const drag = sys.uniforms.uDrag?.value ?? 0;

    const dists = [], heights = [], sizes = [];
    // The number that actually matters for "floating in open sky": how many of
    // these project ABOVE the horizon, where they have no ground behind them to
    // belong to. Everything else is a proxy for it.
    let onScreen = 0, aboveHorizon = 0;
    const cam = g.camera;
    const p = new cam.position.constructor();
    const eyeY = cam.getWorldPosition(new cam.position.constructor()).y;
    for (let i = 0; i < spawn.length; i++) {
      const lt = life[i] * lifeScale;
      if (lt <= 0) continue;
      const age = now - spawn[i];
      if (age < 0 || age > lt) continue;
      // Matches the shader: velocity with exponential drag plus gravity.
      const k = drag > 0 ? (1 - Math.exp(-drag * age)) / drag : age;
      const px = start[i * 3] + vel[i * 3] * speedScale * k;
      const py = start[i * 3 + 1] + vel[i * 3 + 1] * speedScale * k + 0.5 * gravY * age * age;
      const pz = start[i * 3 + 2] + vel[i * 3 + 2] * speedScale * k;
      dists.push(Math.hypot(px - impact.x, pz - impact.z));
      heights.push(py);
      sizes.push((size?.[i] ?? 1) * sizeScale);

      p.set(px, py, pz).project(cam);
      if (p.x > -1 && p.x < 1 && p.y > -1 && p.y < 1 && p.z < 1) {
        onScreen++;
        // The ground is a plane at y = 0, so the eye-to-particle ray hits ground
        // somewhere iff it points downward — that is, iff the particle is below
        // the camera. Anything above eye height is drawn against sky or against
        // the far wall, and that is the population that reads as floating.
        if (py > eyeY) aboveHorizon++;
      }
    }
    if (!dists.length) { report[name] = 'none live'; continue; }
    dists.sort((p2, q2) => p2 - q2); heights.sort((p2, q2) => p2 - q2); sizes.sort((p2, q2) => p2 - q2);
    const q = (arr, f) => +arr[Math.min(arr.length - 1, Math.floor(arr.length * f))].toFixed(2);
    report[name] = {
      live: dists.length,
      onScreen,
      againstSky: aboveHorizon,
      distFromImpact: { p50: q(dists, 0.5), p90: q(dists, 0.9), max: q(dists, 1) },
      height: { p50: q(heights, 0.5), p90: q(heights, 0.9), max: q(heights, 1) },
      size: { p50: q(sizes, 0.5), max: q(sizes, 1) }
    };
  }
  return { castLength: +ability.length.toFixed(2), report };
}, { element: ELEMENT, delay: DELAY });

console.log(JSON.stringify(out, null, 2));
await browser.close();
