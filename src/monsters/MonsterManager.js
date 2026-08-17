import {
  Group,
  Vector3,
  Quaternion,
  Matrix4,
  MathUtils,
  Bone,
  Skeleton,
  SkinnedMesh
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { generateMonster, rng } from './MonsterGenerator.js';
import { MonsterMaterial } from './MonsterMaterial.js';

const _toPlayer = new Vector3();
const _oc = new Vector3();
const _point = new Vector3();
const _normal = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _mat = new Matrix4();
const _bend = new Vector3();
const _femur = new Vector3();
const _shin = new Vector3();
const _restA = new Vector3();
const _meshQuat = new Quaternion();
const _AXIS_X = new Vector3(1, 0, 0);
const _AXIS_Y = new Vector3(0, 1, 0);
const _AXIS_Z = new Vector3(0, 0, 1);
/** Where a planted foot points: forward and flat, whatever the shin does. */
const _FLOOR_FWD = new Vector3(0, -0.12, 1).normalize();

/**
 * Spawns, drives, animates and kills the monsters.
 *
 * The population is a fixed pool of pre-generated species: growing a creature
 * costs milliseconds, and doing it during play would hitch the frame. So a
 * handful of distinct bodies are grown at load, and spawning hangs a fresh
 * *instance* off one — its own skeleton, its own state.
 *
 * ## Animation
 *
 * Every creature carries a real bone hierarchy and is drawn as a `SkinnedMesh`.
 * The gait is procedural, not keyframed, and is built from four ideas:
 *
 *  1. **Phase advances with distance, not with time.** A creature that slows
 *     down slows its legs by exactly the same factor, so the feet never skate.
 *  2. **Feet are solved in world space, then IK'd back into joint angles.** The
 *     planted foot is *pinned to the ground* and the body moves over it; only
 *     the swinging foot moves relative to the body. This is the whole reason a
 *     walk cycle reads as pushing rather than as miming.
 *  3. **The body reacts to the legs.** The pelvis drops as weight transfers,
 *     rolls toward the stance leg, and yaws with the stride. Without these the
 *     legs look like a puppet's under a static torso.
 *  4. **Everything lags.** The spine, neck and head each carry a fraction of
 *     the turn one segment behind the last, so a turning creature whips its
 *     head around after its shoulders — the single clearest signal of mass.
 *
 * Two-bone IK is closed-form (law of cosines), which at 22 creatures × 2–6 legs
 * is cheaper than a single iteration of anything numerical and never jitters.
 */
export class MonsterManager {
  constructor(context) {
    this.ctx = context;
    this.scene = context.scene;
    this.collider = context.collider;
    this.player = context.player;
    this.combat = context.combat;

    this.group = new Group();
    this.group.name = 'Monsters';
    // Bone matrices are driven by hand every frame.
    this.group.matrixAutoUpdate = false;
    this.scene.add(this.group);

    /** Pre-generated species. */
    this.species = [];
    /** Live creatures. */
    this.monsters = [];

    this.spawnTimer = 2.0;
    this.wave = 1;
    this._nextId = 1;
    this._elapsed = 0;
  }

  get aliveCount() {
    let n = 0;
    for (const m of this.monsters) if (m.alive) n++;
    return n;
  }

  async load() {
    const cfg = settings.monsters;

    // Two of each archetype, so the player sees real variety without the
    // generator ever running during play.
    let seed = 1337;
    let index = 0;
    for (const archetype of cfg.archetypes) {
      for (let i = 0; i < 2; i++) {
        const generated = generateMonster(seed, archetype);
        // Alternate species get a hue push so a horde is not one palette.
        generated.material = new MonsterMaterial(generated.stats.seed, i === 1 ? 0.55 : 0);
        generated.material.sync();
        this.species.push(generated);
        seed += 7919;
        index++;
      }
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Rig instancing                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Build a live bone hierarchy for one creature from its species' rig.
   *
   * Every instance needs its own bones — they are what the animation writes to
   * — but the geometry, the bone inverses and the material are all shared.
   */
  _instantiate(species) {
    const bones = [];
    for (const spec of species.bones) {
      const bone = new Bone();
      bone.position.copy(spec.local);
      bones.push(bone);
    }
    const root = bones[0];
    for (let i = 0; i < bones.length; i++) {
      const parent = species.bones[i].parent;
      if (parent >= 0) bones[parent].add(bones[i]);
    }

    const skeleton = new Skeleton(bones, species.boneInverses.map((m) => m.clone()));
    const mesh = new SkinnedMesh(species.geometry, species.material.material);
    mesh.add(root);
    mesh.bind(skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.WORLD);
    mesh.frustumCulled = true;
    // The generator's bind pose has bones at identity rotation, so the bind
    // matrix is the identity and skinning is a pure delta from rest.
    mesh.bindMatrix.identity();
    mesh.bindMatrixInverse.identity();

    return { mesh, bones, root, skeleton };
  }

  /**
   * Swap a live creature onto a different species, rebuilding its rig.
   *
   * A skeleton is bound to one geometry's skin weights, so re-pointing
   * `monster.species` without rebuilding leaves the animator writing to bones
   * that the vertices do not reference.
   */
  _rebind(monster) {
    const species = monster.species;
    this.group.remove(monster.mesh);
    monster.skeleton?.dispose?.();

    const rig = this._instantiate(species);
    monster.mesh = rig.mesh;
    monster.bones = rig.bones;
    monster.root = rig.root;
    monster.skeleton = rig.skeleton;
    monster.rigSpecies = species;
    monster.feet = species.rig.legs.map(() => ({
      planted: new Vector3(),
      valid: false,
      lift: 0
    }));
    monster.mesh.scale.setScalar(monster.scale);
    monster.mesh.position.copy(monster.position);
    monster.mesh.rotation.y = monster.facing;
    this.group.add(monster.mesh);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Put a fully-formed creature at an exact spot, optionally of a chosen
   * species. This is the path reference captures and scripted encounters use —
   * going through `spawn()` and then mutating the result cannot work, because
   * a skeleton is bound to one specific geometry.
   */
  spawnAt(x, z, speciesIndex = null, facing = null) {
    const species =
      speciesIndex === null
        ? null
        : this.species[((speciesIndex % this.species.length) + this.species.length) % this.species.length];
    const monster = this.spawn(species, true);
    if (!monster) return null;
    monster.position.set(x, 0, z);
    if (facing !== null) monster.facing = facing;
    for (const foot of monster.feet) foot.valid = false;
    monster.mesh.position.copy(monster.position);
    monster.mesh.rotation.y = monster.facing;
    return monster;
  }

  spawn(forcedSpecies = null, ignoreCap = false) {
    const cfg = settings.monsters;
    if (!ignoreCap && this.aliveCount >= cfg.maxAlive) return null;

    const species =
      forcedSpecies ?? this.species[Math.floor(Math.random() * this.species.length)];
    if (!species) return null;

    // Ring-spawn around the player, outside their view distance but inside the
    // arena. Rejection-sampled so nothing spawns outside the walls.
    const arenaHalf = settings.arena.size / 2 - 3;
    let x = 0;
    let z = 0;
    let ok = false;
    for (let attempt = 0; attempt < 24 && !ok; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance =
        cfg.spawnDistanceMin + Math.random() * (cfg.spawnDistanceMax - cfg.spawnDistanceMin);
      x = this.player.position.x + Math.cos(angle) * distance;
      z = this.player.position.z + Math.sin(angle) * distance;
      if (Math.abs(x) > arenaHalf || Math.abs(z) > arenaHalf) continue;
      ok = true;
    }
    if (!ok) return null;

    const rig = this._instantiate(species);
    this.group.add(rig.mesh);

    // Per-instance size variance on top of the per-species height. A horde
    // where everything is the same size reads as clones no matter how good the
    // individual is.
    const scale = 0.82 + Math.random() * 0.42;

    const monster = {
      id: this._nextId++,
      species,
      /** Which species this instance's bones were grown from. */
      rigSpecies: species,
      ...rig,
      alive: true,
      position: new Vector3(x, 0, z),
      velocity: new Vector3(),
      facing: Math.random() * Math.PI * 2,
      health: species.stats.health * scale,
      maxHealth: species.stats.health * scale,
      speed: species.stats.speed * (1.18 - scale * 0.22),
      radius: species.stats.radius * scale,
      height: species.stats.height * scale,
      scale,
      gait: Math.random() * Math.PI * 2,
      gaitSpeed: 0,
      state: 'hunt',
      stateTime: 0,
      lungeCooldown: 0,
      deathTime: 0,
      hitFlash: 0,
      // Animation state.
      bodyY: 0,
      bodyRoll: 0,
      bodyPitch: 0,
      lean: 0,
      turnRate: 0,
      jawOpen: 0,
      jawTarget: 0,
      breath: Math.random() * Math.PI * 2,
      headYaw: 0,
      headPitch: 0,
      spineLag: 0,
      /** Per-leg planted-foot memory, in world space. */
      feet: species.rig.legs.map(() => ({
        planted: new Vector3(),
        valid: false,
        lift: 0
      })),
      deathSpin: (Math.random() - 0.5) * 2.4,
      deathFall: Math.random() < 0.5 ? 1 : -1,
      random: rng(species.stats.seed + this._nextId)
    };

    monster.mesh.scale.setScalar(scale);
    monster.mesh.position.copy(monster.position);
    monster.mesh.rotation.y = monster.facing;

    this.monsters.push(monster);
    return monster;
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    if (dt <= 0) return;
    const cfg = settings.monsters;
    this._elapsed += dt;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = cfg.spawnInterval;
      this.spawn();
    }

    for (let i = this.monsters.length - 1; i >= 0; i--) {
      const monster = this.monsters[i];

      // The capture harness (and any future spawner) may reassign `species` on
      // a live creature to force a specific body. A rig belongs to exactly one
      // species, so rebuild it rather than animating bones that do not match
      // the geometry.
      if (monster.species !== monster.rigSpecies) this._rebind(monster);

      if (!monster.alive) {
        monster.deathTime += dt;
        this._updateCorpse(monster, dt);
        if (monster.deathTime > cfg.ragdollTime + cfg.sinkTime) {
          this.group.remove(monster.mesh);
          monster.skeleton.dispose?.();
          this.monsters.splice(i, 1);
        }
        continue;
      }

      this._updateAI(monster, dt);
      this._animate(monster, dt);
      this._updateTransform(monster, dt);
      monster.hitFlash = Math.max(0, monster.hitFlash - dt * 5);
    }
  }

  _updateAI(monster, dt) {
    const cfg = settings.monsters;

    _toPlayer.copy(this.player.position);
    _toPlayer.y = 0;
    _toPlayer.sub(monster.position);
    const distance = _toPlayer.length();
    if (distance > 0.001) _toPlayer.divideScalar(distance);

    monster.stateTime += dt;
    monster.lungeCooldown = Math.max(0, monster.lungeCooldown - dt);

    // Turn toward the player at a finite rate — an enemy that snaps to face you
    // reads as an aimbot, and the turn is most of what makes it feel alive.
    const wantedFacing = Math.atan2(_toPlayer.x, _toPlayer.z);
    let delta = wantedFacing - monster.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const turn = MathUtils.clamp(delta, -cfg.turnRate * dt, cfg.turnRate * dt);
    monster.facing += turn;
    // Remembered so the spine can lag behind the hips through a turn.
    monster.turnRate = MathUtils.lerp(monster.turnRate, dt > 0 ? turn / dt : 0, 1 - Math.exp(-8 * dt));

    let speed = monster.speed;

    if (distance < cfg.lungeRange * monster.scale && monster.lungeCooldown <= 0) {
      monster.state = 'lunge';
      monster.stateTime = 0;
      monster.lungeCooldown = cfg.lungeCooldown;
      monster.velocity.copy(_toPlayer).multiplyScalar(cfg.chargeSpeed * 1.6);
      monster.jawTarget = 1;
      this.combat.emit?.('playerDamage', cfg.attackDamage);
    } else if (monster.state === 'lunge' && monster.stateTime > 0.45) {
      monster.state = 'hunt';
    }

    if (monster.state === 'hunt') {
      // Only close in when facing roughly the right way — a creature that
      // strafes sideways at full speed while turning looks like it is on rails.
      const alignment = Math.max(0, Math.cos(delta));
      speed *= 0.35 + 0.65 * alignment;
      if (distance < 2.2) speed *= 0.2;

      monster.velocity.set(
        Math.sin(monster.facing) * speed,
        0,
        Math.cos(monster.facing) * speed
      );
      // The jaw opens as it closes on you, and gapes inside striking distance.
      monster.jawTarget = distance < 6 ? MathUtils.clamp(1.6 - distance / 5, 0.05, 0.85) : 0.05;
    } else {
      monster.velocity.multiplyScalar(1 - Math.min(1, 4 * dt));
    }

    monster.position.addScaledVector(monster.velocity, dt);

    // Keep them inside the arena and out of each other.
    const half = settings.arena.size / 2 - 1.5;
    monster.position.x = MathUtils.clamp(monster.position.x, -half, half);
    monster.position.z = MathUtils.clamp(monster.position.z, -half, half);

    for (const other of this.monsters) {
      if (other === monster || !other.alive) continue;
      const dx = monster.position.x - other.position.x;
      const dz = monster.position.z - other.position.z;
      const distSq = dx * dx + dz * dz;
      const minDist = (monster.radius + other.radius) * 0.75;
      if (distSq < minDist * minDist && distSq > 0.0001) {
        const d = Math.sqrt(distSq);
        const push = (minDist - d) * 0.5;
        monster.position.x += (dx / d) * push;
        monster.position.z += (dz / d) * push;
      }
    }

    // The gait phase advances with distance travelled, not with time, so the
    // legs never skate when the creature slows down.
    const moved = monster.velocity.length() * dt;
    const stride = Math.max(0.2, settings.monsters.strideLength * monster.species.stats.strideScale * monster.scale);
    monster.gait += (moved / stride) * Math.PI * 2;
    monster.gaitSpeed = dt > 0 ? moved / dt : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Procedural gait                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Pose one creature's skeleton.
   *
   * Runs entirely in the creature's local frame: the mesh carries the world
   * yaw and position, so the animator only ever thinks about a body facing +Z.
   */
  _animate(monster, dt) {
    const cfg = settings.monsters;
    const rig = monster.species.rig;
    const bones = monster.bones;
    const specs = monster.species.bones;

    monster.breath += dt * (1.4 + monster.gaitSpeed * 0.25);
    monster.jawOpen = MathUtils.lerp(monster.jawOpen, monster.jawTarget, 1 - Math.exp(-9 * dt));

    // How hard it is working: 0 idle, 1 sprinting. Drives amplitude everywhere.
    const effort = MathUtils.clamp(monster.gaitSpeed / Math.max(0.5, monster.speed), 0, 1.4);
    const moving = MathUtils.clamp(monster.gaitSpeed * 2.2, 0, 1);
    const lunge = monster.state === 'lunge' ? Math.max(0, 1 - monster.stateTime / 0.45) : 0;

    /* ---- body: the legs push the torso around ---------------------- */
    // Two footfalls per stride, so the vertical bob is at twice the gait rate.
    const bobPhase = monster.gait * 2;
    const bounce = -Math.abs(Math.sin(bobPhase * 0.5)) * cfg.bodyBob * moving;
    const idleBreath = Math.sin(monster.breath) * 0.012;
    monster.bodyY = MathUtils.lerp(monster.bodyY, bounce + idleBreath, 1 - Math.exp(-16 * dt));

    // Roll toward whichever side is carrying the weight, and pitch down into
    // the acceleration. Both are what makes a body read as heavy.
    const targetRoll = Math.sin(monster.gait) * cfg.bodyRoll * moving - monster.turnRate * 0.14;
    monster.bodyRoll = MathUtils.lerp(monster.bodyRoll, targetRoll, 1 - Math.exp(-11 * dt));
    const targetPitch = -effort * cfg.bodyLean - lunge * 0.3 + Math.sin(bobPhase) * 0.035 * moving;
    monster.bodyPitch = MathUtils.lerp(monster.bodyPitch, targetPitch, 1 - Math.exp(-9 * dt));

    // The shoulders lag the hips through a turn.
    monster.spineLag = MathUtils.lerp(monster.spineLag, -monster.turnRate * 0.16, 1 - Math.exp(-7 * dt));

    const pelvis = bones[rig.pelvis];
    pelvis.position.set(
      specs[rig.pelvis].local.x + Math.sin(monster.gait) * cfg.bodySway * moving,
      specs[rig.pelvis].local.y + monster.bodyY,
      specs[rig.pelvis].local.z
    );
    _q.setFromAxisAngle(_AXIS_Z, monster.bodyRoll);
    _q2.setFromAxisAngle(_AXIS_X, monster.bodyPitch);
    pelvis.quaternion.copy(_q).multiply(_q2);
    // Counter-rotate the hips against the stride: a real quadruped's pelvis
    // twists the opposite way to its shoulders.
    _q.setFromAxisAngle(_AXIS_Y, -Math.sin(monster.gait) * 0.1 * moving);
    pelvis.quaternion.multiply(_q);

    /* ---- spine chain ------------------------------------------------ */
    for (let i = 1; i < rig.spine.length; i++) {
      const t = i / (rig.spine.length - 1);
      const bone = bones[rig.spine[i]];
      // The counter-twist unwinds up the back; the lag accumulates.
      const twist = Math.sin(monster.gait) * 0.075 * moving * (t * 2 - 0.4) + monster.spineLag * t * 0.6;
      const flex = Math.sin(bobPhase + t * 1.2) * 0.028 * moving + lunge * 0.12 * t;
      _q.setFromAxisAngle(_AXIS_Y, twist);
      _q2.setFromAxisAngle(_AXIS_X, flex - monster.bodyPitch * 0.22);
      bone.quaternion.copy(_q).multiply(_q2);
      // A ripple of lateral flex down the back — the "S" of a stalking animal.
      _q.setFromAxisAngle(_AXIS_Z, Math.sin(monster.gait + t * 2.4) * 0.05 * moving);
      bone.quaternion.multiply(_q);
    }

    /* ---- neck + head: lags the body, then locks on ------------------ */
    // The head aims at the player independent of the body, which is what makes
    // a creature feel like it is tracking you rather than pointing at you.
    _v.copy(this.player.position).sub(monster.position);
    const localYaw = Math.atan2(_v.x, _v.z) - monster.facing;
    let wrapped = localYaw;
    while (wrapped > Math.PI) wrapped -= Math.PI * 2;
    while (wrapped < -Math.PI) wrapped += Math.PI * 2;
    const wantYaw = MathUtils.clamp(wrapped, -0.75, 0.75);
    const horizontal = Math.hypot(_v.x, _v.z);
    const wantPitch = MathUtils.clamp(
      Math.atan2(this.player.position.y - (monster.position.y + monster.height * 0.72), horizontal),
      -0.5,
      0.6
    );
    monster.headYaw = MathUtils.lerp(monster.headYaw, wantYaw, 1 - Math.exp(-6 * dt));
    monster.headPitch = MathUtils.lerp(monster.headPitch, wantPitch, 1 - Math.exp(-5 * dt));

    for (let i = 0; i < rig.neck.length; i++) {
      const t = (i + 1) / rig.neck.length;
      const bone = bones[rig.neck[i]];
      const share = 0.45 / rig.neck.length;
      _q.setFromAxisAngle(_AXIS_Y, monster.headYaw * share * (i + 1) + monster.spineLag * 0.3);
      _q2.setFromAxisAngle(
        _AXIS_X,
        monster.headPitch * share * (i + 1) * 0.7 +
          Math.sin(bobPhase + 1.3) * 0.05 * moving -
          lunge * 0.18
      );
      bone.quaternion.copy(_q).multiply(_q2);
    }

    const head = bones[rig.head];
    _q.setFromAxisAngle(_AXIS_Y, monster.headYaw * 0.55);
    _q2.setFromAxisAngle(
      _AXIS_X,
      monster.headPitch * 0.6 - Math.sin(bobPhase + 2.1) * 0.06 * moving + lunge * 0.25
    );
    head.quaternion.copy(_q).multiply(_q2);
    // A slight head cant. Perfectly level heads look like turrets.
    _q.setFromAxisAngle(_AXIS_Z, Math.sin(monster.gait * 0.5 + 1.1) * 0.09 * moving - monster.headYaw * 0.2);
    head.quaternion.multiply(_q);

    if (rig.jaw >= 0) {
      // The jaw chatters a little when it gapes — a still-open mouth is a prop.
      const chatter = Math.sin(this._elapsed * 17 + monster.id) * 0.05 * monster.jawOpen;
      bones[rig.jaw].quaternion.setFromAxisAngle(
        _AXIS_X,
        (monster.jawOpen * 0.62 + chatter + lunge * 0.35) * -1
      );
    }

    /* ---- legs -------------------------------------------------------- */
    // The mesh's world transform is needed to convert the pinned world-space
    // feet into the creature's local frame, so refresh it before solving.
    monster.mesh.position.copy(monster.position);
    monster.mesh.position.y += monster.bodyY * 0.35;
    monster.mesh.rotation.y = monster.facing;
    monster.mesh.updateMatrixWorld(true);
    monster.mesh.getWorldQuaternion(_meshQuat);

    const invScale = 1 / monster.scale;
    for (let i = 0; i < rig.legs.length; i++) {
      this._solveLeg(monster, rig.legs[i], i, dt, moving, effort, lunge, invScale);
    }

    /* ---- arms -------------------------------------------------------- */
    for (let i = 0; i < rig.arms.length; i++) {
      this._poseArm(monster, rig.arms[i], i, dt, moving, effort, lunge);
    }

    /* ---- tail -------------------------------------------------------- */
    for (let i = 0; i < rig.tail.length; i++) {
      const t = (i + 1) / rig.tail.length;
      const bone = bones[rig.tail[i]];
      // A whip that lags further down its length — the classic secondary motion.
      const sway = Math.sin(monster.gait * 0.5 - t * 2.1) * (0.1 + 0.16 * t) * (0.4 + moving);
      const lift = Math.sin(monster.gait - t * 1.6) * 0.06 * moving - 0.08 * t;
      _q.setFromAxisAngle(_AXIS_Y, sway - monster.turnRate * 0.1 * t);
      _q2.setFromAxisAngle(_AXIS_X, lift);
      bone.quaternion.copy(_q).multiply(_q2);
    }
  }

  /**
   * Pin the planted foot to the ground and IK the leg to reach it.
   *
   * The foot target lives in **world** space so that while a foot is down, the
   * creature's body slides over a stationary contact point. That is the single
   * behaviour that separates walking from miming a walk: at any instant, one
   * foot is not moving, and the leg it belongs to is straightening to push.
   */
  _solveLeg(monster, leg, index, dt, moving, effort, lunge, invScale) {
    const cfg = settings.monsters;
    const bones = monster.bones;
    const specs = monster.species.bones;
    const foot = monster.feet[index];

    const phase = monster.gait + leg.phase;
    // Duty factor: the foot is on the ground for most of the cycle. Walking
    // animals are >0.5; that overlap is what keeps the body from bobbing like
    // a pogo stick.
    const duty = MathUtils.lerp(0.68, 0.55, MathUtils.clamp(effort, 0, 1));
    const cycle = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
    const swinging = cycle > duty;

    const stride =
      cfg.strideLength * monster.species.stats.strideScale * monster.scale * (0.45 + 0.75 * moving);

    // The rest foot position in world space, in front of / behind the body.
    const rest = leg.restFoot;
    _v.set(rest.x * monster.scale, 0, rest.z * monster.scale);
    // Rotate the rest offset into the world by the creature's facing.
    const cos = Math.cos(monster.facing);
    const sin = Math.sin(monster.facing);
    const restWorldX = monster.position.x + _v.x * cos + _v.z * sin;
    const restWorldZ = monster.position.z + (-_v.x * sin + _v.z * cos);

    if (!foot.valid) {
      foot.planted.set(restWorldX, 0, restWorldZ);
      foot.valid = true;
    }

    let targetX;
    let targetZ;
    let targetY;

    if (swinging) {
      // Swing: reach forward to where the body will be when this foot lands.
      const s = (cycle - duty) / (1 - duty);
      const ease = s * s * (3 - 2 * s);
      const landX = restWorldX + sin * stride * 0.55;
      const landZ = restWorldZ + cos * stride * 0.55;
      targetX = MathUtils.lerp(foot.liftX ?? foot.planted.x, landX, ease);
      targetZ = MathUtils.lerp(foot.liftZ ?? foot.planted.z, landZ, ease);
      // Lift arcs high early and drops fast — animals snatch a foot up and set
      // it down, they do not float it across.
      targetY = Math.sin(Math.pow(s, 0.72) * Math.PI) * cfg.stepHeight * monster.scale * (0.35 + 0.8 * moving);
      foot.lift = targetY;
      // Re-plant the moment the swing ends.
      foot.planted.set(targetX, 0, targetZ);
    } else {
      // Stance: the contact point does not move. The body moves over it.
      targetX = foot.planted.x;
      targetZ = foot.planted.z;
      targetY = 0;
      foot.liftX = targetX;
      foot.liftZ = targetZ;
      foot.lift = 0;

      // If the body has dragged the foot beyond what the leg can reach — a
      // hard turn, a shove, a lunge — snap it under the hip rather than let
      // the leg stretch into a straight line.
      const dx = targetX - restWorldX;
      const dz = targetZ - restWorldZ;
      const limit = stride * 0.85 + 0.25;
      if (dx * dx + dz * dz > limit * limit) {
        foot.planted.set(restWorldX, 0, restWorldZ);
        targetX = restWorldX;
        targetZ = restWorldZ;
      }
    }

    // World → the creature's local frame.
    _v.set(targetX - monster.position.x, targetY, targetZ - monster.position.z);
    const lx = (_v.x * cos - _v.z * sin) * invScale;
    const lz = (_v.x * sin + _v.z * cos) * invScale;
    const ly = (_v.y - monster.bodyY * 0.35) * invScale;

    this._twoBoneIK(monster, leg, lx, ly, lz, swinging, cycle, duty, moving, lunge);
  }

  /**
   * Closed-form two-bone IK onto the hip → knee → ankle chain, plus a foot
   * roll on the ball joint.
   *
   * Solved in the parent bone's space: the hip's world position already carries
   * every bit of pelvis bob, roll and spine flex, so the leg automatically
   * compensates for the body's motion — which is exactly the behaviour that
   * makes the contact look solid.
   */
  _twoBoneIK(monster, leg, tx, ty, tz, swinging, cycle, duty, moving, lunge) {
    const bones = monster.bones;
    const specs = monster.species.bones;
    const hipBone = bones[leg.bones[0]];
    const kneeBone = bones[leg.bones[1]];
    const ankleBone = bones[leg.bones[2]];
    const ballBone = bones[leg.bones[3]];

    // Where the hip actually is right now, in the creature's local space.
    hipBone.updateWorldMatrix(true, false);
    _mat.copy(monster.mesh.matrixWorld).invert().multiply(hipBone.matrixWorld);
    const hipX = _mat.elements[12];
    const hipY = _mat.elements[13];
    const hipZ = _mat.elements[14];

    let dx = tx - hipX;
    let dy = ty - hipY;
    let dz = tz - hipZ;
    let dist = Math.hypot(dx, dy, dz);

    const upper = leg.upperLen;
    const lower = leg.lowerLen;
    const maxReach = (upper + lower) * 0.995;
    const minReach = Math.abs(upper - lower) * 1.05 + 0.01;
    if (dist > maxReach) {
      const k = maxReach / dist;
      dx *= k; dy *= k; dz *= k;
      dist = maxReach;
    } else if (dist < minReach) {
      const k = minReach / Math.max(1e-5, dist);
      dx *= k; dy *= k; dz *= k;
      dist = minReach;
    }

    // Law of cosines: the interior angle at the hip between the chain
    // direction and the femur.
    const cosHip = MathUtils.clamp(
      (upper * upper + dist * dist - lower * lower) / (2 * upper * dist),
      -1,
      1
    );
    const hipAngle = Math.acos(cosHip);
    const cosKnee = MathUtils.clamp(
      (upper * upper + lower * lower - dist * dist) / (2 * upper * lower),
      -1,
      1
    );
    const kneeAngle = Math.PI - Math.acos(cosKnee);

    // The chain direction, and the plane the knee bends in. A digitigrade leg
    // folds forward at the knee — the pole vector points +Z (forward) — and
    // splays outward by the leg's own side.
    _v.set(dx, dy, dz).normalize();
    _v2.set(leg.side * 0.28, 0.12, 1).normalize();
    // Orthogonalise the pole against the chain so the bend plane is stable.
    _v2.addScaledVector(_v, -_v2.dot(_v));
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, 1).addScaledVector(_v, -_v.z);
    _v2.normalize();

    // Rotate the femur off the chain direction by hipAngle, toward the pole.
    const bendAxis = _bend.crossVectors(_v, _v2).normalize();
    _q.setFromAxisAngle(bendAxis, -hipAngle);
    const femurDir = _femur.copy(_v).applyQuaternion(_q);

    // Bones rest pointing along their child's offset; build the model-space
    // rotation that takes the rest direction to the solved direction.
    _q.setFromUnitVectors(_restDir(specs, leg.bones[0], leg.bones[1], _restA), femurDir);
    _modelToLocalQuat(hipBone, _q, _meshQuat, _q2);
    hipBone.quaternion.copy(_q2);
    // The knee's parent chain changed, so refresh before solving it.
    hipBone.updateWorldMatrix(false, false);

    // The knee: point the shin at the target from where the knee now is.
    _v2.set(hipX + femurDir.x * upper, hipY + femurDir.y * upper, hipZ + femurDir.z * upper);
    const shinDir = _shin.set(tx - _v2.x, ty - _v2.y, tz - _v2.z);
    if (shinDir.lengthSq() < 1e-10) shinDir.copy(femurDir);
    shinDir.normalize();
    _q.setFromUnitVectors(_restDir(specs, leg.bones[1], leg.bones[2], _restA), shinDir);
    _modelToLocalQuat(kneeBone, _q, _meshQuat, _q2);
    kneeBone.quaternion.copy(_q2);
    kneeBone.updateWorldMatrix(false, false);

    /* ---- the foot ----------------------------------------------------- */
    // Foot roll is what makes a step land and push instead of stamping flat:
    // toe-off at the end of stance, heel-strike at the end of swing.
    const stanceT = swinging ? 1 : cycle / Math.max(1e-4, duty);
    let ankleAngle;
    if (swinging) {
      const s = (cycle - duty) / (1 - duty);
      // Lift the toes clear on the way through, then drop them to land.
      ankleAngle = MathUtils.lerp(-0.55, 0.32, Math.min(1, s * 1.35));
    } else {
      // Roll from flat onto the ball, and push off hard at the very end.
      ankleAngle = 0.32 - 0.18 * stanceT - Math.pow(stanceT, 5) * 0.85;
    }
    ankleAngle *= 0.35 + 0.75 * moving;
    ankleAngle -= lunge * 0.4;

    // The foot wants to stay flat on the floor whatever the shin is doing, so
    // it is solved in model space and then converted, rather than being a local
    // offset that would inherit the shin's swing.
    _q.setFromAxisAngle(_AXIS_X, ankleAngle);
    _q2.setFromUnitVectors(_restDir(specs, leg.bones[2], leg.bones[3], _restA), _FLOOR_FWD);
    _q.multiply(_q2);
    _modelToLocalQuat(ankleBone, _q, _meshQuat, _q2);
    ankleBone.quaternion.copy(_q2);

    // The toes splay on contact and curl through the swing.
    if (ballBone) {
      ballBone.quaternion.setFromAxisAngle(
        _AXIS_X,
        swinging ? -0.25 : -Math.pow(stanceT, 4) * 0.7
      );
    }
  }

  /**
   * Arms.
   *
   * Not IK'd — a free arm has no contact constraint, so forward kinematics with
   * good phase offsets reads better and costs nothing. The pose swings with the
   * opposite leg, hunches under effort, and throws forward on a lunge.
   */
  _poseArm(monster, arm, index, dt, moving, effort, lunge) {
    const bones = monster.bones;
    const swing = Math.sin(monster.gait + (arm.side > 0 ? Math.PI : 0) + arm.pair * 0.6);
    const secondary = Math.sin(monster.gait * 2 + arm.pair);

    // Shoulder: rolls forward under effort, hunching the creature.
    const shoulder = bones[arm.bones[0]];
    _q.setFromAxisAngle(_AXIS_X, -0.12 * effort - lunge * 0.35 + swing * 0.06 * moving);
    _q2.setFromAxisAngle(_AXIS_Z, arm.side * (0.1 + 0.12 * effort));
    shoulder.quaternion.copy(_q).multiply(_q2);

    // Upper arm: the main swing, plus a hanging droop at rest.
    const upper = bones[arm.bones[1]];
    const reach = lunge * 1.05;
    _q.setFromAxisAngle(_AXIS_X, swing * (0.3 + 0.35 * moving) - 0.12 - reach);
    _q2.setFromAxisAngle(_AXIS_Y, arm.side * (-0.12 - 0.16 * effort + reach * 0.3));
    upper.quaternion.copy(_q).multiply(_q2);
    _q.setFromAxisAngle(_AXIS_Z, arm.side * (0.18 + swing * 0.1 * moving - reach * 0.25));
    upper.quaternion.multiply(_q);

    // Forearm: always somewhat flexed. A straight arm reads as a mannequin.
    const fore = bones[arm.bones[2]];
    _q.setFromAxisAngle(
      _AXIS_X,
      -0.45 - 0.3 * effort - Math.max(0, swing) * 0.35 * moving + reach * 0.55
    );
    fore.quaternion.copy(_q);

    // Hand: the claws curl and the wrist counter-rotates.
    const hand = bones[arm.bones[3]];
    _q.setFromAxisAngle(_AXIS_X, 0.25 + secondary * 0.12 * moving - reach * 0.5);
    _q2.setFromAxisAngle(_AXIS_Y, arm.side * 0.18);
    hand.quaternion.copy(_q).multiply(_q2);
  }

  _updateTransform(monster, dt) {
    monster.mesh.position.copy(monster.position);
    monster.mesh.position.y += monster.bodyY * 0.35;
    monster.mesh.rotation.y = monster.facing;

    const material = monster.species.material;
    material.setHitFlash?.(monster.hitFlash);
  }

  /**
   * Death.
   *
   * The rig goes limp: joints relax toward a slack pose over the first moments,
   * the body topples about the contact edge rather than about its own centre,
   * and the whole thing settles before sinking. A corpse that rotates rigidly
   * about its middle reads as a felled statue.
   */
  _updateCorpse(monster, dt) {
    const cfg = settings.monsters;
    const t = monster.deathTime;
    const rig = monster.species.rig;
    const bones = monster.bones;

    // Relax every joint toward slack over the first half second.
    const limp = 1 - Math.exp(-6 * dt);
    const slack = Math.min(1, t / 0.5);
    for (let i = 0; i < bones.length; i++) {
      _q.identity();
      bones[i].quaternion.slerp(_q, limp * 0.55);
    }
    // The jaw falls open and the head lolls.
    if (rig.jaw >= 0) {
      _q.setFromAxisAngle(_AXIS_X, -0.9);
      bones[rig.jaw].quaternion.slerp(_q, limp);
    }
    _q.setFromAxisAngle(_AXIS_X, 0.55);
    _q2.setFromAxisAngle(_AXIS_Z, monster.deathSpin * 0.25);
    bones[rig.head].quaternion.slerp(_q.multiply(_q2), limp * 0.7);
    // Legs buckle.
    for (const leg of rig.legs) {
      _q.setFromAxisAngle(_AXIS_X, -0.7 * leg.side * 0.3 - 0.5);
      bones[leg.bones[1]].quaternion.slerp(_q, limp * 0.8);
    }

    // Topple. The pivot is the contact edge, so the body swings down and out.
    const fall = Math.min(1, t / 0.85);
    const eased = 1 - Math.pow(1 - fall, 3);
    const angle = eased * (Math.PI / 2) * 0.92;
    const settle = t > 0.85 ? Math.sin((t - 0.85) * 13) * Math.exp(-(t - 0.85) * 7) * 0.06 : 0;

    monster.mesh.rotation.set(0, 0, 0);
    monster.mesh.rotation.y = monster.facing + monster.deathSpin * eased * 0.35;
    monster.mesh.rotation.x = (angle + settle) * monster.deathFall;
    monster.mesh.rotation.z = monster.deathSpin * eased * 0.3;

    // Drop the hip toward the floor as it goes over.
    monster.mesh.position.copy(monster.position);
    monster.mesh.position.y = -monster.height * 0.06 * eased;

    // The corpse cools: the seams glow, then fade as it sinks.
    if (t > cfg.ragdollTime) {
      const sink = (t - cfg.ragdollTime) / cfg.sinkTime;
      monster.mesh.position.y = -sink * monster.height * 1.25;
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Ray against every live monster's hitbox spheres.
   *
   * Hitboxes are bound to bones, so a head that has ducked, lunged or lolled in
   * death is shot where it actually is — the alternative is a headshot volume
   * floating in the air above a charging creature.
   *
   * @returns {{monster, point, normal, distance, zone}|null}
   */
  raycast(origin, direction, maxDistance = 200) {
    let best = null;
    let bestT = maxDistance;

    for (const monster of this.monsters) {
      if (!monster.alive) continue;

      // Cheap reject: a sphere around the whole creature.
      _oc.copy(origin).sub(monster.position);
      _oc.y -= monster.height * 0.5;
      const bound = monster.height * 0.9;
      const bProj = _oc.dot(direction);
      if (_oc.lengthSq() - bProj * bProj > bound * bound) continue;

      for (const box of monster.species.hitboxes) {
        const bone = monster.bones[box.bone];
        if (!bone) continue;
        // The bone's world matrix is current: the animator refreshed it this
        // frame before solving the legs.
        _point.copy(box.offset).applyMatrix4(bone.matrixWorld);

        _oc.copy(origin).sub(_point);
        const radius = box.radius * monster.scale;
        const b = _oc.dot(direction);
        const c = _oc.lengthSq() - radius * radius;
        const disc = b * b - c;
        if (disc < 0) continue;

        const t = -b - Math.sqrt(disc);
        if (t > 0.01 && t < bestT) {
          bestT = t;
          best = {
            monster,
            zone: box.zone,
            distance: t,
            point: new Vector3().copy(origin).addScaledVector(direction, t),
            normal: new Vector3()
              .copy(origin)
              .addScaledVector(direction, t)
              .sub(_point)
              .normalize()
          };
        }
      }
    }

    return best;
  }

  /** @returns {boolean} true if this killed it */
  damage(monster, amount, point, direction, isHead) {
    if (!monster.alive) return false;
    monster.health -= amount;
    monster.hitFlash = 1;

    // Knock the creature back a little — a hit that moves nothing reads as a
    // hit on a wall.
    monster.position.addScaledVector(direction, Math.min(0.14, amount * 0.0022));

    if (monster.health <= 0) {
      monster.alive = false;
      monster.deathTime = 0;
      // The topple direction is decided by where the killing round came from.
      monster.deathFall = 1;
      monster.deathSpin = (direction.x * Math.cos(monster.facing) - direction.z * Math.sin(monster.facing)) * 2.2;
      return true;
    }
    return false;
  }

  /** Area damage, for spells. */
  damageArea(center, radius, amount) {
    let killed = 0;
    for (const monster of this.monsters) {
      if (!monster.alive) continue;
      const dx = monster.position.x - center.x;
      const dy = monster.position.y + monster.height * 0.5 - center.y;
      const dz = monster.position.z - center.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radius * radius) continue;

      // Linear falloff from the centre.
      const falloff = 1 - Math.sqrt(distSq) / radius;
      _normal.set(dx, 0, dz).normalize();
      if (this.damage(monster, amount * falloff, monster.position, _normal, false)) killed++;
    }
    return killed;
  }

  dispose() {
    for (const monster of this.monsters) {
      monster.skeleton?.dispose?.();
    }
    for (const species of this.species) {
      species.geometry.dispose();
      species.material.dispose?.();
    }
    this.scene.remove(this.group);
  }
}

/* ==================================================================== */
/* Rig maths helpers                                                    */
/* ==================================================================== */

/** The rest-pose direction from one bone to another, in model space. */
function _restDir(specs, from, to, out) {
  return out.copy(specs[to].rest).sub(specs[from].rest).normalize();
}

/**
 * Convert a rotation expressed in the creature's **model** space into a bone's
 * **local** space.
 *
 * Rest orientations across the whole rig are identity, so a bone's accumulated
 * model rotation is just the product of the local quaternions above it. That
 * accumulation is recovered from the world matrices already computed this
 * frame — `meshQuat⁻¹ · parentWorldQuat` — and taking it out of the target
 * leaves the local quaternion to write.
 */
const _parentQuat = new Quaternion();
function _modelToLocalQuat(bone, modelQuat, meshQuat, out) {
  const parent = bone.parent;
  if (parent && parent.isBone) {
    parent.getWorldQuaternion(_parentQuat);
    // parentModel = meshQuat⁻¹ · parentWorld  ⇒  local = parentModel⁻¹ · target
    //             = parentWorld⁻¹ · meshQuat · target
    out.copy(_parentQuat).invert().multiply(meshQuat).multiply(modelQuat);
    return out;
  }
  return out.copy(modelQuat);
}
