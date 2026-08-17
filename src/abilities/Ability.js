import { Group, Vector3, Color } from 'three';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

export const AbilityPhase = Object.freeze({
  IDLE: 'idle',
  TRAVEL: 'travel',
  IMPACT: 'impact',
  FADE: 'fade',
  DONE: 'done'
});

const _up = new Vector3(0, 1, 0);

/* Scratch for the first-person muzzle frame. Module-level so `muzzlePoint`
 * allocates nothing however many casts are in the air. */
const _camRight = new Vector3();
const _camUp = new Vector3();
const _camFwd = new Vector3();

/**
 * Abstract base for a linear skillshot.
 *
 * The sandbox used to cast along a freehand spline; it now casts along a **line**
 * chosen with the aim indicator, so this base is correspondingly small. What it
 * still owns, because every ability wants it and none of them should re-derive
 * it:
 *
 *   - the phase machine (travel → impact → fade → done)
 *   - a front that advances along the line at a constant metres-per-second,
 *     frame-rate independent and eased off a standstill
 *   - the local frame (`direction`, `side`) every effect places itself in
 *   - dynamic light bookkeeping, including a decaying impact punch
 *   - the pooling contract: `spawn` must fully reset state, `destroy` must
 *     release, and neither may allocate
 *
 * Subclasses implement: `createShaders`, `createParticles`, `onSpawn`,
 * `onTravel`, `onImpact`, `onFade`, `onDestroy`.
 *
 * A second ability is therefore one new file plus a settings block — nothing
 * else in the project changes.
 */
export class Ability {
  /**
   * @param {string} element  key into `settings` ('ice')
   * @param {object} context  shared systems (see AbilityManager)
   */
  constructor(element, context) {
    this.element = element;
    this.ctx = context;

    this.group = new Group();
    this.group.name = `Ability:${element}`;
    this.group.layers.set(LAYER.VFX);
    this.group.matrixAutoUpdate = false;

    this.phase = AbilityPhase.IDLE;

    /** Where the cast came from, on the floor. */
    this.origin = new Vector3();
    /**
     * Where the crosshair actually landed, in 3-D.
     *
     * `origin`/`direction`/`length` describe the cast as a line *on the floor*,
     * which is what every ground effect is placed against. That flattening is
     * lossless for a scorch mark and badly lossy for anything the player is
     * looking straight at: a beam that ends at the floor line ends a metre
     * below the crosshair, and one that ends at a fixed `endHeight` ends a
     * metre above it. `FPSAbilityManager` fills this in with the real hit
     * point, so an ability that wants to terminate *where the player aimed* can.
     * Defaults to the far end of the floor line, which is what the third-person
     * sandbox assumed.
     */
    this.aimPoint = new Vector3();
    /** Unit heading, flat. */
    this.direction = new Vector3(0, 0, 1);
    /** Unit lateral, `direction × up`. */
    this.side = new Vector3(1, 0, 0);
    /** How far the cast reaches, metres. */
    this.length = 1;

    /** Metres the fracture front has travelled. */
    this.front = 0;
    /** That front as a fraction of `length`. */
    this.u = 0;
    /** World position of the front — what the camera frames. */
    this.position = new Vector3();

    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;

    this.light = null;
    this.lightColor = new Color();
    /** Transient additive light punch (impacts). Decays on its own. */
    this.lightBoost = 0;

    this.createShaders();
    this.createParticles();
  }

  /** Live settings block for this element. */
  get config() {
    return settings[this.element];
  }

  get isActive() {
    return this.phase !== AbilityPhase.IDLE && this.phase !== AbilityPhase.DONE;
  }

  get isFinished() {
    return this.phase === AbilityPhase.DONE;
  }

