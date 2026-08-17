import { MeshStandardMaterial, Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The creature skin.
 *
 * A patched `MeshStandardMaterial` rather than a raw `ShaderMaterial`, because a
 * monster has to sit in the same PBR lighting as the crates it is standing
 * between — a hand-rolled shader would need the whole shadow, IBL and fog stack
 * re-derived to match, and would still drift.
 *
 * ## Where the material comes from
 *
 * The generator writes `aSkin = (plate, class, ao)` on every vertex:
 *  - `plate` — how armoured this patch of body is, *placed* by anatomy (skull,
 *    spine, pauldrons, forearms, shins), not sampled from noise. Noise only
 *    breaks up the boundary. This is the difference between armour that looks
 *    bolted onto a creature and armour that looks grown out of one.
 *  - `class` — a discrete surface: flesh, keratin, eye, maw. Four genuinely
 *    different materials in one draw call.
 *  - `ao` — baked cavity darkening, so the underside of a body and the root of
 *    every claw read dark before a single light is evaluated.
 *
 * ## What the patch adds on top of standard PBR
 *  - **chitin vs flesh** — colour, roughness *and* a procedural normal all
 *    switch together at the plate boundary, which is what makes it read as a
 *    material change rather than as a paint change
 *  - **bevelled plate seams** — a ridged field pinched to thin lines, darkened
 *    in the groove and paled on the lip, so the armour has edges
 *  - **flesh** — pore-scale mottling, deep-red subdermal veining that only
 *    shows through where the skin is thin, and grime in the creases
 *  - **wetness** — roughness pulled down in the seams and around the maw, which
 *    is what stops a creature reading as dry clay
 *  - **subsurface** — a grazing-angle term standing in for light bleeding
 *    through thin tissue, killed on armour
 *  - **eyes** — an unlit emissive with a hot core, a dark limbal ring and a
 *    slit pupil that closes as you look at it head-on
 *  - **hit flash / death burn** — a whole-body punch on the frame it is shot,
 *    and a cooling ember glow through the plate seams as a corpse sinks
 *
 * Everything is sampled in *local* space so the pattern is welded to the body
 * and does not swim as the creature walks.
 */
export class MonsterMaterial {
  constructor(seed = 0, tint = 0) {
    const cfg = settings.monsters;

    this.uniforms = {
      uTime: frame.uTime,
      uSeed: { value: (seed % 997) * 0.037 },
      uFleshA: { value: new Color() },
      uFleshB: { value: new Color() },
      uFleshDeep: { value: new Color() },
      uPlate: { value: new Color() },
      uPlateEdge: { value: new Color() },
      uKeratin: { value: new Color() },
      uMaw: { value: new Color() },
      uEye: { value: new Color() },
      uEyeGlow: { value: cfg.eyeGlow },
      uSubsurface: { value: cfg.subsurface },
      uWetness: { value: cfg.wetness },
      uPlateScale: { value: 3.1 },
      uRoughFlesh: { value: cfg.roughnessFlesh },
      uRoughPlate: { value: cfg.roughnessPlate },
      uHitFlash: { value: 0 },
      uBurn: { value: 0 },
      /** Per-species hue push, so a horde is not eight copies of one palette. */
      uTint: { value: tint }
    };

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: cfg.roughnessFlesh,
      metalness: 0.0,
      /**
       * Low on purpose. The arena probe is a bright desert sky, and a creature
       * is not a chrome ball: at 0.6 the environment alone lifted the whole
       * body toward the value of the wall behind it and dissolved the
       * silhouette. Organic material takes a *little* sky in the shadows and
       * nothing like a mirror.
       */
      envMapIntensity: 0.22
    });

    // One shader body across every species — they differ only by uniforms, so
    // a shared key lets them share a single compiled program. Without an
    // explicit key they would each get a unique one and recompile per species.
    patchOnBeforeCompile(
      this.material,
      (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aSkin;
           varying vec3 vBodyLocal;
           varying vec3 vSkin;
           varying vec3 vNormalBind;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // Sampled *before* skinning: the pattern is welded to the body and
           // does not swim across the surface as the creature walks.
           vBodyLocal = position;
           vSkin = aSkin;
           // The rest-pose normal, for anatomy-locked effects like
           // countershading. The shaded normal is post-skinning and post-view,
           // so 'up' in that space is wherever the creature happens to be
           // looking; this one still means up along the animal.
           vNormalBind = normal;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uSeed;
           uniform float uTime;
           uniform vec3  uFleshA;
           uniform vec3  uFleshB;
           uniform vec3  uFleshDeep;
           uniform vec3  uPlate;
           uniform vec3  uPlateEdge;
           uniform vec3  uKeratin;
           uniform vec3  uMaw;
           uniform vec3  uEye;
           uniform float uEyeGlow;
           uniform float uSubsurface;
           uniform float uWetness;
           uniform float uPlateScale;
           uniform float uRoughFlesh;
           uniform float uRoughPlate;
           uniform float uHitFlash;
           uniform float uBurn;
           uniform float uTint;
           varying vec3  vBodyLocal;
           varying vec3  vSkin;
           varying vec3  vNormalBind;

           ${noiseGLSL}

           // Values shared between the colour, roughness and normal blocks.
           // Declared at file scope in the fragment stage: GLSL ES 1.00 has no
           // way to hand locals between the chunks three.js injects, and the
           // blocks below run in a fixed order inside one main().
           float gPlate;
           float gSeam;
           float gWet;
           vec3  gAlbedo;
           float gEye;
           float gKeratin;
           float gMaw;
           vec3  gDetailN;`
        )
        // Base colour, before lighting. Roughness and the detail normal are
        // resolved here too, because the chunks that consume them run later.
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             vec3 bp = vBodyLocal * uPlateScale + uSeed * 17.0;

             // Class masks. These are discrete tags (0..3) written per vertex,
             // so they compare directly — running the 0-or-1 result through a
             // smoothstep(0.5, 1.5) would clamp every 'yes' to 0.5 and leave
             // claws permanently half-flesh.
             gKeratin = abs(vSkin.y - 1.0) < 0.5 ? 1.0 : 0.0;
             gEye     = abs(vSkin.y - 2.0) < 0.5 ? 1.0 : 0.0;
             gMaw     = abs(vSkin.y - 3.0) < 0.5 ? 1.0 : 0.0;
             float ao = vSkin.z;

             // --- where the armour is -------------------------------------
             // Placed by the generator, then dithered at the boundary so the
             // edge is ragged like keratin and not like a decal.
             // A tighter window than the placement itself: armour has an edge
             // where it stops. Widening the ramp blends chitin into flesh over
             // a hand's width and costs the plates their shape at range, which
             // is the difference between armour and a paint job.
             float placed = vSkin.x;
             float breakup = fbm3(bp * 1.6) * 0.5 + 0.5;
             gPlate = smoothstep(0.40, 0.56, placed * 0.86 + breakup * 0.26);

             // --- plate seams ---------------------------------------------
             // Ridged noise pinched into thin lines: the groove between plates.
             //
             // The thresholds here are solved against the actual distribution
             // of 'ridged()', which is not uniform: it lands ~0.55-0.88 for
             // almost the whole surface and effectively never reaches 1.0. A
             // window of (0.78, 1.02) therefore covered 0.3% of the body — the
             // grooves were invisible. (0.74, 0.90) puts them at ~12%, which
             // is a seam every few centimetres rather than one per limb.
             float ridge = ridged(bp * 1.35 + 21.0, 3);
             float seam  = smoothstep(0.74, 0.90, ridge);
             // A second, finer set for the pebbling inside each plate.
             float pebble = ridged(bp * 5.5 + 61.0, 3);
             gSeam = seam;

             // --- flesh -----------------------------------------------------
             float mottle = fbm3(vBodyLocal * 5.5 - uSeed * 2.0) * 0.5 + 0.5;
             float pores  = fbm4(vBodyLocal * 26.0 + uSeed * 3.0) * 0.5 + 0.5;
             // Deep veining: low-frequency ridged lines under the skin.
             float veins  = smoothstep(0.72, 0.98, ridged(vBodyLocal * 7.0 + 5.0, 3));

             vec3 flesh = mix(uFleshB, uFleshA, clamp(mottle * 1.15 - 0.12, 0.0, 1.0));
             flesh = mix(flesh, uFleshDeep, veins * 0.55);
             // Grime gathers in the creases and pores.
             flesh *= 0.74 + 0.4 * pores;

             // --- chitin ----------------------------------------------------
             // Tone varies, but narrowly. At 0.62..1.35 the bright end of the
             // range came out as bleached grey slabs across the thighs and
             // forearms — the creature looked like it had bare bone showing
             // through. Armour is one material: it should vary the way a slab
             // of horn varies, not the way camouflage does.
             float plateTone = fbm3(vBodyLocal * 2.2 + 47.0) * 0.5 + 0.5;
             vec3 plate = mix(uPlate * 0.80, uPlate * 1.16, plateTone);
             plate *= 0.90 + 0.16 * smoothstep(0.35, 0.9, pebble);
             // The seam is a dark groove; its shoulders catch the light.
             //
             // This was the single biggest reason the creature read as a
             // bone-white blob. 'smoothstep(0.62, 0.8, ridge)' is above 0.5 for
             // over half of the body, so subtracting the (then near-zero) seam
             // left a lip that painted the pale bevel colour across ~51% of the
             // armour. A bevel is the *edge* of a plate: it has to be a thin
             // band hugging the groove, not a fill. Multiplying by (1 - seam)
             // keeps it strictly outside the groove it belongs to, and the
             // narrower window holds it near 10% coverage.
             float lip = smoothstep(0.78, 0.86, ridge) * (1.0 - seam);
             plate = mix(plate, uPlateEdge, lip * 0.55);
             // The groove itself goes properly dark — this is the contrast that
             // makes armour read as panelled rather than as one poured shell.
             plate *= 1.0 - seam * 0.72;

             vec3 skin = mix(flesh, plate, gPlate);

             // --- discrete surfaces -----------------------------------------
             // Keratin: claws, horns, teeth. Pale at the tip, stained at the
             // root — the generator bakes that gradient into aSkin.z.
             vec3 keratin = mix(uKeratin * 0.35, uKeratin, ao);
             keratin *= 0.9 + 0.2 * fbm3(vBodyLocal * 30.0);
             skin = mix(skin, keratin, gKeratin);

             // Maw: wet, dark, and almost unlit — a mouth is a hole.
             skin = mix(skin, uMaw, gMaw);

             // Per-species hue push, so eight species are not one palette.
             skin = mix(skin, skin.bgr, uTint * 0.35);
             skin *= mix(1.0, 0.55 + 0.45 * ao, 0.9);

             // --- countershading --------------------------------------------
             // Every real animal is darker on top than underneath, and a
             // predator design exaggerates it: the back takes the key and the
             // belly, the inner thigh and the underside of the jaw fall away
             // into near-black. This is what stops a creature reading as an
             // evenly-lit cutout, and it is doing more work for the silhouette
             // than any amount of surface detail. Driven off the *bind-pose*
             // normal, so it stays welded to the anatomy as the body animates.
             // Note the ceiling is 1.0, not above it: this term is only allowed
             // to take light *away*. Letting it brighten pushed the tops of the
             // shins and forearms — which face up along a digitigrade leg — to
             // a pale grey that read as bare bone at range.
             float up = normalize(vNormalBind).y;
             skin *= mix(0.40, 1.0, smoothstep(-0.85, 0.55, up));

             // Grime settles downward — the lower body of something that lives
             // on a floor is filthier than its shoulders.
             float low = smoothstep(0.55, -0.2, vBodyLocal.y * 1.6);
             skin *= mix(1.0, 0.74, low * 0.8);

             // Eyes replace everything.
             skin = mix(skin, uEye * 0.16, gEye);

             gAlbedo = skin;
             diffuseColor.rgb *= skin;

             // --- detail normal ---------------------------------------------
             // Gradient of the same fields that drive the colour, so the bumps
             // land exactly where the pattern does. Cheap 3-tap.
             float e = 0.035;
             float n0 = ridged(bp * 1.35 + 21.0, 3);
             float nx = ridged((bp + vec3(e, 0.0, 0.0)) * 1.35 + 21.0, 3);
             float ny = ridged((bp + vec3(0.0, e, 0.0)) * 1.35 + 21.0, 3);
             float nz = ridged((bp + vec3(0.0, 0.0, e)) * 1.35 + 21.0, 3);
             vec3 seamGrad = vec3(nx - n0, ny - n0, nz - n0) / e;

             float f0 = fbm4(vBodyLocal * 22.0);
             float fx = fbm4((vBodyLocal + vec3(e, 0.0, 0.0)) * 22.0);
             float fy = fbm4((vBodyLocal + vec3(0.0, e, 0.0)) * 22.0);
             float fz = fbm4((vBodyLocal + vec3(0.0, 0.0, e)) * 22.0);
             vec3 skinGrad = vec3(fx - f0, fy - f0, fz - f0) / e;

             // Armour takes the hard seam relief, flesh takes the soft pebbling.
             gDetailN = seamGrad * (0.028 * gPlate) + skinGrad * (0.006 * (1.0 - gPlate));
             gDetailN *= (1.0 - gEye) * (1.0 - gMaw);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             roughnessFactor = mix(uRoughFlesh, uRoughPlate, gPlate);
             // The seams hold moisture; so does the mouth.
             //
             // The floor here matters more than it looks. Driving roughness to
             // 0.12 makes a near-mirror, and under a 4.6-intensity sun that
             // turned every seam ridge on the thighs and forearms into a blown
             // white highlight — bright enough to read as bare bone at range
             // and to punch holes in the silhouette. 0.30 still reads visibly
             // damp against the 0.55 plate around it without clipping.
             float wet = gSeam * uWetness * (0.3 + 0.7 * gPlate);
             roughnessFactor = mix(roughnessFactor, 0.30, clamp(wet, 0.0, 1.0));
             // The mouth is the one genuinely wet thing, and it is in shadow.
             roughnessFactor = mix(roughnessFactor, 0.14, gMaw * 0.85);
             roughnessFactor = mix(roughnessFactor, 0.42, gKeratin);
             roughnessFactor = mix(roughnessFactor, 0.06, gEye);
             gWet = wet;
             roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);
           }`
        )
        // Perturb the shading normal once the geometric one exists.
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           {
             // Project the gradient into the tangent plane so the bump does not
             // shorten the normal or tilt it through the surface.
             vec3 g = gDetailN - normal * dot(gDetailN, normal);
             normal = normalize(normal - g);
           }`
        )
        // Additive terms that are not part of the BRDF.
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             vec3  N   = normalize(normal);
             vec3  V   = normalize(vViewPosition);
             float ndv = clamp(dot(N, V), 0.0, 1.0);

             // Thin tissue lit from behind: strongest at grazing angles, and
             // only where the armour is not.
             float sss = pow(1.0 - ndv, 2.8) * uSubsurface * (1.0 - gPlate) * (1.0 - gEye);
             totalEmissiveRadiance += mix(uFleshDeep, uFleshA, 0.35) * sss * 0.7;

             // --- silhouette rim ----------------------------------------------
             // A hot, narrow wrap around the outline of the body.
             //
             // This exists to make the read *exposure-independent*. Separating
             // a creature from its background by albedo alone only works at one
             // exposure: the arena is being regraded from a near-blown 180 wall
             // toward something far darker, and a body tuned to be the dark
             // shape against a bright wall becomes a black shape against a dark
             // one — same value, no edge, silhouette gone. An additive rim is
             // not scaled by the key, so it survives the regrade and keeps the
             // outline legible in both directions. It is the same trick the
             // reference shooters use to keep a character readable against
             // arbitrary level geometry.
             //
             // Very narrow, and very dim, for a non-obvious reason: the body
             // albedo is now ~0.013 linear, so an additive term that looks
             // conservative in isolation swamps it. At pow 3.4 and 0.85 this
             // added ~120% of the surface value at 70 deg off-normal and turned
             // the whole torso into a pale lavender slab — measured, then fixed.
             // pow 6.0 confines it to the last few degrees of grazing angle,
             // where it is an edge rather than a wash.
             float rim = pow(1.0 - ndv, 6.0);
             // Kill it on the eyes and inside the mouth, which have their own
             // light, and ease it off the armour so chitin stays matte.
             rim *= (1.0 - gEye) * (1.0 - gMaw) * (0.55 + 0.45 * (1.0 - gPlate));
             // Warm on flesh, cooler on plate — the same edge light reported by
             // two different materials.
             vec3 rimTint = mix(vec3(0.42, 0.19, 0.15), vec3(0.26, 0.29, 0.38), gPlate);
             totalEmissiveRadiance += rimTint * rim * 0.22;

             // --- the eye ---------------------------------------------------
             if (gEye > 0.5) {
               // A vertical slit that narrows as it faces you: the pupil is the
               // only part of a creature that can look back.
               vec3 local = normalize(vBodyLocal - vec3(0.0, 0.0, 0.0));
               float slit = smoothstep(0.30, 0.02, abs(local.x) * 0.55 + 0.06);
               float iris = pow(ndv, 1.6);
               vec3 core = uEye * (0.55 + 2.2 * iris);
               core = mix(core, uEye * 0.06, slit * iris);
               // A dark limbal ring stops the eye reading as a light bulb.
               core *= smoothstep(0.02, 0.42, ndv);
               totalEmissiveRadiance += core * uEyeGlow;
             }

             // Bioluminescence bleeding out of the seams — faint, and only on
             // armour, so it reads as heat under the shell.
             float vent = gSeam * gPlate * (0.35 + 0.65 * uBurn);
             totalEmissiveRadiance += uEye * vent * 0.16 * uEyeGlow * 0.3;

             // Death burn: the corpse cools through its own cracks.
             totalEmissiveRadiance += vec3(1.0, 0.28, 0.06) * uBurn * gSeam * 1.4;

             // Getting shot.
             totalEmissiveRadiance += vec3(1.0, 0.34, 0.2) * uHitFlash * 1.5;
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.25, 0.2), uHitFlash * 0.35);
           }`
        );
      },
      'monster-skin'
    );
  }

  setHitFlash(value) {
    this.uniforms.uHitFlash.value = value;
  }

  setBurn(value) {
    this.uniforms.uBurn.value = value;
  }

  /** Re-read the tunable colours. Cheap enough to call per frame. */
  sync() {
    const cfg = settings.monsters;
    const u = this.uniforms;
    u.uFleshA.value.copy(getColor(cfg.colorFleshA));
    u.uFleshB.value.copy(getColor(cfg.colorFleshB));
    u.uFleshDeep.value.copy(getColor(cfg.colorFleshDeep ?? cfg.colorBlood));
    u.uPlate.value.copy(getColor(cfg.colorPlate));
    u.uPlateEdge.value.copy(getColor(cfg.colorPlateEdge));
    u.uKeratin.value.copy(getColor(cfg.colorKeratin ?? '#b8ae9a'));
    u.uMaw.value.copy(getColor(cfg.colorMaw ?? '#1a0708'));
    u.uEye.value.copy(getColor(cfg.colorEye));
    u.uEyeGlow.value = cfg.eyeGlow;
    u.uSubsurface.value = cfg.subsurface;
    u.uWetness.value = cfg.wetness;
    u.uRoughFlesh.value = cfg.roughnessFlesh;
    u.uRoughPlate.value = cfg.roughnessPlate;
  }

  dispose() {
    this.material.dispose();
  }
}
