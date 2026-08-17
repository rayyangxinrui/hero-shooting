import { BufferGeometry, BufferAttribute, Float32BufferAttribute } from 'three';

/**
 * Geometry primitives for a firearm viewmodel.
 *
 * ## Why not BoxGeometry
 *
 * Nothing on a real gun has a perfectly sharp 90-degree corner. Every edge is
 * chamfered, radiused or broken — by machining, by moulding draft, or by being
 * handled. That matters far more than it sounds: a sharp edge catches light in
 * exactly one infinitely thin line, so under any lighting it renders as a hard
 * black-to-lit discontinuity. A chamfered edge catches a *highlight* along its
 * face, and that highlight is what the eye reads as metal.
 *
 * A viewmodel built from `BoxGeometry` therefore cannot look like a weapon no
 * matter what material is on it. It has no edge highlights to catch, so it goes
 * flat and dark and reads as a black wedge. That is the single biggest reason a
 * hobby shooter's gun looks wrong next to CS2's.
 *
 * So every part here is a **chamfered box**: 24 vertices instead of 8, with the
 * corner bevels cut at a real width in metres. Each vertex carries `aEdge` —
 * 1 on a bevel face, 0 on a flat — which `GunMaterial` uses to place wear where
 * a gun is actually handled and knocked, rather than spraying it with noise.
 *
 * Cost is trivial: a chamfered box is 44 triangles against 12, and a whole rifle
 * comes to about 1,400 triangles. The reference frames these are judged against
 * are 30k-triangle models, so this is not where the budget goes.
 */

/**
 * A box with all twelve edges chamfered.
 *
 * Built as an inset core plus the bevel faces, rather than by beveling a cube
 * after the fact: the topology is then fixed and the `aEdge` attribute can be
 * written directly instead of being inferred from face angles.
 *
 * @param {number} w  width  (x)
 * @param {number} h  height (y)
 * @param {number} d  depth  (z)
 * @param {number} bevel  chamfer width in metres — 0.6-1.5 mm is realistic
 */
