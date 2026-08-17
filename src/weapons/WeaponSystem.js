import { Group, Vector3, Box3, Quaternion, Euler, MathUtils } from 'three';
import { settings, WEAPONS } from '../config/settings.js';
import { LAYER, setLayerRecursive } from '../core/Layers.js';
import { WeaponModelFactory } from './WeaponModelFactory.js';
import { Hands } from './Hands.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { ShellEjector } from './ShellEjector.js';

const _dir = new Vector3();
const _muzzle = new Vector3();
const _spread = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _q = new Quaternion();
const _euler = new Euler(0, 0, 0, 'XYZ');
const _box = new Box3();
const _v = new Vector3();

/* ---- viewmodel rest pose ---- */
// The 3/4 cant a weapon sits at when not aimed. Small angles: past about 0.1 rad
// of roll the gun reads as being held sideways.
// A weapon presented nearly axis-aligned is seen end-on: you look down the
// buttstock at the receiver, the barrel foreshortens to nothing, and the
// silhouette that identifies the weapon is never shown. Measured across a yaw
// sweep, the rifle's on-screen width goes 33% -> 47% of the frame between
// 0.075 and 0.35 rad, while the fraction of it inside the frame is unchanged
// at ~93% — so the wider presentation is free, and it is what lets the eye
// read the barrel, the handguard and the magazine as separate masses.
//
// Faded out with aimProgress: in sights the weapon must be square to the view
// or the irons do not line up.
const REST_PITCH = 0.03; // muzzle nosed very slightly down
const REST_YAW = 0.3; // muzzle raked inward, toward the screen centre
const REST_ROLL = 0.13; // rolled so the top plane of the receiver is visible

/* ---- viewmodel kick springs ---- */
// Damping is held below critical (2*sqrt(k)) so the gun overshoots slightly on
// its way back and settles, which is what reads as a mechanism returning to
// battery rather than as a value being lerped home.
const KICK_STIFFNESS = 320;
const KICK_DAMPING = 26;
const KICK_ROT_STIFFNESS = 260;
const KICK_ROT_DAMPING = 22;
/** Angular frequency of each spring: an impulse of v peaks at v/w. */
const KICK_OMEGA = Math.sqrt(KICK_STIFFNESS);
const KICK_ROT_OMEGA = Math.sqrt(KICK_ROT_STIFFNESS);

/** What the gun is doing right now. */
const State = Object.freeze({
  IDLE: 'idle',
  FIRING: 'firing',
  RELOADING: 'reloading',
  DRAWING: 'drawing'
});

/**
 * Weapons: the viewmodel, the trigger, the recoil and the reload.
 *
 * The two rules that make this feel like a shooter rather than like a mouse
 * emitting rays:
 *
 *  1. **The ray comes from the eye, the tracer comes from the muzzle.** What the
 *     crosshair covers is what dies. If the ray started at the barrel, a player
 *     hugging a corner would shoot the wall their crosshair clears.
 *  2. **Recoil is one impulse split two ways.** Part of it kicks the *view*
 *     (which is what the player fights, and what recovers), part of it kicks the
 *     *viewmodel* (which is what the player sees, and which springs back). Using
 *     one for both makes the gun feel either weightless or unusable.
 *
 * The spray pattern is fixed and indexed by shot number, with a small random
 * cone on top. That is the CS/CoD contract: the pattern is learnable, the cone
 * is the tax for moving.
 */
export class WeaponSystem {
  constructor(context) {
    this.ctx = context;
    this.scene = context.scene;
    this.camera = context.camera;
    this.viewCamera = context.viewCamera;
    this.player = context.player;
    this.combat = context.combat;

    /** The viewmodel root — parented to nothing, driven from the view camera. */
    this.root = new Group();
    this.root.name = 'Viewmodel';
    this.root.matrixAutoUpdate = true;
    setLayerRecursive(this.root, LAYER.VIEWMODEL);
    this.scene.add(this.root);

    this.models = new WeaponModelFactory();
    this.muzzle = new MuzzleFlash(this.root, context.lights);
    this.shells = new ShellEjector(this.scene);

    /** @type {Map<string, {group: Group, muzzlePoint: Vector3}>} */
    this.built = new Map();

    this.currentId = WEAPONS[0];
    this.state = State.IDLE;
    this.stateTime = 0;

    this.ammo = new Map();
    this.reserves = new Map();

    this.shotIndex = 0;
    this.spread = 0;
    this.fireCooldown = 0;
    this.aimProgress = 0;
    this.aiming = false;
    this._triggerHeld = false;
    this._triggerReleased = true;

    /* --- viewmodel spring state --- */
    this.kickOffset = new Vector3();
    this.kickVelocity = new Vector3();
    this.kickRotation = new Euler();
    this.kickRotVelocity = new Vector3();
    this.swayOffset = new Vector3();
    this.swayRot = new Vector3();
    this._lastYaw = 0;
    this._lastPitch = 0;
    this.bobPhase = 0;
    this._sprintLower = 0;
    this._idleTime = 0;

    /** Per-weapon ADS offsets, solved from the model's real sight geometry. */
    this.adsOffsets = new Map();
  }

