import { chromium } from 'playwright';

const el = process.argv[2] ?? 'glacier';
const DELAYS = { thunder:0.16, ice:0.42, meteor:0.95, beam:0.75, snare:0.5, glacier:0.6 };
const delay = Number(process.argv[3] ?? DELAYS[el]);

const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.game?.ready === true || window.__gameError, { timeout: 90000 });

await page.evaluate(() => {
  const g = window.game;
  g.stop();
  const FIXED = 1/120;
  window.__h = {
    tick(dt) {
      g.elapsed += dt; g.frameUniforms.uTime.value = g.elapsed; g.frameUniforms.uDelta.value = dt;
      g.player.update(dt, {forward:0,strafe:0,jump:false,crouch:false,sprint:false,walk:false,firing:false,aiming:false});
      g.fps.update(g.player, dt);
      g.environment.setFocus(g.player.position.x, g.player.position.z); g.environment.update();
      g.weapons.update(dt, {firing:false}, g.player);
      g.combat.update(dt); g.monsters.update(dt); g.abilities.update(dt);
      g.particles.flush(); g.decals.update(dt); g.fissures.update(dt);
      g.bursts.update(dt); g.lights.update(dt); g.flash.update(dt); g.shake.update(dt);
    },
    step(s) { const n = Math.max(1, Math.round(s/FIXED)); for (let i=0;i<n;i++) this.tick(FIXED); },
    place(x,z,yaw,pitch) {
      g.player.teleport(x,1.72,z); g.player.euler.y=yaw; g.player.euler.x=pitch;
      g.player.velocity.set(0,0,0); g.player.onGround=true;
      g.fps.update(g.player,0); g.camera.updateMatrixWorld(true); g.fps.viewCamera.updateMatrixWorld(true);
    },
    reset() {
      g.abilities.clear(); g.particles.reset(); g.decals.clear(); g.fissures.clear();
      g.bursts.clear(); g.lights.reset(); g.shake.reset(); g.flash.reset();
      for (const m of g.monsters.monsters.slice()) g.monsters.group.remove(m.mesh);
      g.monsters.monsters.length=0; g.monsters.spawnTimer=1e6;
      for (const k of g.cooldowns.keys()) g.cooldowns.set(k,0);
      document.getElementById('hud').style.display='none';
      document.getElementById('lockPrompt').style.display='none';
      document.getElementById('loading').style.display='none';
    },
    render(n=3){ for(let i=0;i<n;i++){ g.renderer.gl.shadowMap.needsUpdate=true; g.post.sync(g.elapsed,g.flash); g.post.render(); } },
    /** Read the canvas back through a 2D context and measure it. */
    measure() {
      const src = g.renderer.gl.domElement;
      let c = window.__mc;
      if (!c) { c = window.__mc = document.createElement('canvas'); c.width = 320; c.height = 180; }
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0, blown = 0, n = 0;
      let rs = 0, gs = 0, bs = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i+1], b = d[i+2];
        sum += 0.2126*r + 0.7152*gg + 0.0722*b;
        rs += r; gs += gg; bs += b;
        if (r > 246 && gg > 246 && b > 246) blown++;
        n++;
      }
      return { meanL: +(sum/n).toFixed(1), blownPct: +(100*blown/n).toFixed(2),
               tint: [Math.round(rs/n), Math.round(gs/n), Math.round(bs/n)] };
    }
  };
});

async function shot(name, mutate) {
  const r = await page.evaluate(({ el, delay, mutateSrc }) => {
    const g = window.game; const h = window.__h;
    h.reset(); h.place(0,14,0,-0.14);
    g.__restore?.forEach(f=>f()); g.__restore = [];
    if (mutateSrc) { const f = new Function('game','restore', mutateSrc); f(g, g.__restore); }
    g.cooldowns.set(el,0); g.abilities.cast(el); h.step(delay); h.render(3);
    return h.measure();
  }, { el, delay, mutateSrc: mutate ? mutate.toString().replace(/^[^{]*\{/, '').replace(/\}\s*$/, '') : null });
  return { name, ...r };
}

const rows = [];
rows.push(await shot('ALL', null));
rows.push(await shot('no-particles', (game, restore) => {
  for (const s of game.particles.systems.values()) { const m = s.mesh; const v = m.visible; m.visible = false; restore.push(()=>m.visible=v); }
}));
rows.push(await shot('no-bursts', (game, restore) => {
  const gr = game.bursts.group; const v = gr.visible; gr.visible = false; restore.push(()=>gr.visible=v);
}));
rows.push(await shot('no-decals', (game, restore) => {
  const gr = game.decals.group; const v = gr.visible; gr.visible = false; restore.push(()=>gr.visible=v);
}));
rows.push(await shot('no-fissures', (game, restore) => {
  const gr = game.fissures.group; const v = gr.visible; gr.visible = false; restore.push(()=>gr.visible=v);
}));
rows.push(await shot('no-ability-meshes', (game, restore) => {
  for (const a of game.abilities.active) { const gr = a.group; const v = gr.visible; gr.visible = false; restore.push(()=>gr.visible=v); }
}));
rows.push(await shot('no-flash', (game, restore) => {
  const t = game.flash.trigger; game.flash.trigger = () => {}; restore.push(()=>game.flash.trigger=t);
}));
rows.push(await shot('no-dynlights', (game, restore) => {
  for (const e of game.lights.lights) { const l = e.light; const v = l.visible; l.visible = false; restore.push(()=>l.visible=v); }
}));
rows.push(await shot('no-bloom', (game, restore) => {
  const s = game.settings.post.bloomStrength; game.settings.post.bloomStrength = 0; restore.push(()=>game.settings.post.bloomStrength=s);
}));
rows.push(await shot('EMPTY (no cast)', (game, restore) => {
  const c = game.abilities.cast; game.abilities.cast = () => null; restore.push(()=>game.abilities.cast=c);
}));

console.log(`\n=== ${el} @ ${delay}s — brightness attribution ===`);
const base = rows[0];
for (const r of rows) {
  const d = (r.meanL - base.meanL).toFixed(1);
  console.log(`${r.name.padEnd(20)} meanL=${String(r.meanL).padStart(6)}  blown=${String(r.blownPct).padStart(6)}%  tint=${JSON.stringify(r.tint).padEnd(18)} Δ=${d}`);
}
await browser.close();