export function chamferedBox(w, h, d, bevel = 0.0012) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  // Never let the chamfer eat more than a third of the smallest dimension.
  const b = Math.min(bevel, Math.min(w, h, d) / 3);

  const positions = [];
  const normals = [];
  const edges = [];
  const indices = [];

  /** Push one quad, with a flat normal and a uniform edge weight. */
  const quad = (a, bb, c, dd, nx, ny, nz, edgeWeight) => {
    const base = positions.length / 3;
    for (const v of [a, bb, c, dd]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(nx, ny, nz);
      edges.push(edgeWeight);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const xi = x - b;
  const yi = y - b;
  const zi = z - b;
  const s = Math.SQRT1_2;

  /* ---- the six flat faces, inset by the chamfer ---- */
  //
  // ## Winding
  //
  // Every quad below is listed counterclockwise *as seen from outside*, which
  // is what three's default front-face convention requires. Getting this wrong
  // does not throw and does not look like a winding bug: with backface culling
  // on, the offending faces simply vanish and you see through the solid to the
  // inside of its far wall. A whole gun built from boxes that were 12/18
  // backwards read as a hollow shell of floating plates — which is exactly the
  // failure this comment exists to prevent recurring.
  //
  // The `_check` test in the tools directory verifies signed volume is
  // positive; run it after touching any of these.
  quad([-xi, -yi, z], [xi, -yi, z], [xi, yi, z], [-xi, yi, z], 0, 0, 1, 0);
  quad([xi, -yi, -z], [-xi, -yi, -z], [-xi, yi, -z], [xi, yi, -z], 0, 0, -1, 0);
  quad([x, -yi, zi], [x, -yi, -zi], [x, yi, -zi], [x, yi, zi], 1, 0, 0, 0);
  quad([-x, -yi, -zi], [-x, -yi, zi], [-x, yi, zi], [-x, yi, -zi], -1, 0, 0, 0);
  quad([-xi, y, zi], [xi, y, zi], [xi, y, -zi], [-xi, y, -zi], 0, 1, 0, 0);
  quad([-xi, -y, -zi], [xi, -y, -zi], [xi, -y, zi], [-xi, -y, zi], 0, -1, 0, 0);

  /* ---- the twelve edge bevels ---- */
  // Four running along x.
  quad([-xi, yi, z], [xi, yi, z], [xi, y, zi], [-xi, y, zi], 0, s, s, 1);
  quad([-xi, y, -zi], [xi, y, -zi], [xi, yi, -z], [-xi, yi, -z], 0, s, -s, 1);
  quad([-xi, -y, zi], [xi, -y, zi], [xi, -yi, z], [-xi, -yi, z], 0, -s, s, 1);
  quad([-xi, -yi, -z], [xi, -yi, -z], [xi, -y, -zi], [-xi, -y, -zi], 0, -s, -s, 1);
  // Four running along y.
  quad([x, -yi, zi], [x, yi, zi], [xi, yi, z], [xi, -yi, z], s, 0, s, 1);
  quad([xi, -yi, -z], [xi, yi, -z], [x, yi, -zi], [x, -yi, -zi], s, 0, -s, 1);
  quad([-xi, -yi, z], [-xi, yi, z], [-x, yi, zi], [-x, -yi, zi], -s, 0, s, 1);
  quad([-x, -yi, -zi], [-x, yi, -zi], [-xi, yi, -z], [-xi, -yi, -z], -s, 0, -s, 1);
  // Four running along z.
  quad([x, yi, -zi], [xi, y, -zi], [xi, y, zi], [x, yi, zi], s, s, 0, 1);
  quad([-x, yi, zi], [-xi, y, zi], [-xi, y, -zi], [-x, yi, -zi], -s, s, 0, 1);
  quad([x, -yi, zi], [xi, -y, zi], [xi, -y, -zi], [x, -yi, -zi], s, -s, 0, 1);
  quad([-x, -yi, -zi], [-xi, -y, -zi], [-xi, -y, zi], [-x, -yi, zi], -s, -s, 0, 1);

  /* ---- the eight corners ---- */
  const corner = (sx, sy, sz) => {
    const base = positions.length / 3;
    const n = sx * 0.577;
    const m = sy * 0.577;
    const o = sz * 0.577;
    positions.push(sx * x, sy * yi, sz * zi);
    positions.push(sx * xi, sy * y, sz * zi);
    positions.push(sx * xi, sy * yi, sz * z);
    for (let i = 0; i < 3; i++) {
      normals.push(n, m, o);
      edges.push(1);
    }
    // Wind so the outward normal is consistent for this octant.
    if (sx * sy * sz > 0) indices.push(base, base + 1, base + 2);
    else indices.push(base, base + 2, base + 1);
  };
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corner(sx, sy, sz);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * A tube along -Z, open at both ends, with an optional chamfer at the muzzle.
 *
 * Real barrels are *hollow*, and the bore is visible as a dark circle at the
 * end. A solid cylinder with a flat cap reads as a dowel, which is one of the
 * clearest tells of a placeholder weapon.
 *
 * @param {number} outer   outer radius at the breech
 * @param {number} outerEnd outer radius at the muzzle
 * @param {number} bore    inner radius, 0 for solid
 * @param {number} length
 * @param {number} segments
 */
export function barrel(outer, outerEnd, bore, length, segments = 24) {
  const positions = [];
  const normals = [];
  const edges = [];
  const indices = [];

  const half = length / 2;

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    // Outer wall.
    positions.push(ca * outer, sa * outer, half);
    normals.push(ca, sa, 0);
    edges.push(0);
    positions.push(ca * outerEnd, sa * outerEnd, -half);
    normals.push(ca, sa, 0);
    edges.push(0);
  }
  // Winding, for all three walls below. Even indices are the breech ring
  // (z = +half), odd are the muzzle ring (z = −half), and the angle increases
  // with i. Walking (this-breech → next-breech → this-muzzle) is therefore
  // counterclockwise seen from outside the tube, which is what puts the front
  // face outward. The reverse makes the barrel invisible from outside and
  // leaves you looking at the inside of its far wall.
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 2;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }

  if (bore > 0) {
    const boreBase = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Inner wall, normals pointing inward.
      positions.push(ca * bore, sa * bore, half);
      normals.push(-ca, -sa, 0);
      edges.push(0);
      positions.push(ca * bore, sa * bore, -half);
      normals.push(-ca, -sa, 0);
      edges.push(0);
    }
    // The bore faces *inward*, so it is wound opposite to the outer wall.
    for (let i = 0; i < segments; i++) {
      const a = boreBase + i * 2;
      const b = a + 2;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }

    // The muzzle crown: the annulus between bore and outer, which is the
    // surface that catches light around a bore and says "this is a hole".
    const crownBase = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions.push(ca * outerEnd, sa * outerEnd, -half);
      normals.push(0, 0, -1);
      edges.push(1);
      positions.push(ca * bore, sa * bore, -half);
      normals.push(0, 0, -1);
      edges.push(1);
    }
    // The crown is the flat annulus at the muzzle and genuinely faces −Z, out
    // of the end of the gun. Even indices are on the outer radius, odd on the
    // bore, so this winding is the one that agrees with that normal.
    for (let i = 0; i < segments; i++) {
      const a = crownBase + i * 2;
      const b = a + 2;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * A hollow rectangular ring — the rear aperture of an iron sight.
 *
 * This exists because a *solid* rear sight cannot be looked through, and ADS
 * then renders as two black blocks covering the middle of the screen with no
 * aperture and no target visible. The sight has to have an actual hole in it.
 *
 * @param {number} w  outer width
 * @param {number} h  outer height
 * @param {number} t  wall thickness
 * @param {number} d  depth along z
 */
export function sightRing(w, h, t, d) {
  const positions = [];
  const normals = [];
  const edges = [];
  const indices = [];

  const ox = w / 2;
  const oy = h / 2;
  const ix = ox - t;
  const iy = oy - t;
  const z = d / 2;

  const quad = (a, b, c, dd, n, edgeWeight) => {
    const base = positions.length / 3;
    for (const v of [a, b, c, dd]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(n[0], n[1], n[2]);
      edges.push(edgeWeight);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Front and back faces, as four quads each (the frame around the hole).
  for (const sz of [z, -z]) {
    const n = sz > 0 ? [0, 0, 1] : [0, 0, -1];
    const flip = sz > 0;
    const f = (a, b, c, dd) => (flip ? quad(a, b, c, dd, n, 1) : quad(dd, c, b, a, n, 1));
    f([-ox, iy, sz], [ox, iy, sz], [ox, oy, sz], [-ox, oy, sz]); // top
    f([-ox, -oy, sz], [ox, -oy, sz], [ox, -iy, sz], [-ox, -iy, sz]); // bottom
    f([-ox, -iy, sz], [-ix, -iy, sz], [-ix, iy, sz], [-ox, iy, sz]); // left
    f([ix, -iy, sz], [ox, -iy, sz], [ox, iy, sz], [ix, iy, sz]); // right
  }

  // Outer walls.
  quad([ox, -oy, z], [ox, -oy, -z], [ox, oy, -z], [ox, oy, z], [1, 0, 0], 0);
  quad([-ox, -oy, -z], [-ox, -oy, z], [-ox, oy, z], [-ox, oy, -z], [-1, 0, 0], 0);
  quad([-ox, oy, z], [ox, oy, z], [ox, oy, -z], [-ox, oy, -z], [0, 1, 0], 0);
  quad([-ox, -oy, -z], [ox, -oy, -z], [ox, -oy, z], [-ox, -oy, z], [0, -1, 0], 0);

  // Inner walls — the surface of the aperture. Their normals point *into* the
  // hole (that is what you see when you look through the sight), so each is
  // wound to agree with its own inward normal rather than with the outer shell.
  quad([ix, -iy, -z], [ix, -iy, z], [ix, iy, z], [ix, iy, -z], [-1, 0, 0], 1);
  quad([-ix, -iy, z], [-ix, -iy, -z], [-ix, iy, -z], [-ix, iy, z], [1, 0, 0], 1);
  quad([-ix, iy, -z], [ix, iy, -z], [ix, iy, z], [-ix, iy, z], [0, -1, 0], 1);
  quad([-ix, -iy, z], [ix, -iy, z], [ix, -iy, -z], [-ix, -iy, -z], [0, 1, 0], 1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Cooling slots / lightening cuts, as a strip of thin chamfered boxes.
 * Returned as a single merged geometry so a handguard's vents cost one draw.
 */
export function slotStrip(count, spacing, w, h, d, bevel = 0.0004) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const geometry = chamferedBox(w, h, d, bevel);
    const offset = (i - (count - 1) / 2) * spacing;
    const position = geometry.getAttribute('position');
    for (let v = 0; v < position.count; v++) {
      position.setZ(v, position.getZ(v) + offset);
    }
    parts.push(geometry);
  }
  return mergeGeometries(parts);
}

/**
 * Bake a mesh-style transform into a geometry's vertices.
 *
 * This is what lets a whole weapon collapse into one geometry per material.
 * Parts are authored with a position and a rotation, exactly as if they were
 * meshes; baking those into the vertices means the merged result is still one
 * draw call. Normals go through the inverse-transpose so a rotated part is not
 * lit as though it were still axis-aligned.
 *
 * @param {BufferGeometry} geometry  mutated in place
 * @param {{x?:number,y?:number,z?:number}} [position]
 * @param {{x?:number,y?:number,z?:number}} [rotation]  XYZ euler, radians
 */
export function place(geometry, position = {}, rotation = {}) {
  const rx = rotation.x ?? 0;
  const ry = rotation.y ?? 0;
  const rz = rotation.z ?? 0;

  if (rx || ry || rz) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    // R = Rz * Ry * Rx, matching three's default 'XYZ' euler order.
    const m = [
      cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
      cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
      -sy,     cy * sx,                cx * cy
    ];

    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      pos.setXYZ(i, m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      // Rotation is orthonormal, so the inverse-transpose is the matrix itself.
      nor.setXYZ(i, m[0] * nx + m[1] * ny + m[2] * nz, m[3] * nx + m[4] * ny + m[5] * nz, m[6] * nx + m[7] * ny + m[8] * nz);
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  const dx = position.x ?? 0;
  const dy = position.y ?? 0;
  const dz = position.z ?? 0;
  if (dx || dy || dz) {
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
    }
    pos.needsUpdate = true;
  }
  return geometry;
}

/**
 * Loft a solid through a stack of rectangular cross-sections.
 *
 * ## Why this exists
 *
 * A curved magazine built as three rotated boxes has two visible seams where
 * the boxes intersect, and daylight through the gaps between them. Worse, the
 * eye reads three objects rather than one part. A real magazine is a single
 * swept body, and lofting is what makes it one: the sections are joined by a
 * continuous skin, so there is no seam to see and nothing to leak light.
 *
 * The same primitive builds pistol grips (which taper and swell), stocks, and
 * handguards — anything whose cross-section changes along its length.
 *
 * Each section is `{ y, z, w, h, r }`: centre in the y/z plane, width in x,
 * height along the section's own vertical, and a corner radius. The section
 * is placed perpendicular to the path, so a curving stack sweeps a curve.
 *
 * @param {{y:number,z:number,w:number,h:number,r?:number}[]} sections
 * @param {number} cornerSteps  vertices per rounded corner
 */
export function loft(sections, cornerSteps = 3) {
  const positions = [];
  const normals = [];
  const edges = [];
  const indices = [];

  /** The rounded-rectangle outline of one section, in its own 2D frame. */
  const outline = (w, h, r) => {
    const hw = w / 2;
    const hh = h / 2;
    const rad = Math.min(r ?? 0, hw * 0.9, hh * 0.9);
    const pts = [];
    // Corners in order: +u+v, -u+v, -u-v, +u-v (u across, v along the section).
    const corners = [
      [hw - rad, hh - rad, 0],
      [-(hw - rad), hh - rad, Math.PI / 2],
      [-(hw - rad), -(hh - rad), Math.PI],
      [hw - rad, -(hh - rad), (Math.PI * 3) / 2]
    ];
    for (const [cu, cv, a0] of corners) {
      if (rad <= 1e-6) {
        pts.push([cu, cv, 1]);
        continue;
      }
      for (let s = 0; s <= cornerSteps; s++) {
        const a = a0 + (s / cornerSteps) * (Math.PI / 2);
        // ## The edge weight
        //
        // `aEdge` drives wear *and* the edge highlight, so it must mean "this
        // vertex is on an arris" and nothing else. Writing 1 for every vertex
        // of the outline — as this did — makes a lofted part 100% edge, and it
        // then renders as bare polished metal all over. That is why the
        // magazine came out pale grey instead of dark polymer.
        //
        // The apex of the corner arc is the true edge; the two ends of the arc
        // are where it meets the flat, so they taper to 0. A half-sine over the
        // sweep gives exactly that.
        const t = s / cornerSteps;
        pts.push([cu + Math.cos(a) * rad, cv + Math.sin(a) * rad, Math.sin(t * Math.PI)]);
      }
    }
    return pts;
  };

  const rings = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    // Tangent from neighbours, so the section stands square to the sweep.
    const prev = sections[Math.max(0, i - 1)];
    const next = sections[Math.min(sections.length - 1, i + 1)];
    let ty = next.y - prev.y;
    let tz = next.z - prev.z;
    const len = Math.hypot(ty, tz) || 1;
    ty /= len;
    tz /= len;
    // Section's vertical axis is perpendicular to the tangent in the y/z plane.
    const vy = tz;
    const vz = -ty;

    const pts = outline(s.w, s.h, s.r);
    const ring = [];
    for (const [u, v, e] of pts) {
      ring.push({
        x: u,
        y: s.y + vy * v,
        z: s.z + vz * v,
        e
      });
    }
    rings.push(ring);
  }

  const perRing = rings[0].length;

  // Skin.
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    for (let j = 0; j < perRing; j++) {
      const p = ring[j];
      // Outward normal: away from the section centre, in the section's plane.
      const s = sections[i];
      let nx = p.x;
      let ny = p.y - s.y;
      let nz = p.z - s.z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      positions.push(p.x, p.y, p.z);
      normals.push(nx / nl, ny / nl, nz / nl);
      // Corner columns carry the edge weight, so wear lands on the arris.
      edges.push(p.e);
    }
  }
  // Winding. The section frame (u, v, t) — u across, v along the section, t
  // along the sweep — is right-handed, so advancing j walks the outline
  // counterclockwise about t and the outward face is (a, b, c). Winding it the
  // other way builds the solid inside-out: with backface culling on, you then
  // see straight through the near wall to the inside of the far one, which is
  // exactly how the magazine and grip were rendering as translucent shells.
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < perRing; j++) {
      const a = i * perRing + j;
      const b = i * perRing + ((j + 1) % perRing);
      const c = a + perRing;
      const d = b + perRing;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Caps, as a fan about the section centre.
  const cap = (ringIndex, flip) => {
    const s = sections[ringIndex];
    const ring = rings[ringIndex];
    const base = positions.length / 3;
    const prev = sections[Math.max(0, ringIndex - 1)];
    const next = sections[Math.min(sections.length - 1, ringIndex + 1)];
    let ty = next.y - prev.y;
    let tz = next.z - prev.z;
    const len = Math.hypot(ty, tz) || 1;
    const ny = (ty / len) * (flip ? -1 : 1);
    const nz = (tz / len) * (flip ? -1 : 1);

    positions.push(0, s.y, s.z);
    normals.push(0, ny, nz);
    edges.push(0);
    for (const p of ring) {
      positions.push(p.x, p.y, p.z);
      normals.push(0, ny, nz);
      // The rim of a cap genuinely is an arris, but only weakly — carry the
      // outline's own taper rather than flooding the whole rim with 1.
      edges.push(p.e * 0.6);
    }
    // The outline runs counterclockwise about +t, so a fan wound (centre, a, b)
    // faces +t — that is the *end* cap. The start cap faces -t and so is wound
    // the other way.
    for (let j = 0; j < perRing; j++) {
      const a = base + 1 + j;
      const b = base + 1 + ((j + 1) % perRing);
      if (flip) indices.push(base, b, a);
      else indices.push(base, a, b);
    }
  };
  // `flip` = this cap faces backward along the sweep.
  cap(0, true);
  cap(rings.length - 1, false);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  return geometry;
}

/** Merge geometries that all carry position / normal / aEdge. */
export function mergeGeometries(list) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.getAttribute('position').count;
    indexCount += g.getIndex().count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const edges = new Float32Array(vertexCount);
  const occlusion = new Float32Array(vertexCount);
  // A whole weapon merged into one buffer runs past 65,535 vertices, and a
  // Uint16 index silently wraps to garbage triangles when it does.
  const indices =
    vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const e = g.getAttribute('aEdge');
    const o = g.getAttribute('aOcclusion');
    const idx = g.getIndex();

    positions.set(p.array, vertexOffset * 3);
    normals.set(n.array, vertexOffset * 3);
    edges.set(e.array, vertexOffset);
    // Unbaked parts are simply unoccluded, so a caller that skips the bake
    // still gets a correct (if flatter) weapon rather than a black one.
    if (o) occlusion.set(o.array, vertexOffset);
    else occlusion.fill(1, vertexOffset, vertexOffset + p.count);
    for (let i = 0; i < idx.count; i++) indices[indexOffset + i] = idx.array[i] + vertexOffset;

    vertexOffset += p.count;
    indexOffset += idx.count;
    g.dispose();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aEdge', new BufferAttribute(edges, 1));
  geometry.setAttribute('aOcclusion', new BufferAttribute(occlusion, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/**
 * Bake per-vertex ambient occlusion across a whole weapon.
 *
 * ## Why the gun needs this and the world does not
 *
 * The arena has screen-space occlusion; the viewmodel is drawn by a separate
 * camera in a separate pass and gets none. The result is that every junction on
 * the weapon — magazine into magwell, handguard against receiver, grip under
 * the trigger group — meets at full brightness, with no darkening in the crack.
 * Nothing looks *seated*. It is the single clearest reason a gun reads as a
 * stack of separate blocks rather than as an assembly.
 *
 * ## The approximation
 *
 * True AO would raycast the hemisphere at every vertex. That is far more than
 * this needs. What actually sells a junction is that a vertex with a lot of
 * *other geometry nearby, in front of its own normal* should be darker. So:
 * for each vertex, count neighbouring parts' occupancy within a small radius,
 * weighted by how much each sits in the vertex's forward hemisphere.
 *
 * Parts are reduced to their bounding boxes first, which makes this O(V · P)
 * with P the part count (about 60) rather than O(V · T). A whole weapon bakes
 * in a couple of milliseconds at load, and costs one float per vertex.
 *
 * @param {BufferGeometry[]} parts  every part of the weapon, any material
 * @param {number} radius  occlusion reach in metres
 */
export function bakeOcclusion(parts, radius = 0.032) {
  // Bounding box per part — the occluder set.
  const boxes = parts.map((g) => {
    const p = g.getAttribute('position');
    const b = { minX: 1e9, minY: 1e9, minZ: 1e9, maxX: -1e9, maxY: -1e9, maxZ: -1e9 };
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (z < b.minZ) b.minZ = z;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
      if (z > b.maxZ) b.maxZ = z;
    }
    return b;
  });

  for (let pi = 0; pi < parts.length; pi++) {
    const geometry = parts[pi];
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const ao = new Float32Array(position.count);

    for (let v = 0; v < position.count; v++) {
      const vx = position.getX(v), vy = position.getY(v), vz = position.getZ(v);
      const nx = normal.getX(v), ny = normal.getY(v), nz = normal.getZ(v);

      let occlusion = 0;
      for (let bi = 0; bi < boxes.length; bi++) {
        if (bi === pi) continue;
        const b = boxes[bi];

        // Closest point on the occluder's box to this vertex.
        const cx = Math.max(b.minX, Math.min(vx, b.maxX));
        const cy = Math.max(b.minY, Math.min(vy, b.maxY));
        const cz = Math.max(b.minZ, Math.min(vz, b.maxZ));

        let dx = cx - vx, dy = cy - vy, dz = cz - vz;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > radius) continue;

        // Only geometry in front of the surface can occlude it. A part behind
        // the vertex's own face is on the other side of the solid.
        if (distance > 1e-6) {
          dx /= distance; dy /= distance; dz /= distance;
        }
        const facing = dx * nx + dy * ny + dz * nz;
        if (facing <= 0) continue;

        // Falls off with distance; strongest when the occluder is dead ahead.
        const proximity = 1 - distance / radius;
        occlusion += proximity * proximity * facing;
      }

      // Saturate: several nearby parts should not drive this arbitrarily dark.
      ao[v] = 1 - Math.min(0.72, occlusion * 0.55);
    }

    geometry.setAttribute('aOcclusion', new BufferAttribute(ao, 1));
  }

  return parts;
}
