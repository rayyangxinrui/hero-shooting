#!/usr/bin/env node
/**
 * Can the player actually see through the rear sight?
 *
 * ADS is the most-looked-at frame in a shooter, and it fails in a way that is
 * invisible to every other check: the sight is modelled with a real hole, the
 * ADS offset solves correctly, and yet some *other* part of the weapon sits in
 * the line of sight and turns the aperture into a black wall.
 *
 * This casts the actual sight line — from the eye, through the middle of the
 * rear aperture — and reports every part it strikes.
 */
import { WeaponModelFactory } from '../src/weapons/WeaponModelFactory.js';

const factory = new WeaponModelFactory();
let failed = 0;

for (const id of ['rifle', 'smg', 'pistol']) {
  const built = factory.build(id);

  let rear = null;
  let front = null;
  built.group.traverse((o) => {
    if (o.name === 'rearSight') rear = o.position;
    if (o.name === 'frontSight') front = o.position;
  });
  if (!rear || !front) {
    console.log(`${id}: no named sights, skipping`);
    continue;
  }

  console.log(`\n=== ${id} ===`);
  console.log(`  rear  sight at y=${rear.y.toFixed(4)} z=${rear.z.toFixed(4)}`);
  console.log(`  front sight at y=${front.y.toFixed(4)} z=${front.z.toFixed(4)}`);

  // The sight line runs from behind the rear sight, through it, to the front
  // post and on to the target. Sample along it and report any solid hit.
  const dy = front.y - rear.y;
  const dz = front.z - rear.z;
  const length = Math.hypot(dy, dz);
  const uy = dy / length;
  const uz = dz / length;

  // Walk the span *between* the two sights, excluding both.
  //
  // The sights themselves are legitimately on the sight line — the front post
  // is what you aim with, and the rear sight's frame necessarily surrounds the
  // aperture you look through. Including either reports every correctly built
  // weapon as broken. What this is actually looking for is a *third* thing in
  // the way: a dust cover rib, a slide roof, a carry handle.
  const blockers = new Map();
  const samples = 400;
  const skipNearRear = 0.06; // the rear sight body
  const skipNearFront = 0.94; // the front post
  for (let s = samples * skipNearRear; s < samples * skipNearFront; s++) {
    const t = (s / samples) * length;
    const py = rear.y + uy * t;
    const pz = rear.z + uz * t;

    built.group.traverse((o) => {
      if (!o.isMesh) return;
      const position = o.geometry.getAttribute('position');
      // Cheap test: is this sample inside the mesh's bounding box, away from
      // the sight parts themselves?
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      if (py < b.min.y || py > b.max.y || pz < b.min.z || pz > b.max.z) return;

      // Finer: count vertices of this mesh near the sample, on the centreline.
      let near = 0;
      for (let i = 0; i < position.count; i += 3) {
        const x = position.getX(i);
        if (Math.abs(x) > 0.006) continue;
        if (Math.abs(position.getY(i) - py) < 0.004 && Math.abs(position.getZ(i) - pz) < 0.004) {
          near++;
          if (near > 2) break;
        }
      }
      if (near > 2) {
        const key = `mesh@${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}`;
        blockers.set(key, (blockers.get(key) ?? 0) + 1);
      }
    });
  }

  // The front post itself is legitimately in the sight line.
  const real = [...blockers.entries()].filter(([, hits]) => hits > 6);
  if (real.length) {
    failed++;
    console.log(`  FAIL sight line obstructed at ${real.length} place(s):`);
    for (const [key, hits] of real) console.log(`       ${key}  (${hits} samples)`);
  } else {
    console.log('  PASS sight line is clear');
  }
}

console.log(
  failed ? `\n${failed} weapon(s) cannot be aimed through.` : '\nAll sight lines are clear.'
);
process.exit(failed ? 1 : 0);