  /** Instanced geometry this cast is currently drawing. HUD readout only. */
  get instanceCount() {
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* Subclass hooks                                                      */
  /* ------------------------------------------------------------------ */

  /** Build materials/meshes once, at construction. */
  createShaders() {}

  /** Register the shared particle systems this element needs. */
  createParticles() {}

  /** Called at the start of every cast, after the base state was reset. */
  onSpawn() {}

  /** Per-frame while the front is still travelling. */
  onTravel(_dt) {}

  /** One-shot when the front reaches the end of the line. */
  onImpact() {}

  /**
   * Per-frame after the impact.
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade.
   */
  onFade(_dt, _t) {}

  /** Release any per-cast resources. */
  onDestroy() {}

  /** How long the impact and fade phases last. Overridable per element. */
  get impactDuration() {
    return 1.1;
  }

  get fadeDuration() {
    return 1.2;
  }

  /**
   * Per-frame multiplier on the dynamic light's intensity.
   *
   * The default is a slow shimmer rather than a flicker: ice glints, it does not
   * gutter. Elements that *should* gutter override this.
   */
  lightShimmer() {
    return 0.9 + 0.1 * Math.sin(this.age * 9.3) * Math.sin(this.age * 3.7);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Begin a cast.
   *
   * @param {THREE.Vector3} origin     on the floor
   * @param {THREE.Vector3} direction  unit, flat
   * @param {number} distance          metres
   */
  spawn(origin, direction, distance) {
    this.origin.set(origin.x, 0, origin.z);
    this.direction.copy(direction).setY(0).normalize();
    this.side.crossVectors(this.direction, _up).normalize();
    this.length = Math.max(0.1, distance);
    // Default: the far end of the floor line. `FPSAbilityManager` replaces this
    // with the crosshair's real hit point immediately after `spawn`.
    this.pointAt(1, this.aimPoint);

    this.front = 0;
    this.u = 0;
    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;
    this.lightBoost = 0;
    this.phase = AbilityPhase.TRAVEL;

    this.position.copy(this.origin);
    this.light = this.ctx.lights.acquire();

    this.group.visible = true;
    this.onSpawn();
  }

  /** A point on the cast line. `s` is 0..1 along it. */
  pointAt(s, out) {
    return out.copy(this.origin).addScaledVector(this.direction, s * this.length);
  }

  /**
   * Where the spell leaves the *player*, in first person.
   *
   * The sandbox this came from measured the hand from the caster's feet in a
   * third-person frame: `handHeight` metres up, `handForward` metres along the
   * cast. That is exactly wrong once the camera is the head. Those offsets put
   * the muzzle roughly 0.6 m in front of the eye and slightly below it — so a
   * 0.55 m flare there subtends about 50° of screen and reads as a white dome
   * over the whole left of the frame, which is precisely what it was doing.
   *
   * In first person the hand is not a point on the floor at all; it is a point
   * in *view space*, down and to the right of the crosshair, and it has to
   * track the camera's roll and pitch or the flash detaches from the weapon.
   * So the offsets are reinterpreted rather than reused:
   *
   *   - `handSide`    → metres right of the view axis
   *   - `handHeight`  → now read as a *drop below the eye* via `muzzleDrop`
   *   - `handForward` → metres down the view axis
   *
   * Keeping the names means the tuning surface and the settings contract are
   * untouched; only the frame they are resolved in changes. Values are still
   * sampled every frame, never snapshotted.
   *
   * @param {THREE.Vector3} out
   * @param {number} [forwardScale] pushes the point further downrange, used by
   *   effects that must clear the near plane by more than the flare does.
   */
  muzzlePoint(out, forwardScale = 1) {
    const c = this.config;
    const camera = this.ctx.camera;

    if (!camera) {
      // No camera in context (headless tests): fall back to the floor frame.
      out
        .copy(this.origin)
        .addScaledVector(this.direction, c.handForward * forwardScale)
        .addScaledVector(this.side, c.handSide);
      out.y = c.handHeight;
      return out;
    }

    camera.getWorldPosition(out);
    camera.getWorldDirection(_camFwd);
    // Right and up are taken off the camera basis rather than from world up, so
    // the muzzle rides the view's roll — a flash pinned to world up visibly
    // slides across the screen the moment the view banks.
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    const drop = c.muzzleDrop ?? 0.3;
    const side = c.handSide ?? 0;
    // `handSide` is signed off the cast's lateral in the source frame; in first
    // person the hand is on the weapon side, so its magnitude is what matters.
    const right = c.muzzleSideAbs === false ? side : Math.abs(side) + 0.22;

    return out
      .addScaledVector(_camFwd, Math.max(0.12, c.handForward) * forwardScale)
      .addScaledVector(_camRight, right)
      .addScaledVector(_camUp, -drop);
  }

  /**
   * Advance the front. Delta-time driven, so the eruption travels at a constant
   * metres-per-second regardless of frame rate or how long the cast is.
   *
   * @returns {boolean} true on the frame the front reaches the end
   */
  advance(dt) {
    const speed = this.config.speed * settings.global.speed;
    // Ease off the standstill so the front has weight. Keyed off elapsed time
    // rather than progress: keying it off `u` would multiply the very first step
    // by zero and the front could never leave the caster.
    const easeIn = Easing.outQuad(saturate(this.age / 0.08));

    this.front += speed * easeIn * dt;
    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);

    return this.u >= 1 && previousU < 1;
  }

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;

    switch (this.phase) {
      case AbilityPhase.TRAVEL: {
        const reachedEnd = this.advance(dt);
        this.onTravel(dt);
        this._updateLight(dt, 1);
        if (reachedEnd) {
          this.phase = AbilityPhase.IMPACT;
          this.impactTime = 0;
          this.onImpact();
        }
        break;
      }

      case AbilityPhase.IMPACT: {
        this.impactTime += dt;
        const t = saturate(this.impactTime / this.impactDuration);
        this.onFade(dt, t);
        this._updateLight(dt, 1 - Easing.inQuad(t) * 0.45);
        if (t >= 1) {
          this.phase = AbilityPhase.FADE;
          this.fadeTime = 0;
        }
        break;
      }

      case AbilityPhase.FADE: {
        this.fadeTime += dt;
        const t = saturate(this.fadeTime / this.fadeDuration);
        this.onFade(dt, 1 + t);
        this._updateLight(dt, (1 - t) * 0.35);
        if (t >= 1) this.phase = AbilityPhase.DONE;
        break;
      }

      default:
        break;
    }
  }

  _updateLight(dt, scale) {
    if (!this.light) return;
    const cfg = this.config;
    this.lightColor.copy(getColor(cfg.lightColor));
    const shimmer = this.lightShimmer();
    this.ctx.lights.set(
      this.light,
      this.position,
      this.lightColor,
      cfg.lightIntensity * scale * shimmer + this.lightBoost,
      cfg.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /** Return to the pool. Must leave the instance reusable. */
  destroy() {
    this.onDestroy();
    this.ctx.lights.release(this.light);
    this.light = null;
    this.group.visible = false;
    this.phase = AbilityPhase.IDLE;
  }

  /** Free GPU resources (app teardown only — not part of pooling). */
  dispose() {
    this.group.parent?.remove(this.group);
  }
}
