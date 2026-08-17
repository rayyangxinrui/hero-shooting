import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });

const d = await page.evaluate(() => {
  const g = window.game;
  const out = {};
  const V = g.player.position.constructor;

  // Instrument impacts + tracers
  const hits = [];
  const origSpawnWorld = g.combat.impacts.spawnWorld.bind(g.combat.impacts);
  g.combat.impacts.spawnWorld = (p, n, s, i) => {
    hits.push({ p: p.toArray().map(v=>+v.toFixed(2)), n: n.toArray(), s });
    return origSpawnWorld(p, n, s, i);
  };
  const tracers = [];
  const origTracer = g.combat.tracers.spawn.bind(g.combat.tracers);
  g.combat.tracers.spawn = (a, b) => { tracers.push({ from: a.toArray().map(v=>+v.toFixed(2)), to: b.toArray().map(v=>+v.toFixed(2)) }); return origTracer(a,b); };
  const shells = [];
  const origEject = g.weapons.shells.eject.bind(g.weapons.shells);
  g.weapons.shells.eject = (p, c) => { shells.push(p.toArray().map(v=>+v.toFixed(2))); return origEject(p, c); };

  // Replicate the impacts shot
  g.harness = g.harness || {};
  // minimal harness bits
  g.stop();
  g.player.teleport(0, 1.72, 6); g.player.euler.y = 0; g.player.euler.x = 0;
  g.player.velocity.set(0,0,0); g.player.onGround = true;
  g.fps.update(g.player, 0); g.camera.updateMatrixWorld(true);
  g.weapons.select('rifle', true);

  const FIXED = 1/120;
  const tick = (dt) => {
    g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
    g.player.update(dt, {forward:0,strafe:0,jump:false,crouch:false,sprint:false,walk:false,firing:false,aiming:false});
    g.fps.update(g.player, dt);
    g.weapons.update(dt, {firing:false}, g.player);
    g.combat.update(dt); g.particles.flush(); g.decals.update(dt); g.lights.update(dt);
  };
  const step = (s) => { const n = Math.max(1, Math.round(s/FIXED)); for (let i=0;i<n;i++) tick(FIXED); };

  for (let i = 0; i < 14; i++) { g.weapons.fireCooldown = 0; g.weapons._fire(g.player); step(0.06); }
  step(0.35);

  out.hits = hits;
  out.tracers = tracers;
  out.shells = shells;
  out.decalsActive = g.decals.active.length;
  out.decalPositions = g.decals.active.map(dd => dd.mesh.position.toArray().map(v=>+v.toFixed(2)));
  out.camPos = g.camera.position.toArray().map(v=>+v.toFixed(2));
  out.recoilPitch = +g.player.recoilPitch.toFixed(3);
  out.euler = [+g.player.euler.x.toFixed(3), +g.player.euler.y.toFixed(3)];

  // distances from camera
  out.hitDistances = hits.map(h => {
    const dx=h.p[0]-out.camPos[0], dy=h.p[1]-out.camPos[1], dz=h.p[2]-out.camPos[2];
    return +Math.sqrt(dx*dx+dy*dy+dz*dz).toFixed(1);
  });
  return out;
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
