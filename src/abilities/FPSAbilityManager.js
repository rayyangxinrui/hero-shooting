import { Vector3 } from 'three';
import { AbilityManager } from './AbilityManager.js';
import { settings, castShapeOf, CastShape } from '../config/settings.js';

const _dir = new Vector3();
const _origin = new Vector3();
const _target = new Vector3();
const _flat = new Vector3();
const _muzzle = new Vector3();
const _toTarget = new Vector3();
const _camRight = new Vector3();
const _camUp = new Vector3();
const _impact = new Vector3();
const _point = new Vector3();

/**
 * Where a spell leaves the player, in view space.
 *
 * These mirror the muzzle offsets in `Ability#muzzlePoint`, and they are the
 * first-person answer to the sandbox's `handHeight` / `handForward` / `handSide`:
 * a spell comes out of the hand holding the weapon, which is below and to the
 * right of the crosshair, not out of the floor under the player's feet.
 */
const MUZZLE_FORWARD = 0.42; // metres down the view axis
const MUZZLE_RIGHT = 0.26; // metres to the weapon side
const MUZZLE_DROP = 0.3; // metres below the eye

/**
 * Adapts the ground-targeted ability system to a first-person camera.
 *
 * The abilities themselves are unchanged and unaware of the camera: each one
 * still takes `(origin, direction, distance)` on the floor, because that is
 * what its whole VFX is built around. What changes in a shooter is only *how
 * those three numbers are chosen* — and the answer is the crosshair.
 *
 * A cast raycasts down the view ray, finds what the player is actually looking
 * at, and lays the spell along the ground line from their feet to that point.
 * Two consequences fall out that are worth stating:
 *
 *  - aiming at a wall 4 m away casts a 4 m spell, not a 20 m one that ends
 *    inside the wall;
 *  - aiming at the sky casts at maximum range along the flattened view
 *    heading, which is what a player expects from a snap-cast.
 *
 * Damage is applied at cast time in a sphere around the impact point rather
 * than by simulating the VFX, because the VFX is a *depiction* of the spell —
 * tying hit registration to particle positions would make damage depend on the
 * frame rate.
 */
export class FPSAbilityManager extends AbilityManager {
  constructor(context) {
    super(context);
    this.camera = context.camera;
    this.player = context.player;
    this.collider = context.collider;
    this.combat = context.combat;

    /** Area damage per element, applied at the impact point. */
    this.damage = {
      thunder: { amount: 95, radius: 3.4 },
      ice: { amount: 78, radius: 4.0 },
      meteor: { amount: 150, radius: 5.4 },
      beam: { amount: 210, radius: 3.0 },
      snare: { amount: 60, radius: 4.6 },
      glacier: { amount: 90, radius: 4.8 }
    };
  }

  /**
   * Cast the given element down the crosshair.
   * @returns {import('./Ability.js').Ability|null}
   */
  cast(element) {
    const config = settings[element];
    if (!config) return null;

    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_dir);

    const range = config.range;

    // What is the player actually looking at?
    const worldHit = this.collider.raycast(_origin, _dir, range * 1.6);
    const monsterHit = this.ctx.combat?.monsters?.raycast(_origin, _dir, range * 1.6) ?? null;

    let hit = worldHit;
    if (monsterHit && (!worldHit || monsterHit.distance < worldHit.distance)) hit = monsterHit;

    if (hit) {
      _target.copy(hit.point);
    } else {
      _target.copy(_origin).addScaledVector(_dir, range);
    }

    // Where the spell *starts*.
    //
    // The sandbox this came from laid every cast from the caster's feet, which
    // is right for a third-person camera looking down at a character: you can
    // see the body, so a spell leaving the floor beside it reads as leaving the
    // character. In first person there is no body, the floor beside you is off
    // the bottom of the screen, and a cast laid from your own feet visibly
    // emanates from a point beside the player rather than from the crosshair.
    //
    // So the line starts at the *muzzle* — down and right of the crosshair,
    // where the player's hand is — and runs to whatever the crosshair hit. The
    // spell is still a line with an origin, a direction and a length, so
    // nothing downstream changes; only where the line begins.
    const muzzle = _muzzle.copy(_origin);
    _camRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    _camUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    muzzle
      .addScaledVector(_dir, MUZZLE_FORWARD)
      .addScaledVector(_camRight, MUZZLE_RIGHT)
      .addScaledVector(_camUp, -MUZZLE_DROP);

    // The abilities are still ground-anchored — their fields, decals and
    // fissures are all placed against y = 0 — so the line they are handed is
    // the muzzle's *ground projection*. Each ability lifts its own origin back
    // to the hand through `Ability#muzzlePoint`, which is where the spell is
    // actually drawn from.
    const start = _flat.set(muzzle.x, 0, muzzle.z);

    const toTarget = _toTarget.set(_target.x - start.x, 0, _target.z - start.z);
    let distance = toTarget.length();

    if (distance < 0.001) {
      // Looking straight down or straight up: fall back to the flat heading.
      toTarget.set(-Math.sin(this.player.euler.y), 0, -Math.cos(this.player.euler.y));
      distance = Math.min(range, config.minRange + 1);
    }

    toTarget.normalize();
    distance = Math.max(config.minRange + 0.5, Math.min(range, distance));

    const ability = super.cast(start, toTarget, distance, element);
    if (!ability) return null;

    // Hand the ability the crosshair's *real* 3-D landing point, not the floor
    // projection of it. Clamped back onto the (possibly shortened) cast line so
    // an ability that ends at the aim point still ends where its own ground
    // effects do — only at the right height.
    ability.aimPoint.set(
      start.x + toTarget.x * distance,
      hit ? _target.y : _origin.y + _dir.y * distance,
      start.z + toTarget.z * distance
    );

    /* ---- damage ---- */
    // Scratch vectors throughout: casting must not allocate, or spamming an
    // ability walks the GC straight through the frame budget.
    const damage = this.damage[element];
    if (damage && this.ctx.combat?.monsters) {
      const shape = castShapeOf(element);
      const impact = _impact
        .copy(start)
        .addScaledVector(toTarget, distance);
      impact.y = 1.0;

      if (shape === CastShape.ZONE) {
        // A far cast damages its whole footprint.
        this.ctx.combat.monsters.damageArea(
          impact,
          config.zoneRadius ?? damage.radius,
          damage.amount
        );
      } else {
        // A line cast damages along its length, sampled at intervals so a
        // creature standing halfway down the lance is hit by it.
        const steps = Math.max(2, Math.round(distance / 2.5));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const point = _point.copy(start).addScaledVector(toTarget, distance * t);
          point.y = 1.0;
          // Damage is weighted toward the impact point: the tip of a lance
          // hurts more than its shaft.
          this.ctx.combat.monsters.damageArea(
            point,
            damage.radius * (0.6 + 0.4 * t),
            (damage.amount / steps) * (0.5 + t)
          );
        }
      }
    }

    return ability;
  }
}
