import { Vector3, Color } from 'three';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { DecalType } from '../effects/GroundDecals.js';
import { frame } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';
import { settings } from '../config/settings.js';

const _reflect = new Vector3();
const _spray = new Vector3();
const _tint = new Color();
const _tmp = new Vector3();

/**
 * Bullet impacts: what a round does when it stops.
 *
 * Surfaces are not decoration. A round into concrete throws grey dust and hot
 * chips; into metal it throws sparks, a bright ricochet flash and almost no
 * dust; into wood it throws splinters and brown dust and no sparks at all.
 * That difference is the single loudest signal in a shooter that the world is
 * made of *materials* rather than of textures, and it costs one table lookup.
 *
 * Two things here are worth more than the particle counts:
 *
 *  1. **The spray is reflected about the surface normal**, not fired along it.
 *     Debris from a glancing hit travels along the wall, and that is what sells
 *     the angle of the shot. Fired along the normal, every impact looks like it
 *     was shot dead square — which is what a player almost never does.
 *
 *  2. **Everything scales with distance from the camera.** Impacts in this
 *     arena land 25-50 m out, where debris authored for a 3 m contact shot is
 *     under a pixel and simply is not there. The scale is applied to sizes and
 *     to the decal, never to the counts, so a far hit reads without a near hit
 *     turning into an explosion.
 */
const SURFACES = {
  concrete: {
    dust: 20,
    dustColor: '#a49c92',
    chips: 11,
    chipColor: '#756f66',
    sparks: 0,
    smoke: 4,
    puffSize: 0.20,
    chipSize: 0.030,
    decal: 0.055,
    decalRim: '#b9b2a7',
    decalCore: '#14100c',
    flash: 0
  },
  metal: {
    dust: 3,
    dustColor: '#9aa0a8',
    chips: 5,
    chipColor: '#585c62',
    sparks: 30,
    smoke: 1,
    puffSize: 0.09,
    chipSize: 0.022,
    decal: 0.038,
    decalRim: '#d2d6db',
    decalCore: '#0d0f12',
    // Metal is the only surface that throws a real ricochet flash.
    flash: 1
  },
  wood: {
    dust: 10,
    dustColor: '#93secretgone',
    chips: 17,
    chipColor: '#63481f',
    sparks: 0,
    smoke: 3,
    puffSize: 0.15,
    chipSize: 0.040,
    decal: 0.05,
    decalRim: '#a87a45',
    decalCore: '#170e05',
    flash: 0
  },
  flesh: {
    dust: 0,
    dustColor: '#5e0d0d',
    chips: 12,
    chipColor: '#7a1010',
    sparks: 0,
    smoke: 0,
    puffSize: 0.2,
    chipSize: 0.03,
    decal: 0.09,
    decalRim: '#3a0808',
    decalCore: '#120202',
    flash: 0
  }
};
// Authored wood dust colour, kept out of the literal above so a typo in a hex
// string can never silently become black.
SURFACES.wood.dustColor = '#94764f';

export class ImpactSystem {
  constructor(context) {
    this.ctx = context;
    this.particles = context.particles;
    this.decals = context.decals;
    this.lights = context.lights;
    /** Optional: used only to scale debris by distance. Safe when absent. */
    this.camera = context.camera ?? null;

    /* --- dust: soft, lit, short-lived, and *not* additive --- */
    this.dust = this.particles.get('impact.dust', {
      capacity: 3000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      lit: true,
      softFade: 0.35
    });
    this.dust.uniforms.uGravity.value.set(0, -1.4, 0);
    this.dust.uniforms.uDrag.value = 3.4;
    this.dust.uniforms.uEndSize.value = 2.9;
    this.dust.uniforms.uSizeIn.value = 0.03;
    this.dust.uniforms.uFadeIn.value = 0.02;
    this.dust.uniforms.uFadeOut.value = 0.42;
    this.dust.uniforms.uOpacity.value = 0.62;
    this.dust.uniforms.uGlow.value = 0.42;
    this.dust.uniforms.uTurbulence.value = 0.35;
    // Near-neutral value ramp: the *hue* of a puff arrives per particle as
    // `tint`, because one shared system serves concrete, wood and metal.
    this.dust.setGradient(
      getColor('#ffffff'),
      getColor('#ded9d2'),
      getColor('#a29c93'),
      getColor('#615d57')
    );

    /* --- the hanging cloud: what is left a second after the round lands --- */
    // Split from `dust` because it wants a completely different motion profile
    // (no gravity, heavy drag, long life) and uniforms are per-system.
    this.smoke = this.particles.get('impact.smoke', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      lit: true,
      softFade: 0.5
    });
    this.smoke.uniforms.uGravity.value.set(0, 0.16, 0);
    this.smoke.uniforms.uDrag.value = 4.6;
    this.smoke.uniforms.uEndSize.value = 3.6;
    this.smoke.uniforms.uSizeIn.value = 0.06;
    this.smoke.uniforms.uFadeIn.value = 0.05;
    this.smoke.uniforms.uFadeOut.value = 0.2;
    this.smoke.uniforms.uOpacity.value = 0.4;
    this.smoke.uniforms.uGlow.value = 0.5;
    this.smoke.uniforms.uTurbulence.value = 0.28;
    this.smoke.setGradient(
      getColor('#ffffff'),
      getColor('#e2ded7'),
      getColor('#b0aaa2'),
      getColor('#6d6862')
    );

