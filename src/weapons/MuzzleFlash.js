import {
  Mesh,
  PlaneGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  BufferAttribute,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  DynamicDrawUsage,
  Sphere,
  Group,
  Vector3,
  Quaternion,
  Color
} from 'three';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { LAYER, setLayerRecursive } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { settings } from '../config/settings.js';

const _worldMuzzle = new Vector3();
const _worldFwd = new Vector3();
const _q = new Quaternion();

/**
 * The muzzle flash.
 *
 * A rifle flash lasts about two frames at 60 fps. Everything here is built
 * around that: there is no attack, only decay, and the whole event is over in
 * 45 ms. Drawing it for longer is the single most common reason a browser
 * shooter looks cheap.
 *
 * Five parts, because that is what a real flash is made of:
 *
 *  - **core**   a tiny, genuinely blown-out white spot at the bore
 *  - **star**   an *asymmetric* burst of burning gas — 0-7 petals at random
 *               bearings, widths and lengths, so no two shots draw the same
 *               shape. A symmetric 'cos(a * n)' lobe function draws a flower,
 *               and a flower repeated down a spray is instantly readable as
 *               fake, which is what the first version of this file did.
 *  - **glow**   a soft orange ball that carries the colour
 *  - **cone**   a short plume of unburnt powder pushed down the barrel line,
 *               drawn in the *bore's* frame rather than billboarded, so it
 *               foreshortens correctly when the gun is seen at an angle
 *  - **smoke**  a small puff that lingers a third of a second in *world* space,
 *               so a spray leaves a haze hanging in front of the player
 *
 * And, critically, a **real dynamic light**. The light is what moves the flash
 * from "a sprite drawn over the frame" to "an event happening in the room": it
 * lights the wall ahead, the crates beside the player and the gun itself. It is
 * driven hard and briefly — 60-odd units over 17 m for 45 ms.
 *
 * The star, glow and core are billboarded in the vertex shader rather than
 * being crossed quads in the weapon's local frame. Crossed billboards are the
 * right answer in third person; in *first* person the gun is always seen from
 * behind, so one of the two crossed quads is permanently edge-on and simply
 * throws away half the effect. The bore-aligned cone supplies the volume those
 * crossed quads were there for.
 */
export class MuzzleFlash {
  constructor(parent, lights, particles = null) {
    this.lights = lights;
    this.particles = particles;
    this.group = new Group();
    this.group.visible = false;
    parent.add(this.group);

    this.age = 0;
    this.duration = 0.045;
    this.size = 0.18;
    this._pending = false;

    /* ---------------- shared per-shot state ---------------- */
    this.shared = {
      uAge: { value: 0 },
      uDuration: { value: 0.045 },
      uSeed: { value: 0 },
      uSpin: { value: 0 },
      uColorHot: { value: new Color('#fffdf2') },
      uColorMid: { value: new Color('#ffc65a') },
      uColorEdge: { value: new Color('#ff5f14') }
    };

    const quad = new PlaneGeometry(1, 1);
    this._quad = quad;

    // A plane laid into the bore's frame: spans z from -1 (downrange) to 0 (the
    // muzzle), x across. uv.y is 1 at the bore and 0 at the tip of the plume.
    const cone = new PlaneGeometry(1, 1);
    cone.translate(0, -0.5, 0);
    cone.rotateX(Math.PI / 2);
    this._coneGeo = cone;

    this.core = this._part(quad, 2, 0.34, true, 1);
    this.star = this._part(quad, 0, 1.0, true, 0);
    this.glow = this._part(quad, 1, 2.0, true, 0);
    this.coneA = this._part(cone, 3, 1.0, false, 0);
    this.coneB = this._part(cone, 3, 1.0, false, 0);
    this.coneB.rotation.z = Math.PI / 2;

    // Painter's order inside the flash: the glow first, the core last, so the
    // white spot is what survives the additive pile-up.
    this.glow.renderOrder = 10;
    this.coneA.renderOrder = 11;
    this.coneB.renderOrder = 11;
    this.star.renderOrder = 12;
    this.core.renderOrder = 13;

    this.group.add(this.glow, this.coneA, this.coneB, this.star, this.core);
    setLayerRecursive(this.group, LAYER.VIEWMODEL);
    this.group.renderOrder = 12;

    /* ---------------- powder smoke, in world space ---------------- */
    // Parented to the scene rather than to the viewmodel: smoke that swings
    // with the gun through a spray's recoil reads as a decal stuck to the
    // barrel. It has to be left behind in the air.
    this._buildSmoke(parent.parent ?? parent);

    this._light = null;
    this._lightPos = new Vector3();
    this._lightColor = new Color('#ffc078');
    this._flicker = 1;
  }

