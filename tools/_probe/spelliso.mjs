/**
 * Generic spell isolation. Renders one spell repeatedly with a single named
 * subsystem hidden each time, so an artefact can be attributed to the system
 * that draws it rather than guessed at from the composite.
 *
 *   node tools/_probe/spelliso.mjs glacier
 *
 * Writes reference/ours/_si_<element>_<variant>.png for each variant, and lists
 * the ability's own meshes so its per-pass groups can be named too.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const ELEMENT = process.argv[2] ?? 'glacier';
const DELAYS = { thunder: 0.16, ice: 0.42, meteor: 0.95, beam: 0.75, snare: 0.5, glacier: 0.6 };
const DELAY = Number(process.argv[3] ?? DELAYS[ELEMENT] ?? 0.6);

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
  document.getElementById('hud').style.display = 'none';
});

const inventory = await page.evaluate(({ element, delay }) => {
  const g = window.game;
  g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
  g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
  g.monsters.spawnTimer = 1e6;
  for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
  g.player.teleport(0, 1.72, 14); g.player.euler.y = 0; g.player.euler.x = -0.14;
  g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true);
  g.cooldowns.set(element, 0);
  const ability = g.abilities.cast(element);
  window.__step(delay);
  const out = [];
  ability.group.traverse((o) => {
    if (o.isMesh) out.push({ name: o.name || o.type, order: o.renderOrder, count: o.count ?? null });
  });
  return out;
}, { element: ELEMENT, delay: DELAY });
console.log('ability meshes: ' + JSON.stringify(inventory));

const VARIANTS = ['none', 'bursts', 'decals', 'particles', 'fissures', 'ability', 'flash'];
for (let i = 0; i < inventory.length; i++) VARIANTS.push('hideMesh:' + i);
for (let i = 0; i < inventory.length; i++) VARIANTS.push('onlyMesh:' + i);

for (const variant of VARIANTS) {
  await page.evaluate(({ variant, element, delay }) => {
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

    const meshes = [];
    ability.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) m.visible = true;

    if (variant === 'bursts') g.bursts.group.visible = false;
    else if (variant === 'decals') g.decals.group.visible = false;
    else if (variant === 'fissures') g.fissures.group.visible = false;
    else if (variant === 'particles') for (const s of g.particles.systems.values()) s.mesh.visible = false;
    else if (variant === 'ability') ability.group.visible = false;
    else if (variant === 'flash') g.flash.reset();
    else if (variant.startsWith('hideMesh:')) meshes[Number(variant.slice(9))].visible = false;
    else if (variant.startsWith('onlyMesh:')) {
      const want = Number(variant.slice(9));
      meshes.forEach((m, i) => { m.visible = i === want; });
      g.bursts.group.visible = false; g.decals.group.visible = false;
      g.fissures.group.visible = false;
      for (const s of g.particles.systems.values()) s.mesh.visible = false;
      g.flash.reset();
    }

    for (let i = 0; i < 3; i++) { g.post.sync(g.elapsed, g.flash); g.post.render(); }
  }, { variant, element: ELEMENT, delay: DELAY });

  await page.waitForTimeout(50);
  const file = `reference/ours/_si_${ELEMENT}_${variant.replace(':', '')}.png`;
  await writeFile(file, await page.screenshot({ type: 'png' }));
  console.log('wrote ' + file);
}

await browser.close();
