/**
 * Cross-spell audit of the two things that have gone wrong in every ability.
 *
 *  1. **Burst shells sized for a third-person camera.** Every one of these
 *     abilities came from a sandbox whose camera sat ~8 m back. A 4 m shell is
 *     a nice impact from there and a screen-filling dome down the sights. This
 *     reports, per live burst, how many DEGREES of the frame it subtends — the
 *     only number that means anything, since metres do not.
 *
 *  2. **Whether the ability actually drives a pool light.** `ViewmodelLighting`
 *     collapses the whole LightPool into the single light that reaches the
 *     weapon, so an ability that never acquires one cannot light the gun no
 *     matter what it draws. "The gun takes zero bounce from a fireball 8 m
 *     away" is checkable, not a matter of opinion.
 *
 *   node tools/_probe/spellaudit.mjs
 */
import { chromium } from 'playwright';

const DELAYS = { thunder: 0.16, ice: 0.42, meteor: 0.95, beam: 0.75, snare: 0.5, glacier: 0.6 };

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

const rows = await page.evaluate((DELAYS) => {
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
    // The reason this line matters: the viewmodel's dynamic light is derived
    // from the LightPool *after* the pool has been updated, so a probe that
    // omits it reads zero for every spell and looks like a game bug.
    g.viewmodelLighting.update(g.weapons.root, dt);
  };

  const out = [];
  for (const [element, delay] of Object.entries(DELAYS)) {
    g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
    g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
    g.monsters.spawnTimer = 1e6;
    for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
    g.player.teleport(0, 1.72, 14); g.player.euler.y = 0; g.player.euler.x = -0.14;
    g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);
    g.cooldowns.set(element, 0);
    const ability = g.abilities.cast(element);
    const n = Math.max(1, Math.round(delay / (1 / 120)));
    for (let i = 0; i < n; i++) tick(1 / 120);

    const eye = g.camera.getWorldPosition(new g.camera.position.constructor());
    // Vertical FOV is 58.7 deg over 1080 px, so degrees convert straight to px.
    const pxPerDeg = 1080 / g.camera.fov;

    const bursts = g.bursts.active.map((b) => {
      const d = Math.max(0.05, eye.distanceTo(b.mesh.position));
      const r = b.mesh.scale.x;
      const deg = 2 * Math.atan(r / d) * 180 / Math.PI;
      return {
        mode: b.mode,
        r: +r.toFixed(2),
        dist: +d.toFixed(1),
        deg: +deg.toFixed(0),
        px: Math.round(deg * pxPerDeg),
        opacity: +(b.material.uniforms.uOpacity?.value ?? 1).toFixed(2)
      };
    }).sort((a, b2) => b2.px - a.px);

    const lit = g.lights.lights.filter((e) => e.light.intensity > 0.01);
    // Which of those lights this ability owns.
    const own = [];
    if (ability?.light) own.push('main');
    if (ability?.muzzleLight) own.push('muzzle');
    if (ability?.handLight) own.push('hand');

    // What the viewmodel light actually ended up as — the real test.
    const vm = g.viewmodelLighting ?? g.fps?.lighting ?? null;
    const dyn = vm?.dynamic ? {
      intensity: +vm.dynamic.intensity.toFixed(1),
      color: '#' + vm.dynamic.color.getHexString(),
      dist: +eye.distanceTo(vm.dynamic.position).toFixed(2)
    } : 'no viewmodel lighting found';

    out.push({
      element,
      poolLights: own,
      liveLights: lit.length,
      viewmodelDynamic: dyn,
      widestBursts: bursts.slice(0, 3)
    });
  }
  return out;
}, DELAYS);

for (const r of rows) console.log(JSON.stringify(r));
await browser.close();
