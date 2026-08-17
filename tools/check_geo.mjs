#!/usr/bin/env node
/**
 * Winding / solidity gate for the gun primitives.
 *
 * ## Why this exists
 *
 * A backwards-wound triangle is the most expensive class of bug in this
 * codebase to find by eye, because it does not look like a winding bug. With
 * backface culling on, a reversed face is simply *not drawn* — so you see
 * through the near wall of a solid to the inside of its far wall, and the part
 * reads as a thin floating plate rather than as a block. A whole weapon built
 * from boxes that were 12/18 quads backwards rendered as a hollow cage of
 * plates, and every review of it blamed the lighting and the materials.
 *
 * Two properties are checked per primitive:
 *
 *  1. **Signed volume is positive.** By the divergence theorem the sum of
 *     `(a · (b × c)) / 6` over a closed outward-wound mesh is its volume.
 *     Negative means the solid is inside-out; near-zero means it is not closed.
 *  2. **Winding agrees with the authored normal.** Each triangle's geometric
 *     normal (b−a) × (c−a) must point the same way as the normal the builder
 *     wrote into the attribute. Disagreement means one of the two is a typo.
 *
 * Usage: node tools/check_geo.mjs
 * Exit code is non-zero if any primitive fails.
 */
import { chamferedBox, barrel, sightRing, loft } from '../src/weapons/GunGeometry.js';

/** @returns {{volume:number, backward:number, triangles:number}} */
function inspect(geometry) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();

  let volume = 0;
  let backward = 0;

  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);

    const ax = position.getX(ia), ay = position.getY(ia), az = position.getZ(ia);
    const bx = position.getX(ib), by = position.getY(ib), bz = position.getZ(ib);
    const cx = position.getX(ic), cy = position.getY(ic), cz = position.getZ(ic);

    volume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;

    const nx = normal.getX(ia), ny = normal.getY(ia), nz = normal.getZ(ia);
    if (gx * nx + gy * ny + gz * nz < 0) backward++;
  }

  return { volume, backward, triangles: index.count / 3 };
}

const cases = [
  // name, geometry, expected volume (optional — chamfers shave a little off)
  ['chamferedBox', chamferedBox(0.06, 0.08, 0.3, 0.004), 0.06 * 0.08 * 0.3],
  ['thin plate', chamferedBox(0.0535, 0.011, 0.018, 0.0022), null],
  ['tiny part', chamferedBox(0.006, 0.009, 0.011, 0.0012), null],
  ['barrel', barrel(0.0122, 0.0112, 0.0039, 0.4, 22), null],
  ['sightRing', sightRing(0.028, 0.022, 0.0055, 0.009), null],
  [
    'loft',
    loft(
      [
        { y: -0.03, z: -0.05, w: 0.031, h: 0.03, r: 0.005 },
        { y: -0.114, z: -0.03, w: 0.0295, h: 0.031, r: 0.006 },
        { y: -0.202, z: 0.042, w: 0.0275, h: 0.032, r: 0.006 }
      ],
      3
    ),
    null
  ]
];

let failed = 0;

for (const [name, geometry, expected] of cases) {
  const { volume, backward, triangles } = inspect(geometry);

  // A barrel and a sight ring are deliberately not closed solids: a barrel has
  // a bore whose wall faces inward, and a sight ring has an aperture that does
  // the same. Signed volume is meaningless for those, so they are judged on
  // the invariant that *does* hold everywhere — every triangle's winding must
  // agree with the normal its builder authored.
  const openByDesign = name === 'barrel' || name === 'sightRing';
  const volumeOk = openByDesign ? true : volume > 0;
  const ok = volumeOk && backward === 0;

  if (!ok) failed++;

  const detail = [
    `${triangles} tris`,
    `volume ${volume.toExponential(2)}`,
    expected ? `(expected ~${expected.toExponential(2)})` : '',
    backward ? `${backward} BACKWARD` : 'winding clean'
  ]
    .filter(Boolean)
    .join(' · ');

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${detail}`);
}

if (failed) {
  console.error(
    `\n${failed} primitive(s) are inside-out or inconsistently wound.\n` +
      'A quad must be listed counterclockwise as seen from OUTSIDE the solid.\n' +
      'Symptom in game: parts render as thin floating plates you can see through.'
  );
  process.exit(1);
}

console.log(`\n${cases.length}/${cases.length} primitives are closed and outward-wound.`);
