/**
 * Beam pass isolation. Renders the beam shot repeatedly, each time hiding one
 * pass / subsystem, and writes a contact sheet of crops so the thing that is
 * actually drawing the white sphere can be named rather than guessed at.
 *
 *   node tools/_probe/beamiso.mjs
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const DELAY = Number(process.argv[2] ?? 0.75);
const ELEMENT = process.argv[3] ?? 'beam';

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

await page.evaluate(() => {
  const g = window.game;
  g.stop();
  const FIXED = 1 / 120;
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
  window.__step = (s) => { const n = Math.max(1, Math.round(s / FIXED)); for (let i = 0; i < n; i++) window.__tick(FIXED); };
  document.getElementById('lockPrompt').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  document.getElementById('hud').style.display = 'none';
});

const VARIANTS = [
  'none', 'bursts', 'decals', 'particles', 'flash',
  'pass:CORE', 'pass:SHELL', 'pass:HALO', 'pass:COIL', 'pass:RING', 'pass:ORB',
  'only:CORE', 'only:SHELL', 'only:HALO', 'only:COIL', 'only:RING', 'only:ORB'
];

for (const variant of VARIANTS) {
  await page.evaluate(({ variant, delay, element }) => {
    const g = window.game;
    g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
    g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
    for (const m of g.monsters.monsters.slice()) g.monsters.group.remove(m.mesh);
    g.monsters.monsters.length = 0; g.monsters.spawnTimer = 1e6;
    for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
    g.decals.group.visible = true; g.bursts.group.visible = true; g.fissures.group.visible = true;
    for (const s of g.particles.systems.values()) s.mesh.visible = true;

    g.player.teleport(0, 1.72, 14); g.player.euler.y = 0; g.player.euler.x = -0.14;
    g.player.velocity.set(0, 0, 0); g.player.onGround = true;
    g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);

    g.cooldowns.set(element, 0);
    const ability = g.abilities.cast(element);
    window.__step(delay);

    // BeamPass order in BeamAbility.createShaders(): HALO, SHELL, CORE, COIL, RING, ORB
    const NAMES = ['HALO', 'SHELL', 'CORE', 'COIL', 'RING', 'ORB'];
    const meshes = ability?.meshes ?? [];
    for (const m of meshes) m.visible = true;

    if (variant === 'bursts') g.bursts.group.visible = false;
    else if (variant === 'decals') g.decals.group.visible = false;
    else if (variant === 'particles') for (const s of g.particles.systems.values()) s.mesh.visible = false;
    else if (variant === 'flash') g.flash.reset();
    else if (variant.startsWith('pass:')) {
      const want = variant.slice(5);
      meshes.forEach((m, i) => { if (NAMES[i] === want) m.visible = false; });
    } else if (variant.startsWith('only:')) {
      const want = variant.slice(5);
      meshes.forEach((m, i) => { m.visible = NAMES[i] === want; });
      g.bursts.group.visible = false; g.decals.group.visible = false;
      for (const s of g.particles.systems.values()) s.mesh.visible = false;
      g.flash.reset();
    }

    for (let i = 0; i < 3; i++) { g.post.sync(g.elapsed, g.flash); g.post.render(); }
  }, { variant, delay: DELAY, element: ELEMENT });

  await page.waitForTimeout(60);
  const file = `reference/ours/_bi_${variant.replace(':', '_')}.png`;
  await writeFile(file, await page.screenshot({ type: 'png' }));
  console.log('wrote ' + file);
}

await browser.close();
