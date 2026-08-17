#!/usr/bin/env node
/**
 * Viewmodel diagnostic.
 *
 * Reports, for each weapon, where the model actually sits in *view space* and
 * where its parts land in *screen space* — which is the only way to tell
 * whether an ADS sight picture is aligned or merely close.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, {
  timeout: 60000
});

const mode = process.argv[2] ?? 'hip';

const out = await page.evaluate(async (mode) => {
  const g = window.game;
  const THREE = g.THREE ?? null;
  g.stop();

  const lightsSeen = [];
  g.scene.traverse((o) => {
    if (o.isLight) lightsSeen.push({ type: o.type, mask: o.layers.mask, intensity: o.intensity });
  });

  const report = { mode, lights: lightsSeen, weapons: {} };
  report.viewCamMask = g.fps.viewCamera.layers.mask;
  report.worldCamMask = g.camera.layers.mask;
  report.viewFov = g.fps.viewCamera.fov;
  report.sceneEnvIntensity = g.scene.environmentIntensity;

  for (const id of ['rifle', 'smg', 'pistol']) {
    g.weapons.select(id, true);
    g.weapons.aimProgress = mode === 'ads' ? 1 : 0;
    g.weapons.setAiming(mode === 'ads');
    g.player.euler.set(0, 0, 0);
    g.player.teleport(0, 1.72, 6);
    g.fps.update(g.player, 0);
    g.weapons._updateViewmodel(0.016, g.player);
    g.weapons.root.updateMatrixWorld(true);
    g.fps.viewCamera.updateMatrixWorld(true);

    const entry = g.weapons.built.get(id);
    const cam = g.fps.viewCamera;

    // Every mesh, in view space and in NDC.
    const parts = [];
    const V = g.weapons.root.position.constructor; // Vector3
    const min = new V(1e9, 1e9, 1e9);
    const max = new V(-1e9, -1e9, -1e9);
    entry.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const corners = [];
      for (let i = 0; i < 8; i++) {
        const c = new V(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        );
        o.localToWorld(c);
        cam.worldToLocal(c);
        corners.push(c);
        min.min(c);
        max.max(c);
      }
      // NDC of the mesh centre
      const centre = new V();
      bb.getCenter(centre);
      o.localToWorld(centre);
      const view = centre.clone();
      cam.worldToLocal(view);
      const ndc = centre.clone().project(cam);
      parts.push({
        name: o.name || 'mesh',
        view: view.toArray().map((n) => +n.toFixed(4)),
        px: [Math.round((ndc.x * 0.5 + 0.5) * 1920), Math.round((-ndc.y * 0.5 + 0.5) * 1080)],
        size: [
          +(bb.max.x - bb.min.x).toFixed(3),
          +(bb.max.y - bb.min.y).toFixed(3),
          +(bb.max.z - bb.min.z).toFixed(3)
        ]
      });
    });

    // Named helper points
    const named = {};
    entry.group.traverse((o) => {
      if (o.name) {
        const w = o.getWorldPosition(new V());
        const v = w.clone();
        cam.worldToLocal(v);
        const ndc = w.clone().project(cam);
        named[o.name] = {
          local: o.position.toArray().map((n) => +n.toFixed(4)),
          view: v.toArray().map((n) => +n.toFixed(4)),
          px: [Math.round((ndc.x * 0.5 + 0.5) * 1920), Math.round((-ndc.y * 0.5 + 0.5) * 1080)]
        };
      }
    });

    report.weapons[id] = {
      rootPos: g.weapons.root.position.toArray().map((n) => +n.toFixed(4)),
      viewSpaceBounds: {
        min: min.toArray().map((n) => +n.toFixed(4)),
        max: max.toArray().map((n) => +n.toFixed(4))
      },
      named,
      parts: parts.slice(0, 40)
    };
  }
  return report;
}, mode);

console.log(JSON.stringify(out, null, 2));
await browser.close();
