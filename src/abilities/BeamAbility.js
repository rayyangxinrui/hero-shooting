import { IcosahedronGeometry, Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createBeamMaterial, BeamPass } from '../materials/BeamMaterial.js';
import {
  createBeamTubeGeometry,
  createBeamRingGeometry,
  createBoltRibbonGeometry
} from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** Hard ceilings. The editor's `coils` / `rings` sliders clamp here. */
const MAX_COILS = 8;
const MAX_RINGS = 12;

/** Tessellation of the column. Nothing about the *shape* lives in these. */
const TUBE_NODES = 96;
const TUBE_SIDES = 26;
const COIL_NODES = 128;
const RING_SEGMENTS = 44;

/**
 * How many points along the column one frame's sparks are split between. As
 * with the bolt: a single origin makes every batch read as a starburst, and a
 * beam sheds along its whole length.
 */
const SPARK_BATCHES = 5;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _radial = new Vector3();
const _target = new Vector3();
const _up = new Vector3(0, 1, 0);
const _axisA = new Vector3();
const _axisB = new Vector3();

/**
 * BEAM — a sustained column of light held on the aimed line.
 *
 * Four beats where the other three abilities have three. The caster winds a
 * ball of light up in both hands (`charge`), lets it out as a column that races
 * downrange at `speed`, *holds* it there burning into the floor for `lifetime`,
 * and finally lets it collapse back to a thread over `fadeTime`. The hold is
 * the point of the ability: it is the only cast in the sandbox that is still
 * happening a second after it landed.
 *
 * The extra beat needed nothing from the base class. `advance()` simply refuses
 * to let the front leave the hand until the orb is up to power, so the phase
 * machine still runs travel → impact → fade and `IMPACT` becomes the burn.
 *
 * Everything is generated: the column is one parametric tube drawn three times
 * at three radii, the coils are the bolt's ribbon strip bent into a helix, the
 * shock discs are an instanced annulus slid downrange by the clock, the charge
 * is a noise-eroded sphere, and the sparks, motes, steam and chips are GPU
 * particles. Nothing is loaded from disk and nothing is a texture.
 *
 * **Not electric.** The Storm Lance's whole character is that its noise is
 * piecewise-linear and keeps its corners; every noise term here is smooth,
 * stretched hard along the flow and crawling downrange, because a beam that
 * kinks is a bolt. The two abilities share a colour family on purpose — what
 * separates them is entirely how they move.
 *
 * **The rule that makes the editor work.** A cast captures exactly one number —
 * `_seed`, so two beams do not draw the identical column — plus timestamps.
 * Every metre, radian and second is resolved against `settings.beam` each
 * frame, on a zero-length frame included. Dragging `radius` re-bores a beam
 * that is already burning; dragging `coilTurns` re-winds its ribbons; dragging
 * `flare` re-opens the cone at the far end. That is what pausing with **P**
 * mid-burn is for.
 */
