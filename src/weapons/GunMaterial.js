import { MeshStandardMaterial, Color } from 'three';
import { frame } from '../core/FrameUniforms.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * Gun metal, polymer and wood.
 *
 * ## Why a patched standard material rather than four flat ones
 *
 * A firearm viewmodel is the single most-looked-at object in a shooter, and the
 * thing that separates a real one from a grey box is not its silhouette — it is
 * that *every surface tells you how it was made*. Bluing is not a colour, it is
 * a finish over machining marks. A polymer grip is not matte, it is stippled.
 * Wood is not brown, it is grain under varnish.
 *
 * Flat PBR constants cannot express any of that, and the result reads as a
 * plastic toy no matter how the roughness is tuned. So each surface gets a
 * procedural break-up in *local* space — welded to the part, so it does not swim
 * as the gun recoils — driving albedo, roughness and a detail normal together.
 * Changing all three at once is what makes it read as a material rather than as
 * a painted-on pattern.
 *
 * ## The four surfaces
 *
 *  - **STEEL** — bluing. Fine circumferential machining marks, a slight warm
 *    tint in the polish, and wear that *brightens* toward bare metal on the
 *    edges the shader detects as exposed.
 *  - **PARKERISED** — the matte phosphate finish on a receiver. Coarser, more
 *    diffuse, much rougher, and it does not take a mirror highlight.
 *  - **POLYMER** — stippled grip plastic. Pebble noise in the roughness only:
 *    the albedo stays nearly flat, because plastic pigment is uniform and it is
 *    the *surface* that varies. Getting that backwards is what makes game
 *    plastic look like painted stone.
 *  - **WOOD** — ring grain stretched hard along the part's long axis, with a
 *    varnish lobe over the top: a clearcoat is smooth even where the wood under
 *    it is not, so roughness stays low while the albedo does all the work.
 *
 * ## Edge wear
 *
 * Real wear happens where a gun is handled and where it knocks against things —
 * which is to say, on convex edges. 'aEdge' is written by the geometry builder
 * (1 on a chamfer, 0 on a flat face), so wear can be placed *geometrically*
 * rather than by noise. That is the difference between scuffs that follow the
 * shape of the weapon and scuffs sprayed randomly over it.
 */

export const SURFACE = {
  STEEL: 0,
  PARKERISED: 1,
  POLYMER: 2,
  WOOD: 3
};

