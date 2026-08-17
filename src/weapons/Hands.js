import {
  Group,
  Mesh,
  MeshStandardMaterial,
  Color,
  CatmullRomCurve3,
  Vector3,
  TubeGeometry,
  Float32BufferAttribute
} from 'three';
import { frame } from '../core/FrameUniforms.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * Gloved hands and forearms.
 *
 * ## Why this is not optional
 *
 * A first-person weapon with no hands on it is the single loudest tell that a
 * shooter is unfinished. Every reference frame in this project — CS2, CoD,
 * Valorant — has gloved fingers wrapped around the grip and a forearm running
 * out of the bottom of the screen. Without them the gun floats, and the eye has
 * nothing to attach it to.
 *
 * They also do real compositional work: the forearm is a large diagonal mass
 * that fills the bottom-right corner and *frames* the weapon, which is why the
 * reference frames read as balanced while a bare gun reads as an object pasted
 * onto a background.
 *
 * ## How they are built
 *
 * Swept tubes along Catmull-Rom curves rather than boxes: a limb is a tapering
 * cylinder that bends, which is exactly what a tube along a spline is, and it
 * costs one geometry per limb. Fingers are short tubes with two bends, wrapped
 * around the grip's radius.
 *
 * The material is a patched standard so the glove gets knuckle-scale wrinkling
 * and a fabric sheen at grazing angles, without which a glove reads as a rubber
 * glove — matte, uniform, and obviously not cloth.
 */

