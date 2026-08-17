import { Vector3, Box3, Raycaster } from 'three';

const _min = new Vector3();
const _max = new Vector3();
const _closest = new Vector3();
const _push = new Vector3();

/**
 * Axis-aligned collision world.
 *
 * Everything the player can stand on or bump into is a box. That is a real
 * constraint on level geometry, and it buys three things a mesh collider would
 * not: resolution is a handful of min/max compares rather than a triangle
 * sweep, the hit normal is exact instead of interpolated, and there is no
 * tunnelling budget to tune. The arena is built from crates, pillars and walls,
 * so the constraint costs nothing here.
 *
 * The player is a vertical capsule approximated as a cylinder with a flat cap:
 * for boxes, and at these speeds, the difference from a true capsule only shows
 * up on the top lip of a crate — which is exactly what `stepHeight` is for.
 */
export class Collider {
  constructor() {
    /** @type {{box: Box3, surface: string}[]} */
    this.boxes = [];
    this.raycaster = new Raycaster();
    /** Meshes eligible for bullet raycasts (world geometry). */
    this.hitMeshes = [];
  }

  /**
   * @param {THREE.Box3} box
   * @param {string} surface  material id for impact effects
   */
  add(box, surface = 'concrete') {
    this.boxes.push({ box, surface });
    return this;
  }

  addMesh(mesh, surface = 'concrete') {
    mesh.updateWorldMatrix(true, false);
    const box = new Box3().setFromObject(mesh);
    this.add(box, surface);
    mesh.userData.surface = surface;
    this.hitMeshes.push(mesh);
    return this;
  }

  clear() {
    this.boxes.length = 0;
    this.hitMeshes.length = 0;
  }

  /**
   * Push a capsule out of every box it is inside, and report whether it ended
   * up standing on something.
   *
   * @param {THREE.Vector3} position  eye position — mutated in place
   * @param {number} radius
   * @param {number} height           eye height above the feet
   * @param {THREE.Vector3} velocity  mutated: killed along each contact normal
   */
  resolve(position, radius, height, velocity) {
    let onGround = false;
    const feetOffset = height;

    // The floor is implicit: y = 0. Cheap, and it means an arena without a
    // ground box still behaves.
    if (position.y - feetOffset <= 0) {
      position.y = feetOffset;
      if (velocity.y < 0) velocity.y = 0;
      onGround = true;
    }

    for (let pass = 0; pass < 3; pass++) {
      let moved = false;

      for (const entry of this.boxes) {
        const box = entry.box;
        const feetY = position.y - feetOffset;
        const headY = position.y + 0.12;

        // Vertical overlap first — it rejects most boxes with two compares.
        if (headY < box.min.y || feetY > box.max.y) continue;

        _min.copy(box.min);
        _max.copy(box.max);

        // Closest point on the box footprint to the capsule axis.
        _closest.set(
          Math.max(_min.x, Math.min(position.x, _max.x)),
          0,
          Math.max(_min.z, Math.min(position.z, _max.z))
        );

        const dx = position.x - _closest.x;
        const dz = position.z - _closest.z;
        const distSq = dx * dx + dz * dz;

        if (distSq >= radius * radius) continue;

        // Landing on top: if the feet are above the box top minus a step, and
        // we are falling, this is a floor rather than a wall.
        const topGap = box.max.y - feetY;
        if (velocity.y <= 0 && topGap > 0 && topGap <= 0.55) {
          position.y = box.max.y + feetOffset;
          velocity.y = 0;
          onGround = true;
          moved = true;
          continue;
        }

        // Under a ceiling.
        if (velocity.y > 0 && headY > box.min.y && feetY < box.min.y) {
          position.y = box.min.y - 0.12 + feetOffset - (headY - position.y);
          velocity.y = 0;
          moved = true;
          continue;
        }

        // Otherwise push out horizontally along the shortest axis.
        const dist = Math.sqrt(distSq);
        if (dist > 0.0001) {
          _push.set(dx / dist, 0, dz / dist);
        } else {
          // Dead centre: pick the axis with the least penetration.
          const toMinX = position.x - _min.x;
          const toMaxX = _max.x - position.x;
          const toMinZ = position.z - _min.z;
          const toMaxZ = _max.z - position.z;
          const minPen = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
          if (minPen === toMinX) _push.set(-1, 0, 0);
          else if (minPen === toMaxX) _push.set(1, 0, 0);
          else if (minPen === toMinZ) _push.set(0, 0, -1);
          else _push.set(0, 0, 1);
        }

        const penetration = radius - dist;
        position.x += _push.x * penetration;
        position.z += _push.z * penetration;

        // Kill the velocity component going into the surface, keep the rest —
        // this is what lets you slide along a wall instead of sticking to it.
        const into = velocity.x * _push.x + velocity.z * _push.z;
        if (into < 0) {
          velocity.x -= _push.x * into;
          velocity.z -= _push.z * into;
        }
        moved = true;
      }

      if (!moved) break;
    }

    return { onGround };
  }

  /**
   * Ray against the box world. Returns the nearest hit or null.
   * Slab method — branchless enough to run per bullet without a broadphase at
   * this box count.
   */
  raycast(origin, direction, maxDistance = 200) {
    let best = null;
    let bestT = maxDistance;

    for (const entry of this.boxes) {
      const box = entry.box;
      let tmin = 0;
      let tmax = bestT;
      let hitAxis = 0;
      let hitSign = 1;
      let valid = true;

      for (let axis = 0; axis < 3; axis++) {
        const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
        const d = axis === 0 ? direction.x : axis === 1 ? direction.y : direction.z;
        const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
        const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;

        if (Math.abs(d) < 1e-8) {
          if (o < lo || o > hi) {
            valid = false;
            break;
          }
          continue;
        }

        const inv = 1 / d;
        let t1 = (lo - o) * inv;
        let t2 = (hi - o) * inv;
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          hitAxis = axis;
          hitSign = sign;
        }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) {
          valid = false;
          break;
        }
      }

      if (valid && tmin > 0.001 && tmin < bestT) {
        bestT = tmin;
        best = { distance: tmin, axis: hitAxis, sign: hitSign, surface: entry.surface };
      }
    }

    // The implicit floor.
    if (direction.y < -1e-8) {
      const t = -origin.y / direction.y;
      if (t > 0.001 && t < bestT) {
        bestT = t;
        best = { distance: t, axis: 1, sign: -1, surface: 'concrete' };
      }
    }

    if (!best) return null;

    const point = new Vector3()
      .copy(origin)
      .addScaledVector(direction, best.distance);
    // Read `sign`, which is what the hit record above stores. Reading a
    // `hitSign` field that does not exist yields undefined, every comparison
    // fails, and the normal comes out (0,0,0) — which silently breaks every
    // consumer of a wall normal: impact debris sprays nowhere and decals
    // cannot be oriented.
    const normal = new Vector3(
      best.axis === 0 ? best.sign : 0,
      best.axis === 1 ? best.sign : 0,
      best.axis === 2 ? best.sign : 0
    );
    // The floor case above sets sign -1 on the y axis, but its normal points up.
    if (best.axis === 1 && best.sign === -1) normal.set(0, 1, 0);

    return { point, normal, distance: best.distance, surface: best.surface };
  }
}
