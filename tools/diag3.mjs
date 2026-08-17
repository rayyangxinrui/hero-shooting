import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 60000 });
const d = await page.evaluate(() => {
  const g = window.game;
  const gl = g.renderer.gl;
  const out = {};
  out.camMask = g.camera.layers.mask;
  out.viewCamMask = g.fps.viewCamera.layers.mask;
  out.camNearFar = [g.camera.near, g.camera.far];
  out.camFov = g.camera.fov;
  out.camPos = g.camera.position.toArray().map(n=>+n.toFixed(2));
  out.camRot = g.camera.rotation.toArray().slice(0,3).map(n=>+n.toFixed(3));

  // Render the raw scene straight to the canvas, bypassing the composer.
  gl.setRenderTarget(null);
  gl.info.reset();
  gl.render(g.scene, g.camera);
  out.directRender = { calls: gl.info.render.calls, tris: gl.info.render.triangles };

  // Now via the composer.
  gl.info.reset();
  g.post.render();
  out.composerRender = { calls: gl.info.render.calls, tris: gl.info.render.triangles };

  // Pixel probe: read the centre of the canvas after a direct render.
  gl.setRenderTarget(null);
  gl.render(g.scene, g.camera);
  const c = gl.domElement;
  out.canvasSize = [c.width, c.height];
  return out;
});
console.log(JSON.stringify(d, null, 2));
// screenshot right after the direct render
await page.evaluate(() => { const g=window.game; g.stop(); g.renderer.gl.setRenderTarget(null); g.renderer.gl.render(g.scene, g.camera); document.getElementById('hud').style.display='none'; document.getElementById('lockPrompt').style.display='none'; document.getElementById('loading').style.display='none'; });
await page.screenshot({ path: 'reference/ours/_diag_direct.png' });
console.log('wrote reference/ours/_diag_direct.png');
await browser.close();
