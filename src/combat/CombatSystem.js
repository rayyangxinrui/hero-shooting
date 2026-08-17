import { Vector3, Color } from 'three';
import { settings } from '../config/settings.js';
import { DecalType } from '../effects/GroundDecals.js';
import { TracerSystem } from './TracerSystem.js';
import { ImpactSystem } from './ImpactSystem.js';

const _dir = new Vector3();
const _hit = new Vector3();
const _normal = new Vector3();

/**
 * Damage resolution and hit feedback.
 *
 * The whole system exists to answer one question — *what did that round hit* —
 * and then to make the answer felt. Hitscan against the box world and the
 * monster hitboxes, nearest wins, then surface-appropriate impact VFX, a decal,
 * a tracer and a hitmarker.
 *
 * Instant hitscan rather than projectiles, because that is what CS2 and CoD
 * both do for bullets: at 800 m/s over a 84 m arena the travel time is 0.1 s,
 * which is inside one frame of perceptual tolerance but far outside the
 * tolerance for "did my crosshair-accurate shot land". The visible tracer is
 * decoupled and *does* travel, which is the trick that buys both.
 */
export class CombatSystem {
  constructor(context) {
    this.ctx = context;
    this.collider = context.collider;
    this.monsters = null; // set by App after MonsterManager exists

    this.tracers = new TracerSystem(context.scene);
    this.impacts = new ImpactSystem(context);

    this._events = new Map();
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0 };
    this.hitmarker = 0;
    this.hitmarkerKill = false;
    this._shotCount = 0;
  }

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(handler);
    return this;
  }

  emit(event, ...args) {
    const list = this._events.get(event);
    if (list) for (const handler of list) handler(...args);
  }

  /**
   * Fire one round.
   *
   * @param {THREE.Vector3} origin     the muzzle, world space
   * @param {THREE.Vector3} direction  unit, already spread
   * @param {object} weapon            weapon config block
   * @param {THREE.Vector3} [tracerFrom] where the visible tracer starts —
   *        the muzzle, which is *not* the ray origin (the ray starts at the eye
   *        so that what the crosshair covers is what gets hit)
   */
  fire(origin, direction, weapon, tracerFrom = origin) {
    this.stats.shots++;
    this._shotCount++;
    _dir.copy(direction).normalize();

    const worldHit = this.collider.raycast(origin, _dir, weapon.range);
    const monsterHit = this.monsters?.raycast(origin, _dir, weapon.range) ?? null;

    let end = null;

    if (monsterHit && (!worldHit || monsterHit.distance < worldHit.distance)) {
      end = monsterHit.point;
      const falloff = this._falloff(monsterHit.distance, weapon);
      const isHead = monsterHit.zone === 'head';
      const damage =
        weapon.damage * falloff * (isHead ? weapon.headshotMultiplier : 1) *
        (monsterHit.zone === 'armor' ? 1 - settings.monsters.armorPlates : 1);

      const killed = this.monsters.damage(monsterHit.monster, damage, monsterHit.point, _dir, isHead);

      this.stats.hits++;
      this.stats.damage += damage;
      if (isHead) this.stats.headshots++;
      if (killed) this.stats.kills++;

      this.hitmarker = settings.combat.hitmarkerTime;
      this.hitmarkerKill = killed;

      this.impacts.spawnFlesh(monsterHit.point, monsterHit.normal, isHead);
      this.emit('hit', { point: monsterHit.point, damage, isHead, killed });
    } else if (worldHit) {
      end = worldHit.point;
      _normal.copy(worldHit.normal);
      // The shot direction goes through so the debris cone can be reflected
      // about the surface normal: a glancing hit has to spray *along* the wall.
      this.impacts.spawnWorld(worldHit.point, _normal, worldHit.surface, _dir);
      this.emit('miss', worldHit);
    } else {
      _hit.copy(origin).addScaledVector(_dir, weapon.range);
      end = _hit;
    }

    if (weapon.tracerEvery > 0 && this._shotCount % weapon.tracerEvery === 0) {
      this.tracers.spawn(tracerFrom, end);
    }
  }

  _falloff(distance, weapon) {
    if (distance <= weapon.falloffStart) return 1;
    if (distance >= weapon.falloffEnd) return weapon.falloffMin;
    const t =
      (distance - weapon.falloffStart) / Math.max(0.001, weapon.falloffEnd - weapon.falloffStart);
    return 1 - (1 - weapon.falloffMin) * t;
  }

  update(dt) {
    this.tracers.update(dt);
    this.impacts.update(dt);
    this.hitmarker = Math.max(0, this.hitmarker - dt);
  }

  dispose() {
    this.tracers.dispose();
    this.impacts.dispose();
  }
}
