import {
  Vector3,
  Color,
  Object3D,
  DirectionalLight,
  PointLight,
  AmbientLight,
  HemisphereLight
} from 'three';
import { LAYER } from '../core/Layers.js';

const _worldPos = new Vector3();
const _toGun = new Vector3();
const _accum = new Color();
const _contribution = new Color();

/**
 * Lights the first-person weapon from the world around it.
 *
 * ## Why this class has to exist
 *
 * The viewmodel is drawn by its own camera on its own layer, which is what lets
 * a rifle sit 30 cm from the eye without clipping through walls. But three.js
 * collects lights *per camera, by layer*: a light on `LAYER.WORLD` is simply
 * not in the viewmodel camera's light list. Without this class the gun is lit
 * by image-based lighting alone — it never sees the sun, and, far more
 * visibly, it never sees the muzzle flash, the fireball or the lightning bolt
 * going off beside it.
 *
 * That is the "flat black gun in front of a violet explosion" problem. No
 * amount of work on the gun's own materials can fix it, because the gun is not
 * being lit wrongly — it is not being lit at all.
 *
 * ## The fix
 *
 * Four lights that live on the VIEWMODEL layer and are driven every frame:
 * an ambient and a hemisphere for fill, a **key** that copies the world sun so
 * the gun agrees with the wall about the time of day, and a **dynamic** that
 * gathers every live light in the `LightPool` and reduces them to one point
 * light — placed at their intensity-weighted centroid, coloured by their summed
 * contribution at the gun.
 *
 * Summing to a single light rather than mirroring each one is deliberate. Every
 * additional light in a camera's list changes the program cache key and forces
 * three to recompile every material that camera draws; mirroring six pooled
 * lights would hitch the frame on the first cast. One light, re-aimed per
 * frame, costs nothing and captures what the eye actually reads: the direction,
 * colour and brightness of the bright thing nearby.
 */
export class ViewmodelLighting {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../effects/LightPool.js').LightPool} pool
   * @param {import('../world/Environment.js').Environment} environment
   */
  constructor(scene, pool, environment) {
    this.pool = pool;
    this.environment = environment;

    /** Matches the world sun, so the gun and the wall agree about the sun. */
    this.key = new DirectionalLight(0xffffff, 1);
    this.key.castShadow = false;
    this.key.layers.set(LAYER.VIEWMODEL);
    // A directional light aims at its target's world position, so the target
    // has to be in the scene graph to have one.
    this.keyTarget = new Object3D();
    this.key.target = this.keyTarget;

    /** Fill, so the shadowed side of the gun is not pure black. */
    this.hemi = new HemisphereLight(0xffffff, 0x404040, 1);
    this.hemi.layers.set(LAYER.VIEWMODEL);

    this.ambient = new AmbientLight(0xffffff, 1);
    this.ambient.layers.set(LAYER.VIEWMODEL);

    /** Everything transient in the world, collapsed into one light. */
    this.dynamic = new PointLight(0xffffff, 0, 12, 2);
    this.dynamic.castShadow = false;
    this.dynamic.layers.set(LAYER.VIEWMODEL);

    scene.add(this.key, this.keyTarget, this.hemi, this.ambient, this.dynamic);

    this._centroid = new Vector3();
  }

  /**
   * @param {THREE.Object3D} viewmodelRoot  where the gun currently is
   * @param {number} dt
   */
  update(viewmodelRoot, dt) {
    const env = this.environment;

    /* ---- key: copy the world sun ---- */
    this.key.position.copy(env.sun.position);
    this.keyTarget.position.copy(env.sunTarget.position);
    this.key.color.copy(env.sun.color);
    // Held slightly under the world's key: a viewmodel 30 cm from the eye
    // subtends far more of the frame than a wall 20 m away, so matching the
    // world intensity exactly blows the gun out.
    //
    // But only *slightly*. An earlier version of this file suppressed the key
    // to 0.62 while pushing hemi to 1.15 and ambient to 1.1, and a blind critic
    // correctly read the result as "lit by a different light than the
    // environment". The reason is that fill is omnidirectional: boosting it
    // while cutting the key flattens the form and destroys the directional
    // agreement that makes the gun look like it is *in* the scene. A first
    // person weapon needs one dominant raking light and a cool sky fill, in the
    // same ratio the world uses — not a lightbox.
    //
    // Held at parity now rather than under. The world sun is a *shadow-casting*
    // directional and the viewmodel's is not, so an identical intensity does
    // not produce an identical result: the gun never receives the occlusion the
    // world does, but it also never receives the bounce that fills the world's
    // shadow side. Measured against the scene it sits in, the weapon came out
    // at luma 62 with the ground directly behind it at 101 — a first-person
    // weapon that is consistently darker than the floor reads as pasted on, and
    // the eye notices that long before it notices a material.
    this.key.intensity = env.sun.intensity * 1.0;

    this.hemi.color.copy(env.hemi.color);
    this.hemi.groundColor.copy(env.hemi.groundColor);
    // Fill is scaled *up* rather than down, for the same reason: the gun gets no
    // bounce from the ground it is being held over, so its shadow side has to be
    // paid for explicitly or it crushes.
    this.hemi.intensity = env.hemi.intensity * 1.6;

    this.ambient.color.copy(env.ambient.color);
    this.ambient.intensity = env.ambient.intensity * 1.2;

    /* ---- dynamic: collapse the pool to one light at the gun ---- */
    viewmodelRoot.getWorldPosition(_worldPos);

    _accum.setRGB(0, 0, 0);
    this._centroid.set(0, 0, 0);
    let totalWeight = 0;

    for (const entry of this.pool.lights) {
      const light = entry.light;
      if (light.intensity <= 0.001) continue;

      _toGun.copy(light.position).sub(_worldPos);
      const distance = Math.max(0.35, _toGun.length());

      // Cut off at the light's own radius, so a spell landing across the arena
      // does not tint the gun forever.
      const radius = Math.max(0.001, light.distance);
      if (distance > radius) continue;

      const falloff = (1 - distance / radius) ** 2;
      const weight = (light.intensity * falloff) / (distance * distance);
      if (weight <= 0.0001) continue;

      _contribution.copy(light.color).multiplyScalar(weight);
      _accum.add(_contribution);

      this._centroid.addScaledVector(light.position, weight);
      totalWeight += weight;
    }

    if (totalWeight > 0.0001) {
      this._centroid.divideScalar(totalWeight);
      this.dynamic.position.copy(this._centroid);

      // The accumulated colour carries the summed weight, so hue comes from the
      // sum and strength from the total — normalise the one against the other.
      const peak = Math.max(_accum.r, _accum.g, _accum.b);
      if (peak > 0.0001) this.dynamic.color.copy(_accum).multiplyScalar(1 / peak);

      const distance = Math.max(0.35, this._centroid.distanceTo(_worldPos));
      // Rebuild an intensity that lands the same irradiance on the gun that the
      // summed contributions did, given three's own inverse-square falloff.
      const target = Math.min(45, totalWeight * distance * distance);
      // Eased rather than snapped: a muzzle flash lasting two frames still has
      // to read as a pulse of light on the gun, not as a single-frame pop.
      this.dynamic.intensity += (target - this.dynamic.intensity) * Math.min(1, 34 * dt);
      this.dynamic.distance = Math.max(4, distance * 2.4);
    } else {
      this.dynamic.intensity += (0 - this.dynamic.intensity) * Math.min(1, 16 * dt);
    }
  }

  dispose() {
    for (const light of [this.key, this.keyTarget, this.hemi, this.ambient, this.dynamic]) {
      light.parent?.remove(light);
    }
  }
}