  /** One billboarded or bore-aligned quad sharing the per-shot uniforms. */
  _part(geometry, mode, scale, billboard, hot) {
    const material = new ShaderMaterial({
      defines: billboard ? { BILLBOARD: '' } : {},
      uniforms: sharedUniforms({
        ...this.shared,
        uMode: { value: mode },
        uScale: { value: scale },
        uHot: { value: hot }
      }),
      vertexShader: /* glsl */ `
        uniform float uScale;
        uniform float uSpin;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          #ifdef BILLBOARD
            // Expand the quad around the object's origin *in view space*, so it
            // faces the camera whatever the gun is doing.
            vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float c = cos(uSpin), s = sin(uSpin);
            vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
            center.xy += p * uScale;
            gl_Position = projectionMatrix * center;
          #else
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #endif
        }
      `,
      fragmentShader: FLASH_FRAGMENT,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false
    });

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
  }

  /* ------------------------------------------------------------------ */

  _buildSmoke(scene) {
    const CAP = 28;
    this._smokeScene = scene;
    this._smokeCursor = 0;
    this._smokeCap = CAP;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this._sOrigin = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(DynamicDrawUsage);
    this._sVel = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(DynamicDrawUsage);
    this._sSpawn = new InstancedBufferAttribute(new Float32Array(CAP), 1).setUsage(DynamicDrawUsage);
    this._sSeed = new InstancedBufferAttribute(new Float32Array(CAP), 1).setUsage(DynamicDrawUsage);
    this._sSize = new InstancedBufferAttribute(new Float32Array(CAP), 1).setUsage(DynamicDrawUsage);
    this._sSpawn.array.fill(-1000);

    geometry.setAttribute('aOrigin', this._sOrigin);
    geometry.setAttribute('aVel', this._sVel);
    geometry.setAttribute('aSpawn', this._sSpawn);
    geometry.setAttribute('aSeed', this._sSeed);
    geometry.setAttribute('aSize', this._sSize);
    geometry.instanceCount = CAP;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this._smokeGeo = geometry;

    this._smokeMat = new ShaderMaterial({
      uniforms: sharedUniforms({
        uLife: { value: settings.combat.muzzleSmokeTime }
      }),
      vertexShader: /* glsl */ `
        attribute vec3  aOrigin;
        attribute vec3  aVel;
        attribute float aSpawn;
        attribute float aSeed;
        attribute float aSize;

        uniform float uTime;
        uniform float uLife;

        varying vec2  vUv;
        varying float vT;
        varying float vSeed;

        void main() {
          vUv = uv;
          vSeed = aSeed;
          float age = uTime - aSpawn;
          float t = age / max(uLife, 1e-4);
          vT = t;
          if (age < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

          // Exponential drag: powder smoke leaves the bore fast and stops fast.
          float k = 5.2;
          float travel = (1.0 - exp(-k * age)) / k;
          vec3 pos = aOrigin + aVel * travel + vec3(0.0, 0.30 * age * age, 0.0);

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          float grow = aSize * (0.35 + 1.9 * t);
          float rot = aSeed * 6.2831 + age * (aSeed - 0.5) * 2.2;
          float c = cos(rot), s = sin(rot);
          mv.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * grow;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2  vUv;
        varying float vT;
        varying float vSeed;
        uniform float uTime;
        uniform float uGlobalGlow;

        ${noiseGLSL}

        void main() {
          if (vT < 0.0 || vT > 1.0) discard;
          vec2 c = (vUv - 0.5) * 2.0;
          float d = length(c);
          float n = fbm3(vec3(c * 1.5, vSeed * 23.0 + uTime * 0.2));
          float mask = smoothstep(1.0, 0.05, d + n * 0.5);
          if (mask <= 0.01) discard;

          // In fast, out slow — and never opaque. Powder smoke is thin.
          float fade = smoothstep(0.0, 0.06, vT) * (1.0 - smoothstep(0.28, 1.0, vT));
          // Lit warm at the start (it is still glowing), cooling to grey.
          vec3 col = mix(vec3(0.62, 0.55, 0.47), vec3(0.40, 0.41, 0.43), smoothstep(0.0, 0.4, vT));
          col += vec3(0.55, 0.28, 0.08) * (1.0 - smoothstep(0.0, 0.12, vT));
          gl_FragColor = vec4(col * uGlobalGlow, mask * fade * 0.32);
        }
      `,
      transparent: true,
      blending: NormalBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false
    });

    this._smokeMesh = new Mesh(geometry, this._smokeMat);
    this._smokeMesh.frustumCulled = false;
    this._smokeMesh.layers.set(LAYER.VFX);
    this._smokeMesh.renderOrder = 9;
    scene.add(this._smokeMesh);
    this._smokeDirty = false;
  }