/** Build a tapering tube through a set of points. */
function limb(points, radii, radialSegments = 10, tubularSegments = 20) {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  const geometry = new TubeGeometry(curve, tubularSegments, 1, radialSegments, false);

  // TubeGeometry has a constant radius, so the taper is applied afterwards by
  // pushing each ring's vertices in along their own normal. The ring index is
  // recoverable from the vertex index because the tessellation is regular.
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const ringCount = tubularSegments + 1;
  const perRing = radialSegments + 1;

  for (let ring = 0; ring < ringCount; ring++) {
    const t = ring / (ringCount - 1);
    // Sample the radius profile: [t0, r0, t1, r1, ...]
    let radius = radii[1];
    for (let i = 0; i < radii.length - 2; i += 2) {
      const ta = radii[i];
      const ra = radii[i + 1];
      const tb = radii[i + 2];
      const rb = radii[i + 3];
      if (t >= ta && t <= tb) {
        const local = (t - ta) / Math.max(1e-6, tb - ta);
        radius = ra + (rb - ra) * local;
        break;
      }
      if (t > tb) radius = rb;
    }
    for (let i = 0; i < perRing; i++) {
      const index = ring * perRing + i;
      if (index >= position.count) break;
      const cx = position.getX(index) - normal.getX(index);
      const cy = position.getY(index) - normal.getY(index);
      const cz = position.getZ(index) - normal.getZ(index);
      position.setXYZ(
        index,
        cx + normal.getX(index) * radius,
        cy + normal.getY(index) * radius,
        cz + normal.getZ(index) * radius
      );
    }
  }
  position.needsUpdate = true;

  // ## Cap both ends
  //
  // 'TubeGeometry' is open. An uncapped limb shows the flat rim of its end
  // ring and, through the hole, the inside of its own far wall — which reads
  // as an amputated pipe rather than as an arm. Fingertips and wrists are
  // exactly where the eye looks, so this is not subtle: the hands looked
  // severed.
  //
  // Each cap is a triangle fan about the centre of the end ring. The ring's
  // own vertices are reused, so the cap is watertight by construction.
  const index = geometry.getIndex();
  const indices = Array.from(index.array);
  const positions = Array.from(position.array);
  const centreOf = (ring) => {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < radialSegments; i++) {
      const v = ring * perRing + i;
      cx += positions[v * 3];
      cy += positions[v * 3 + 1];
      cz += positions[v * 3 + 2];
    }
    return [cx / radialSegments, cy / radialSegments, cz / radialSegments];
  };

  for (const [ring, flip] of [[0, true], [ringCount - 1, false]]) {
    const centre = centreOf(ring);
    const centreIndex = positions.length / 3;
    positions.push(centre[0], centre[1], centre[2]);
    for (let i = 0; i < radialSegments; i++) {
      const a = ring * perRing + i;
      const b = ring * perRing + ((i + 1) % perRing);
      if (flip) indices.push(centreIndex, b, a);
      else indices.push(centreIndex, a, b);
    }
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Where a weapon is held.
 *
 * 'WeaponSystem' constructs 'Hands' with no arguments, so these defaults are
 * what a weapon gets unless the model factory has published better numbers.
 * The factory writes the anchors for the weapon it is currently building into
 * 'Hands.pendingAnchors' immediately before that construction happens, which is
 * how per-weapon grips reach here without changing the call site.
 */
const DEFAULT_ANCHORS = {
  grip: { y: -0.075, z: 0.072 },
  fore: { y: 0.014, z: -0.235 },
  gripWidth: 0.042
};

export class Hands {
  /**
   * @param {typeof DEFAULT_ANCHORS} [anchors]  where this weapon is gripped,
   *   in the weapon's own space. Supplied by the model factory, which is the
   *   only thing that knows where it put the grip.
   */
  constructor(anchors) {
    this.group = new Group();
    this._geometries = [];

    // Dark tactical fabric. The previous values sat around 18% grey, which
    // under this key light rendered as bare concrete — the forearms read as
    // pipes rather than as sleeves. Real black nomex/suede gloves photograph
    // *very* dark, around 4-8% reflectance, and get all of their form from
    // specular sheen rather than from albedo variation. So the base goes down
    // hard and the highlight stays close to it: a wide spread between base and
    // highlight is what makes cloth look like poured stone.
    this.uniforms = {
      uTime: frame.uTime,
      // Authored well above the near-black these were originally set to.
      //
      // A tactical glove *looks* almost black in memory, but that impression
      // comes from seeing it unlit or in shadow. Authoring that impression as
      // albedo makes it unlightable: measured against the weapon it holds, the
      // glove came out at luma 45 while the wood furniture read 93 and the
      // receiver 117 — nearly three times darker than the gun, so the hands
      // read as a hole rather than as hands. Real dark fabric sits around
      // 12-18% reflectance, not 5%.
      // Warm-neutral, not blue-grey.
      //
      // These were violet-leaning (#3a3841, R-B = -7). Under a warm desert key
      // that reads as pale lavender against the sand — the one colour in the
      // frame that belongs to no material in the scene, so the eye goes
      // straight to it. Real dark tactical fabric under warm light is
      // warm-neutral to slightly brown. Value is held around 12-15%
      // reflectance: dark enough to sit under the weapon it holds, light
      // enough to still be lit rather than reading as a hole.
      uGlove: { value: new Color('#332e2b') },
      uGloveHi: { value: new Color('#4a443f') },
      uSeam: { value: new Color('#1a1715') }
    };

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.0,
      // Held low deliberately: fabric does not reflect the sky, and env is what
      // was washing the glove out to concrete grey.
      envMapIntensity: 0.45
    });

    patchOnBeforeCompile(
      this.material,
      (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n varying vec3 vLocal;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n vLocal = position;`);

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uGlove;
           uniform vec3 uGloveHi;
           uniform vec3 uSeam;
           varying vec3 vLocal;
           ${noiseGLSL}
           float gRough;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             // Knuckle-scale creasing, plus a finer weave. Both in local space,
             // so the wrinkles stay welded to the glove as the hand moves.
             float crease = ridged(vLocal * 118.0, 3);
             float weave  = fbm4(vLocal * 190.0) * 0.5 + 0.5;
             float panel  = fbm3(vLocal * 15.0 + 7.0) * 0.5 + 0.5;

             // ## Why the crease term is confined so tightly
             //
             // 'ridged()' produces long connected filaments. Run at a low
             // frequency over a smooth tube and mixed in broadly, those
             // filaments read as *veins in marble* — which is exactly what the
             // forearm looked like: a pale polished stone pipe, not fabric.
             // Cloth creases are short, local to folds, and much darker than
             // the surrounding surface. So the crease is pushed to a high
             // threshold (only the sharpest ridges survive), driven at a higher
             // spatial frequency, and the broad panel lift is cut right back so
             // the base colour stays the base colour.
             vec3 albedo = mix(uGlove, uGloveHi, panel * 0.14 + weave * 0.1);
             albedo = mix(albedo, uSeam, smoothstep(0.84, 0.99, crease) * 0.55);

             // Cloth is rougher in the creases and slightly polished on the
             // raised weave — that contrast is what separates cloth from rubber.
             gRough = (weave - 0.5) * 0.16 + smoothstep(0.6, 1.0, crease) * 0.12;
             diffuseColor.rgb *= albedo;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(roughnessFactor + gRough, 0.2, 1.0);`
        );
      },
      'glove'
    );

    this._build({ ...DEFAULT_ANCHORS, ...(anchors ?? Hands.pendingAnchors ?? {}) });
    Hands.pendingAnchors = null;
  }

  _add(geometry, x = 0, y = 0, z = 0) {
    this._geometries.push(geometry);
    const mesh = new Mesh(geometry, this.material);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Both hands, posed for a rifle: the right on the grip with the index finger
   * on the trigger, the left forward under the handguard.
   *
   * Coordinates are the weapon's own frame, so the hands travel with the gun
   * through recoil and sway without any extra bookkeeping.
   */
  /**
   * @param {{grip:{y:number,z:number}, fore:{y:number,z:number}, gripWidth:number}} anchors
   *   Where this particular weapon is actually held, in the weapon's own space.
   *   Passing these in rather than hard-coding them is the whole point: a pistol
   *   grip, a rifle grip and an SMG handguard are in completely different
   *   places, and hands authored against one weapon's numbers pass straight
   *   through another's.
   */
  _build(anchors) {
    const grip = anchors.grip;
    const fore = anchors.fore;
    const halfWidth = anchors.gripWidth * 0.5;

    /* ================= right hand: on the pistol grip ================= */
    //
    // The palm sits on the *right* flank of the grip, the fingers wrap around
    // its front face toward −x, and the forearm leaves the wrist heading back
    // and down. Critically the forearm is routed *below* the stock line: a
    // forearm that runs back at receiver height goes straight through the
    // buttstock, which is what it was doing.
    const wristY = grip.y - 0.052;
    const wristZ = grip.z + 0.03;

    this._add(
      limb(
        [
          [halfWidth + 0.008, wristY, wristZ],
          [halfWidth + 0.02, wristY - 0.042, wristZ + 0.03],
          [halfWidth + 0.032, wristY - 0.07, wristZ + 0.05],
          [halfWidth + 0.062, wristY - 0.155, wristZ + 0.105],
          [halfWidth + 0.095, wristY - 0.26, wristZ + 0.165]
        ],
        [0, 0.022, 0.18, 0.017, 0.42, 0.027, 1, 0.035],
        10,
        14
      )
    );

    /* ---- the palm itself, hugging the grip's right flank ---- */
    //
    // The palm has to run all the way into the forearm's first control point.
    // Ending it short leaves a gap at the wrist, and the arm then reads as an
    // amputated tube with a separate blob floating near the grip. The last
    // section here is deliberately the same place and radius as the forearm's
    // first, so the two limbs share a joint.
    this._add(
      limb(
        [
          [halfWidth + 0.003, grip.y - 0.006, grip.z - 0.008],
          [halfWidth + 0.008, grip.y - 0.03, grip.z + 0.01],
          [halfWidth + 0.008, wristY, wristZ]
        ],
        [0, 0.024, 0.55, 0.027, 1, 0.024],
        10,
        10
      )
    );

    /* ---- three fingers wrapping the front of the grip ---- */
    //
    // The tips have to *emerge* on the far flank. Stopping level with the
    // grip's left face — as these did, by 0.4 mm — means the wrap is entirely
    // hidden behind the grip from the camera's side and the hand reads as a
    // stump resting against it rather than as fingers curled around it.
    for (let i = 0; i < 3; i++) {
      const y = grip.y - 0.024 - i * 0.021;
      const z = grip.z - 0.012 + i * 0.005;
      this._add(
        limb(
          [
            [halfWidth + 0.006, y, z + 0.018],
            [halfWidth - 0.004, y - 0.006, z - 0.004],
            [-0.006, y - 0.008, z - 0.013],
            [-halfWidth - 0.006, y - 0.005, z - 0.009],
            [-halfWidth - 0.013, y + 0.002, z - 0.002]
          ],
          [0, 0.0092, 1, 0.0072],
          8,
          10
        )
      );
    }

    /* ---- thumb, laid along the top of the grip toward the receiver ---- */
    this._add(
      limb(
        [
          [halfWidth + 0.004, grip.y - 0.004, grip.z + 0.01],
          [halfWidth - 0.006, grip.y + 0.012, grip.z - 0.016],
          [halfWidth - 0.014, grip.y + 0.018, grip.z - 0.04]
        ],
        [0, 0.0112, 1, 0.0088],
        8,
        8
      )
    );

    /* ---- index finger, reaching forward onto the trigger ---- */
    this._add(
      limb(
        [
          [halfWidth + 0.002, grip.y - 0.004, grip.z - 0.018],
          [halfWidth - 0.006, grip.y - 0.002, grip.z - 0.038],
          [halfWidth - 0.014, grip.y + 0.004, grip.z - 0.05]
        ],
        [0, 0.0092, 1, 0.0076],
        8,
        8
      )
    );

    /* ================= left hand: on the handguard ================= */
    //
    // Mirror logic: palm under the handguard's left flank, fingers over the
    // top of it, forearm leaving down and back toward the bottom-left corner
    // of the frame — which is the diagonal that frames the weapon.
    // The arm must leave the frame, not cross it. A forearm that runs back at
    // roughly the weapon's own x stays on screen as a bar lying under the
    // receiver — which is what it was doing, and it read as a black pipe laid
    // across the shot. A real support arm goes down and *well outboard*, out of
    // the bottom-left corner, and that departing diagonal is what frames the
    // weapon instead of competing with it.
    this._add(
      limb(
        [
          [-0.028, fore.y - 0.032, fore.z + 0.024],
          [-0.042, fore.y - 0.078, fore.z + 0.062],
          [-0.058, fore.y - 0.115, fore.z + 0.096],
          [-0.1, fore.y - 0.225, fore.z + 0.182],
          [-0.15, fore.y - 0.355, fore.z + 0.28]
        ],
        // The wrist pinch is the whole point of this profile. A limb swept at a
        // smoothly increasing radius reads as a cone or a pipe; an actual arm
        // narrows hard at the wrist and flares into the forearm, and that one
        // inflection is what makes it read as anatomy. The narrow point sits at
        // t=0.18, just past the glove cuff.
        [0, 0.021, 0.18, 0.0165, 0.42, 0.026, 1, 0.034],
        10,
        14
      )
    );

    /* ---- left palm, under the handguard, running into the forearm ---- */
    this._add(
      limb(
        [
          [-0.022, fore.y - 0.01, fore.z - 0.032],
          [-0.028, fore.y - 0.024, fore.z - 0.004],
          [-0.028, fore.y - 0.03, fore.z + 0.022]
        ],
        [0, 0.023, 0.55, 0.026, 1, 0.023],
        10,
        10
      )
    );

    /* ---- four fingers over the top of the handguard ---- */
    //
    // ## These must clear the wood, not tunnel through it
    //
    // A finger whose arc crowns *below* the handguard's top surface is still
    // drawn and still moves with the gun — it is simply inside it, invisible.
    // The weapon then reads as floating rather than held, which is the single
    // loudest tell of an unfinished viewmodel. Measured, every finger here used
    // to crown 37-52 mm under the solid.
    //
    // 'fore.top' is the real top of the furniture at this station, published by
    // the model factory, which is the only thing that knows where it put the
    // wood. The arc is built to crown a few millimetres above it so the knuckle
    // is visibly proud, then wrap down the far flank.
    const top = fore.top ?? fore.y + 0.03;
    for (let i = 0; i < 4; i++) {
      const z = fore.z - 0.042 + i * 0.024;
      // Slight stagger: the fingers are not a comb.
      const crown = top + 0.007 - i * 0.0015;
      const root = fore.y - 0.012 - i * 0.002;
      this._add(
        limb(
          [
            [-0.03, root, z],
            [-0.024, crown - 0.008, z - 0.002],
            [-0.008, crown, z - 0.001],
            [0.014, crown - 0.006, z],
            [0.026, root + 0.01, z + 0.001]
          ],
          [0, 0.0096, 1, 0.008],
          8,
          10
        )
      );
    }

    /* ---- left thumb, along the side of the handguard ---- */
    this._add(
      limb(
        [
          [-0.024, fore.y - 0.006, fore.z - 0.012],
          [-0.016, fore.y + 0.012, fore.z - 0.034],
          [-0.008, fore.y + 0.018, fore.z - 0.056]
        ],
        [0, 0.011, 1, 0.0088],
        8,
        8
      )
    );
  }

  dispose() {
    for (const geometry of this._geometries) geometry.dispose();
    this._geometries.length = 0;
    this.material.dispose();
  }
}
