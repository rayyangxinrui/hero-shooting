import {
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  Color,
  Group,
  Vector3,
  Quaternion
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';

const _normal = new Vector3();
const _quat = new Quaternion();
const _roll = new Quaternion();
const _UP = new Vector3(0, 1, 0);

/**
 * SCORCH, SHOCKWAVE, FROST and ARC are used by the live abilities; the rest are
 * generic ground marks kept for whatever gets built next, and cost nothing until
 * one is spawned (three compiles a program per decal type, on first use).
 */
export const DecalType = Object.freeze({
  SCORCH: 0, // burnt ground with cooling embers  (fire / thunder)
  RIPPLE: 1, // expanding water ring              (water)
  CRACK: 2, // radial fractures with hot glow     (earth)
  SHOCKWAVE: 3, // thin expanding ring            (all impacts)
  DUSTRING: 4, // soft ground-hugging dust puff   (earth / wind)
  FOAM: 5, // spreading sea foam over wet stone   (water)
  FROST: 6, // rime creeping outward in plates    (ice)
  ARC: 7, // branching electric burn               (thunder)
  BULLETHOLE: 8 // punched hole with a cratered rim (gunfire)
});

const DECAL_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // world space, toward the sun
  varying vec2 vUv;
  varying vec3 vLight;         // the same direction, in the decal's own frame
  varying vec3 vViewDirW;      // world-space eye → fragment, for the graze fade
  varying vec3 vNormalW;       // the quad's own facing, ditto

  void main() {
    vUv = uv;

    // Decals are spawned with a random yaw to decorrelate their noise, so a key
    // direction taken straight from world space would light every patch from a
    // different side of the room. Rotate it into the quad's frame once, here:
    // the fragment stage's c.x runs along local +X and c.y along local -Z.
    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);
    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), -dot(uLightDir, az)));

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vViewDirW = worldPos.xyz - cameraPosition;
    // The quad's geometry lies in its own XZ plane, so local +Y is its facing.
    // For a ground decal this is world up; for one laid against a wall it is
    // the wall's normal, which is what keeps the graze fade honest for both.
    vNormalW = ay;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DECAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;        // 0..1 normalised lifetime
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uWidth;      // crack / ring thickness
  uniform float uRadius;     // footprint radius in metres, for world-scaled grain
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform float uGlobalGlow;
  uniform float uGrazeFade;  // alpha kept when the quad is seen edge-on
  varying vec2 vUv;
  varying vec3 vLight;
  varying vec3 vViewDirW;
  varying vec3 vNormalW;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * Depth of settled snow at q (metres from the centre of the patch), ~0..1.
   *
   * Three scales, because that is what makes powder read as powder rather than
   * as a texture: banked drifts you can see the shape of, the shouldered slabs
   * where the crust has packed and cracked, and a fine grain on top for the
   * light to catch. It is a *height* field — the FROST decal differentiates it
   * for a normal, which is the whole reason the patch stops looking flat.
   */
  float snowDepth(vec2 q, float seed, float sharpness) {
    float drift = fbm3(vec3(q * 0.85, seed)) * 0.5 + 0.5;
    vec2  cell  = voronoi2(q * (1.4 + sharpness * 0.9) + seed * 7.0);
    float slabs = smoothstep(0.0, 0.55, cell.x) * 0.30 + cell.y * 0.12;
    float grain = snoise01(vec3(q * (7.0 + sharpness * 5.0), seed * 3.0)) * 0.15;
    return drift * 0.60 + slabs + grain;
  }

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;

    float alpha = 0.0;
    vec3 color = uColorA;
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, uAge);

    #if DECAL == 0                                   /* SCORCH */
      float n = fbm3(vec3(c * 2.4, uSeed * 13.0));
      float burn = smoothstep(1.0, 0.15, d + n * 0.45);
      float embers = pow(max(0.0, snoise(vec3(c * 6.0, uSeed * 9.0 + uTime * 0.35))), 4.0);
      alpha = burn * (0.85 * fadeOut);
      color = mix(uColorA, uColorB, embers * (1.0 - uAge));
      color += embers * uColorB * 2.5 * (1.0 - smoothstep(0.0, 0.6, uAge));

    #elif DECAL == 1                                 /* RIPPLE */
      float radius = mix(0.05, 1.0, sqrt(uAge));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      float inner = smoothstep(radius, radius - 0.35, d) * 0.22;
      float wobble = 0.75 + 0.25 * snoise(vec3(c * 5.0, uSeed * 4.0 + uTime));
      alpha = (ring * wobble + inner) * fadeOut;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 2                                 /* CRACK */
      float ang = atan(c.y, c.x);
      float branch = ridged(vec3(cos(ang), sin(ang), uSeed * 5.0) * 2.6, 4);
      float spread = smoothstep(0.0, 0.45, uAge);
      float radial = smoothstep(spread, spread * 0.35, d);
      float crack = smoothstep(0.55 - uWidth * 0.35, 0.85, branch) * radial;
      float glow = crack * (1.0 - smoothstep(0.1, 0.8, uAge));
      alpha = clamp(crack * 0.95 * fadeOut, 0.0, 1.0);
      color = mix(uColorA, uColorB, glow);
      color += uColorB * glow * 1.8;

    #elif DECAL == 3                                 /* SHOCKWAVE */
      // A perfect circle of constant width is a UI element. Seen from above at
      // 8 m that was forgivable; seen from eye height at a grazing angle it is
      // unmistakably a drawn ellipse on the floor, which is exactly how it read.
      //
      // Two things fix it. The rim is warped in the *plane* so the front is
      // ragged, and the ring is thinned and dimmed with azimuth so it is
      // strongest where the blast is travelling toward the viewer and dies at
      // the sides — a pressure front, not a hoop.
      float radius = mix(0.0, 1.0, pow(uAge, 0.55));
      float ang = atan(c.y, c.x);
      float warp = fbm3(vec3(cos(ang) * 1.7, sin(ang) * 1.7, uSeed * 11.0)) * 0.5 + 0.5;
      float rr = radius * (0.86 + 0.14 * warp);
      float w = uWidth * (0.55 + 0.9 * warp);
      float ring = smoothstep(w, 0.0, abs(d - rr));
      // Break the band up along its length so it reads as dust being shoved
      // outward rather than as a stroked outline.
      float broken = 0.45 + 0.55 * (fbm3(vec3(cos(ang) * 3.4, sin(ang) * 3.4, uSeed * 5.0 + uTime * 0.6)) * 0.5 + 0.5);
      alpha = ring * broken * (1.0 - uAge) * 0.9;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 4                                 /* DUSTRING */
      float radius = mix(0.1, 1.0, pow(uAge, 0.4));
      float n = fbm3(vec3(c * 3.1, uSeed * 7.0 + uTime * 0.2));
      float puff = smoothstep(radius, radius * 0.35, d) * (0.6 + n * 0.5);
      alpha = puff * (1.0 - uAge) * 0.7;
      color = mix(uColorA, uColorB, n * 0.5 + 0.5);

    #elif DECAL == 6                                 /* FROST */
      // Snow driven into the ground where the cold went through it.
      //
      // The old version drove its silhouette off atan(), and an angular lookup
      // hands every radius along a bearing the same lobe value — which is
      // literally how you draw a star, and a star is what it drew. Everything
      // here is sampled in the *plane* instead, and the patch is **shaded** off
      // a height field rather than tinted through a mask: cheap forward
      // differences give a normal, the scene's own key direction lights it, and
      // the result banks and catches light like powder instead of reading as a
      // blue-and-white transfer stuck to the floor.
      //
      // uWidth (the "crystal sharpness" slider) is the grain frequency.
      float seed = uSeed * 37.0;
      float sharp = clamp(uWidth, 0.05, 4.0);
      // Sample in metres, so a small rime patch and the broad sheet under an
      // impact have the same size of grain and read as the same substance.
      vec2 q = c * max(0.35, uRadius);

      /* ---- the drift: a ragged reach, never a disc ---- */
      vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
      float grow = pow(uAge, 0.30);
      float reach = d * (1.0 - lobes * 0.40);
      float cover = smoothstep(grow, grow - 0.38, reach);
      if (cover < 0.004) discard;

      /* ---- relief ---- */
      float e = 0.16;                               // metres between taps
      float h  = snowDepth(q, seed, sharp);
      float hx = snowDepth(q + vec2(e, 0.0), seed, sharp);
      float hy = snowDepth(q + vec2(0.0, e), seed, sharp);
      // A shallow bump: snow is soft, and a steep fake normal reads as gravel.
      vec3 nrm = normalize(vec3((h - hx) / e * 0.30, 1.0, (h - hy) / e * 0.30));

      float lambert = clamp(dot(nrm, normalize(vLight)), 0.0, 1.0);
      // Snow scatters deep, so its own shadow never goes black — it goes blue.
      float shade = 0.36 + 0.64 * pow(lambert, 0.8);

      /* ---- how thickly it lies ---- */
      // Thick in the middle, breaking into scattered grains at the rim, so the
      // patch has no printed outline anywhere.
      float lie = smoothstep(0.10, 0.52, cover * (0.34 + 0.78 * h));

      alpha = lie * fadeOut * 0.95;
      color = mix(uColorB * 0.55, mix(uColorA, vec3(1.0), 0.45), shade);

      // Ice glints where the crust catches the light — stepped in time so they
      // twinkle as the patch settles rather than crawling.
      float glint = smoothstep(0.90, 1.0, snoise01(vec3(q * 9.0, floor(uTime * 7.0) * 0.37 + seed)));
      color += glint * pow(lambert, 2.0) * 1.5 * (1.0 - smoothstep(0.0, 0.7, uAge));

      // The advancing lip is still freezing, so it stays lit while it travels.
      float lip = smoothstep(0.10, 0.0, abs(reach - grow)) * (1.0 - smoothstep(0.0, 0.5, uAge));
      color = mix(color, mix(uColorB, vec3(1.0), 0.6), lip * 0.55);
      alpha = clamp(alpha + lip * cover * 0.25 * fadeOut, 0.0, 1.0);

    #elif DECAL == 5                                 /* FOAM */
      // A sheet of foam thrown outward by the impact, which then drains from
      // the middle and dries back into a ring, over wet stone that darkens and
      // slowly evaporates.
      float front = mix(0.12, 1.0, pow(uAge, 0.42));
      float n = fbm3(vec3(c * 2.6, uSeed * 17.0 + uTime * 0.12));
      // Water runs outward in fingers, so the front is never a clean circle.
      float ang = atan(c.y, c.x);
      float fingers = 0.68 + 0.32 * snoise(vec3(cos(ang), sin(ang), uSeed * 3.0) * 3.5);
      float edge = d + n * 0.26;
      float reach = front * fingers;

      float sheet = smoothstep(reach, reach - 0.3, edge);
      float drain = smoothstep(reach * uAge * 0.9 - 0.05, reach * uAge + 0.3, edge + n * 0.12);
      float foam = sheet * mix(1.0, drain, smoothstep(0.12, 0.85, uAge));

      // Cell noise turns the sheet into bubbles instead of flat white paint.
      vec2 cell = voronoi2(c * 9.0 + uSeed * 30.0);
      float bubbles = smoothstep(0.55, 0.04, cell.x);
      float rim = smoothstep(0.09, 0.0, abs(edge - reach)) * (1.0 - uAge);

      float wet = sheet * (1.0 - smoothstep(0.3, 1.0, uAge));
      float mask = clamp(foam * (0.5 + 0.65 * bubbles) + rim * 0.9, 0.0, 1.0);
      alpha = clamp(wet * 0.5 + mask, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(mask * 1.3, 0.0, 1.0));

    #elif DECAL == 8                                 /* BULLETHOLE */
      // A punched hole, which is a *crater* rather than a stain: a dark void
      // where the material is gone, a bright lip of fresh substrate thrown up
      // around it, and a ring of scattered spall further out.
      //
      // The lip is the whole effect. A dark disc alone reads as a sticker at
      // any distance; the pale rim is what gives the hole depth, and it is why
      // bullet holes in CS2 and CoD are legible on a grey wall from 30 m. Both
      // the void and the lip take their colour from the surface, so concrete,
      // wood and steel punch differently.
      float seed = uSeed * 41.0;

      // Nothing about a hole is circular. Warp the radius before it is used.
      float rough = fbm3(vec3(c * 3.4, seed)) - 0.5;
      float rr = d * (1.0 + rough * 0.34);

      // The void: small, hard-edged, and genuinely dark.
      float hole = 1.0 - smoothstep(0.20, 0.34, rr);

      // The lip: fresh material pushed out of the hole, brightest just outside
      // it and falling away quickly.
      float lip = smoothstep(0.20, 0.36, rr) * (1.0 - smoothstep(0.36, 0.66, rr));

      // Spall: scattered flecks knocked loose further out, breaking the
      // outline so the mark never ends on a clean circle.
      float fleck = snoise01(vec3(c * 7.5, seed + 2.0));
      float spall = smoothstep(0.46, 0.98, fleck) * (1.0 - smoothstep(0.45, 1.0, rr));

      // Shade the lip off the same key the world uses, so the rim has a lit
      // side and a shaded side rather than reading as a painted ring.
      float lift = clamp(dot(normalize(vec3(rough * 1.6, 1.0, rough * 1.2)), normalize(vLight)), 0.0, 1.0);
      float rimShade = 0.55 + 0.75 * lift;

      // uColorA is the surface's dark core, uColorB its bright dust.
      color = mix(uColorB * rimShade, uColorA, hole);
      // A faint scorch ring immediately around the void: powder burn.
      color = mix(color, uColorA * 1.35, lip * 0.30);

      alpha = clamp(hole * 0.96 + lip * 0.72 + spall * 0.36, 0.0, 1.0) * fadeOut;

    #else                                            /* ARC */
      // The burn a bolt leaves where it earthed itself.
      //
      // The filament field is sampled in the *plane*, never on the angle. An
      // angular function hands every radius along a given bearing the same
      // value, which draws dead-straight spokes out of the centre — a firework,
      // not a burn. Sampling in 2D and warping the lookup lets the filaments
      // meander and fork the way current actually does. uWidth is how finely it
      // splits.
      float warp = fbm3(vec3(c * 1.7, uSeed * 3.0)) * 0.5;
      float fil = ridged(vec3(c * (2.4 + uWidth * 4.0) + warp, uSeed * 11.0), 4);
      float veins = smoothstep(0.70, 0.96, fil);

      // A ragged front that opens outward, so the mark spreads from the strike
      // rather than appearing whole.
      float grow = pow(uAge, 0.35);
      float edge = d + fbm3(vec3(c * 2.2, uSeed * 5.0)) * 0.25;
      float front = smoothstep(grow, grow * 0.15, edge);
      float hot = veins * front * (1.0 - smoothstep(0.0, 0.45, uAge));

      alpha = clamp(veins * front * 1.1, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(veins * 1.4, 0.0, 1.0));
      color += uColorB * hot * 1.8;
    #endif

    alpha *= uIntensity;

    // Every mark here is painted on a flat quad. From the third-person camera
    // such a quad was always seen from well above, so its shape read as a
    // shape. From eye height a *ground* decal is seen almost edge-on, and a
    // flat sprite viewed edge-on reads as a decal *sticker* — the single most
    // obvious tell that a ground effect is faked. Fading with the view angle
    // costs one dot product and removes it.
    //
    // The angle is measured against the quad's own normal rather than against
    // world up: identical for a decal lying on the floor, and correct for a
    // bullet hole laid against a wall, which is seen face-on and must not be
    // faded out for being vertical.
    float graze = abs(dot(normalize(vViewDirW), normalize(vNormalW)));
    alpha *= mix(uGrazeFade, 1.0, smoothstep(0.0, 0.42, graze));

    // Soften the outer edge of the quad so no mark ever ends on the circle its
    // geometry happens to be cut to.
    alpha *= smoothstep(1.0, 0.86, d);

    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Pooled ground decals: scorch marks, ripples, cracks, shockwaves and foam.
 *
 * Each decal is a single quad lying on the ground with a fully procedural
 * fragment shader, so there are no decal textures and no projection cost. One
 * material instance per decal keeps the uniforms independent while three's
 * program cache still compiles only one program per decal type.
 */
