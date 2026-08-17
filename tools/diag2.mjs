import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const THREE_Box3 = g.arena.ground.geometry.boundingBox;
  const out = { arena: [], layers: {} };
  g.arena.group.children.slice(0,6).forEach(m => {
    m.updateWorldMatrix(true,false);
    out.arena.push({
      type: m.type, visible: m.visible, layerMask: m.layers.mask,
      pos: m.position.toArray().map(n=>+n.toFixed(2)),
      scale: m.scale.toArray().map(n=>+n.toFixed(2)),
      matVisible: m.material?.visible, matOpacity: m.material?.opacity,
      matColor: m.material?.color ? '#'+m.material.color.getHexString() : null,
      hasMap: !!m.material?.map,
      mapImage: m.material?.map?.image ? (m.material.map.image.width+'x'+m.material.map.image.height) : null,
      inFrustum: (()=>{ return true; })()
    });
  });
  out.camMask = g.camera.layers.mask;
  out.viewCamMask = g.fps.viewCamera.layers.mask;
  out.groundBBox = THREE_Box3 ? {min: THREE_Box3.min.toArray(), max: THREE_Box3.max.toArray()} : null;
  out.groundParentIsScene = g.arena.ground.parent === g.arena.group;
  out.arenaGroupParent = g.arena.group.parent?.type;
  out.arenaGroupVisible = g.arena.group.visible;
  out.sceneChildren = g.scene.children.map(c=>c.type+':'+(c.name||'')).slice(0,20);
  return out;
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
