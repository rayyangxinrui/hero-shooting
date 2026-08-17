import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const g = window.game;
  const THREE = g.THREE ?? null;
  const report = {};

  // Minimal harness
  g.stop();
  const FIXED = 1/120;
  const tick = (dt) => {
    g.elapsed += dt;
    g.frameUniforms.uTime.value = g.elapsed;
    g.frameUniforms.uDelta.value = dt;
    g.player.update(dt, {forward:0,strafe:0,jump:false,crouch:false,sprint:false,walk:false,firing:false,aiming:false});
    g.fps.update(g.player, dt);
    g.environment.setFocus(g.player.position.x, g.player.position.z);
    g.environment.update();
    g.weapons.update(dt, {firing:false}, g.player);
    g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
    g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
    g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
  };
  const step = (s) => { const n = Math.max(1, Math.round(s/FIXED)); for (let i=0;i<n;i++) tick(FIXED); };
  const place = (x,z,yaw,pitch) => {
    g.player.teleport(x, 1.72, z);
    g.player.euler.y = yaw; g.player.euler.x = pitch;
    g.player.velocity.set(0,0,0); g.player.onGround = true;
    g.fps.update(g.player, 0);
    g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);
  };
  const reset = () => {
    g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
    g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
    for (const m of g.monsters.monsters.slice()) g.monsters.group.remove(m.mesh);
    g.monsters.monsters.length = 0; g.monsters.spawnTimer = 1e6;
    for (const k of g.cooldowns.keys()) g.cooldowns.set(k, 0);
  };

  const delays = { thunder:0.16, ice:0.42, meteor:0.95, beam:0.75, snare:0.5, glacier:0.6 };

  report.camera = {};
  report.spells = {};

  for (const [el, delay] of Object.entries(delays)) {
    reset();
    place(0, 14, 0, -0.14);
    g.cooldowns.set(el, 0);
    const ab = g.abilities.cast(el);
    step(delay);

    const camPos = g.camera.getWorldPosition(new g.camera.position.constructor());
    report.camera[el] = { pos: camPos.toArray().map(n=>+n.toFixed(2)), near: g.camera.near, fov: g.camera.fov };

    const info = {
      phase: ab?.phase, length: +(ab?.length ?? 0).toFixed(2),
      origin: ab ? ab.origin.toArray().map(n=>+n.toFixed(2)) : null,
      frontPos: ab ? ab.position.toArray().map(n=>+n.toFixed(2)) : null,
      u: +(ab?.u ?? 0).toFixed(3)
    };
    if (ab) info.distFrontToCam = +camPos.distanceTo(ab.position).toFixed(2);

    // Bursts near the camera — the "camera is inside the effect" test.
    info.bursts = g.bursts.active.map(b => ({
      mode: b.mode,
      dist: +camPos.distanceTo(b.mesh.position).toFixed(2),
      scale: +b.mesh.scale.x.toFixed(2),
      inside: camPos.distanceTo(b.mesh.position) < b.mesh.scale.x * 1.05,
      age: +(b.age/b.life).toFixed(2)
    }));

    // Dynamic lights
    info.lights = g.lights.lights.filter(e => e.light.intensity > 0.01).map(e => ({
      i: +e.light.intensity.toFixed(1),
      d: +e.light.distance.toFixed(1),
      dist: +camPos.distanceTo(e.light.position).toFixed(2),
      color: '#' + e.light.color.getHexString()
    }));

    // Any VFX mesh whose bounding sphere contains the camera
    const engulf = [];
    g.scene.traverse(o => {
      if (!o.visible || !o.isMesh) return;
      const wp = o.getWorldPosition(new g.camera.position.constructor());
      const d = camPos.distanceTo(wp);
      const s = Math.max(o.scale.x, o.scale.y, o.scale.z);
      let r = 0;
      if (o.geometry?.boundingSphere) r = o.geometry.boundingSphere.radius * s;
      else if (o.geometry) { o.geometry.computeBoundingSphere(); r = (o.geometry.boundingSphere?.radius ?? 0) * s; }
      if (r > 0 && d < r && d < 30 && r < 200) {
        engulf.push({ name: o.name || o.type, dist: +d.toFixed(2), radius: +r.toFixed(2),
                      mat: o.material?.type, blending: o.material?.blending });
      }
    });
    info.engulfing = engulf.slice(0, 14);
    info.particleCount = g.particles.liveCount?.() ?? null;
    info.flash = +g.flash.strength.toFixed(3);
    report.spells[el] = info;
  }
  return report;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