  _emitSmoke(position, forward, scale) {
    const count = 4;
    for (let n = 0; n < count; n++) {
      const i = this._smokeCursor;
      this._smokeCursor = (this._smokeCursor + 1) % this._smokeCap;
      const i3 = i * 3;

      this._sOrigin.array[i3] = position.x + (Math.random() - 0.5) * 0.03;
      this._sOrigin.array[i3 + 1] = position.y + (Math.random() - 0.5) * 0.03;
      this._sOrigin.array[i3 + 2] = position.z + (Math.random() - 0.5) * 0.03;

      // Mostly down the bore, with enough spread that the puff is not a jet.
      const speed = 1.5 + Math.random() * 1.8;
      this._sVel.array[i3] = forward.x * speed + (Math.random() - 0.5) * 1.1;
      this._sVel.array[i3 + 1] = forward.y * speed + (Math.random() - 0.5) * 0.9 + 0.25;
      this._sVel.array[i3 + 2] = forward.z * speed + (Math.random() - 0.5) * 1.1;

      this._sSpawn.array[i] = frame.uTime.value;
      this._sSeed.array[i] = Math.random();
      this._sSize.array[i] = scale * (1.1 + Math.random() * 1.0);
    }
    this._smokeDirty = true;
  }

  /* ------------------------------------------------------------------ */

  /**
   * @param {{muzzlePoint: THREE.Object3D, group: THREE.Group}} weapon
   * @param {object} config     weapon settings block
   * @param {number} aimProgress
   */
  fire(weapon, config, aimProgress = 0) {
    if (!weapon?.muzzlePoint) return;
    const c = settings.combat;

    this.age = 0;
    this.duration = config.muzzleFlashTime;
    // No two shots the same: size, roll and petal seed all move.
    const variance = 0.84 + Math.random() * 0.36;
    // In ADS the barrel is closer to the eye and a full-size flash whites out
    // the sights, so it shrinks — and is pushed down the bore so what is left
    // sits past the front post rather than on top of it.
    const ads = 1 - aimProgress * (1 - c.muzzleFlashAdsScale);
    this.size = config.muzzleFlashSize * c.muzzleFlashScale * variance * ads;

    // Local-to-weapon → local-to-viewmodel-root, so this stays correct if the
    // weapon group is ever given a transform of its own.
    this.group.position.copy(weapon.muzzlePoint.position);
    if (weapon.group) {
      weapon.group.updateMatrix();
      this.group.position.applyMatrix4(weapon.group.matrix);
    }
    // A few millimetres of jitter, plus the ADS push down the bore.
    this.group.position.x += (Math.random() - 0.5) * 0.008;
    this.group.position.y += (Math.random() - 0.5) * 0.008;
    this.group.position.z -= aimProgress * c.muzzleFlashAdsPush;
    this.group.visible = true;

    const seed = Math.random() * 997;
    this.shared.uSeed.value = seed;
    this.shared.uSpin.value = Math.random() * Math.PI * 2;
    this.shared.uDuration.value = this.duration;

    const s = this.size;
    this.core.material.uniforms.uScale.value = s * c.muzzleFlashCore;
    this.star.material.uniforms.uScale.value = s;
    this.glow.material.uniforms.uScale.value = s * c.muzzleFlashGlow;

    const coneR = s * c.muzzleFlashConeRadius;
    const coneL = s * c.muzzleFlashConeLength * (0.8 + Math.random() * 0.5);
    this.coneA.scale.set(coneR * 2, 1, coneL);
    this.coneB.scale.set(coneR * 2, 1, coneL);

    // A real dynamic light at the muzzle, so the flash lights the wall in front
    // of the player rather than floating in front of it.
    if (this.lights && !this._light) this._light = this.lights.acquire();
    this._flicker = 0.82 + Math.random() * 0.36;
    this._pending = true;
  }

