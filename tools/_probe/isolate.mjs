/**
 * Capture one spell with a named subsystem hidden, to attribute an artefact
 * to the system that draws it. Usage:
 *   node tools/_probe/isolate.mjs thunder decals out.png [delay]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const el = process.argv[2] ?? 'thunder';
const hide = process.argv[3] ?? 'decals';
const out = process.argv[4] ?? `reference/ours/_iso_${el}_${hide}.png`;
const DELAYS = { thunder:0.16, ice:0.42, meteor:0.95, beam:0.75, snare:0.5, glacier:0.6 };
const delay = Number(process.argv[5] ?? DELAYS[el]);

const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

await page.evaluate(({ el, hide, delay }) => {
  const g = window.game;
  g.stop();
  const FIXED = 1/120;
  const tick = (dt) => {
    g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
    g.player.update(dt, {forward:0,strafe:0,jump:false,crouch:false,sprint:false,walk:false,firing:false,aiming:false});
    g.fps.update(g.player, dt);
    g.environment.setFocus(g.player.position.x, g.player.position.z); g.environment.update();
    g.weapons.update(dt, {firing:false}, g.player);
    g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
    g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
    g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
  };
  const step = (s) => { const n = Math.max(1, Math.round(s/FIXED)); for (let i=0;i<n;i++) tick(FIXED); };

  g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
  g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
  for (const m of g.monsters.monsters.slice()) g.monsters.group.remove(m.mesh);
  g.monsters.monsters.length = 0; g.monsters.spawnTimer = 1e6;
  for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
  document.getElementById('lockPrompt').style.display='none';
  document.getElementById('loading').style.display='none';

  g.player.teleport(0,1.72,14); g.player.euler.y=0; g.player.euler.x=-0.14;
  g.player.velocity.set(0,0,0); g.player.onGround=true;
  g.fps.update(g.player,0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);

  g.cooldowns.set(el,0); g.abilities.cast(el); step(delay);

  // Hide *after* the sim so the effect still ran and spawned everything.
  const groups = { decals: g.decals.group, bursts: g.bursts.group, fissures: g.fissures.group };
  if (groups[hide]) groups[hide].visible = false;
  if (hide === 'particles') for (const s of g.particles.systems.values()) s.mesh.visible = false;
  if (hide === 'ability') for (const a of g.abilities.active) a.group.visible = false;
  if (hide === 'viewmodel') g.weapons.root.visible = false;

  for (let i=0;i<3;i++){ g.renderer.gl.shadowMap.needsUpdate=true; g.post.sync(g.elapsed,g.flash); g.post.render(); }
}, { el, hide, delay });

await page.waitForTimeout(120);
await writeFile(out, await page.screenshot({ type: 'png' }));
console.log('wrote ' + out);
await browser.close();
