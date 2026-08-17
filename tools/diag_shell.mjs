import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  g.stop();
  g.player.teleport(0,1.72,6); g.player.euler.set(0,0,0); g.fps.update(g.player,0);
  g.camera.updateMatrixWorld(true);
  g.weapons.select('rifle', true);
  g.weapons.update(0.016, {firing:false}, g.player);
  g.weapons.root.updateMatrixWorld(true);

  const out = {};
  const entry = g.weapons.current;
  const ejectWorld = entry.ejectPoint.getWorldPosition(new (g.camera.position.constructor)());
  out.ejectWorld = ejectWorld.toArray().map(n=>+n.toFixed(3));
  out.camWorld = g.camera.position.toArray().map(n=>+n.toFixed(3));
  out.distFromCam = +ejectWorld.distanceTo(g.camera.position).toFixed(3);
  out.worldNear = g.camera.near;

  // fire one round, then step and see where shells are
  g.weapons.fireCooldown = 0;
  g.weapons._fire(g.player);
  const live = g.weapons.shells.shells.filter(s=>s.alive);
  out.aliveShellsAfterFire = live.length;
  if (live.length) {
    out.shell0 = { pos: live[0].position.toArray().map(n=>+n.toFixed(3)), vel: live[0].velocity.toArray().map(n=>+n.toFixed(2)) };
    out.shell0DistFromCam = +live[0].position.distanceTo(g.camera.position).toFixed(3);
  }
  out.shellMeshLayer = g.weapons.shells.mesh.layers.mask;
  out.worldCamMask = g.camera.layers.mask;
  out.shellSeenByWorldCam = (g.weapons.shells.mesh.layers.mask & g.camera.layers.mask) !== 0;
  return out;
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