  update(dt) {
    if (this._smokeDirty) {
      this._sOrigin.needsUpdate = true;
      this._sVel.needsUpdate = true;
      this._sSpawn.needsUpdate = true;
      this._sSeed.needsUpdate = true;
      this._sSize.needsUpdate = true;
      this._smokeDirty = false;
    }
    this._smokeMat.uniforms.uLife.value = settings.combat.muzzleSmokeTime;

    if (!this.group.visible) return;
    this.age += dt;

    const t = this.age / Math.max(0.0001, this.duration);
    this.shared.uAge.value = this.age;

    // The viewmodel transform is only current *after* WeaponSystem has run its
    // update, so the world position of the muzzle is resolved here rather than
    // at the trigger pull — which also means the smoke is left at the place the
    // barrel actually was on the frame it is drawn.
    this.group.updateWorldMatrix(true, false);
    this.group.getWorldPosition(this._lightPos);

    if (this._pending) {
      this._pending = false;
      _worldMuzzle.copy(this._lightPos);
      // -Z of the viewmodel root is down the bore.
      _worldFwd.set(0, 0, -1).applyQuaternion(this.group.parent.getWorldQuaternion(_q));
      this._emitSmoke(_worldMuzzle, _worldFwd, this.size * 0.7);
    }

    if (this._light) {
      const c = settings.combat;
      // A flash is all decay: full brightness on the frame it appears, then
      // gone. 'pow(1-t, 2)' is what that looks like.
      const punch = Math.max(0, 1 - t) ** 2.0 * this._flicker;
      this.lights.set(
        this._light,
        this._lightPos,
        this._lightColor,
        c.muzzleLightIntensity * punch,
        c.muzzleLightRadius,
        dt
      );
      // LightPool eases intensity toward its target with a 1-second time
      // constant, which over a 45 ms flash reaches barely a third of the way
      // there. An event this short has to be written, not chased.
      this._light.light.intensity =
        c.muzzleLightIntensity * punch * settings.global.lightIntensity;

      if (t >= 1) {
        this._light.light.intensity = 0;
        this.lights.release(this._light);
        this._light = null;
      }
    }

    if (t >= 1) this.group.visible = false;
  }

  dispose() {
    this._quad.dispose();
    this._coneGeo.dispose();
    for (const mesh of [this.core, this.star, this.glow, this.coneA, this.coneB]) {
      mesh.material.dispose();
    }
    this._smokeScene?.remove(this._smokeMesh);
    this._smokeGeo.dispose();
    this._smokeMat.dispose();
    if (this._light) {
      this._light.light.intensity = 0;
      this.lights.release(this._light);
      this._light = null;
    }
  }
}