    /* --- chips: angular, lit, ballistic --- */
    this.chips = this.particles.get('impact.chips', {
      capacity: 3000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.chips.uniforms.uGravity.value.set(0, -17, 0);
    this.chips.uniforms.uDrag.value = 0.7;
    this.chips.uniforms.uEndSize.value = 0.85;
    this.chips.uniforms.uFadeOut.value = 0.55;
    this.chips.uniforms.uGlow.value = 0.5;
    this.chips.setGradient(
      getColor('#ffffff'),
      getColor('#d5d0c9'),
      getColor('#948e86'),
      getColor('#524e49')
    );

    /* --- sparks: stretched, additive, gone in a quarter second --- */
    this.sparks = this.particles.get('impact.sparks', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.2
    });
    this.sparks.uniforms.uGravity.value.set(0, -15, 0);
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.1;
    this.sparks.uniforms.uSizeIn.value = 0.015;
    this.sparks.uniforms.uFadeIn.value = 0.015;
    this.sparks.uniforms.uFadeOut.value = 0.3;
    this.sparks.uniforms.uStretch.value = 0.5;
    this.sparks.uniforms.uGlow.value = 2.6;
    this.sparks.setGradient(
      getColor('#ffffff'),
      getColor('#ffe1a4'),
      getColor('#ff8b2c'),
      getColor('#611b02')
    );

    /* --- blood: normal-blended, heavy, dark --- */
    this.blood = this.particles.get('impact.blood', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.blood.uniforms.uGravity.value.set(0, -14, 0);
    this.blood.uniforms.uDrag.value = 1.1;
    this.blood.uniforms.uEndSize.value = 0.6;
    this.blood.uniforms.uFadeOut.value = 0.35;
    this.blood.uniforms.uGlow.value = 0.15;
    this.blood.setGradient(
      getColor('#8c1414'),
      getColor('#5e0d0d'),
      getColor('#3a0808'),
      getColor('#1c0404')
    );
  }

  /**
   * How much to inflate an impact so it still reads at range.
   *
   * A bullet hole is about 1 cm across. At 40 m with a 90° horizontal fov on a
   * 1920-wide frame, one pixel covers 3.6 cm — so the honest size is a third of
   * a pixel and the impact is, correctly and uselessly, invisible. Every
   * shipped shooter inflates distant impacts for exactly this reason.
   */
  _scaleFor(point) {
    if (!this.camera) return 1;
    const c = settings.combat;
    const distance = this.camera.getWorldPosition(_tmp).distanceTo(point);
    const t = Math.min(1, distance / Math.max(1, c.impactFarDistance));
    return 1 + (c.impactFarScale - 1) * t;
  }

  /**
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {string} surface    key into SURFACES
   * @param {THREE.Vector3} [incoming]  unit direction the round was travelling
   */
  spawnWorld(point, normal, surface = 'concrete', incoming = null) {
    const s = SURFACES[surface] ?? SURFACES.concrete;
    const time = frame.uTime.value;
    const scale = this._scaleFor(point);

    // A degenerate normal would send every particle to the same place; the
    // collider has been known to hand one over, and a NaN cone is unrecoverable.
    let n = normal;
    if (!n || n.lengthSq() < 0.5) {
      _tmp.set(0, 1, 0);
      n = _tmp;
    }

    /* ---- the debris cone -------------------------------------------- */
    // Reflect the incoming ray about the surface: `r = d - 2(d·n)n`. A square
    // hit reflects straight back out along the normal; a glancing hit skips
    // along the wall, which is what makes the angle of the shot readable.
    if (incoming) {
      const dot = incoming.dot(n);
      _reflect.copy(incoming).addScaledVector(n, -2 * dot);
      if (_reflect.lengthSq() < 1e-6) _reflect.copy(n);
      else _reflect.normalize();
      // Pulled back toward the normal: real debris does not leave along a
      // mirror line, it leaves in a cone biased that way.
      _spray.copy(_reflect).multiplyScalar(0.62).addScaledVector(n, 0.55).normalize();
    } else {
      _spray.copy(n);
    }

    if (s.dust > 0) {
      _tint.set(s.dustColor);
      this.dust.emit(s.dust, {
        position: point,
        radius: 0.03 * scale,
        direction: _spray,
        speed: 2.1,
        speedVariance: 0.65,
        spread: 0.8,
        size: s.puffSize * scale * 0.85,
        sizeVariance: 0.55,
        life: 0.5,
        lifeVariance: 0.45,
        spin: 1.6,
        tint: _tint,
        time
      });
    }

    // The puff that hangs. This is what a spray into concrete leaves behind,
    // and it is most of the reason CS2's wall fire reads as dusty.
    if (s.smoke > 0) {
      _tint.set(s.dustColor);
      this.smoke.emit(s.smoke, {
        position: point,
        radius: 0.05 * scale,
        direction: _spray,
        speed: 0.85,
        speedVariance: 0.7,
        spread: 1.0,
        size: s.puffSize * scale * 1.3,
        sizeVariance: 0.5,
        life: settings.combat.impactSmokeLife,
        lifeVariance: 0.4,
        spin: 0.7,
        tint: _tint,
        time
      });
    }

    if (s.chips > 0) {
      _tint.set(s.chipColor);
      this.chips.emit(s.chips, {
        position: point,
        radius: 0.025 * scale,
        direction: _spray,
        speed: 5.4,
        speedVariance: 0.75,
        spread: 0.62,
        size: s.chipSize * scale,
        sizeVariance: 0.65,
        life: 1.0,
        lifeVariance: 0.5,
        spin: 11,
        tint: _tint,
        time
      });
    }

    if (s.sparks > 0) {
      // Sparks follow the *reflection* far more tightly than dust does — they
      // are the part of the impact that actually ricochets.
      this.sparks.emit(s.sparks, {
        position: point,
        radius: 0.015 * scale,
        direction: _reflect.lengthSq() > 0.5 ? _reflect : _spray,
        speed: 9.5,
        speedVariance: 0.85,
        spread: 0.55,
        size: 0.05 * scale,
        sizeVariance: 0.7,
        life: 0.34,
        lifeVariance: 0.6,
        time
      });
    }

    /* ---- the hole ---------------------------------------------------- */
    // A real bullet hole: dark centre, bright cratered rim, tinted to the
    // surface. Oriented to the surface normal, so it lies on walls as well as
    // on the floor.
    this.decals.spawn(DecalType.BULLETHOLE, point, {
      radius: s.decal * (1 + (scale - 1) * 0.55),
      life: settings.combat.impactDecalLife,
      intensity: 1,
      normal: n,
      colorA: getColor(s.decalCore),
      colorB: getColor(s.decalRim)
    });

    /* ---- the ricochet flash ------------------------------------------ */
    if (s.flash > 0 && this.lights) {
      this._popLight(point, '#ffca7a', 16 * s.flash * settings.combat.impactSparkFlash, 4.5);
    }
  }

  /**
   * A one-frame light. Acquired, driven to full, and released on the next
   * update — the pool is six deep, so an impact may never hold one.
   */
  _popLight(point, hex, intensity, radius) {
    const entry = this.lights.acquire();
    if (!entry) return;
    entry.light.position.copy(point);
    entry.light.color.copy(getColor(hex));
    entry.light.intensity = intensity * settings.global.lightIntensity;
    entry.light.distance = radius * settings.global.lightRadius;
    // Released immediately: LightPool fades released lights out rather than
    // cutting them, which is exactly the decay a ricochet spark wants.
    this.lights.release(entry);
  }

  spawnFlesh(point, normal, isHead) {
    const time = frame.uTime.value;
    const count = isHead ? 26 : 14;
    const scale = this._scaleFor(point);

    _tint.set(settings.monsters.colorBlood);
    this.blood.emit(count, {
      position: point,
      radius: 0.05 * scale,
      direction: normal,
      speed: isHead ? 5.4 : 3.4,
      speedVariance: 0.7,
      spread: 0.8,
      size: 0.07 * scale,
      sizeVariance: 0.6,
      life: 0.75,
      lifeVariance: 0.5,
      tint: _tint,
      time
    });

    this.chips.emit(isHead ? 14 : 7, {
      position: point,
      radius: 0.04 * scale,
      direction: normal,
      speed: 4.0,
      speedVariance: 0.7,
      spread: 0.85,
      size: 0.03 * scale,
      sizeVariance: 0.6,
      life: 0.8,
      lifeVariance: 0.5,
      spin: 11,
      tint: _tint,
      time
    });
  }

  update() {}

  dispose() {}
}