export class DecalSystem {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'GroundDecals';
    scene.add(this.group);

    this.geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.active = [];

    // One pool per type so the shader `#define` stays constant per material.
    this.pools = new Map();
  }

  _poolFor(type) {
    let pool = this.pools.get(type);
    if (!pool) {
      pool = new ObjectPool(() => this._createDecal(type), (decal) => {
        decal.mesh.visible = false;
        this.group.remove(decal.mesh);
      });
      this.pools.set(type, pool);
    }
    return pool;
  }

  _createDecal(type) {
    const additive =
      type === DecalType.RIPPLE || type === DecalType.SHOCKWAVE || type === DecalType.ARC;
    const material = new ShaderMaterial({
      defines: { DECAL: type },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uIntensity: { value: 1 },
        uWidth: { value: 0.12 },
        uRadius: { value: 1 },
        uGrazeFade: { value: 0.22 },
        uColorA: { value: new Color(0.1, 0.06, 0.05) },
        uColorB: { value: new Color(1, 0.5, 0.15) }
      }),
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = additive ? 8 : 6;
    mesh.frustumCulled = false;

    return { mesh, material, type, age: 0, life: 1, radius: 1, growth: 0 };
  }

  /**
   * @param {number} type   DecalType.*
   * @param {THREE.Vector3} position
   * @param {object} options
   * @param {THREE.Vector3} [options.normal]  surface normal. When given, the
   *        quad is laid *against that surface* at the exact point supplied,
   *        which is what lets bullet holes sit on walls and on the undersides
   *        of things. Omitted, the decal lies flat on the floor at y=height,
   *        which is the behaviour every ability relies on.
   */
  spawn(type, position, options = {}) {
    const {
      radius = 2,
      life = 2,
      colorA = null,
      colorB = null,
      intensity = 1,
      width = 0.12,
      growth = 0,
      height = 0.02,
      normal = null
    } = options;

    const decal = this._poolFor(type).acquire();
    const u = decal.material.uniforms;

    decal.age = 0;
    decal.life = Math.max(0.05, life);
    decal.radius = radius;
    decal.growth = growth;

    u.uAge.value = 0;
    u.uSeed.value = Math.random();
    u.uIntensity.value = intensity;
    u.uWidth.value = width;
    u.uRadius.value = radius;
    if (colorA) u.uColorA.value.copy(colorA);
    if (colorB) u.uColorB.value.copy(colorB);

    // A surface normal, if it is a usable one. A zero-length normal is treated
    // as absent rather than propagated into a NaN quaternion.
    const oriented = normal && normal.lengthSq() > 0.5;

    if (oriented) {
      _normal.copy(normal).normalize();
      // The quad's geometry was rotated to lie in the XZ plane, so its own
      // "up" is +Y; aim that at the surface normal.
      _quat.setFromUnitVectors(_UP, _normal);
      decal.mesh.quaternion.copy(_quat);
      // Random roll *about the normal*, to decorrelate the procedural noise
      // between neighbouring holes without tilting the quad off the surface.
      _roll.setFromAxisAngle(_UP, Math.random() * Math.PI * 2);
      decal.mesh.quaternion.multiply(_roll);
      // Lifted along the normal rather than along world Y, or a decal on a
      // vertical wall would be pushed sideways out of it.
      decal.mesh.position.copy(position).addScaledVector(_normal, height);
    } else {
      decal.mesh.quaternion.identity();
      decal.mesh.rotation.y = Math.random() * Math.PI * 2;
      decal.mesh.position.set(position.x, height, position.z);
    }

    decal.mesh.scale.setScalar(radius * 2);
    decal.mesh.visible = true;

    this.group.add(decal.mesh);
    this.active.push(decal);
    return decal;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const decal = this.active[i];
      decal.age += dt;
      const t = decal.age / decal.life;
      decal.material.uniforms.uAge.value = t;

      if (decal.growth !== 0) {
        decal.mesh.scale.setScalar(decal.radius * 2 * (1 + decal.growth * t));
      }

      if (t >= 1) {
        this.active.splice(i, 1);
        this._poolFor(decal.type).release(decal);
      }
    }
  }

  clear() {
    for (const decal of this.active) this._poolFor(decal.type).release(decal);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((decal) => decal.material.dispose());
    this.pools.clear();
    this.geometry.dispose();
    this.group.parent?.remove(this.group);
  }
}
