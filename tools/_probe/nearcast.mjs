/**
 * Cast each spell at a wall a few metres away and at the sky.
 *
 * The spell shots all frame a comfortable 12 m cast across open ground. That is
 * the easy case. The frame that actually breaks a first-person VFX is the one
 * where the player is pressed up against cover — the whole effect collapses into
 * the near field and anything sized in metres balloons. This probe is how a
 * "never engulfs the view again" claim gets checked instead of asserted.
 *
 *   node tools/_probe/nearcast.mjs beam
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const ELEMENT = process.argv[2] ?? 'beam';
const DELAYS = { thunder: 0.16, ice: 0.42, meteor: 0.95, beam: 0.75, snare: 0.5, glacier: 0.6 };

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

await page.evaluate(() => {
  const g = window.game;
  g.stop();
  window.__tick = (dt) => {
    g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
    g.player.update(dt, { forward: 0, strafe: 0, jump: false, crouch: false, sprint: false, walk: false, firing: false, aiming: false });
    g.fps.update(g.player, dt);
    g.environment.setFocus(g.player.position.x, g.player.position.z); g.environment.update();
    g.weapons.update(dt, { firing: false }, g.player);
    g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
    g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
    g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
  };
  window.__step = (s) => { const n = Math.max(1, Math.round(s / (1 / 120))); for (let i = 0; i < n; i++) window.__tick(1 / 120); };
  document.getElementById('lockPrompt').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
});

// [label, x, z, yaw, pitch] — pressed to the wall, point blank down, at the sky.
const POSES = [
  ['wall', 0, -34, 0, 0],
  ['floor', 0, 6, 0, -1.1],
  ['sky', 0, 6, 0, 0.6],
  ['open', 0, 14, 0, -0.14]
];

for (const [label, x, z, yaw, pitch] of POSES) {
  const shot = await page.evaluate(({ label, x, z, yaw, pitch, element, delay }) => {
    const g = window.game;
    g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
    g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
    for (const m of g.monsters.monsters.slice()) g.monsters.group.remove(m.mesh);
    g.monsters.monsters.length = 0; g.monsters.spawnTimer = 1e6;
    for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);

    g.player.teleport(x, 1.72, z); g.player.euler.y = yaw; g.player.euler.x = pitch;
    g.player.velocity.set(0, 0, 0); g.player.onGround = true;
    g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);

    g.cooldowns.set(element, 0);
    const ability = g.abilities.cast(element);
    window.__step(delay);
    for (let i = 0; i < 3; i++) { g.post.sync(g.elapsed, g.flash); g.post.render(); }
    void label;
    return { length: +(ability?.length ?? 0).toFixed(2) };
  }, { label, x, z, yaw, pitch, element: ELEMENT, delay: DELAYS[ELEMENT] ?? 0.6 });

  await page.waitForTimeout(60);
  const file = `reference/ours/_near_${ELEMENT}_${label}.png`;
  await writeFile(file, await page.screenshot({ type: 'png' }));
  console.log(`${file}  castLength=${shot.length}m`);
}

await browser.close();