const FLASH_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uAge;
  uniform float uDuration;
  uniform float uSeed;
  uniform float uMode;      // 0 star · 1 glow · 2 core · 3 cone
  uniform vec3  uColorHot;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;

  float h11(float n) { return fract(sin(n) * 43758.5453123); }

  /**
   * The burning-gas star.
   *
   * Up to seven independent lobes, each with its own bearing, angular width and
   * reach, and each free to be absent entirely. That is what makes consecutive
   * rounds in a spray draw genuinely different shapes — the thing a single
   * 'pow(abs(cos(a * n)), k)' can never do, because it is symmetric by
   * construction and therefore draws the same flower every time.
   */
  float petalField(float a, float seed) {
    float best = 0.0;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float pick = h11(seed * 1.7 + fi * 21.31 + 9.7);
      if (pick < 0.28) continue;                       // this petal did not form
      float ang   = h11(seed + fi * 13.77) * 6.28318530;
      float width = mix(0.09, 0.40, h11(seed + fi * 7.13 + 3.1));
      float len   = mix(0.26, 1.00, pick);
      float d = a - ang;
      d = abs(mod(d + 3.14159265, 6.28318530) - 3.14159265);
      best = max(best, len * exp(-(d * d) / (2.0 * width * width)));
    }
    return best;
  }

  void main() {
    float t = clamp(uAge / max(0.0001, uDuration), 0.0, 1.0);
    // Instant on, fast decay — a flash has no attack whatsoever.
    float env = pow(1.0 - t, 1.55);

    vec3 color;
    float alpha;
    float power;

    if (uMode < 0.5) {
      /* ---------------- star ---------------- */
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      float a = atan(p.y, p.x);

      float pf = petalField(a, uSeed);
      // Gas expands as it burns; the star reaches slightly further as it dies.
      float reach = mix(0.17, 1.0, pf) * mix(0.78, 1.12, t);
      float body = 1.0 - smoothstep(reach * 0.16, reach, r);
      body = pow(max(body, 0.0), 1.25);

      // Erode it so the petals have grain rather than a clean gradient.
      float grain = 0.72 + 0.28 * h11(floor(a * 9.0) + uSeed * 3.0);
      body *= grain;

      float centre = 1.0 - smoothstep(0.0, 0.30, r);
      color = mix(uColorEdge, uColorMid, body);
      color = mix(color, uColorHot, centre * centre * 0.85);
      alpha = body * env;
      power = 2.6 + 2.2 * env;

    } else if (uMode < 1.5) {
      /* ---------------- glow ---------------- */
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      float ball = 1.0 - smoothstep(0.0, 1.0, r);
      ball = pow(ball, 2.8);
      color = mix(uColorEdge, uColorMid, ball);
      // Squared envelope: the halo dies before the star does.
      alpha = ball * env * env * 0.85;
      power = 1.0;

    } else if (uMode < 2.5) {
      /* ---------------- core ---------------- */
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      float c = 1.0 - smoothstep(0.0, 1.0, r);
      c = pow(c, 1.7);
      color = mix(uColorMid, uColorHot, c);
      alpha = c * pow(env, 0.75);
      // Deliberately far over 1.0: this is the only part of the flash that is
      // *meant* to clip to white and bloom.
      power = 9.0;

    } else {
      /* ---------------- cone of unburnt powder ---------------- */
      // uv.y is 1 at the bore, 0 at the tip of the plume.
      float along = vUv.y;
      float across = abs(vUv.x - 0.5) * 2.0;
      // Narrow at the muzzle, opening out downrange.
      float w = mix(0.95, 0.20, along);
      float body = 1.0 - smoothstep(w * 0.2, w, across);
      // Ragged, and different every shot.
      float n = 0.55 + 0.45 * h11(floor(along * 7.0) * 3.7 + uSeed);
      body *= n;
      // Fade at both ends: nothing at the very tip, nothing behind the bore.
      float ends = smoothstep(0.0, 0.30, along) * (1.0 - smoothstep(0.86, 1.0, along));
      color = mix(uColorEdge, uColorMid, body * along);
      alpha = body * ends * env * 0.55;
      power = 1.5;
    }

    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(color * power * uGlobalGlow, alpha);
  }
`;