export class BeamAbility extends Ability {
  constructor(context) {
    super('beam', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.tubeGeometry = createBeamTubeGeometry(TUBE_NODES, TUBE_SIDES);
    this.coilGeometry = createBoltRibbonGeometry(COIL_NODES, MAX_COILS);
    this.ringGeometry = createBeamRingGeometry(MAX_RINGS, RING_SEGMENTS);
    this.orbGeometry = new IcosahedronGeometry(1, 4);

    /*
     * Six passes over three geometries. The three tube passes are the same
     * mesh at three radii — see `materials/BeamMaterial.js` for why the core is
     * weighted inside-out compared to the sheath around it.
     *
     * Everything here is additive with `depthWrite` off, so the draw order is
     * not about correctness; the render orders only keep this ability sitting
     * in the same band as the rest of the VFX.
     */
    const passes = [
      [BeamPass.HALO, this.tubeGeometry, 11],
      [BeamPass.SHELL, this.tubeGeometry, 12],
      [BeamPass.CORE, this.tubeGeometry, 13],
      [BeamPass.COIL, this.coilGeometry, 13],
      [BeamPass.RING, this.ringGeometry, 13],
      [BeamPass.ORB, this.orbGeometry, 14]
    ];

    this.materials = [];
    this.meshes = [];
    for (const [pass, geometry, renderOrder] of passes) {
      const material = createBeamMaterial(pass);
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = renderOrder;
      // Every pass but the orb is placed in world space by its vertex shader.
      // The orb is the one thing that rides a model matrix, because the ability
      // has to move and scale it as the charge builds.
      if (pass === BeamPass.ORB) this.orbMesh = mesh;
      else mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.materials.push(material);
      this.meshes.push(mesh);
    }

    /** Re-rolled per cast so no two beams draw the same column. */
    this._seed = 0;
    this._coilCount = 1;
    this._ringCount = 1;
    /** Whether the orb has let go yet — the release only fires once. */
    this._fired = false;
    /** Metres of front travel already paid out in ground burns. */
    this._burnDistance = 0;
    /** The light sitting in the caster's hands. Released with the cast. */
    this.muzzleLight = null;

    // Scratch state handed to all six materials each frame. One object, reused —
    // syncing the beam allocates nothing.
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      widthFade: 1,
      charge: 0,
      orb: 0,
      seed: 0,
      coils: 1,
      rings: 1
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks shed off the column: velocity-stretched streaks, thrown radially
    // and then dragged downrange by `sparkForward`.
    this.sparks = particles.get('beam.sparks', {
      capacity: 5000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.4;

    // Motes: the intake spiralling into the orb while it charges, and the drift
    // hanging around the column once it is firing. One system, two jobs — they
    // are the same glow, differing only in which way they are thrown.
    this.motes = particles.get('beam.motes', {
      capacity: 3600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.1;
    this.motes.uniforms.uEndSize.value = 0.12;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.35;

    // Steam scoured off the floor under the burn. Non-additive so it occludes.
    this.smoke = particles.get('beam.smoke', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    // Chips torn off the floor along the burn line.
    this.debris = particles.get('beam.debris', {
      capacity: 1800,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.8;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.intakeEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.debrisEmitter = new RateEmitter();
    this.splashEmitter = new RateEmitter();
    // Decals and shells are throttled through the same fractional-rate emitter
    // the particles use, so "rings per second" stays frame-rate independent.
    this.pulseEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.shockEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Three tube passes, the coils, the discs and the orb.
    return 4 + this._coilCount + this._ringCount;
  }

  /** The beam burns where it landed, then collapses. */
  get impactDuration() {
    return Math.max(0.05, settings.beam.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.beam.fadeTime);
  }

  /** How far the orb has wound up, 0..1. */
  get charge() {
    return saturate(this.age / Math.max(0.01, settings.beam.charge));
  }

  /**
   * How much of the charge orb is still there, 0..1.
   *
   * Distinct from `charge`, which only ever ramps up and then stays pinned at 1
   * for the rest of the cast. The orb is what the *wind-up* is; once the beam
   * has been let out of it there is nothing left to hold, and leaving it at full
   * power parked half a metre from the eye put a blown-white blob over the
   * weapon for the whole burn — the single brightest thing in the frame, sitting
   * on top of the gun the beam was supposed to be leaving.
   *
   * So it collapses over `orbRelease` seconds from the moment of release. The
   * column's mouth takes over from it, which is the read that was intended.
   */
  get orbPresence() {
    const c = settings.beam;
    const since = this.age - Math.max(0, c.charge);
    if (since <= 0) return this.charge;
    return 1 - Easing.outCubic(saturate(since / Math.max(0.01, c.orbRelease)));
  }

  /**
   * A beam hums where lightning gutters — a slow sine, not a quantised stutter.
   * The one thing that must *not* happen here is a flicker: it would immediately
   * read as the Storm Lance's light.
   */
  lightShimmer() {
    const c = settings.beam;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /**
   * Hold the front at the hand until the orb is up to power.
   *
   * This is the whole of the fourth beat. The base class eases off a standstill
   * over the first fraction of a second; here the same ease is keyed off the
   * moment of release instead of the moment of the cast.
   */
  advance(dt) {
    const c = this.config;
    const charge = Math.max(0, c.charge);
    if (this.age < charge) return false;

    const speed = c.speed * settings.global.speed;
    const since = this.age - charge;
    this.front += speed * Easing.outQuad(saturate(since / 0.05)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the beam — every metre resolved from live settings       */
  /* ------------------------------------------------------------------ */

  /**
   * Where the column leaves the caster, in world space.
   *
   * **This is the whole first-person port of this ability.** The sandbox laid
   * the column from a point on the cast's *floor* line, lifted to a fixed
   * `handHeight`. In third person that is a hand beside a visible body. In
   * first person it is a point roughly a metre in front of the eye and almost
   * exactly on the view axis — so the column was drawn coming straight at the
   * camera, and a tube seen end-on is not a line, it is a bullseye. That is why
   * five rounds of critique reported "no line, no axis, no origin, no
   * terminus": there genuinely was no axis on screen to see.
   *
   * `Ability#muzzlePoint` already resolves the hand in *view* space — down and
   * right of the crosshair, where the weapon is — and that is the one thing
   * that gives the column a readable axis: it now runs diagonally from the gun
   * in the lower right of the frame up to the crosshair in the middle of it.
   */
  _handPoint(out) {
    return this.muzzlePoint(out);
  }

  /**
   * Where it lands: the crosshair.
   *
   * The old version forced `y = endHeight`, a fixed 1 m off the floor. Against
   * a third-person camera that reads as the beam standing on the ground; down
   * the sights it puts the terminus a metre above the thing the player is
   * pointing at, so the beam visibly misses. `aimPoint` is the real hit, and
   * `endHeight` survives as a small lift off a *floor* hit so the burn still
   * stands on the ground rather than being buried in it.
   */
  _impactPoint(out) {
    const c = settings.beam;
    out.copy(this.aimPoint);
    // Only lift a hit that landed on (or below) the floor plane.
    out.y = Math.max(out.y, Math.min(c.endHeight, this.aimPoint.y + c.endHeight));
    return out;
  }

  /**
   * A point on the column's *axis* at `s` along it, 0..1.
   *
   * Mirrors the first stage of the vertex shader, minus the sub-decimetre
   * drift, so the sparks and burns the CPU spawns sit on the beam the GPU
   * actually draws instead of near it. The shader's `beamAxis` is a straight
   * `mix(uOrigin, uTarget, t)`, so this is too — deriving it a second way from
   * the floor line is what used to let the sparks drift off the column.
   */
  _axisPoint(s, out) {
    const t = saturate(s);
    this._handPoint(_axisA);
    this._impactPoint(_axisB);
    return out.lerpVectors(_axisA, _axisB, t);
  }

  /**
   * Half-width of the column at `s`, metres — how far off the axis sparks are
   * thrown. Mirrors `beamRadius()` in the shader, minus the throb, so the spray
   * sits on the surface the GPU is drawing.
   */
  _beamRadius(s) {
    const c = settings.beam;
    const t = saturate(s);
    const r = lerp(c.radiusNear, c.radius, Math.pow(t, Math.max(0.01, c.radiusCurve)));
    return r * (1 + c.flare * smoothstep(1 - Math.max(1e-3, c.flareWidth), 1, t));
  }

  /** A unit vector perpendicular to the column, `a` radians around it. */
  _radialAt(a, out) {
    return out
      .copy(this.side)
      .multiplyScalar(Math.cos(a))
      .addScaledVector(_up, Math.sin(a))
      .normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    for (const emitter of [
      this.sparkEmitter,
      this.moteEmitter,
      this.intakeEmitter,
      this.smokeEmitter,
      this.debrisEmitter,
      this.splashEmitter,
      this.pulseEmitter,
      this.dustEmitter,
      this.shockEmitter
    ]) {
      emitter.reset();
    }

    this._burnDistance = 0;
    this._fired = false;

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    // A second light, sitting in the caster's hands, so the wind-up actually
    // lights the body holding it. The pool can hand back null when several
    // casts are in flight — every use below is guarded.
    this.muzzleLight = this.ctx.lights.acquire();

    this._syncUniforms(0, 1, 1);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all six passes.
   *
   * @param {number} dt        seconds, for the muzzle light's easing
   * @param {number} fade      1 while the beam is lit, ramping to 0 as it dies
   * @param {number} widthFade the same for the column's *width* — it collapses
   *                           to a thread faster than it dims, which is what
   *                           makes the cut-out read as a snap
   */
  _syncUniforms(dt, fade, widthFade) {
    const c = settings.beam;
    const g = settings.global;
    const state = this._state;

    this._handPoint(state.origin);
    this._impactPoint(state.target);
    state.side.copy(this.side);
    state.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    state.fade = fade;
    state.widthFade = widthFade;
    state.charge = this.charge;
    state.orb = this.orbPresence;
    state.seed = this._seed;

    this._coilCount = Math.max(1, Math.min(MAX_COILS, Math.round(c.coils)));
    this._ringCount = Math.max(1, Math.min(MAX_RINGS, Math.round(c.rings)));
    state.coils = this._coilCount;
    state.rings = this._ringCount;
    this.coilGeometry.instanceCount = this._coilCount;
    this.ringGeometry.instanceCount = this._ringCount;

    for (const material of this.materials) material.userData.sync(state);

    /* --- the orb: placed and sized here, shaded in the shader --- */
    const swell = 1 + c.orbThrob * Math.sin(this.age * c.orbThrobSpeed * TAU);
    const size = c.orbSize * (0.28 + 0.72 * Easing.outCubic(state.orb)) * swell * widthFade;
    this.orbMesh.position.copy(state.origin);
    this.orbMesh.scale.setScalar(Math.max(0.001, size));
    // Nothing to draw once it has let go: skip the pass entirely rather than
    // drawing a degenerate sphere at the muzzle every frame of the burn.
    this.orbMesh.visible = state.orb > 0.004;

    if (this.muzzleLight) {
      // The light at the hand does NOT follow the orb — it follows the beam.
      // `ViewmodelLighting` collapses the whole pool into the one light that
      // reaches the weapon, so this is the light that puts the spell's colour on
      // the gun and the gloved hands. Killing it when the orb collapses would
      // leave the gun unlit for the entire burn, which is exactly the "the gun
      // takes zero bounce from the spell in its own hands" note.
      //
      // It ramps with the wind-up, then holds while the column is standing.
      const power = Math.max(state.charge * 0.55, this._fired ? 1 : 0);
      this.ctx.lights.set(
        this.muzzleLight,
        state.origin,
        getColor(c.lightColor),
        c.muzzleLightIntensity * power * fade * this.lightShimmer(),
        c.muzzleLightRadius,
        dt
      );
    }

    /* --- the particle systems, all four of them --- */
    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.glow * 0.6 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 1.1 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * The wind-up: light pulled *inward* out of the air and swallowed by the orb.
   *
   * This is the same mote system the column sheds later, thrown the other way —
   * emitted on a shell around the hands with its velocity pointing at them. The
   * batches are small and their directions independent, because a single
   * direction per frame reads as a stream rather than as an intake.
   */
  _intakeFx(dt) {
    const c = settings.beam;
    const g = settings.global;
    const charge = this.charge;
    const time = frame.uTime.value;

    let count = Math.round(this.intakeEmitter.tick(dt, c.intakeRate * (0.35 + charge)) * g.particleCount);
    if (count <= 0) return;

    this._handPoint(_target);
    _emit.radius = 0.12;
    _emit.speedVariance = 0.35;
    _emit.spread = 0.12;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.lifeVariance = 0.3;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;

    // The shell tightens as the orb fills, so the intake visibly closes in.
    const shell = c.intakeRadius * lerp(1, 0.45, charge);
    const per = Math.max(1, Math.round(count / 6));

    while (count > 0) {
      const theta = Math.random() * TAU;
      const phi = Math.acos(randRange(-1, 1));
      const s = Math.sin(phi);
      _dir.set(s * Math.cos(theta), Math.cos(phi) * 0.7, s * Math.sin(theta)).normalize();

      _pos.copy(_target).addScaledVector(_dir, shell * randRange(0.7, 1.15));
      _emit.position = _pos;
      _emit.direction = _dir.multiplyScalar(-1);
      _emit.speed = c.intakeSpeed;
      _emit.life = (shell / Math.max(0.5, c.intakeSpeed)) * 1.5;
      this.motes.emit(Math.min(per, count), _emit);
      count -= per;
    }
  }

  /** The release: the orb lets go and the column is thrown out of it. */
  _releaseFx() {
    const c = settings.beam;
    const g = settings.global;

    // The pressure shell is pushed a little further down the barrel than the
    // orb sits. A shell centred exactly on the muzzle expands *through* the
    // camera within two frames, and once the eye is inside it the far wall is
    // drawn across the entire screen — which is what turned this ability into
    // a white sphere covering most of the frame. `BurstSphere` now fades
    // geometry that has wrapped around the eye, and putting the centre ahead
    // of the hand means it mostly never gets there.
    this.muzzlePoint(_pos, 2.2);

    // A pressure shell rather than a fireball — nothing burns here, the air is
    // simply shoved out of the way.
    //
    // Held faint and rim-tight for the same reason as the bolt's: a shell this
    // close to the eye subtends 20-30 degrees, and the AIR mode's alpha is pure
    // fresnel, so at a low exponent and full opacity it is a hard bright circle
    // beside the weapon rather than a puff of shoved air.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.3,
      fresnel: 3.4,
      displace: 0.35,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstC)
    });

    /*
     * There is deliberately NO floor shockwave at the caster's feet.
     *
     * The third-person sandbox put one at `this.origin` and it was the right
     * call there: the camera looked down at the character, so a ring shoving
     * dust away from their feet was a readable beat. In first person you cannot
     * see your own feet, the floor beneath you is at a grazing angle, and a
     * decal is a flat quad — so all that ring can draw is a hard thin circle
     * lying on the ground in the near field, which is the single most obvious
     * "this is a sprite stuck to the floor" tell available. Moving it downrange
     * does not help; it is simply not a shot that exists in this camera.
     *
     * The release now reads through the pressure shell, the sparks, the screen
     * flash and the light on the weapon, all of which survive the change of
     * viewpoint.
     */

    _emit.position = _pos;
    _emit.radius = 0.22;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(70 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.ctx.shake.add(
      c.impactShake * 0.45 * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      30
    );
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  /**
   * What the column sheds along its length.
   * @param {number} scale 0..1 — thinned out as the beam collapses
   */
  _columnFx(dt, scale) {
    const c = settings.beam;
    const g = settings.global;
    const time = frame.uTime.value;
    // Only the drawn part of the column is allowed to throw anything.
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

    let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
      while (sparkCount > 0) {
        const s = randRange(0.04, 1) * reach;
        const radius = this._beamRadius(s);
        this._radialAt(Math.random() * TAU, _radial);
        this._axisPoint(s, _pos).addScaledVector(_radial, radius * randRange(0.8, 1.25));

        _emit.position = _pos;
        _emit.radius = radius * 0.3;
        // Thrown off the surface, then dragged downrange by the flow. This is
        // the read that says "pressure", and it is the one thing the sparks
        // must not share with the bolt's, which fall.
        _emit.direction = _dir
          .copy(_radial)
          .addScaledVector(this.direction, c.sparkForward)
          .normalize();
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const s = Math.random() * reach;
      this._axisPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = this._beamRadius(s) * 2.2;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      // Steam comes off the *floor*, not the column, and is blown out sideways
      // from under it rather than lifted.
      const s = Math.random() * reach;
      this.pointAt(s, _pos).setY(0.12);
      this._radialAt(randRange(0, TAU), _radial).setY(Math.abs(_radial.y) * 0.35);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 1.6;
      _emit.direction = _dir.copy(_radial).normalize();
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.55;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    const debrisCount = Math.round(this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount);
    if (debrisCount > 0) {
      this.pointAt(Math.random() * reach, _pos).setY(0.06);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 1.4;
      // Thrown outward far more than up: a chip kicked vertically hangs at its
      // apex above eye level with nothing behind it, which reads as floating
      // litter rather than as something torn off the floor.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.55).normalize();
      _emit.speed = c.debrisSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.8;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.debrisLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.time = time;
      this.debris.emit(debrisCount, _emit);
    }
  }

  /**
   * Burns laid on the floor as the leading edge passes over it.
   *
   * As in `ThunderAbility#_groundFx`: the metres nearest the player lay nothing,
   * because a flat decal disc that close to the eye is seen almost edge-on and
   * reads as a bright hoop across the weapon rather than as a mark on the floor.
   */
  _groundFx() {
    const c = settings.beam;
    const step = 1 / Math.max(0.05, c.scorchRate);
    const skip = Math.min(this.length * 0.5, c.groundStart ?? 0);

    while (this.front - this._burnDistance >= step) {
      this._burnDistance += step;
      if (this._burnDistance < skip) continue;
      const s = saturate(this._burnDistance / this.length);
      this.pointAt(s, _pos);
      // Jittered off the axis so the line does not read as a row of stamps.
      const wander = this._beamRadius(s) * 0.5;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.8, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorEmber),
        height: 0.015
      });
    }
  }

  /**
   * What the far end does while the beam stands on it.
   *
   * This is the half of the ability the other three do not have: an impact that
   * keeps happening. Sparks are thrown *back* up the beam, pressure shells are
   * shed off the burning point, and dust and shockwave rings are pushed out
   * across the floor — all rate-throttled, so they are frame-rate independent
   * and every rate is a live slider.
   *
   * @param {number} scale 0..1 — thinned out as the beam collapses
   */
  _burnFx(dt, scale) {
    const c = settings.beam;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_pos);
    this.pointAt(1, _target);

    const splash = Math.round(this.splashEmitter.tick(dt, c.splashRate * scale) * g.particleCount);
    if (splash > 0) {
      _emit.position = _pos;
      _emit.radius = this._beamRadius(1) * 0.7;
      // Back up the line and upward: the wash coming off something being
      // drilled, not an explosion leaving it.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.65).setY(0.75).normalize();
      _emit.speed = c.sparkSpeed * 1.4;
      _emit.speedVariance = 0.9;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.8;
      _emit.life = c.sparkLifetime * 1.2;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(splash, _emit);
    }

    if (this.pulseEmitter.tick(dt, c.pulseRate * scale) > 0) {
      this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
        radius: c.pulseSize * 0.25,
        endRadius: c.pulseSize * g.explosionIntensity,
        life: 0.32,
        intensity: c.pulseIntensity,
        opacity: 0.16,
        fresnel: 2.8,
        displace: 0.22,
        squash: 0.6,
        colorA: getColor(c.colorBurstA),
        colorB: getColor(c.colorBurstC)
      });
      this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.2 * g.explosionIntensity);
    }

    if (this.dustEmitter.tick(dt, c.dustRate * scale) > 0) {
      this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
        radius: c.dustRadius * randRange(0.75, 1.15),
        life: c.dustLife,
        intensity: 0.7,
        colorA: getColor(c.colorDustA),
        colorB: getColor(c.colorDustB),
        height: 0.02
      });
    }

    if (this.shockEmitter.tick(dt, c.shockRate * scale) > 0) {
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
        radius: c.shockRadius * 0.55 * g.explosionIntensity,
        life: 0.45,
        width: 0.04,
        intensity: 0.8,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.beam;
    const g = settings.global;

    this._syncUniforms(dt, 1, 1);

    if (this.age < c.charge) {
      // Still winding up. The camera frames the caster, not the empty line.
      this._handPoint(this.position);
      this._intakeFx(dt);
      this.ctx.shake.rumble(c.chargeShake * this.charge * g.cameraShake, dt);
      return;
    }

    if (!this._fired) {
      this._fired = true;
      this._releaseFx();
    }

    // The light rides the leading edge, not the floor under it. `advance()` has
    // already put `position` on the ground line, so lift it onto the axis.
    this._axisPoint(this.u, this.position);

    this._columnFx(dt, 1);
    this._groundFx();
    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.beam;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_pos);
    this.pointAt(1, _target);

    /*
     * The shell of compressed air where it grounded out.
     *
     * A shell is the wrong primary read for a *beam* impact and it is worth
     * being explicit about why, because it is what kept this frame looking like
     * a cotton ball. An explosion is a volume of hot gas expanding in every
     * direction, so a sphere is the shape of it. A beam terminus is a point
     * being drilled: the energy arrives along one axis and leaves along the
     * surface. What sells it is the ground ring, the scorch, the spray coming
     * back up the beam and the white-hot end of the column itself — all of which
     * this ability already draws.
     *
     * So the shell is demoted to what it should always have been: a fast, thin,
     * mostly-transparent pressure edge that snaps out and is gone, breaking the
     * silhouette rather than being one. Low opacity, low displacement (a lumpy
     * silhouette reads as a cloud), and squashed toward the floor because the
     * air has a floor to go along.
     */
    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.18,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.burstIntensity,
      opacity: 0.14,
      fresnel: 3.2,
      displace: 0.2,
      squash: 0.45,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.65,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a wide scorch under the burning point */
    this.ctx.decals.spawn(DecalType.SCORCH, _target, {
      radius: c.scorchRadius * 3.2,
      life: c.scorchLife * 1.4,
      intensity: c.scorchIntensity * 1.4,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
      radius: c.dustRadius * 1.8,
      life: c.dustLife * 1.6,
      intensity: 0.85,
      colorA: getColor(c.colorDustA),
      colorB: getColor(c.colorDustB),
      height: 0.02
    });

    /* sparks and chips blown out of the strike */
    _emit.position = _pos;
    _emit.radius = 0.35;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.35).setY(0.85).normalize();
    _emit.speed = c.sparkSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.6;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _target;
    _emit.radius = c.scorchRadius * 2.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed * 1.9;
    _emit.spread = 0.85;
    _emit.size = 0.14;
    _emit.life = c.debrisLifetime * 1.3;
    _emit.spin = 11;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.smokeLifetime * 1.2;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(55 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.beam;
    const g = settings.global;

    // `t` runs 0..1 while the beam burns, then 1..2 while it collapses.
    let fade = 1;
    let widthFade = 1;
    if (t > 1) {
      const k = saturate(t - 1);
      // Brightness hangs on and then goes; the *width* pinches early. Together
      // they read as the column snapping back to a thread and blinking out,
      // rather than as a fat beam dimming.
      fade = 1 - Easing.inCubic(k);
      widthFade = Math.max(0.04, 1 - Easing.outCubic(k) * 0.94);
    }

    this._syncUniforms(dt, fade, widthFade);

    // The light stays on the burning point once the front has arrived.
    this._axisPoint(1, this.position);

    const scale = t <= 1 ? 1 : fade * 0.5;
    this._columnFx(dt, scale * 0.85);
    this._burnFx(dt, scale);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * g.cameraShake, dt);
  }

  onDestroy() {
    this.ctx.lights.release(this.muzzleLight);
    this.muzzleLight = null;
    this._coilCount = 1;
    this._ringCount = 1;
    this.coilGeometry.instanceCount = 1;
    this.ringGeometry.instanceCount = 1;
    for (const material of this.materials) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uCharge.value = 0;
    }
  }

  dispose() {
    this.tubeGeometry.dispose();
    this.coilGeometry.dispose();
    this.ringGeometry.dispose();
    this.orbGeometry.dispose();
    for (const material of this.materials) material.dispose();
    super.dispose();
  }
}