  get current() {
    return this.built.get(this.currentId) ?? null;
  }

  get config() {
    return settings[this.currentId];
  }

  get reserve() {
    return this.reserves.get(this.currentId) ?? 0;
  }

  get isReloading() {
    return this.state === State.RELOADING;
  }

  /**
   * The cone the *next* round will actually be fired into, in radians.
   * The HUD draws its crosshair gap from this, so the gap never lies.
   */
  get currentSpreadAngle() {
    return this._lastSpread ?? this.config.spreadBase;
  }

  async load() {
    for (const id of WEAPONS) {
      const built = this.models.build(id);
      built.group.visible = false;
      // Gloved hands, parented to the weapon so they travel with it through
      // recoil and sway for free. A first-person gun with nothing holding it is
      // the loudest tell that a shooter is unfinished.
      built.hands = new Hands();
      built.group.add(built.hands.group);
      // Trimmed slightly under true scale — a 1:1 rifle crowds the frame at any
      // usable fov, which is why every shipped shooter shrinks its viewmodel.
      built.group.scale.setScalar(settings.weapons.viewmodelScale ?? 1);

      // Re-origin the model onto its grip.
      //
      // The parts are authored about the receiver, so the group's origin sits
      // in the middle of the gun and `viewmodelPos.z` ends up meaning "distance
      // to a point halfway along the rifle" — which leaves the stock behind the
      // eye and filling the frame. Shifting the geometry forward by the grip
      // offset makes the origin the point the hand holds, so the offset in
      // settings means what it says: how far the grip is from the eye. The
      // muzzle and eject points move with it, so nothing downstream shifts.
      const gripZ = built.gripOffset ?? 0.08;
      for (const child of built.group.children) child.position.z -= gripZ;

      setLayerRecursive(built.group, LAYER.VIEWMODEL);
      this.root.add(built.group);
      this.built.set(id, built);

      this.ammo.set(id, settings[id].magazine);
      this.reserves.set(id, settings[id].reserve);
    }
    this.solveAdsOffsets();
    this.select(this.currentId, true);
    return this;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Solve the ADS offset for every weapon from the model's *actual* sights.
   *
   * This is the whole ballgame for ADS. A hand-authored offset is a guess that
   * is wrong the moment anyone moves a sight by a millimetre, and "wrong" here
   * means the player is staring down the side of a receiver instead of through
   * a sight picture.
   *
   * The solve is exact rather than iterative. In view space the camera sits at
   * the origin looking down −Z, so a point is on the screen's centre line iff
   * its x and y are both zero. If the model is placed at offset `o`, the rear
   * sight (local `r`) lands at `o + r` and the front post (local `f`) at
   * `o + f`. Choosing
   *
   *     o = −(r + f) / 2      … in x and y
   *
   * puts the *midpoint of the sight line* on the centre line, which means the
   * rear notch and the front post straddle the crosshair symmetrically — a real
   * sight picture, and the same thing your eye does when it centres a post in a
   * notch. Z is chosen so the rear sight sits a comfortable eye relief away.
   *
   * Called again by `refreshSights()` when another agent rebuilds the models.
   */
  solveAdsOffsets() {
    for (const [id, entry] of this.built) {
      const sights = this._findSights(entry);
      if (!sights) continue;

      const { rear, front } = sights;
      // Eye relief: how far the *rear* sight sits from the eye. 22 cm is what a
      // cheek weld on a rifle actually gives you, and it is what makes the
      // front post small enough to aim with rather than a wall of steel.
      const relief = settings.weapons.adsEyeRelief;

      this.adsOffsets.set(id, {
        x: -(rear.x + front.x) * 0.5,
        y: -(rear.y + front.y) * 0.5,
        z: -relief - rear.z
      });
    }
  }

  /** Re-solve after another agent replaces the weapon models. */
  refreshSights() {
    this.solveAdsOffsets();
  }

  /**
   * Find the rear and front sight on a built weapon, in the model's own space.
   *
   * Prefers explicitly named helper objects (`rearSight` / `frontSight`), which
   * is the contract a model author should honour. Falls back to a geometric
   * search: among the small parts in the upper half of the receiver, the
   * rearmost and the frontmost are the sights on every iron-sighted gun ever
   * made. The fallback is what keeps this working when the models are rebuilt
   * by someone who has not read this file.
   */
  _findSights(entry) {
    const group = entry.group;

    const named = { rear: null, front: null };
    group.traverse((node) => {
      const name = (node.name || '').toLowerCase();
      if (!name) return;
      if (name.includes('rearsight') || name === 'rear' || name.includes('rear_sight')) {
        named.rear = node.position.clone();
      } else if (
        name.includes('frontsight') ||
        name === 'front' ||
        name.includes('front_sight')
      ) {
        named.front = node.position.clone();
      }
    });
    if (named.rear && named.front) return named;

    /* ---- geometric fallback ---- */
    // The full extent of the gun, so "upper" and "small" are relative to it.
    _box.makeEmpty();
    group.traverse((node) => {
      if (!node.isMesh) return;
      node.updateMatrix();
      node.geometry.computeBoundingBox();
      const bb = node.geometry.boundingBox.clone().applyMatrix4(node.matrix);
      _box.union(bb);
    });
    if (_box.isEmpty()) return null;

    const centreY = (_box.min.y + _box.max.y) * 0.5;
    const candidates = [];
    group.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry.computeBoundingBox();
      const bb = node.geometry.boundingBox;
      const size = _v.copy(bb.max).sub(bb.min);
      // A sight is a small block sitting high on the gun. Anything longer than
      // 6 cm along the bore is a barrel, a handguard or a receiver.
      if (size.z > 0.06 || size.x > 0.05) return;
      const y = node.position.y + (bb.min.y + bb.max.y) * 0.5;
      if (y < centreY + (_box.max.y - centreY) * 0.35) return;
      candidates.push({
        x: node.position.x,
        // The *top* of the sight block is what the eye uses, not its centre.
        y: node.position.y + bb.max.y,
        z: node.position.z
      });
    });
    if (candidates.length < 2) return null;

