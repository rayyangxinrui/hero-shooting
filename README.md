# Hero Shooting

A photorealistic first-person hero shooter in Three.js — gunplay plus magic.
Procedurally generated monsters, procedurally generated weapons, six spell
abilities, and a fully procedural desert arena. No modelling package was used:
every mesh, material and texture in the game is generated in code at load time.

## Running it

```bash
npm install
npm run dev      # http://127.0.0.1:5178
```

Build a static bundle:

```bash
npm run build    # -> dist/
npm run preview
```

Requires Node 20+. The only runtime dependencies are `three` and `lil-gui`.

## Controls

| | |
|---|---|
| WASD | move (Source-style acceleration — strafe-turning gains speed) |
| Shift / Ctrl / Space | sprint / crouch / jump |
| LMB / RMB | fire / aim down sights |
| R, 1-3 | reload, switch weapon |
| Q E R F V X | Frost Lance, Storm Lance, Cinder Fall, Nova Beam, Voltaic Snare, Glacial Crown |
| F2 / Esc | performance stats / release mouse |

## Layout

```
src/
  core/         renderer, app loop, shared frame uniforms, render layers
  fps/          player movement, collision, FPS camera, viewmodel lighting
  weapons/      procedural gun geometry + materials, hands, muzzle flash, shells
  combat/       hitscan, tracers, impact effects
  monsters/     procedural creature generator, skinning, gait/IK, skin shader
  abilities/    the six spells
  materials/    custom GLSL for ice, lightning, fire, beams, glacier
  particles/    GPU particle engine
  world/        arena generation, surface materials, sky bake, environment
  postprocessing/  bloom, grade, distortion
  ui/           HUD
  config/       settings.js — every tunable value in the game
tools/          screenshot harness, blind A/B compositor, diagnostics
```

`src/config/settings.js` is the single source of truth. Systems only ever
*sample* it, never snapshot it, so changing a value reshapes an effect that is
already on screen.

## Tools

```bash
node tools/check.mjs                       # parse-check every source file
node tools/capture.mjs --shot hipfire      # deterministic screenshot
node tools/capture.mjs --list              # all available shots
node tools/blind.mjs --shot horde --real <ref.jpg> --out <out.png>
```

Captures are deterministic: the harness seeds `Math.random` and steps the
simulation at a fixed timestep, so two captures of an unchanged shot are
byte-identical. That makes a numeric frame diff a reliable way to prove a change
actually took effect.

## Two things that will bite you

**Never put a backtick inside a GLSL template literal.** Shader source lives in
`` /* glsl */ `...` `` strings, so a Markdown-style code quote in a shader
comment terminates the string and the build dies with an opaque
`Unexpected identifier` naming no file. Use 'single quotes'. Run
`node tools/check.mjs` before anything else when the page won't boot.

**Pass a cache key when patching a material.** three.js keys its program cache on
`onBeforeCompile.toString()`, and `patchOnBeforeCompile` wraps every material in
an identically-named closure — so without an explicit key every patched material
in the project collapses onto one compiled shader.

## Credits

The ability system, GPU particle engine and several spell materials are built on
top of [LinearAbilityCastingThreeJS](https://github.com/robonuggets/gauntlet-loop).
Reference screenshots used during development (CS2, Call of Duty, Overwatch 2,
Valorant, FFXIV) are the property of their respective publishers and are not
included in this archive.
