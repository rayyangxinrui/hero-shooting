import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const s = g.settings;
  let meshCount = 0, visMesh = 0;
  g.scene.traverse(o => { if (o.isMesh) { meshCount++; if (o.visible) visMesh++; } });
  return {
    exposure: g.renderer.gl.toneMappingExposure,
    toneMapping: g.renderer.gl.toneMapping,
    sunIntensity: g.environment.sun.intensity,
    sunPos: g.environment.sun.position.toArray().map(n=>+n.toFixed(1)),
    ambientIntensity: g.environment.ambient.intensity,
    hemiIntensity: g.environment.hemi.intensity,
    envIntensity: g.scene.environmentIntensity,
    bgIsEnvMap: g.scene.background === g.environment._envMap,
    bgIntensity: g.scene.backgroundIntensity,
    fog: g.scene.fog ? {near:g.scene.fog.near, far:g.scene.fog.far, color:'#'+g.scene.fog.color.getHexString()} : null,
    meshCount, visMesh,
    arenaChildren: g.arena.group.children.length,
    colliderBoxes: g.collider.boxes.length,
    playerPos: g.player.position.toArray().map(n=>+n.toFixed(2)),
    camPos: g.camera.position.toArray().map(n=>+n.toFixed(2)),
    bloom: { strength: g.post.bloomPass.strength, threshold: g.post.bloomPass.threshold },
    settingsEnv: { sunIntensity: s.environment.sunIntensity, ambient: s.environment.ambientIntensity, exposure: s.post.exposure, skyIntensity: s.environment.skyIntensity },
    weaponVisible: g.weapons.current?.group?.visible,
    viewmodelPos: g.weapons.root.position.toArray().map(n=>+n.toFixed(2)),
  };
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