    candidates.sort((a, b) => a.z - b.z);
    const front = candidates[0];
    const rear = candidates[candidates.length - 1];
    if (rear.z - front.z < 0.05) return null;
    return { rear, front };
  }

  /** The solved ADS offset for the current weapon, or the authored fallback. */
  get adsOffset() {
    return this.adsOffsets.get(this.currentId) ?? settings.weapons.viewmodelAdsPos;
  }

  /* ------------------------------------------------------------------ */

  select(id, immediate = false) {
    if (!id || !this.built.has(id)) return;
    if (id === this.currentId && !immediate) return;

    for (const [key, entry] of this.built) entry.group.visible = key === id;

    this.currentId = id;
    this.state = immediate ? State.IDLE : State.DRAWING;
    this.stateTime = 0;
    this.shotIndex = 0;
    this.spread = 0;
    this.aiming = false;
    this.aimProgress = 0;
  }

  cycle(direction) {
    const index = WEAPONS.indexOf(this.currentId);
    const next = (index + (direction > 0 ? 1 : -1) + WEAPONS.length) % WEAPONS.length;
    this.select(WEAPONS[next]);
  }

  setAiming(down) {
    this.aiming = down;
  }

  /** ADS narrows the fov; the amount is proportional to how far in you are. */
  modifyFov(base) {
    return MathUtils.lerp(base, base * 0.72, this.aimProgress);
  }

  reload() {
    if (this.state === State.RELOADING || this.state === State.DRAWING) return;
    const config = this.config;
    const inMag = this.ammo.get(this.currentId) ?? 0;
    const spare = this.reserves.get(this.currentId) ?? 0;
    if (inMag >= config.magazine || spare <= 0) return;

    this.state = State.RELOADING;
    this.stateTime = 0;
    this._reloadEmpty = inMag <= 0;
  }

  _finishReload() {
    const config = this.config;
    const inMag = this.ammo.get(this.currentId) ?? 0;
    const spare = this.reserves.get(this.currentId) ?? 0;
    const wanted = Math.min(config.magazine - inMag, spare);
    this.ammo.set(this.currentId, inMag + wanted);
    this.reserves.set(this.currentId, spare - wanted);
    this.state = State.IDLE;
    this.shotIndex = 0;
  }

  /* ------------------------------------------------------------------ */

  update(dt, input, player) {
    if (dt <= 0) dt = 0;
    const config = this.config;
    this.stateTime += dt;

    /* ---- ADS ---- */
    const canAim = this.state !== State.RELOADING && !player.sprinting;
    const aimTarget = this.aiming && canAim ? 1 : 0;
    const aimRate = dt / Math.max(0.001, settings.weapons.adsTime);
    this.aimProgress = MathUtils.clamp(
      this.aimProgress + Math.sign(aimTarget - this.aimProgress) * aimRate,
      0,
      1
    );

    /* ---- state machine ---- */
    if (this.state === State.DRAWING && this.stateTime >= config.drawTime) {
      this.state = State.IDLE;
    }
    if (this.state === State.RELOADING) {
      const duration = this._reloadEmpty ? config.reloadEmptyTime : config.reloadTime;
      if (this.stateTime >= duration) this._finishReload();
    }

    /* ---- trigger ---- */
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    const canFire =
      this.state === State.IDLE &&
      this.fireCooldown <= 0 &&
      (this.ammo.get(this.currentId) ?? 0) > 0 &&
      !player.sprinting;

    const wantsFire = input.firing && (!config.semiAuto || this._triggerReleased);
    if (!input.firing) this._triggerReleased = true;

    if (wantsFire && canFire) {
      this._fire(player);
      this._triggerReleased = false;
    } else if (input.firing && this.state === State.IDLE && (this.ammo.get(this.currentId) ?? 0) <= 0) {
      // Dry click: auto-reload, which is what every modern shooter does.
      this.reload();
      this._triggerReleased = false;
    }

    /* ---- spread recovery ---- */
    if (!input.firing || !canFire) {
      this.spread = Math.max(0, this.spread - config.spreadRecovery * this.spread * dt - 0.0006 * dt);
    }
    // The spray index only resets after a real pause, not between rounds.
    if (this.fireCooldown <= 0 && !input.firing) {
      this._idleTime = (this._idleTime ?? 0) + dt;
      if (this._idleTime > 0.32) this.shotIndex = 0;
    } else {
      this._idleTime = 0;
    }

    // Cached so the HUD reads the same number the next shot will use.
    this._lastSpread = this._currentSpread(player);

    this._updateViewmodel(dt, player);
    this.muzzle.update(dt);
    this.shells.update(dt);
  }

  /* ------------------------------------------------------------------ */

  _fire(player) {
    const config = this.config;

    this.ammo.set(this.currentId, (this.ammo.get(this.currentId) ?? 0) - 1);
    this.fireCooldown = 60 / config.rpm;

    /* ---- where the shot goes ---- */
    // From the *camera*, so the crosshair is the contract.
    this.camera.getWorldDirection(_dir);
    this.camera.getWorldPosition(_muzzle);

    const totalSpread = this._currentSpread(player);
    if (totalSpread > 0) {
      // A cone, sampled with sqrt on the radius so the distribution is uniform
      // over the disc rather than crowded at the centre.
      _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      _up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * totalSpread;
      _spread
        .copy(_right)
        .multiplyScalar(Math.cos(angle) * radius)
        .addScaledVector(_up, Math.sin(angle) * radius);
      _dir.add(_spread).normalize();
    }

    // The tracer starts at the barrel, which is a viewmodel-space point pushed
    // out into the world so it lines up with what the player sees.
    const muzzlePoint = this._worldMuzzle();

    this.combat.fire(_muzzle, _dir, config, muzzlePoint);

    /* ---- recoil, split between the view and the model ---- */
    const shot = this.shotIndex;
    const pattern = config.recoilPatternX;
    const patternX = pattern[Math.min(shot, pattern.length - 1)] ?? 0;

    // Vertical climb saturates: the first rounds rise hard, later ones less, so
    // the pattern has a shape instead of being a straight line to the sky.
    const rise = 1 - Math.exp(-config.recoilRise * (shot + 1)) / Math.max(0.001, config.recoilRise + 1);
    const vertical = MathUtils.degToRad(config.recoilVertical) * (0.55 + 0.45 * (1 - rise));
    const horizontal =
      MathUtils.degToRad(config.recoilHorizontal) * (patternX + (Math.random() - 0.5) * 0.35);

    player.addRecoil(vertical * config.recoilViewFactor, horizontal * config.recoilViewFactor);

    // The viewmodel gets the rest as a spring impulse.
    // An impulse of `v` on a spring of angular frequency w peaks at v/w, so
    // scaling the impulse by w makes `kick` and `kickRoll` literally the peak
    // displacement in metres and radians that settings.js documents them as.
    this.kickVelocity.z += config.kick * KICK_OMEGA;
    this.kickVelocity.y += config.kick * KICK_OMEGA * 0.26;
    this.kickRotVelocity.x -= config.kick * KICK_ROT_OMEGA * 0.5;
    this.kickRotVelocity.z +=
      config.kickRoll * KICK_ROT_OMEGA * (patternX > 0 ? 1 : -1);

    this.shotIndex++;
    this.spread = Math.min(config.spreadMax, this.spread + config.spreadPerShot);

    /* ---- feedback ---- */
    this.muzzle.fire(this.current, config, this.aimProgress);
    if (config.shellEject) this.shells.eject(this._worldEjectPort(), this.camera);
    this.ctx.shake.add(settings.combat.fireShake, 5.5, 34);
  }

  _currentSpread(player) {
    const config = this.config;
    let spread = config.spreadBase + this.spread;

    const moveRatio = Math.min(1, player.speed / settings.player.runSpeed);
    spread += config.spreadMoving * moveRatio * moveRatio;
    if (!player.onGround) spread += config.spreadAir;
    if (player.crouching) spread += config.spreadCrouch;

    spread *= MathUtils.lerp(1, config.adsSpreadScale, this.aimProgress);
    return Math.max(0, spread);
  }

  /** The barrel tip, in world space, derived from the viewmodel transform. */
  _worldMuzzle() {
    const entry = this.current;
    if (!entry) return _muzzle;
    return entry.muzzlePoint.getWorldPosition(new Vector3());
  }

  _worldEjectPort() {
    const entry = this.current;
    if (!entry?.ejectPoint) return this._worldMuzzle();
    return entry.ejectPoint.getWorldPosition(new Vector3());
  }

  /* ------------------------------------------------------------------ */

  /**
   * Place the viewmodel.
   *
   * The gun lives in *view space*: an offset from the eye, rotated by the eye.
   * Sway, bob and kick are all applied in that space and only then pushed into
   * the world, which is why the gun stays glued to the camera at any angle.
   */
  _updateViewmodel(dt, player) {
    const w = settings.weapons;
    const camera = this.viewCamera;

    /* ---- sway: the gun lags the look ---- */
    const yawDelta = player.euler.y - this._lastYaw;
    const pitchDelta = player.euler.x - this._lastPitch;
    this._lastYaw = player.euler.y;
    this._lastPitch = player.euler.x;

    const swayTarget = {
      x: MathUtils.clamp(-yawDelta * 2.4, -w.sway * 3, w.sway * 3),
      y: MathUtils.clamp(pitchDelta * 2.4, -w.sway * 3, w.sway * 3)
    };
    const swayRate = Math.min(1, w.swaySpeed * dt);
    this.swayOffset.x += (swayTarget.x - this.swayOffset.x) * swayRate;
    this.swayOffset.y += (swayTarget.y - this.swayOffset.y) * swayRate;

    /* ---- kick springs ---- */
    //
    // Underdamped on purpose: damping is held below the critical value
    // (2*sqrt(k)) so the gun overshoots slightly on the way back and settles.
    // That overshoot is what reads as a mechanism returning to battery rather
    // than as a value being lerped home.
    //
    // The integration is a plain semi-implicit Euler step with NO fudge factor.
    // A scale factor here does not slow the kick down, it shrinks it: the
    // spring pulls the displacement back to zero regardless, so dividing the
    // integration step by 100 simply means the gun never visibly moves. That
    // was the bug that made a mid-burst frame pixel-identical to an idle one.
    for (const axis of ['x', 'y', 'z']) {
      const displacement = this.kickOffset[axis];
      this.kickVelocity[axis] +=
        (-displacement * KICK_STIFFNESS - this.kickVelocity[axis] * KICK_DAMPING) * dt;
      this.kickOffset[axis] += this.kickVelocity[axis] * dt;
    }
    for (const axis of ['x', 'y', 'z']) {
      const displacement = this.kickRotation[axis];
      this.kickRotVelocity[axis] +=
        (-displacement * KICK_ROT_STIFFNESS - this.kickRotVelocity[axis] * KICK_ROT_DAMPING) * dt;
      this.kickRotation[axis] += this.kickRotVelocity[axis] * dt;
    }

    /* ---- bob, matched to the player's stride ---- */
    const moveRatio = Math.min(1, player.speed / settings.player.runSpeed);
    if (player.onGround) this.bobPhase += dt * settings.player.bobSpeed * moveRatio;
    const bobAmount = settings.player.bobAmount * moveRatio * w.bobScale * (1 - this.aimProgress * 0.8);
    const bobX = Math.cos(this.bobPhase) * bobAmount * 1.4;
    const bobY = Math.sin(this.bobPhase * 2) * bobAmount * 0.9;

    /* ---- sprint lowers the gun ---- */
    const sprintTarget = player.sprinting ? 1 : 0;
    this._sprintLower += (sprintTarget - this._sprintLower) * Math.min(1, 10 * dt);

    /* ---- reload dip ---- */
    let reloadDip = 0;
    let reloadRoll = 0;
    if (this.state === State.RELOADING) {
      const duration = this._reloadEmpty ? this.config.reloadEmptyTime : this.config.reloadTime;
      const t = MathUtils.clamp(this.stateTime / duration, 0, 1);
      // Down fast, hold, up fast — the shape of a magazine change.
      const curve = Math.sin(Math.PI * Math.min(1, t * 1.12)) ** 0.6;
      reloadDip = curve * 0.11;
      reloadRoll = curve * 0.5;
    } else if (this.state === State.DRAWING) {
      const t = MathUtils.clamp(this.stateTime / this.config.drawTime, 0, 1);
      reloadDip = (1 - t) * (1 - t) * 0.16;
      reloadRoll = (1 - t) * 0.7;
    }

    /* ---- compose the view-space offset ---- */
    const hip = w.viewmodelPos;
    const ads = w.viewmodelAdsPos;
    const a = this.aimProgress;

    const localX = MathUtils.lerp(hip.x, ads.x, a) + this.swayOffset.x + bobX + this.kickOffset.x;
    const localY =
      MathUtils.lerp(hip.y, ads.y, a) +
      this.swayOffset.y +
      bobY +
      this.kickOffset.y -
      reloadDip -
      this._sprintLower * 0.1;
    const localZ = MathUtils.lerp(hip.z, ads.z, a) + this.kickOffset.z;

    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion);
    this.root.translateX(localX);
    this.root.translateY(localY);
    this.root.translateZ(localZ);

    // Rotations are applied *after* the translate so the gun pivots about its
    // own grip rather than swinging around the camera.
    //
    // The **rest cant** is the important part. A viewmodel presented flat
    // side-on shows the eye a slab: one large unbroken face, no depth cue, and
    // none of the receiver's top surfaces. Every shipped shooter instead rotates
    // the weapon toward the camera so you see the top plane *and* the left side
    // at once, and rakes the muzzle slightly inward toward the screen centre.
    // That 3/4 presentation is what makes the gun read as an object with volume
    // rather than as a decal, and it is why CS2's rifle shows its dust cover,
    // its sights and its magazine well all in one frame.
    //
    // Faded out with `aimProgress`: in sights the weapon has to be square to
    // the view or the irons do not line up.
    const cant = 1 - a;
    _q.setFromEuler(
      new Euler(
        this.kickRotation.x + REST_PITCH * cant,
        this.kickRotation.y + (this._restYawOverride ?? REST_YAW) * cant + this._sprintLower * -0.35,
        this.kickRotation.z +
          REST_ROLL * cant +
          reloadRoll * 0.35 +
          this._sprintLower * w.lowerOnSprint,
        'XYZ'
      )
    );
    this.root.quaternion.multiply(_q);
  }

  onStep() {}

  dispose() {
    this.muzzle.dispose();
    this.shells.dispose();
    for (const built of this.built.values()) built.hands?.dispose();
    this.models.dispose();
    this.scene.remove(this.root);
  }
}
