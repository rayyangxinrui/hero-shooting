import { Vector3, Euler, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { saturate } from '../utils/math.js';

const _wish = new Vector3();
const _flatVel = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();

/**
 * Source-style first-person movement.
 *
 * The one thing that makes this feel like a shooter rather than like a camera
 * on a spring is `_accelerate`: ground acceleration is not added to velocity,
 * it is *projected* against it and clamped to what is left of the target speed.
 * Holding forward into a wall therefore gains nothing, while turning and
 * strafing gains a lot — which is the entire skill floor of CS movement, and it
 * falls out of four lines rather than out of a state machine.
 *
 * Collision is a swept capsule against the arena's colliders, resolved by
 * three passes of push-out. Three is not arbitrary: one pass leaves you stuck
 * on inside corners, two leaves you stuck where three planes meet, and the
 * third has never been observed to still be penetrating in this arena.
 */
export class PlayerController {
  constructor(collider) {
    this.collider = collider;

    this.position = new Vector3(0, settings.player.height, 6);
    this.velocity = new Vector3();
    this.euler = new Euler(0, 0, 0, 'YXZ');

    this.onGround = false;
    this.crouching = false;
    this.crouchT = 0;
    this.sprinting = false;
    this.eyeHeight = settings.player.height;

    /* --- what the body does to the camera --- */
    this.bobPhase = 0;
    this.bobOffset = new Vector3();
    this.viewRoll = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.stepDistance = 0;
    this.speed = 0;

    /** Set by the weapon system; added to the look angles and decayed here. */
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this._wasGround = true;
    this._fallSpeed = 0;
    this._events = new Map();
  }

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(handler);
    return this;
  }

  _emit(event, ...args) {
    const list = this._events.get(event);
    if (list) for (const handler of list) handler(...args);
  }

  /* ------------------------------------------------------------------ */

  /** Mouse delta in pixels. */
  look(dx, dy) {
    const p = settings.player;
    const sensitivity = p.sensitivity * (this.zoomScale ?? 1);
    this.euler.y -= dx * sensitivity;
    this.euler.x -= dy * sensitivity;
    this.euler.x = MathUtils.clamp(this.euler.x, -p.maxPitch, p.maxPitch);
  }

  /** Recoil is applied to the *view*, and the view falls back toward zero. */
  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.euler.x = MathUtils.clamp(this.euler.x + pitch, -settings.player.maxPitch, settings.player.maxPitch);
    this.euler.y += yaw;
  }

  /** Yaw+pitch including the un-recovered recoil, for the shot direction. */
  getViewDirection(out) {
    out.set(0, 0, -1).applyEuler(this.euler);
    return out;
  }

  get eyePosition() {
    return this.position;
  }

  /* ------------------------------------------------------------------ */

  update(dt, input) {
    if (dt <= 0) return;
    const p = settings.player;

    /* ---- stance ---- */
    const wantsCrouch = input.crouch;
    this.crouching = wantsCrouch;
    const crouchTarget = wantsCrouch ? 1 : 0;
    const crouchRate = dt / Math.max(0.001, p.crouchTime);
    this.crouchT = MathUtils.clamp(
      this.crouchT + Math.sign(crouchTarget - this.crouchT) * crouchRate,
      0,
      1
    );
    const standHeight = MathUtils.lerp(p.height, p.crouchHeight, this.crouchT);

    _flatVel.set(this.velocity.x, 0, this.velocity.z);
    this.speed = _flatVel.length();

    this.sprinting =
      input.sprint && !wantsCrouch && this.onGround && input.forward > 0.1 && this.speed > 1.5;

    /* ---- wish direction, in the yaw frame only (pitch must not move you) ---- */
    _forward.set(-Math.sin(this.euler.y), 0, -Math.cos(this.euler.y));
    _right.set(Math.cos(this.euler.y), 0, -Math.sin(this.euler.y));
    _wish
      .set(0, 0, 0)
      .addScaledVector(_forward, input.forward)
      .addScaledVector(_right, input.strafe);
    if (_wish.lengthSq() > 1) _wish.normalize();

    let maxSpeed = p.runSpeed;
    if (wantsCrouch) maxSpeed = p.crouchSpeed;
    else if (input.walk) maxSpeed = p.walkSpeed;

    /* ---- ground vs air ---- */
    if (this.onGround) {
      this._friction(dt, p);
      this._accelerate(_wish, maxSpeed, p.accelerate, dt);

      if (input.jump) {
        this.velocity.y = p.jumpVelocity;
        this.onGround = false;
        this._emit('jump');
      }
    } else {
      // Air acceleration is deliberately huge and deliberately capped by the
      // projection inside `_accelerate` — that pair is what air-strafing is.
      this._accelerate(_wish, p.airSpeed, p.airAccelerate, dt);
      this.velocity.y += p.gravity * dt;
    }

    /* ---- integrate + collide ---- */
    this._fallSpeed = this.velocity.y;
    const radius = p.radius;
    const wasGround = this.onGround;

    this.position.addScaledVector(this.velocity, dt);
    const result = this.collider.resolve(this.position, radius, standHeight, this.velocity);
    this.onGround = result.onGround;

    if (this.onGround && !wasGround) {
      const impact = Math.min(1, Math.abs(this._fallSpeed) / 12);
      const dip = MathUtils.lerp(p.landPunch, p.landPunchHeavy, impact);
      this.landDipVel -= dip * 26;
      this._emit('land', impact);
    }

    /* ---- view bob, roll and the landing dip ---- */
    _flatVel.set(this.velocity.x, 0, this.velocity.z);
    this.speed = _flatVel.length();

    const moveRatio = saturate(this.speed / p.runSpeed);
    if (this.onGround) {
      this.bobPhase += dt * p.bobSpeed * moveRatio;
      this.stepDistance += this.speed * dt;
      if (this.stepDistance >= p.stepInterval) {
        this.stepDistance = 0;
        if (moveRatio > 0.25) this._emit('step', moveRatio);
      }
    }

    const bobStrength = p.bobAmount * moveRatio * (wantsCrouch ? 0.5 : 1);
    // Vertical bobs at twice the lateral rate: one lateral sway per stride,
    // two vertical dips (one per foot). Getting this backwards is what makes a
    // bob read as a boat.
    this.bobOffset.set(
      Math.cos(this.bobPhase) * bobStrength,
      Math.sin(this.bobPhase * 2) * bobStrength * 0.6,
      0
    );

    // Bank into a strafe, using the lateral component of velocity in view space.
    const lateral = _flatVel.dot(_right) / Math.max(0.001, p.runSpeed);
    const rollTarget = -lateral * MathUtils.degToRad(p.strafeRoll);
    this.viewRoll += (rollTarget - this.viewRoll) * Math.min(1, p.strafeRollSpeed * dt);

    // Critically-damped spring, written out rather than lerped: a lerp on the
    // landing dip cannot overshoot, and the overshoot is the impact.
    const stiffness = 190;
    const damping = 21;
    this.landDipVel += (-this.landDip * stiffness - this.landDipVel * damping) * dt;
    this.landDip += this.landDipVel * dt;

    this.eyeHeight = standHeight;

    /* ---- recoil recovery ---- */
    const recovery = this.recoilRecovery ?? 7;
    const decay = Math.exp(-recovery * dt);
    const pitchBack = this.recoilPitch * (1 - decay);
    const yawBack = this.recoilYaw * (1 - decay);
    this.euler.x -= pitchBack;
    this.euler.y -= yawBack;
    this.recoilPitch -= pitchBack;
    this.recoilYaw -= yawBack;
  }

  /**
   * Quake/Source ground friction: constant deceleration above `stopSpeed`,
   * and a floor below it so you actually come to rest instead of asymptoting.
   */
  _friction(dt, p) {
    _flatVel.set(this.velocity.x, 0, this.velocity.z);
    const speed = _flatVel.length();
    if (speed < 0.0001) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const control = Math.max(speed, p.stopSpeed);
    const drop = control * p.friction * dt;
    const scale = Math.max(0, speed - drop) / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  /**
   * The projection. `current` is how much of the target speed we already have
   * *in the wish direction*; only the remainder can be added. On the ground
   * that is an ordinary speed cap. In the air, where `maxSpeed` is tiny but
   * `accel` is huge, turning the wish direction sideways to the velocity keeps
   * `current` near zero forever — so every frame adds its full slice and the
   * player accelerates by steering. That is air-strafing, and it is emergent.
   */
  _accelerate(wish, maxSpeed, accel, dt) {
    const wishSpeed = wish.length() * maxSpeed;
    if (wishSpeed < 0.0001) return;

    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = wishSpeed - current;
    if (add <= 0) return;

    const accelSpeed = Math.min(accel * wishSpeed * dt, add);
    this.velocity.x += wish.x * accelSpeed;
    this.velocity.z += wish.z * accelSpeed;
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }
}
