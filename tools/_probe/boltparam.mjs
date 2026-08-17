/**
 * Sweep one thunder setting across values and shoot the same frame for each,
 * so the parameter that is actually responsible for a shape can be identified
 * rather than reasoned about.
 *
 *   node tools/_probe/boltparam.mjs spread 0 0.2 0.62 1.2
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const KEY = process.argv[2] ?? 'spread';
const VALUES = process.argv.slice(3).map(Number);

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

await page.evaluate(() => {
  const g = window.game;
  g.stop();
  window.__step = (s) => {
    const n = Math.max(1, Math.round(s / (1 / 120)));
    for (let i = 0; i < n; i++) {
      const dt = 1 / 120;
      g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
      g.player.update(dt, { forward: 0, strafe: 0, jump: false, crouch: false, sprint: false, walk: false, firing: false, aiming: false });
      g.fps.update(g.player, dt);
      g.environment.setFocus(g.player.position.x, g.player.position.z); g.environment.update();
      g.weapons.update(dt, { firing: false }, g.player);
      g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
      g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
      g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
      g.viewmodelLighting.update(g.weapons.root, dt);
    }
  };
  document.getElementById('lockPrompt').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  document.getElementById('hud').style.display = 'none';
});

for (const value of VALUES) {
  await page.evaluate(({ key, value }) => {
    const g = window.game;
    g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
    g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
    g.monsters.spawnTimer = 1e6;
    for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
    g.player.teleport(0, 1.72, 14); g.player.euler.y = 0; g.player.euler.x = -0.14;
    g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);

    // Suppress everything that is not the bolt, so the shape is unambiguous.
    g.settings.thunder[key] = value;
    g.cooldowns.set('thunder', 0);
    g.abilities.cast('thunder');
    window.__step(0.16);
    g.bursts.group.visible = false;
    g.decals.group.visible = false;
    for (const s of g.particles.systems.values()) s.mesh.visible = false;
    g.flash.reset();
    for (let i = 0; i < 3; i++) { g.post.sync(g.elapsed, g.flash); g.post.render(); }
  }, { key: KEY, value });

  await page.waitForTimeout(50);
  const file = `reference/ours/_bp_${KEY}_${value}.png`;
  await writeFile(file, await page.screenshot({ type: 'png' }));
  console.log('wrote ' + file);
}

await browser.close();
