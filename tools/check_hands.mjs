#!/usr/bin/env node
/**
 * Do the hands actually clear the weapon's solids?
 *
 * A hand buried inside the gun still renders, is still attached, and still
 * moves with recoil — it is simply invisible. The weapon then reads as
 * floating, and no amount of material or lighting work fixes it, because the
 * failure is 20 mm of geometry in the wrong place.
 *
 * This measures, per weapon: the highest point each left finger reaches versus
 * the top of the handguard it is supposed to wrap, and how far each right
 * finger reaches across the grip versus the grip's far flank.
 *
 * Usage: node tools/check_hands.mjs
 */
import { WeaponModelFactory } from '../src/weapons/WeaponModelFactory.js';
import { Hands } from '../src/weapons/Hands.js';

/** World-space bounds of a geometry, after its mesh transform. */
function bounds(geometry, matrixApply) {
  const p = geometry.getAttribute('position');
  const b = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9 };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (matrixApply) ({ x, y, z } = matrixApply(x, y, z));
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
    b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

/** Highest solid surface of the weapon within a z window, ignoring x sign. */
function solidTopAt(built, z0, z1) {
  let top = -1e9;
  built.group.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z < z0 || z > z1) continue;
      top = Math.max(top, p.getY(i));
    }
  });
  return top;
}

let failed = 0;
const factory = new WeaponModelFactory();

for (const id of ['rifle', 'smg', 'pistol']) {
  const built = factory.build(id);
  const anchors = built.handAnchors;
  const hands = new Hands(anchors);

  console.log(`\n=== ${id} ===`);

  // Each limb is one mesh in Hands.group, authored in weapon space.
  const limbs = hands.group.children.map((m) => bounds(m.geometry));

  // By construction in Hands._build the order is:
  //   0 right forearm, 1 right palm, 2..4 right fingers, 5 thumb, 6 index,
  //   7 left forearm, 8 left palm, 9..12 left fingers, 13 left thumb
  const rightFingers = limbs.slice(2, 5);
  const leftFingers = limbs.slice(9, 13);

  /* ---- left fingers must crown ABOVE the surface they wrap ---- */
  //
  // The target is the surface the hand actually holds, published by the model
  // factory as `fore.top`. That is deliberately NOT the maximum y of the whole
  // assembly: on the rifle the gas tube and upper handguard sit well above the
  // lower handguard the hand is wrapped around, and a finger raised to clear
  // *those* would be holding thin air above the gun.
  const fore = anchors.fore;
  const assemblyTop = solidTopAt(built, fore.z - 0.06, fore.z + 0.06);
  const hgTop = fore.top ?? assemblyTop;
  for (let i = 0; i < leftFingers.length; i++) {
    const crown = leftFingers[i].maxY;
    const clear = crown - hgTop;
    const ok = clear > 0.002;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} left finger ${i}: crown y=${crown.toFixed(4)} vs ` +
        `solid top y=${hgTop.toFixed(4)}  clearance ${(clear * 1000).toFixed(1)} mm`
    );
  }

  /* ---- right fingers must emerge past the grip's far flank ---- */
  const gripHalf = anchors.gripWidth * 0.5;
  for (let i = 0; i < rightFingers.length; i++) {
    const tip = rightFingers[i].minX;
    const clear = -gripHalf - tip;
    const ok = clear > 0.002;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} right finger ${i}: tip x=${tip.toFixed(4)} vs ` +
        `grip far flank x=${(-gripHalf).toFixed(4)}  emerges ${(clear * 1000).toFixed(1)} mm`
    );
  }

  /* ---- wrists must not be gaps ---- */
  //
  // A palm that stops short of its forearm leaves a hole at the wrist, and the
  // limb reads as an amputated tube with a blob floating near the grip. The
  // two bounding boxes have to overlap.
  for (const [label, palm, arm] of [
    ['right', limbs[1], limbs[0]],
    ['left', limbs[8], limbs[7]]
  ]) {
    const overlap =
      Math.min(palm.maxY, arm.maxY) - Math.max(palm.minY, arm.minY) > 0 &&
      Math.min(palm.maxZ, arm.maxZ) - Math.max(palm.minZ, arm.minZ) > 0 &&
      Math.min(palm.maxX, arm.maxX) - Math.max(palm.minX, arm.minX) > 0;
    if (!overlap) failed++;
    console.log(
      `  ${overlap ? 'PASS' : 'FAIL'} ${label} wrist: palm y[${palm.minY.toFixed(3)},${palm.maxY.toFixed(3)}] ` +
        `vs forearm y[${arm.minY.toFixed(3)},${arm.maxY.toFixed(3)}]  ${overlap ? 'joined' : 'GAP'}`
    );
  }
}

console.log(
  failed
    ? `\n${failed} hand part(s) are buried inside the weapon.\n` +
        'Symptom: the gun renders correctly but reads as floating, unheld.'
    : '\nAll hand parts clear the weapon solids.'
);
process.exit(failed ? 1 : 0);