export class GunMaterial {
  /**
   * @param {number} surface  one of SURFACE
   * @param {object} [options]
   */
  constructor(surface, options = {}) {
    this.surface = surface;

    const presets = {
      [SURFACE.STEEL]: {
        // ## Why metalness is 0.82 and not 1.0
        //
        // At metalness 1 a surface has *no* diffuse term: every photon it shows
        // is a reflection of the environment. Under this project's blue-hour
        // sky that turns gun steel into a mirror of the sky — the albedo below
        // is multiplied by nothing and the part renders as a blue oil slick,
        // which is exactly what it was doing.
        //
        // Real bluing is a black oxide *conversion* layer, not a polished
        // mirror: it scatters enough to keep a diffuse component. Dropping
        // metalness to 0.82 and holding env down restores that, and the colour
        // below starts mattering again. Roughness up for the same reason —
        // a 0.29 gun is a chrome show gun, not a service weapon.
        color: '#5f636a',
        roughness: 0.42,
        metalness: 0.82,
        env: 0.62,
        wear: 0.5
      },
      [SURFACE.PARKERISED]: {
        // Phosphate is a matte, grey, near-dielectric crystal coat. It is the
        // single most common finish on a service rifle receiver, and it should
        // never take a mirror highlight.
        color: '#55585d',
        roughness: 0.72,
        metalness: 0.55,
        env: 0.4,
        wear: 0.3
      },
      [SURFACE.POLYMER]: {
        color: '#3f4348',
        roughness: 0.8,
        metalness: 0.02,
        env: 0.32,
        wear: 0.1
      },
      [SURFACE.WOOD]: {
        // ## Walnut, not terracotta
        //
        // ## Set from a measurement, not from memory
        //
        // Sampling the handguard of a real CS2 frame gives roughly #4f3a28 at
        // saturation 0.49, and its AK marketing shot runs as high as 0.71.
        // Earlier passes here chased "desaturated walnut" from memory down to
        // saturation 0.18, which rendered as grey driftwood — the opposite
        // error to the terracotta it was correcting. Laminated AK furniture is
        // genuinely a warm orange-brown; it only looks restrained next to the
        // orange *scene* it usually sits in.
        // Value set from the same measurement as the hue. CS2's wood-toned
        // weapon pixels average RGB (127, 97, 79) at luma 101, and the whole
        // weapon region has a median of 82 — ours was rendering at 66 overall,
        // consistently darker than the ground behind it, which is what makes a
        // viewmodel read as pasted onto the frame rather than lit by it.
        // Raising the albedo is the right lever here rather than raising the
        // key again: the key is already at parity with the world sun, and
        // pushing it further would blow the steel before it fixed the wood.
        color: '#7a5330',
        roughness: 0.5,
        metalness: 0.0,
        env: 0.3,
        wear: 0.22
      }
    };

    const preset = { ...presets[surface], ...options };

    this.uniforms = {
      uTime: frame.uTime,
      uSurface: { value: surface },
      uBase: { value: new Color(preset.color) },
      uWear: { value: preset.wear },
      // Bare steel exposed by handling. Very slightly warm: a cold blue-grey
      // here compounds with the sky reflection and pushes the whole gun blue.
      uWearColor: { value: new Color(preset.wearColor ?? '#9a9791') },
      uGrainScale: { value: preset.grainScale ?? 1 },
      uSeed: { value: preset.seed ?? 0 }
    };

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: preset.roughness,
      metalness: preset.metalness,
      envMapIntensity: preset.env
    });

    // Keyed by surface: the four surfaces branch inside one shader body, so
    // they can and should share a single compiled program.
    patchOnBeforeCompile(
      this.material,
      (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aEdge;
           attribute float aOcclusion;
           varying vec3  vGunLocal;
           varying float vEdge;
           varying float vOcclusion;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vGunLocal = position;
           vEdge = aEdge;
           vOcclusion = aOcclusion;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uSurface;
           uniform vec3  uBase;
           uniform float uWear;
           uniform vec3  uWearColor;
           uniform float uGrainScale;
           uniform float uSeed;
           varying vec3  vGunLocal;
           varying float vEdge;
           varying float vOcclusion;

           ${noiseGLSL}

           // Shared between the colour, roughness and normal blocks. GLSL ES
           // 1.00 has no way to hand locals between the chunks three injects,
           // and they run in a fixed order inside one main().
           float gRough;
           float gWear;
           float gEdgeLift;
           vec3  gDetailN;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             vec3 p = vGunLocal * uGrainScale;
             vec3 albedo = uBase;
             float rough = 0.0;
             vec3 dn = vec3(0.0, 0.0, 1.0);

             // --- exposed edges -----------------------------------------
             // vEdge is 1 on a chamfer. Wear is placed by geometry, then
             // dithered by noise so it is not a uniform outline.
             float wearNoise = fbm3(p * 26.0 + uSeed) * 0.5 + 0.5;
             gWear = smoothstep(0.35, 0.95, vEdge * (0.55 + wearNoise * 0.75)) * uWear;

             if (uSurface < 0.5) {
               // ---- STEEL: bluing over machining marks ------------------
               // Fine parallel lines along the bore axis. Anisotropic on
               // purpose: a lathe leaves marks in one direction, and isotropic
               // noise here reads as sandblasting.
               float lathe = fbm3(vec3(p.x * 220.0, p.y * 220.0, p.z * 5.0)) * 0.5 + 0.5;
               float polish = fbm3(p * 7.0 + 13.0) * 0.5 + 0.5;
               albedo *= 0.9 + lathe * 0.14 + polish * 0.1;
               // Warm tint in the polish — bluing is not neutral.
               albedo *= vec3(1.02, 0.995, 0.975);
               rough = (lathe - 0.5) * 0.1 + (polish - 0.5) * 0.06;
               dn.xy += vec2(lathe - 0.5, polish - 0.5) * 0.55;
             } else if (uSurface < 1.5) {
               // ---- PARKERISED: matte phosphate ------------------------
               float grit = fbm4(p * 95.0 + 4.0) * 0.5 + 0.5;
               float blotch = fbm3(p * 12.0 + 31.0) * 0.5 + 0.5;
               albedo *= 0.88 + grit * 0.14 + blotch * 0.12;
               rough = (grit - 0.5) * 0.18;
               dn.xy += vec2(grit - 0.5, blotch - 0.5) * 0.9;
             } else if (uSurface < 2.5) {
               // ---- POLYMER: stippling ---------------------------------
               // Roughness carries almost all of it. Plastic pigment is
               // uniform; it is the surface that varies. Pushing the albedo
               // here is what makes game plastic look like painted stone.
               float pebble = ridged(p * 74.0 + 7.0, 2);
               float mould = fbm3(p * 9.0 + 19.0) * 0.5 + 0.5;
               albedo *= 0.96 + mould * 0.07;
               rough = (pebble - 0.5) * 0.3;
               dn.xy += vec2(pebble - 0.5) * 1.5;
             } else {
               // ---- WOOD: ring grain under varnish ---------------------
               //
               // Grain must run as *parallel lines along the length of the
               // part*. Sampling isotropic fbm and taking a sine of it gives
               // closed contour loops instead — swirls, knots, marble. That is
               // what made the handguard read as polished terracotta.
               //
               // So build the ring coordinate from the cross-section distance
               // only (a stack of nested cylinders about the long axis), and
               // let z contribute just a slow wander so the lines are not
               // mechanically straight. Slicing that field lengthwise is what
               // a sawn board is, and it yields stripes by construction.
               // ## Why this uses fract(), and why the frequency is so high
               //
               // Parts are merged into one geometry before upload, so 'position'
               // is already offset into the *weapon's* frame — a handguard's
               // vertices are not centred on zero, they sit wherever that part
               // was placed. 'length(vec2(x, y))' therefore measures distance
               // from the gun's long axis, not from the board's own centre.
               //
               // For a part sitting near the axis that distance barely varies:
               // measured across the whole handguard, 'across' swept a range of
               // about 2.5 radians, which is *one broad band* of sine. The wood
               // rendered as flat orange plastic with no grain at all — not
               // because the grain was subtle, but because there was under one
               // cycle of it across the part.
               //
               // Wrapping the cross-section into a repeating band with fract()
               // makes the pattern independent of where the part was placed,
               // and a high multiplier puts real cycles across a 5 cm board.
               // ## Grain runs across the board, not around an axis
               //
               // The previous form took length(vec2(x, y)) — distance from the
               // long axis — which models a dowel turned from the centre of a
               // log. Furniture is not that: it is a flat board sawn from one,
               // so its grain crosses the face as roughly parallel lines.
               //
               // That distinction was not cosmetic. Because parts are merged
               // into one geometry before upload, 'position' carries each
               // part's offset in the weapon's frame, so a radial coordinate
               // measured distance from the *gun's* axis. Evaluated across the
               // handguard it swept under one full cycle of sine — less than a
               // single grain line over the whole part — and it was symmetric
               // about x = 0, so both flanks drew the identical band. The wood
               // rendered as flat plastic.
               //
               // A plane sweep along one axis has neither problem: the sweep is
               // proportional to the distance travelled, so a 5 cm board gets
               // however many lines the frequency asks for, and there is no
               // mirror symmetry.
               float across = (p.y * 0.82 + p.x * 0.28) * 620.0;
               float wander = fbm3(vec3(p.x * 6.0, p.y * 6.0, p.z * 1.6) + 3.0) * 3.4;
               float rings  = across + wander;
               // Sharpen: latewood is a narrow dark band, earlywood a wide
               // pale one. A raw sine gives an even split and reads as fabric.
               float grain  = pow(sin(rings) * 0.5 + 0.5, 1.5);

               // Long, soft figure stretched hard along the part's length.
               float figure = fbm3(vec3(p.x * 7.0, p.y * 7.0, p.z * 1.1) + 41.0) * 0.5 + 0.5;

               // Dark latewood lines over a lighter body. Keep the swing
               // modest: high contrast here is what reads as plastic woodgrain.
               // Centred on 1.0 rather than biased upward — the old form only
               // ever brightened, which is half of why the stock came out the
               // colour of raw pine.
               // Contrast set from how the cycle actually distributes, not by
               // feel: at pow 2.2 and a 0.6 floor, 46% of every grain cycle sat
               // within 5% of undarkened and the darkest latewood line only
               // reached 0.68 — the lines were present in the maths and
               // invisible on screen. Real quartersawn walnut runs roughly 2:1
               // between earlywood and latewood.
               albedo *= 0.9 + figure * 0.2;
               albedo = mix(albedo, albedo * 0.44, grain);
               // Warm the pale earlywood slightly rather than tinting the
               // whole part orange.
               albedo *= mix(vec3(1.0), vec3(1.04, 0.99, 0.94), (1.0 - grain) * 0.5);

               // Varnish stays smooth even where the grain under it is not,
               // but the open pores of latewood do drink it in a little.
               rough = grain * 0.1;
               dn.xy += vec2(grain - 0.5) * 0.28;
             }

             // Bare metal on the worn edges: brighter, smoother, more metallic.
             //
             // ## Why this is pushed so hard
             //
             // Measured against a CS2 gameplay frame, the reference weapon's
             // luminance histogram is *bimodal*: about 30% of it sits dark
             // (32-79) and a further 25% sits bright (144-159), because every
             // rubbed edge and every upward-facing plane catches the key. Ours
             // was a single hump with 0.7% above 144 — no bright mode at all,
             // which is precisely what "reads flat in the midtones" means when
             // you measure it rather than squint at it.
             //
             // Wear is therefore allowed to go properly bright and properly
             // smooth. A worn edge on a real gun is bare polished steel, and
             // bare polished steel is one of the brightest things in frame.
             albedo = mix(albedo, uWearColor, gWear);
             rough -= gWear * 0.3;

             gRough = rough;
             gDetailN = normalize(dn);
             gEdgeLift = gWear;
             diffuseColor.rgb *= albedo;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(roughnessFactor + gRough, 0.035, 1.0);`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           {
             // ---- baked ambient occlusion ------------------------------
             //
             // The world gets screen-space occlusion; the viewmodel is drawn by
             // its own camera in its own pass and gets none at all. Without
             // this, every junction on the weapon — magazine into magwell,
             // handguard against receiver, grip under the trigger group — meets
             // at full brightness with no darkening in the crack, and the gun
             // reads as a stack of separate blocks rather than one assembly.
             //
             // Applied to the ambient and indirect terms only. Occlusion is a
             // statement about how much of the *sky* a point can see, so
             // dimming the key light with it would wrongly darken surfaces the
             // key strikes directly.
             float ao = clamp(vOcclusion, 0.0, 1.0);
             reflectedLight.indirectDiffuse *= ao;
             reflectedLight.indirectSpecular *= mix(1.0, ao, 0.7);
           }`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
             // ---- edge light -------------------------------------------
             //
             // A machined edge that has lost its bluing is bare steel, and bare
             // steel picks up light from directions the flat faces cannot —
             // it is curved, so *something* always reflects into the eye. A
             // punctual-light PBR model cannot express that with four lights,
             // so the chamfers stay as dark as the faces and the whole weapon
             // collapses into one mid-grey mass.
             //
             // This adds the missing term directly: a grazing-angle lift,
             // gated on the geometric edge attribute so it can only ever
             // appear on a chamfer, never on a flat panel. That gating is the
             // difference between an edge highlight and a cheap fresnel glow
             // over the whole model.
             float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.5);
             float lift = gEdgeLift * (0.25 + fres * 1.5);
             outgoingLight += uWearColor * lift * 0.5;
           }
           #include <opaque_fragment>`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           {
             // Perturb in tangent space built from screen-space derivatives —
             // the parts carry no UVs and do not need any for this.
             vec3 dpx = dFdx(-vViewPosition);
             vec3 dpy = dFdy(-vViewPosition);
             vec3 t = normalize(dpx);
             vec3 b = normalize(cross(normal, t));
             normal = normalize(normal + (t * gDetailN.x + b * gDetailN.y) * 0.34);
           }`
        );
      },
      'gun-surface'
    );
  }

  dispose() {
    this.material.dispose();
  }
}
