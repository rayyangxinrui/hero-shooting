import { BufferGeometry, BufferAttribute, Vector3, Matrix4 } from 'three';
import { settings } from '../config/settings.js';

/**
 * Procedural monster generation.
 *
 * A creature is *grown*, not modelled. The generator authors a bone rig first —
 * pelvis, spine, neck, skull, jaw, digitigrade legs, a pair (or two) of arms —
 * and then skins geometry onto it: lofted limbs with real muscle profiles,
 * a lofted ribcage, overlapping dorsal armour plates, a skull with a hinged jaw
 * and teeth, curved claws, and recessed glowing eyes.
 *
 * Everything comes back bound to that rig as a SkinnedMesh, because the single
 * biggest difference between a game creature and a prop is whether the limbs
 * plant and push. Static geometry sliding across the floor reads as a decal no
 * matter how good the shader is.
 *
 * ## Design rules the generator follows
 *
 * - **Silhouette first.** Each archetype has a *designed* outline, not a random
 *   one: the brute is all shoulders on stubby legs, the wraith is negative space
 *   between four enormous limbs, the skitter is a low armoured wedge on six
 *   splayed legs, the stalker is a coiled hunch with hands past its knees. The
 *   joint plans below are authored as explicit fractions of body height so the
 *   proportions survive the height variance.
 * - **Anatomy implies function.** Radius profiles bulge where a muscle would
 *   generate force (glute, calf, bicep, forearm) and pinch at every joint. The
 *   knee is forward and the hock is *back* — the reverse articulation is what
 *   stops a biped reading as a man in a suit.
 * - **Material is placed, not noised.** Every vertex carries `aSkin =
 *   (plate, class, ao)`. Armour goes where armour belongs — skull, spine,
 *   shoulders, forearms, thighs — and the shader only breaks up the boundary.
 *   Baked cavity darkening rides in the same attribute.
 *
 * ## Frame
 * `+Z` is forward (the way the creature charges), `+Y` up, `+X` its left.
 * Rest bone orientations are identity, so a bone's bind matrix is a pure
 * translation and its inverse is the negated translation — which keeps the
 * skinning maths trivial and the animator's job pure rotation.
 */

const TAU = Math.PI * 2;

/** Discrete surface classes, carried per-vertex in `aSkin.y`. */
export const MAT = { FLESH: 0, KERATIN: 1, EYE: 2, MAW: 3 };

const _WORLD_UP = new Vector3(0, 1, 0);
const _FWD = new Vector3(0, 0, 1);

/** Deterministic PRNG so a given seed always grows the identical creature. */
export function rng(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================================================================== */
/* Archetypes                                                           */
/* ==================================================================== */

/**
 * Joint plans are `[x, y, z]` in fractions of body height, in the creature's
 * rest frame. They are authored, not generated: the outline is the whole game,
 * and a random walk through joint space produces mush.
 *
 * Leg plan  : hip → knee → ankle(hock) → ball → toe-tip
 * Arm plan  : shoulder → elbow → wrist → knuckle
 */
const ARCHETYPES = {
  /** Coiled hunch, long reach, hands past the knees. Doom's Hell Knight. */
  stalker: {
    height: [2.05, 2.55],
    spine: { hipY: 0.505, hipZ: -0.075, chestY: 0.79, chestZ: 0.085, arch: 0.055 },
    torso: {
      // [t, value] control points along the spine, fractions of height.
      width: [0, 0.084, 0.22, 0.068, 0.46, 0.086, 0.72, 0.116, 1, 0.108],
      back: [0, 0.072, 0.25, 0.062, 0.55, 0.082, 0.8, 0.096, 1, 0.078],
      belly: [0, 0.086, 0.3, 0.078, 0.6, 0.09, 0.85, 0.086, 1, 0.062],
      ribs: 0.16,
      ribFrom: 0.45
    },
    neck: { len: 0.115, drop: 0.5, thick: 0.052, segments: 2 },
    head: { len: 0.215, width: 0.062, tall: 0.062, jaw: 0.9, teeth: 7, horns: 0.13, hornSweep: 0.75 },
    legPairs: 1,
    legPlan: [
      [0.086, 0.505, -0.02],
      [0.096, 0.298, 0.098],
      [0.084, 0.128, -0.062],
      [0.078, 0.021, 0.086],
      [0.074, 0.0, 0.192]
    ],
    legRadius: [0, 0.077, 0.14, 0.083, 0.36, 0.05, 0.47, 0.061, 0.66, 0.027, 0.8, 0.033, 0.93, 0.03, 1, 0.014],
    armPairs: 1,
    armPlan: [
      [0.104, 0.775, 0.028],
      [0.132, 0.55, -0.062],
      [0.118, 0.325, 0.062],
      [0.112, 0.253, 0.098]
    ],
    armRadius: [0, 0.062, 0.18, 0.069, 0.42, 0.043, 0.62, 0.056, 0.86, 0.028, 1, 0.03],
    fingers: 3,
    fingerLen: 0.088,
    clawLen: 0.105,
    footClaw: 0.062,
    pauldron: 0.9,
    dorsalPlates: 7,
    dorsalSpike: 0.055,
    tail: 0.0,
    eyes: 2,
    eyeSize: 0.017,
    plateBias: 0.0
  },

  /** All shoulders, stubby legs, arms that reach the floor. Berserker. */
  brute: {
    height: [2.5, 3.15],
    spine: { hipY: 0.42, hipZ: -0.095, chestY: 0.665, chestZ: 0.075, arch: 0.085 },
    torso: {
      width: [0, 0.108, 0.22, 0.098, 0.5, 0.132, 0.75, 0.184, 1, 0.168],
      back: [0, 0.095, 0.25, 0.09, 0.55, 0.122, 0.82, 0.15, 1, 0.115],
      belly: [0, 0.125, 0.3, 0.13, 0.62, 0.132, 0.86, 0.112, 1, 0.08],
      ribs: 0.1,
      ribFrom: 0.5
    },
    neck: { len: 0.052, drop: 0.72, thick: 0.078, segments: 1 },
    head: { len: 0.2, width: 0.078, tall: 0.07, jaw: 1.0, teeth: 8, horns: 0.155, hornSweep: 0.25 },
    legPairs: 1,
    legPlan: [
      [0.12, 0.42, -0.03],
      [0.135, 0.245, 0.088],
      [0.122, 0.108, -0.058],
      [0.115, 0.022, 0.078],
      [0.11, 0.0, 0.175]
    ],
    legRadius: [0, 0.11, 0.14, 0.118, 0.36, 0.072, 0.47, 0.086, 0.66, 0.042, 0.8, 0.05, 0.93, 0.046, 1, 0.02],
    armPairs: 2,
    armPlan: [
      [0.16, 0.635, 0.018],
      [0.215, 0.4, -0.075],
      [0.19, 0.155, 0.055],
      [0.18, 0.072, 0.095]
    ],
    armRadius: [0, 0.086, 0.18, 0.098, 0.42, 0.062, 0.62, 0.085, 0.86, 0.042, 1, 0.048],
    fingers: 3,
    fingerLen: 0.092,
    clawLen: 0.115,
    footClaw: 0.07,
    pauldron: 1.5,
    dorsalPlates: 9,
    dorsalSpike: 0.07,
    tail: 0.0,
    eyes: 4,
    eyeSize: 0.014,
    plateBias: 0.18
  },

  /** A low armoured wedge on six splayed legs. Reads instantly at any range. */
  skitter: {
    height: [1.35, 1.8],
    spine: { hipY: 0.485, hipZ: -0.3, chestY: 0.545, chestZ: 0.26, arch: 0.07 },
    torso: {
      width: [0, 0.09, 0.2, 0.15, 0.5, 0.185, 0.78, 0.15, 1, 0.095],
      back: [0, 0.075, 0.2, 0.13, 0.52, 0.155, 0.8, 0.12, 1, 0.07],
      belly: [0, 0.08, 0.25, 0.115, 0.55, 0.12, 0.82, 0.1, 1, 0.062],
      ribs: 0.06,
      ribFrom: 0.15
    },
    neck: { len: 0.13, drop: 0.92, thick: 0.06, segments: 2 },
    head: { len: 0.2, width: 0.075, tall: 0.056, jaw: 1.1, teeth: 9, horns: 0.13, hornSweep: 1.0 },
    legPairs: 3,
    legPlan: [
      [0.135, 0.47, -0.02],
      [0.315, 0.6, 0.06],
      [0.36, 0.2, -0.03],
      [0.35, 0.015, 0.09],
      [0.345, 0.0, 0.185]
    ],
    legRadius: [0, 0.06, 0.16, 0.052, 0.38, 0.03, 0.5, 0.038, 0.68, 0.018, 0.82, 0.024, 0.93, 0.022, 1, 0.009],
    armPairs: 1,
    armPlan: [
      [0.09, 0.53, 0.19],
      [0.145, 0.42, 0.3],
      [0.13, 0.3, 0.235],
      [0.125, 0.245, 0.27]
    ],
    armRadius: [0, 0.04, 0.2, 0.044, 0.45, 0.026, 0.65, 0.034, 0.86, 0.018, 1, 0.02],
    fingers: 2,
    fingerLen: 0.075,
    clawLen: 0.1,
    footClaw: 0.055,
    pauldron: 0.35,
    dorsalPlates: 8,
    dorsalSpike: 0.05,
    tail: 0.46,
    eyes: 6,
    eyeSize: 0.014,
    plateBias: 0.35
  },

  /** Negative space. Four enormous limbs, an exposed ribcage, a tiny skull. */
  wraith: {
    height: [2.9, 3.55],
    spine: { hipY: 0.5, hipZ: -0.055, chestY: 0.795, chestZ: 0.06, arch: 0.035 },
    torso: {
      width: [0, 0.058, 0.24, 0.043, 0.5, 0.06, 0.76, 0.084, 1, 0.076],
      back: [0, 0.05, 0.25, 0.04, 0.55, 0.062, 0.82, 0.072, 1, 0.055],
      belly: [0, 0.058, 0.32, 0.042, 0.62, 0.058, 0.86, 0.058, 1, 0.045],
      ribs: 0.3,
      ribFrom: 0.38
    },
    neck: { len: 0.185, drop: 0.36, thick: 0.032, segments: 3 },
    head: { len: 0.17, width: 0.04, tall: 0.043, jaw: 0.85, teeth: 8, horns: 0.165, hornSweep: 0.95 },
    legPairs: 1,
    legPlan: [
      [0.062, 0.5, -0.015],
      [0.072, 0.288, 0.105],
      [0.062, 0.115, -0.075],
      [0.058, 0.018, 0.08],
      [0.056, 0.0, 0.175]
    ],
    legRadius: [0, 0.05, 0.14, 0.054, 0.36, 0.031, 0.47, 0.04, 0.66, 0.016, 0.8, 0.021, 0.93, 0.019, 1, 0.008],
    armPairs: 1,
    armPlan: [
      [0.078, 0.79, 0.022],
      [0.115, 0.51, -0.09],
      [0.098, 0.215, 0.075],
      [0.092, 0.125, 0.115]
    ],
    armRadius: [0, 0.042, 0.18, 0.046, 0.42, 0.026, 0.62, 0.035, 0.86, 0.017, 1, 0.019],
    fingers: 3,
    fingerLen: 0.115,
    clawLen: 0.155,
    footClaw: 0.058,
    pauldron: 0.55,
    dorsalPlates: 6,
    dorsalSpike: 0.1,
    tail: 0.55,
    eyes: 2,
    eyeSize: 0.015,
    plateBias: -0.12
  }
};

/* ==================================================================== */
/* Small maths helpers                                                  */
/* ==================================================================== */

/** Smoothstep-interpolated piecewise curve over a flat `[t,v, t,v, …]` array. */
function profile(controls, t) {
  const n = controls.length >> 1;
  if (t <= controls[0]) return controls[1];
  for (let i = 1; i < n; i++) {
    const ta = controls[(i - 1) * 2];
    const va = controls[(i - 1) * 2 + 1];
    const tb = controls[i * 2];
    const vb = controls[i * 2 + 1];
    if (t <= tb) {
      const s = (t - ta) / Math.max(1e-6, tb - ta);
      return va + (vb - va) * s * s * (3 - 2 * s);
    }
  }
  return controls[controls.length - 1];
}

/**
 * An orthonormal frame around `dir`.
 *
 * `refUp` decides what "up" means for the cross-section: the torso uses the
 * world's forward so its `up` comes out dorsal, and limbs use the same so their
 * `up` comes out along the front of the shin — which is what lets a calf bulge
 * backward and a knee flatten forward.
 */
function makeFrame(dir, refUp, out) {
  out.dir.copy(dir).normalize();
  let r = out.right.crossVectors(refUp, out.dir);
  if (r.lengthSq() < 1e-6) {
    r = out.right.crossVectors(_WORLD_UP, out.dir);
    if (r.lengthSq() < 1e-6) out.right.set(1, 0, 0);
  }
  out.right.normalize();
  out.up.crossVectors(out.dir, out.right).normalize();
  return out;
}

function newFrame() {
  return { dir: new Vector3(), right: new Vector3(), up: new Vector3() };
}

/* ==================================================================== */
/* Rig                                                                  */
/* ==================================================================== */

/**
 * The bone list, authored in model space.
 *
 * Rest orientations stay identity on purpose: a bone's bind matrix is then a
 * pure translation, its inverse is the negation, and the animator only ever has
 * to write a quaternion. Every joint angle in the gait solver is therefore
 * expressed in the creature's own frame with no rest-pose bookkeeping.
 */
class Rig {
  constructor() {
    this.bones = [];
  }

  add(name, parent, x, y, z, meta) {
    const index = this.bones.length;
    this.bones.push({
      name,
      parent,
      rest: new Vector3(x, y, z),
      local: new Vector3(),
      ...meta
    });
    return index;
  }

  at(index) {
    return this.bones[index].rest;
  }

  finish() {
    for (const bone of this.bones) {
      bone.local.copy(bone.rest);
      if (bone.parent >= 0) bone.local.sub(this.bones[bone.parent].rest);
    }
    const inverses = this.bones.map((bone) =>
      new Matrix4().makeTranslation(-bone.rest.x, -bone.rest.y, -bone.rest.z)
    );
    return inverses;
  }
}

/* ==================================================================== */
/* Skinned mesh builder                                                 */
/* ==================================================================== */

const _e1 = new Vector3();
const _e2 = new Vector3();
const _fn = new Vector3();

/**
 * Accumulates skinned triangles.
 *
 * Non-indexed: the creature deliberately mixes smooth flesh with hard-edged
 * chitin, so most of the interesting vertices need split normals anyway and an
 * index buffer would only save on the lofts.
 *
 * Every vertex carries `aSkin = (plate, class, ao)` — a placed armour weight,
 * a discrete surface class, and baked cavity darkening. That is what lets the
 * shader treat a claw, an eye, a gum line and a shoulder plate as four
 * different materials in one draw call.
 */
class SkinBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.skin = [];
    this.bind = [0, 1, 0, 0];
    this.plate = 0;
    this.mat = MAT.FLESH;
    this.ao = 1;
  }

  /** One bone. */
  bind1(a) {
    this.bind[0] = a;
    this.bind[1] = 1;
    this.bind[2] = 0;
    this.bind[3] = 0;
    return this;
  }

  /** Two bones — `w` goes to `b`. */
  bind2(a, b, w) {
    this.bind[0] = a;
    this.bind[1] = 1 - w;
    this.bind[2] = b;
    this.bind[3] = w;
    return this;
  }

  surface(plate, mat, ao) {
    this.plate = plate;
    this.mat = mat;
    this.ao = ao;
    return this;
  }

  vertex(p, n, u, v, bind, plate, mat, ao) {
    const b = bind ?? this.bind;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.si.push(b[0], b[2], 0, 0);
    this.sw.push(b[1], b[3], 0, 0);
    this.skin.push(
      plate ?? this.plate,
      mat ?? this.mat,
      ao ?? this.ao
    );
  }

  /** A triangle with explicit per-vertex normals. */
  tri(a, b, c, na, nb, nc, ua, ub, uc, ba, bb, bc, sa, sb, sc) {
    this.vertex(a, na, ua[0], ua[1], ba, sa?.[0], sa?.[1], sa?.[2]);
    this.vertex(b, nb, ub[0], ub[1], bb, sb?.[0], sb?.[1], sb?.[2]);
    this.vertex(c, nc, uc[0], uc[1], bc, sc?.[0], sc?.[1], sc?.[2]);
  }

  /** A flat-shaded triangle — the face normal, computed here. */
  flatTri(a, b, c, binds, surfaces) {
    _e1.copy(b).sub(a);
    _e2.copy(c).sub(a);
    _fn.crossVectors(_e1, _e2);
    if (_fn.lengthSq() < 1e-12) return;
    _fn.normalize();
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const s = surfaces?.[i];
      this.vertex(pts[i], _fn, 0, 0, binds?.[i], s?.[0], s?.[1], s?.[2]);
    }
  }

  flatQuad(a, b, c, d, binds, surfaces) {
    this.flatTri(a, b, c, binds && [binds[0], binds[1], binds[2]], surfaces && [surfaces[0], surfaces[1], surfaces[2]]);
    this.flatTri(a, c, d, binds && [binds[0], binds[2], binds[3]], surfaces && [surfaces[0], surfaces[2], surfaces[3]]);
  }

  /**
   * Loft a swept surface through a list of sections.
   *
   * Each section is `{ c, right, up, rx, rBack, rBelly, exp, bind, plate, mat,
   * ao, profile }` — an elliptical (or superelliptical) cross-section with
   * independent dorsal and ventral radii, which is how a body gets a flat back
   * and a hanging belly out of one sweep.
   *
   * Normals come from neighbour differences rather than from an analytic
   * derivative: the profile callbacks make the surface arbitrary, and the
   * difference normal is exact enough at these tessellations while staying
   * correct for every shape the archetypes ask for.
   */
  loft(sections, radial, opts = {}) {
    const rings = [];
    for (const section of sections) {
      const ring = [];
      const exp = section.exp ?? 2;
      const power = 2 / exp;
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const shape = section.profile ? section.profile(a, section) : 1;
        const rx = section.rx * shape;
        const ry = (sa >= 0 ? section.rBack ?? section.ry : section.rBelly ?? section.ry) * shape;
        const x = Math.sign(ca) * Math.pow(Math.abs(ca), power) * rx;
        const y = Math.sign(sa) * Math.pow(Math.abs(sa), power) * ry;
        ring.push(
          new Vector3(
            section.c.x + section.right.x * x + section.up.x * y,
            section.c.y + section.right.y * x + section.up.y * y,
            section.c.z + section.right.z * x + section.up.z * y
          )
        );
      }
      rings.push(ring);
    }

    // Smooth normals from the local surface tangents.
    const normals = [];
    for (let i = 0; i < rings.length; i++) {
      const row = [];
      const prev = rings[Math.max(0, i - 1)];
      const next = rings[Math.min(rings.length - 1, i + 1)];
      for (let j = 0; j < radial; j++) {
        const jp = (j + radial - 1) % radial;
        const jn = (j + 1) % radial;
        const along = _e1.copy(next[j]).sub(prev[j]);
        const around = _e2.copy(rings[i][jn]).sub(rings[i][jp]);
        const n = new Vector3().crossVectors(around, along);
        if (n.lengthSq() < 1e-12) n.copy(rings[i][j]).sub(sections[i].c);
        n.normalize();
        // Point it outward — winding is not guaranteed for every frame.
        if (n.dot(_fn.copy(rings[i][j]).sub(sections[i].c)) < 0) n.negate();
        row.push(n);
      }
      normals.push(row);
    }

    const uvA = [0, 0];
    const uvB = [0, 0];
    const uvC = [0, 0];
    const uvD = [0, 0];
    for (let i = 0; i < rings.length - 1; i++) {
      const s0 = sections[i];
      const s1 = sections[i + 1];
      const v0 = i / (rings.length - 1);
      const v1 = (i + 1) / (rings.length - 1);
      const surf0 = [s0.plate ?? 0, s0.mat ?? MAT.FLESH, s0.ao ?? 1];
      const surf1 = [s1.plate ?? 0, s1.mat ?? MAT.FLESH, s1.ao ?? 1];
      for (let j = 0; j < radial; j++) {
        const k = (j + 1) % radial;
        const u0 = j / radial;
        const u1 = (j + 1) / radial;
        uvA[0] = u0; uvA[1] = v0;
        uvB[0] = u1; uvB[1] = v0;
        uvC[0] = u1; uvC[1] = v1;
        uvD[0] = u0; uvD[1] = v1;
        this.tri(
          rings[i][j], rings[i][k], rings[i + 1][k],
          normals[i][j], normals[i][k], normals[i + 1][k],
          uvA, uvB, uvC,
          s0.bind, s0.bind, s1.bind,
          surf0, surf0, surf1
        );
        this.tri(
          rings[i][j], rings[i + 1][k], rings[i + 1][j],
          normals[i][j], normals[i + 1][k], normals[i + 1][j],
          uvA, uvC, uvD,
          s0.bind, s1.bind, s1.bind,
          surf0, surf1, surf1
        );
      }
    }

    if (opts.capStart) this._cap(rings[0], sections[0], radial, true);
    if (opts.capEnd) this._cap(rings[rings.length - 1], sections[sections.length - 1], radial, false);
    return rings;
  }

  _cap(ring, section, radial, flip) {
    const centre = section.c;
    const n = new Vector3().copy(section.dir ?? _FWD);
    if (flip) n.negate();
    const surf = [section.plate ?? 0, section.mat ?? MAT.FLESH, (section.ao ?? 1) * 0.7];
    const uv = [0.5, 0.5];
    for (let j = 0; j < radial; j++) {
      const k = (j + 1) % radial;
      const a = flip ? ring[k] : ring[j];
      const b = flip ? ring[j] : ring[k];
      this.tri(centre, a, b, n, n, n, uv, uv, uv, section.bind, section.bind, section.bind, surf, surf, surf);
    }
  }

  /**
   * A curved, tapered spike — claw, horn, tooth, spine.
   *
   * Curvature is what separates a claw from a cone: a straight spike reads as a
   * traffic bollard, and a hooked one reads as something that has torn things.
   */
  spike(base, dir, bendDir, length, radius, opts = {}) {
    const radial = opts.radial ?? 6;
    const steps = opts.steps ?? 5;
    const bend = opts.bend ?? 0.0;
    const bind = opts.bind ?? this.bind.slice();
    const mat = opts.mat ?? MAT.KERATIN;
    const plate = opts.plate ?? 0;
    const frame = makeFrame(dir, bendDir ?? _FWD, newFrame());
    const path = [];
    const radii = [];
    const point = new Vector3().copy(base);
    const d = new Vector3().copy(dir).normalize();
    const bendAxis = new Vector3().crossVectors(d, frame.right).normalize();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      path.push(point.clone());
      radii.push(radius * Math.pow(1 - t, opts.taper ?? 0.85));
      // Ease the bend in so the base leaves the body straight.
      point.addScaledVector(d, length / steps);
      if (bend !== 0) {
        d.addScaledVector(bendAxis, (bend / steps) * (0.35 + t));
        d.normalize();
      }
    }

    const sections = [];
    for (let i = 0; i <= steps; i++) {
      const dirAt = new Vector3()
        .copy(path[Math.min(steps, i + 1)])
        .sub(path[Math.max(0, i - 1)]);
      if (dirAt.lengthSq() < 1e-10) dirAt.copy(d);
      const f = makeFrame(dirAt, bendDir ?? _FWD, newFrame());
      sections.push({
        c: path[i],
        right: f.right,
        up: f.up,
        dir: f.dir,
        rx: radii[i] * (opts.flat ?? 1),
        ry: radii[i],
        bind,
        plate,
        mat,
        // Keratin darkens into the socket and pales at the tip.
        ao: 0.42 + 0.58 * (i / steps)
      });
    }
    // Collapse the final ring so the tip is a point, not a facet.
    sections[steps].rx = radii[steps] * 0.02;
    sections[steps].ry = radii[steps] * 0.02;
    this.loft(sections, radial, { capStart: opts.capStart ?? false });
  }

  /** A squashed sphere — eyes, knuckles, muscle bellies. */
  blob(centre, rx, ry, rz, opts = {}) {
    const rings = opts.rings ?? 7;
    const radial = opts.radial ?? 10;
    const bind = opts.bind ?? this.bind.slice();
    const mat = opts.mat ?? MAT.FLESH;
    const plate = opts.plate ?? 0;
    const ao = opts.ao ?? 1;
    const sections = [];
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI;
      const s = Math.sin(phi);
      sections.push({
        c: new Vector3(centre.x, centre.y, centre.z - rz * Math.cos(phi) * -1),
        right: new Vector3(1, 0, 0),
        up: new Vector3(0, 1, 0),
        dir: new Vector3(0, 0, 1),
        rx: Math.max(1e-4, rx * s),
        ry: Math.max(1e-4, ry * s),
        bind,
        plate,
        mat,
        ao
      });
    }
    this.loft(sections, radial);
  }

  finish() {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(this.si), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(this.sw), 4));
    geometry.setAttribute('aSkin', new BufferAttribute(new Float32Array(this.skin), 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    // The bind pose under-covers an animated creature; inflate so a raised claw
    // never frustum-culls the whole body.
    if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.45;
    return geometry;
  }
}

/* ==================================================================== */
/* Limb construction                                                    */
/* ==================================================================== */

/**
 * Loft one continuous limb through its joint chain.
 *
 * A single sweep rather than one cylinder per bone: a chain of capsules always
 * shows its seams at the joints, and the seams are exactly where the eye looks
 * for articulation. Skin weights blend across each joint so the elbow creases
 * instead of scissoring.
 */
function buildLimb(builder, joints, bones, radiusControls, opts = {}) {
  const perSegment = opts.perSegment ?? 5;
  const radial = opts.radial ?? 10;
  const blend = opts.blend ?? 0.34;
  const frame = newFrame();
  const sections = [];

  // Arc-length parameterisation, so the radius profile does not stretch over
  // a long femur and bunch up over a short metatarsal.
  const lengths = [];
  let total = 0;
  for (let i = 0; i < joints.length - 1; i++) {
    const l = joints[i].distanceTo(joints[i + 1]);
    lengths.push(l);
    total += l;
  }

  let travelled = 0;
  for (let seg = 0; seg < joints.length - 1; seg++) {
    const a = joints[seg];
    const b = joints[seg + 1];
    const dir = new Vector3().copy(b).sub(a);
    const steps = seg === joints.length - 2 ? perSegment : perSegment;
    for (let i = 0; i <= steps; i++) {
      // Skip the duplicated joint ring except on the first segment.
      if (i === 0 && seg > 0) continue;
      const s = i / steps;
      const c = new Vector3().lerpVectors(a, b, s);
      const globalT = (travelled + lengths[seg] * s) / total;

      // Smooth the frame through the joint so the sweep does not kink.
      const dPrev = seg > 0 ? new Vector3().copy(joints[seg]).sub(joints[seg - 1]).normalize() : null;
      const dNext =
        seg < joints.length - 2
          ? new Vector3().copy(joints[seg + 2]).sub(joints[seg + 1]).normalize()
          : null;
      const d = new Vector3().copy(dir).normalize();
      if (dPrev && s < 0.3) d.lerp(dPrev, (0.3 - s) / 0.3 * 0.5).normalize();
      if (dNext && s > 0.7) d.lerp(dNext, (s - 0.7) / 0.3 * 0.5).normalize();
      makeFrame(d, opts.refUp ?? _FWD, frame);

      // Bone weights: this segment's bone, blended toward its neighbours at the
      // joints, which is what makes a knee crease instead of shearing.
      let bind;
      const here = bones[seg];
      if (s < blend && seg > 0) {
        bind = [bones[seg - 1], 0.5 * (1 - s / blend), here, 1 - 0.5 * (1 - s / blend)];
      } else if (s > 1 - blend && seg < bones.length - 1) {
        const w = 0.5 * ((s - (1 - blend)) / blend);
        bind = [here, 1 - w, bones[seg + 1], w];
      } else {
        bind = [here, 1, 0, 0];
      }

      const r = profile(radiusControls, globalT);
      const shapeRx = opts.aspect ? opts.aspect(globalT)[0] : 1;
      const shapeRy = opts.aspect ? opts.aspect(globalT)[1] : 1;
      sections.push({
        c,
        right: frame.right.clone(),
        up: frame.up.clone(),
        dir: frame.dir.clone(),
        rx: r * shapeRx,
        rBack: r * shapeRy * (opts.backMul ? opts.backMul(globalT) : 1),
        rBelly: r * shapeRy,
        exp: opts.exp ?? 2.4,
        bind,
        plate: opts.plateAt ? opts.plateAt(globalT) : 0,
        mat: MAT.FLESH,
        ao: opts.aoAt ? opts.aoAt(globalT) : 1
      });
    }
    travelled += lengths[seg];
  }

  builder.loft(sections, radial, { capStart: true, capEnd: false });
  return sections;
}

/* ==================================================================== */
/* Generation                                                           */
/* ==================================================================== */

/**
 * Grow one creature.
 * @param {number} seed
 * @param {string} [archetype]
 */
export function generateMonster(seed, archetype = null) {
  const random = rng(seed);
  const cfg = settings.monsters;

  const type =
    archetype ?? cfg.archetypes[Math.floor(random() * cfg.archetypes.length)] ?? 'stalker';
  const A = ARCHETYPES[type] ?? ARCHETYPES.stalker;

  const jitter = cfg.boneJitter;
  const h = A.height[0] + random() * (A.height[1] - A.height[0]);
  // Per-creature proportion drift, applied as whole-body multipliers so the
  // silhouette stays coherent while no two individuals match.
  const bulk = 1 + (random() - 0.5) * jitter * 0.9;
  const reach = 1 + (random() - 0.5) * jitter * 0.55;
  const stance = 1 + (random() - 0.5) * jitter * 0.35;

  const rig = new Rig();
  const builder = new SkinBuilder();

  /* ---- spine ------------------------------------------------------- */
  const S = A.spine;
  const hipY = h * S.hipY * stance;
  const chestY = h * S.chestY * stance;
  const hipZ = h * S.hipZ;
  const chestZ = h * S.chestZ;

  const spinePoints = [];
  const spineCount = 5;
  for (let i = 0; i < spineCount; i++) {
    const t = i / (spineCount - 1);
    const arch = Math.sin(t * Math.PI) * h * S.arch;
    spinePoints.push(
      new Vector3(
        0,
        hipY + (chestY - hipY) * t + arch,
        hipZ + (chestZ - hipZ) * t - arch * 0.25
      )
    );
  }

  const spineBones = [];
  let parent = -1;
  for (let i = 0; i < spineCount; i++) {
    const p = spinePoints[i];
    const index = rig.add(i === 0 ? 'pelvis' : `spine${i}`, parent, p.x, p.y, p.z, {
      role: i === 0 ? 'pelvis' : 'spine'
    });
    spineBones.push(index);
    parent = index;
  }
  const pelvisBone = spineBones[0];
  const chestBone = spineBones[spineCount - 1];

  /* ---- neck + skull ------------------------------------------------ */
  const N = A.neck;
  const neckLen = h * N.len * reach;
  const neckDir = new Vector3(0, 1 - N.drop, 0.35 + N.drop * 0.85).normalize();
  const neckBones = [];
  const neckBase = spinePoints[spineCount - 1];
  parent = chestBone;
  for (let i = 1; i <= N.segments; i++) {
    const t = i / N.segments;
    const p = new Vector3().copy(neckBase).addScaledVector(neckDir, neckLen * t);
    const index = rig.add(`neck${i}`, parent, p.x, p.y, p.z, { role: 'neck' });
    neckBones.push(index);
    parent = index;
  }

  const H = A.head;
  const headLen = h * H.len * (0.9 + random() * 0.2);
  const headOrigin = new Vector3()
    .copy(neckBase)
    .addScaledVector(neckDir, neckLen)
    .addScaledVector(_WORLD_UP, headLen * 0.06);
  const headBone = rig.add('head', parent, headOrigin.x, headOrigin.y, headOrigin.z, {
    role: 'head'
  });
  // The skull axis drops further than the neck does — a predator carries its
  // jaw below the line of its spine, which is most of why it reads as hunting.
  const headDir = new Vector3(0, -0.16 - N.drop * 0.5, 1).normalize();
  const headUp = new Vector3().crossVectors(new Vector3(1, 0, 0), headDir).normalize().negate();
  const headRight = new Vector3(1, 0, 0);

  const jawPivot = new Vector3()
    .copy(headOrigin)
    .addScaledVector(headDir, headLen * 0.1)
    .addScaledVector(headUp, -h * H.tall * 0.55);
  const jawBone = rig.add('jaw', headBone, jawPivot.x, jawPivot.y, jawPivot.z, { role: 'jaw' });

  /* ---- legs -------------------------------------------------------- */
  const legs = [];
  const legPairs = A.legPairs;
  for (let pair = 0; pair < legPairs; pair++) {
    // Spread multi-pair legs along the torso instead of stacking them at the hip.
    const along = legPairs === 1 ? 0 : pair / (legPairs - 1);
    const attachT = legPairs === 1 ? 0.06 : 0.04 + along * 0.62;
    const attach = spinePoints[0].clone().lerp(spinePoints[spineCount - 1], attachT);
    const attachBone = spineBones[Math.min(spineCount - 1, Math.round(attachT * (spineCount - 1)))];
    // Middle legs shorten slightly and rake outward — the classic insect stagger.
    const legScale = legPairs === 1 ? 1 : 0.86 + 0.22 * Math.abs(along - 0.5) * 2;
    const rake = legPairs === 1 ? 0 : (along - 0.5) * h * 0.1;

    for (const side of [1, -1]) {
      const joints = A.legPlan.map((jp, i) => {
        const p = new Vector3(
          side * jp[0] * h * (1 + (random() - 0.5) * jitter * 0.12),
          jp[1] * h * (i === 0 ? stance : stance * legScale),
          jp[2] * h * legScale + rake
        );
        if (i === 0) {
          p.y = attach.y;
          p.z += attach.z;
        } else {
          p.z += attach.z * (1 - i / (A.legPlan.length - 1)) * 0.7;
        }
        return p;
      });

      const names = ['hip', 'knee', 'ankle', 'ball', 'toe'];
      const bones = [];
      let boneParent = attachBone;
      for (let i = 0; i < joints.length; i++) {
        const index = rig.add(
          `${names[i]}_${pair}_${side > 0 ? 'L' : 'R'}`,
          boneParent,
          joints[i].x,
          joints[i].y,
          joints[i].z,
          { role: 'leg', side, pair, chainIndex: i }
        );
        bones.push(index);
        boneParent = index;
      }

      legs.push({
        bones,
        joints: joints.map((j) => j.clone()),
        side,
        pair,
        // Diagonal gait for bipeds; alternating tripod for hexapods.
        phase:
          legPairs === 1
            ? side > 0
              ? 0
              : Math.PI
            : ((pair + (side > 0 ? 0 : 1)) % 2) * Math.PI + pair * 0.22,
        restFoot: joints[3].clone(),
        toeTip: joints[4].clone(),
        upperLen: joints[0].distanceTo(joints[1]),
        lowerLen: joints[1].distanceTo(joints[2]),
        footLen: joints[2].distanceTo(joints[3])
      });
    }
  }

  /* ---- arms -------------------------------------------------------- */
  const arms = [];
  for (let pair = 0; pair < A.armPairs; pair++) {
    // A second pair hangs lower and smaller — extra limbs read as extra threat
    // only if they are clearly subordinate to the primary pair.
    const drop = pair * h * 0.13;
    const scale = pair === 0 ? 1 : 0.68;
    const attachBone = pair === 0 ? chestBone : spineBones[spineCount - 2];

    for (const side of [1, -1]) {
      const joints = A.armPlan.map((jp, i) =>
        new Vector3(
          side * jp[0] * h * scale * (1 + (random() - 0.5) * jitter * 0.1),
          jp[1] * h * stance - drop - (i > 0 ? drop * 0.4 : 0),
          jp[2] * h * reach
        )
      );
      // Long arms are the whole read on a stalker and a wraith; extend from
      // the shoulder rather than scaling the whole chain, so the shoulder stays
      // welded to the torso.
      for (let i = 1; i < joints.length; i++) {
        joints[i].sub(joints[0]).multiplyScalar(reach * scale).add(joints[0]);
      }

      const names = ['clavicle', 'upperarm', 'forearm', 'hand'];
      const bones = [];
      let boneParent = attachBone;
      for (let i = 0; i < joints.length; i++) {
        const index = rig.add(
          `${names[i]}_${pair}_${side > 0 ? 'L' : 'R'}`,
          boneParent,
          joints[i].x,
          joints[i].y,
          joints[i].z,
          { role: 'arm', side, pair, chainIndex: i }
        );
        bones.push(index);
        boneParent = index;
      }
      arms.push({ bones, joints: joints.map((j) => j.clone()), side, pair, scale });
    }
  }

  /* ---- tail -------------------------------------------------------- */
  const tail = [];
  const tailJoints = [];
  if (A.tail > 0.01) {
    const segments = 5;
    const tailLen = h * A.tail * reach;
    let boneParent = pelvisBone;
    const base = spinePoints[0].clone();
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const p = new Vector3(
        0,
        base.y + h * 0.06 * Math.sin(t * 2.1) - t * h * 0.05,
        base.z - tailLen * t
      );
      const index = rig.add(`tail${i}`, boneParent, p.x, p.y, p.z, { role: 'tail', chainIndex: i });
      tail.push(index);
      tailJoints.push(p);
      boneParent = index;
    }
  }

  const boneInverses = rig.finish();

  /* ================================================================== */
  /* Skin                                                               */
  /* ================================================================== */

  const T = A.torso;
  const torsoSections = [];
  const torsoSteps = 26;
  const frame = newFrame();
  const spineAt = (t) => {
    const x = t * (spineCount - 1);
    const i = Math.min(spineCount - 2, Math.floor(x));
    const s = x - i;
    // Catmull-ish smoothing across the authored spine points.
    const a = spinePoints[i];
    const b = spinePoints[i + 1];
    const sm = s * s * (3 - 2 * s);
    return new Vector3(0, a.y + (b.y - a.y) * sm, a.z + (b.z - a.z) * sm);
  };

  for (let i = 0; i <= torsoSteps; i++) {
    const t = i / torsoSteps;
    const c = spineAt(t);
    const next = spineAt(Math.min(1, t + 0.02));
    const prev = spineAt(Math.max(0, t - 0.02));
    makeFrame(new Vector3().copy(next).sub(prev), _FWD, frame);
    // `up` from this frame lands dorsal, so rBack shapes the spine ridge and
    // rBelly hangs the gut.
    const up = frame.up.clone();
    const right = new Vector3(1, 0, 0);

    // Ribs: a band of raised arcs over the chest only. The eye reads a ribcage
    // as "this thing has a skeleton" faster than any amount of surface noise.
    const ribPhase = Math.max(0, (t - T.ribFrom) / (1 - T.ribFrom));
    const ribMask = Math.sin(Math.min(1, ribPhase * 1.25) * Math.PI) ** 0.8;
    const rib = 1 + T.ribs * ribMask * Math.sin(t * 62) * 0.16;

    const width = h * profile(T.width, t) * bulk * rib;
    const back = h * profile(T.back, t) * bulk;
    const belly = h * profile(T.belly, t) * bulk * (1 + T.ribs * ribMask * 0.06);

    // Bind: spread across the two nearest spine bones.
    const x = t * (spineCount - 1);
    const bi = Math.min(spineCount - 2, Math.floor(x));
    const bs = x - bi;
    const bind = [spineBones[bi], 1 - bs, spineBones[bi + 1], bs];

    torsoSections.push({
      c,
      right,
      up,
      dir: frame.dir.clone(),
      rx: width,
      rBack: back,
      rBelly: belly,
      exp: 2.5,
      bind,
      // The back is armoured, the belly is not — read from the section's own
      // angle inside the profile callback below.
      plate: 0,
      mat: MAT.FLESH,
      ao: 1,
      // A dorsal keel plus a slight flattening of the flanks.
      profile: (a) => {
        const dorsal = Math.max(0, Math.sin(a));
        const keel = 1 + 0.1 * Math.pow(dorsal, 6);
        const flank = 1 - 0.06 * Math.pow(Math.abs(Math.cos(a)), 3);
        return keel * flank;
      }
    });
  }
  builder.surface(0, MAT.FLESH, 1);
  const torsoRings = builder.loft(torsoSections, 22, { capStart: true, capEnd: false });

  /**
   * Armour weight over the torso is written per-vertex after the loft, because
   * it depends on the *angle* around the section (back = plated, belly = not)
   * and the loft API is per-section. Rewriting the attribute in place is
   * cheaper than threading an angle-aware callback through the sweep.
   */
  {
    const start = 0;
    const stride = 3;
    const verts = builder.skin.length / stride;
    const pos = builder.pos;
    for (let v = start; v < verts; v++) {
      const y = pos[v * 3 + 1];
      const px = pos[v * 3];
      const pz = pos[v * 3 + 2];
      // Approximate "how dorsal is this point" from its offset above the spine.
      const t = Math.min(1, Math.max(0, (pz - hipZ) / Math.max(0.001, chestZ - hipZ + 0.4)));
      const spineY = hipY + (chestY - hipY) * t;
      const dorsal = Math.max(0, Math.min(1, (y - spineY) / (h * 0.09) + 0.25));
      const flank = 1 - Math.min(1, Math.abs(px) / (h * 0.14));
      builder.skin[v * stride] = Math.min(
        1,
        Math.max(0, dorsal * (0.55 + 0.45 * flank) + A.plateBias)
      );
      // Cavity: the underside of a body never sees the sky.
      builder.skin[v * stride + 2] = 0.5 + 0.5 * Math.min(1, dorsal * 1.4 + 0.25);
    }
  }

  /* ---- dorsal armour plates ---------------------------------------- */
  buildDorsalPlates(builder, torsoSections, A, h, random);

  /* ---- neck -------------------------------------------------------- */
  {
    const chain = [neckBase.clone()];
    for (const b of neckBones) chain.push(rig.at(b).clone());
    chain.push(headOrigin.clone());
    const bones = [chestBone, ...neckBones, headBone];
    const thick = h * N.thick * bulk;
    buildLimb(
      builder,
      chain,
      bones,
      [0, thick * 1.5, 0.35, thick * 1.1, 0.75, thick * 0.95, 1, thick * 1.0],
      {
        perSegment: 3,
        radial: 12,
        refUp: _FWD,
        exp: 2.3,
        plateAt: (t) => 0.25 + 0.5 * t,
        aoAt: (t) => 0.7 + 0.3 * t,
        blend: 0.42
      }
    );
  }

  /* ---- skull ------------------------------------------------------- */
  const headInfo = buildSkull(
    builder,
    { headOrigin, headDir, headUp, headRight, headLen, jawPivot },
    A,
    h,
    headBone,
    jawBone,
    random
  );

  /* ---- legs -------------------------------------------------------- */
  for (const leg of legs) {
    buildLimb(builder, leg.joints, leg.bones, A.legRadius.map((v, i) => (i % 2 ? v * h * bulk : v)), {
      perSegment: 4,
      radial: 10,
      refUp: _FWD,
      exp: 2.5,
      // Thigh and shin get bony plating down the front; the hock is bare.
      plateAt: (t) => Math.max(0, 0.75 * Math.exp(-((t - 0.12) ** 2) / 0.02) + 0.5 * Math.exp(-((t - 0.5) ** 2) / 0.01)),
      aoAt: (t) => 0.72 + 0.28 * Math.min(1, t * 3),
      // The calf sits behind the bone; the shin plate is flat in front.
      backMul: (t) => 1 + 0.35 * Math.exp(-((t - 0.46) ** 2) / 0.008),
      aspect: (t) => [1 + 0.35 * Math.exp(-((t - 0.88) ** 2) / 0.012), 1]
    });
    buildFoot(builder, leg, A, h, random);
  }

  /* ---- arms -------------------------------------------------------- */
  for (const arm of arms) {
    buildLimb(builder, arm.joints, arm.bones, A.armRadius.map((v, i) => (i % 2 ? v * h * bulk * arm.scale : v)), {
      perSegment: 4,
      radial: 10,
      refUp: _FWD,
      exp: 2.4,
      plateAt: (t) => Math.max(0, 0.85 * Math.exp(-((t - 0.62) ** 2) / 0.02) + 0.4 * Math.exp(-((t - 0.08) ** 2) / 0.01)),
      aoAt: (t) => 0.68 + 0.32 * Math.min(1, t * 2.5),
      backMul: (t) => 1 + 0.3 * Math.exp(-((t - 0.2) ** 2) / 0.01)
    });
    buildHand(builder, arm, A, h, bulk, random);
    if (arm.pair === 0) buildPauldron(builder, arm, chestBone, A, h, bulk, random);
  }

  /* ---- tail -------------------------------------------------------- */
  if (tail.length) {
    const chain = [spinePoints[0].clone(), ...tailJoints.map((p) => p.clone())];
    const bones = [pelvisBone, ...tail];
    const thick = h * 0.05 * bulk;
    buildLimb(builder, chain, bones, [0, thick * 1.4, 0.4, thick * 0.85, 0.75, thick * 0.5, 1, thick * 0.14], {
      perSegment: 3,
      radial: 8,
      refUp: _FWD,
      exp: 2.6,
      plateAt: (t) => 0.35 + 0.35 * Math.sin(t * 22),
      aoAt: () => 0.8
    });
    // A blade on the end. Tails without a payoff read as a leftover.
    const last = chain[chain.length - 1];
    const dir = new Vector3().copy(last).sub(chain[chain.length - 2]).normalize();
    builder.bind1(tail[tail.length - 1]);
    builder.spike(last, dir, _WORLD_UP, h * 0.13, h * 0.028, {
      bend: 0.55,
      radial: 6,
      steps: 5,
      flat: 0.42,
      mat: MAT.KERATIN
    });
  }

  const geometry = builder.finish();

  /* ---- hitboxes, bound to bones ------------------------------------ */
  const hb = (zone, bone, point, radius) => ({
    zone,
    bone,
    offset: new Vector3().copy(point).sub(rig.at(bone)),
    radius
  });

  const chestPoint = spineAt(0.78);
  const midPoint = spineAt(0.46);
  const hipPoint = spineAt(0.1);
  const headMid = new Vector3().copy(headOrigin).addScaledVector(headDir, headLen * 0.42);

  const hitboxes = [
    hb('head', headBone, headMid, Math.max(h * 0.06, h * H.width * 1.15)),
    hb('body', chestBone, chestPoint, h * profile(T.width, 0.78) * bulk * 1.18),
    hb('body', spineBones[2], midPoint, h * profile(T.width, 0.46) * bulk * 1.24),
    hb('body', pelvisBone, hipPoint, h * profile(T.width, 0.1) * bulk * 1.22)
  ];

  return {
    geometry,
    type,
    bones: rig.bones,
    boneInverses,
    rig: {
      pelvis: pelvisBone,
      spine: spineBones,
      chest: chestBone,
      neck: neckBones,
      head: headBone,
      jaw: jawBone,
      legs,
      arms,
      tail,
      headDir,
      headLen
    },
    hitboxes,
    stats: {
      height: h,
      hipHeight: hipY,
      radius: h * profile(T.width, 0.5) * bulk * 1.9,
      health: cfg.health * (h / 2.4) * (1 + (random() - 0.5) * 2 * cfg.healthVariance),
      speed: cfg.walkSpeed * (type === 'skitter' ? 1.35 : type === 'brute' ? 0.72 : 1) * (0.85 + random() * 0.35),
      strideScale: h / 2.4,
      seed,
      eyeCount: A.eyes,
      triangles: builder.pos.length / 9
    }
  };
}

/* ==================================================================== */
/* Parts                                                                */
/* ==================================================================== */

/**
 * Overlapping chitin plates down the spine.
 *
 * Each plate is a shell floating a little above the flesh, ramping from flush
 * at its leading edge to a proud lip at its trailing edge, so the next plate
 * slides underneath it. The visible step at every lip is the single detail that
 * makes a back read as armour rather than as painted skin — and because the lip
 * catches the key light, it survives all the way out to fighting range.
 */
function buildDorsalPlates(builder, sections, A, h, random) {
  const count = A.dorsalPlates;
  if (count <= 0) return;
  const first = 0.08;
  const last = 0.94;
  const span = (last - first) / count;
  const lift = h * 0.016;

  for (let p = 0; p < count; p++) {
    const t0 = first + p * span;
    const t1 = t0 + span * 1.18;
    // Plates shrink toward the hips and the neck.
    const mid = (t0 + t1) * 0.5;
    const size = 0.55 + 0.45 * Math.sin(Math.min(1, Math.max(0, (mid - 0.05) / 0.9)) * Math.PI);
    const halfArc = (0.36 + 0.26 * size) * Math.PI;
    const steps = 3;
    const arcSteps = 9;
    // A touch of asymmetry per plate: real armour is never mirrored.
    const skew = (random() - 0.5) * 0.16;

    const grid = [];
    const binds = [];
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const t = t0 + (t1 - t0) * s;
      const si = Math.min(sections.length - 1, Math.max(0, Math.round(t * (sections.length - 1))));
      const section = sections[si];
      const row = [];
      // Ramp: flush at the front, proud at the back.
      const out = lift * (0.15 + 1.0 * s) * size;
      for (let j = 0; j <= arcSteps; j++) {
        const u = j / arcSteps;
        const a = Math.PI * 0.5 + (u - 0.5) * 2 * halfArc + skew;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const rx = section.rx;
        const ry = sa >= 0 ? section.rBack : section.rBelly;
        // Fade the offset to zero at the plate's side edges so it melts into
        // the flesh rather than floating.
        const edge = Math.sin(u * Math.PI) ** 0.45;
        const scale = 1 + (out * edge) / Math.max(0.02, ry);
        const x = ca * rx * scale;
        const y = sa * ry * scale;
        row.push(
          new Vector3(
            section.c.x + section.right.x * x + section.up.x * y,
            section.c.y + section.right.y * x + section.up.y * y,
            section.c.z + section.right.z * x + section.up.z * y
          )
        );
      }
      grid.push(row);
      binds.push(section.bind);
    }

    const surf = [1, MAT.FLESH, 1];
    const surfLip = [1, MAT.FLESH, 0.5];
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < arcSteps; j++) {
        builder.flatQuad(
          grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j],
          [binds[i], binds[i], binds[i + 1], binds[i + 1]],
          [surf, surf, surf, surf]
        );
      }
    }

    // The lip: a short skirt hanging off the trailing edge, which is what
    // actually casts the shadow line between plates.
    const back = grid[steps];
    const bindBack = binds[steps];
    for (let j = 0; j < arcSteps; j++) {
      const si = Math.min(sections.length - 1, Math.round(t1 * (sections.length - 1)));
      const section = sections[si];
      const a0 = grid[steps][j];
      const a1 = grid[steps][j + 1];
      const d0 = new Vector3().copy(a0).sub(section.c).normalize().multiplyScalar(-lift * 0.75 * size);
      const d1 = new Vector3().copy(a1).sub(section.c).normalize().multiplyScalar(-lift * 0.75 * size);
      const b0 = new Vector3().copy(a0).add(d0).addScaledVector(section.dir, -h * 0.008);
      const b1 = new Vector3().copy(a1).add(d1).addScaledVector(section.dir, -h * 0.008);
      builder.flatQuad(
        a1, a0, b0, b1,
        [bindBack, bindBack, bindBack, bindBack],
        [surf, surf, surfLip, surfLip]
      );
    }

    // A spine spike on the centre of every other plate.
    if (p % 2 === 0 && A.dorsalSpike > 0.001) {
      const centre = grid[1][Math.floor(arcSteps / 2)];
      const si = Math.min(sections.length - 1, Math.round(mid * (sections.length - 1)));
      const section = sections[si];
      const dir = new Vector3().copy(centre).sub(section.c).normalize();
      dir.addScaledVector(section.dir, -0.5).normalize();
      builder.bind1(binds[1][0]);
      builder.spike(
        centre,
        dir,
        _FWD,
        h * A.dorsalSpike * (0.7 + size * 0.6) * (0.8 + random() * 0.5),
        h * 0.017 * (0.8 + size * 0.4),
        { bend: -0.3, radial: 6, steps: 4, flat: 0.7, mat: MAT.KERATIN, capStart: true }
      );
    }
  }
}

/**
 * The skull.
 *
 * Built along its own axis so every feature can be placed in snout-space: a
 * cranium that flares at the cheek and tapers to the muzzle, a heavy brow that
 * overhangs the eyes, a hinged lower jaw, two rows of teeth, swept horns, and
 * eyes sunk in dark sockets.
 *
 * The recessed socket matters more than the eye does. A glowing sphere sitting
 * on the surface reads as a bead; the same sphere at the bottom of a dark well
 * reads as a look.
 */
function buildSkull(builder, geo, A, h, headBone, jawBone, random) {
  const { headOrigin, headDir, headUp, headRight, headLen, jawPivot } = geo;
  const H = A.head;
  const W = h * H.width;
  const V = h * H.tall;

  const hp = (f, u, r) =>
    new Vector3()
      .copy(headOrigin)
      .addScaledVector(headDir, f * headLen)
      .addScaledVector(headUp, u)
      .addScaledVector(headRight, r);

  // Skull profile along the snout, in snout-space.
  const widthC = [0, 0.55, 0.16, 1.0, 0.34, 0.86, 0.58, 0.6, 0.8, 0.4, 1, 0.1];
  const upC = [0, 0.6, 0.14, 1.0, 0.3, 0.72, 0.55, 0.5, 0.82, 0.36, 1, 0.08];
  const downC = [0, 0.7, 0.18, 0.92, 0.42, 0.68, 0.7, 0.5, 1, 0.12];

  const steps = 13;
  const sections = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = hp(t * 0.98 - 0.12, 0, 0);
    // The brow: a hard ledge over the eye line at t≈0.3.
    const brow = 1 + 0.3 * Math.exp(-((t - 0.28) ** 2) / 0.006);
    sections.push({
      c,
      right: headRight.clone(),
      up: headUp.clone(),
      dir: headDir.clone(),
      rx: W * profile(widthC, t),
      rBack: V * profile(upC, t) * brow,
      rBelly: V * profile(downC, t),
      exp: 2.9,
      bind: [headBone, 1, 0, 0],
      plate: 0.85,
      mat: MAT.FLESH,
      ao: 0.8 + 0.2 * t,
      profile: (a) => 1 - 0.1 * Math.pow(Math.abs(Math.cos(a)), 4)
    });
  }
  builder.loft(sections, 14, { capStart: true, capEnd: true });

  /* ---- lower jaw ---------------------------------------------------- */
  const jawLen = headLen * H.jaw;
  const jawSections = [];
  const jawSteps = 9;
  const jawWidthC = [0, 0.5, 0.2, 0.88, 0.6, 0.66, 1, 0.14];
  const jawTallC = [0, 0.55, 0.25, 0.62, 0.65, 0.42, 1, 0.1];
  for (let i = 0; i <= jawSteps; i++) {
    const t = i / jawSteps;
    const c = new Vector3()
      .copy(jawPivot)
      .addScaledVector(headDir, t * jawLen * 0.95)
      .addScaledVector(headUp, -V * 0.12 * Math.sin(t * Math.PI));
    jawSections.push({
      c,
      right: headRight.clone(),
      up: headUp.clone(),
      dir: headDir.clone(),
      rx: W * profile(jawWidthC, t) * 0.9,
      rBack: V * profile(jawTallC, t) * 0.42,
      rBelly: V * profile(jawTallC, t) * 0.75,
      exp: 2.8,
      bind: [jawBone, 1, 0, 0],
      plate: 0.8,
      mat: MAT.FLESH,
      ao: 0.62 + 0.3 * t
    });
  }
  builder.loft(jawSections, 12, { capStart: true, capEnd: true });

  /* ---- maw: the dark wet interior ----------------------------------- */
  {
    const surf = [0, MAT.MAW, 0.22];
    const upperBind = [headBone, 1, 0, 0];
    const lowerBind = [jawBone, 1, 0, 0];
    for (let i = 0; i < jawSteps; i++) {
      const t0 = i / jawSteps;
      const t1 = (i + 1) / jawSteps;
      const w0 = W * profile(jawWidthC, t0) * 0.8;
      const w1 = W * profile(jawWidthC, t1) * 0.8;
      const uy = -V * 0.28;
      const a0 = hp(t0 * 0.85 + 0.02, uy, -w0);
      const a1 = hp(t1 * 0.85 + 0.02, uy, -w1);
      const b0 = hp(t1 * 0.85 + 0.02, uy, w1);
      const b1 = hp(t0 * 0.85 + 0.02, uy, w0);
      builder.flatQuad(a0, a1, b0, b1, [upperBind, upperBind, upperBind, upperBind], [surf, surf, surf, surf]);

      // Tongue floor, on the jaw bone so it opens with the mouth.
      const c0 = new Vector3().copy(jawSections[i].c).addScaledVector(headUp, V * 0.14);
      const c1 = new Vector3().copy(jawSections[i + 1].c).addScaledVector(headUp, V * 0.14);
      const l0 = new Vector3().copy(c0).addScaledVector(headRight, -w0);
      const l1 = new Vector3().copy(c1).addScaledVector(headRight, -w1);
      const r1 = new Vector3().copy(c1).addScaledVector(headRight, w1);
      const r0 = new Vector3().copy(c0).addScaledVector(headRight, w0);
      builder.flatQuad(r0, r1, l1, l0, [lowerBind, lowerBind, lowerBind, lowerBind], [surf, surf, surf, surf]);
    }
  }

  /* ---- teeth -------------------------------------------------------- */
  const teeth = H.teeth;
  for (let i = 0; i < teeth; i++) {
    const t = 0.16 + (i / Math.max(1, teeth - 1)) * 0.76;
    // Canines: a couple of oversized fangs near the front break the comb look.
    const fang = i === 1 || i === 2 ? 2.1 : i === 0 ? 1.45 : 1;
    const size = h * 0.013 * fang * (0.75 + random() * 0.5);
    const len = h * 0.036 * fang * (0.7 + random() * 0.6);
    for (const side of [1, -1]) {
      const wU = W * profile(widthC, t) * 0.82;
      const upperBase = hp(t * 0.94 - 0.06, -V * profile(downC, t) * 0.78, side * wU);
      builder.bind1(headBone);
      builder.spike(
        upperBase,
        new Vector3().copy(headUp).multiplyScalar(-1).addScaledVector(headDir, 0.12).normalize(),
        headRight,
        len,
        size,
        { bend: -0.32, radial: 5, steps: 4, mat: MAT.KERATIN, taper: 0.7 }
      );

      const jt = Math.min(0.96, t * 1.02);
      const wL = W * profile(jawWidthC, jt) * 0.72;
      const lowerBase = new Vector3()
        .copy(jawPivot)
        .addScaledVector(headDir, jt * jawLen * 0.92)
        .addScaledVector(headUp, V * profile(jawTallC, jt) * 0.3)
        .addScaledVector(headRight, side * wL);
      builder.bind1(jawBone);
      builder.spike(
        lowerBase,
        new Vector3().copy(headUp).addScaledVector(headDir, 0.1).normalize(),
        headRight,
        len * 0.85,
        size * 0.9,
        { bend: 0.3, radial: 5, steps: 4, mat: MAT.KERATIN, taper: 0.7 }
      );
    }
  }

  /* ---- horns -------------------------------------------------------- */
  if (H.horns > 0.001) {
    for (const side of [1, -1]) {
      // Asymmetric: one horn longer, and sometimes one broken. A perfectly
      // matched pair reads as a logo; a mismatched pair reads as an animal.
      const grow = side > 0 ? 1 : 0.78 + random() * 0.34;
      const base = hp(0.1, V * 0.72, side * W * 0.62);
      const dir = new Vector3()
        .copy(headUp)
        .multiplyScalar(0.85)
        .addScaledVector(headRight, side * 0.45)
        .addScaledVector(headDir, -0.35 - H.hornSweep * 0.5)
        .normalize();
      builder.bind1(headBone);
      builder.spike(base, dir, headRight, h * H.horns * grow, h * 0.026, {
        bend: 0.5 + H.hornSweep * 0.5,
        radial: 7,
        steps: 6,
        mat: MAT.KERATIN,
        taper: 0.75,
        capStart: true
      });
      // A secondary cheek spike, angled back.
      const cheek = hp(0.34, -V * 0.05, side * W * 0.8);
      builder.spike(
        cheek,
        new Vector3().copy(headRight).multiplyScalar(side).addScaledVector(headDir, -0.55).normalize(),
        headUp,
        h * H.horns * 0.42 * grow,
        h * 0.014,
        { bend: 0.35, radial: 5, steps: 4, mat: MAT.KERATIN, capStart: true }
      );
    }
  }

  /* ---- eyes --------------------------------------------------------- */
  const eyeRows = Math.max(1, Math.round(A.eyes / 2));
  const eyes = [];
  for (const side of [1, -1]) {
    for (let row = 0; row < eyeRows; row++) {
      const t = 0.3 + row * 0.11;
      const scale = row === 0 ? 1 : 0.6;
      const size = h * A.eyeSize * scale;
      const w = W * profile(widthC, t) * 0.78;
      const up = V * profile(upC, t) * (0.16 - row * 0.22);
      const socket = hp(t, up, side * w);
      const outward = new Vector3()
        .copy(headRight)
        .multiplyScalar(side * 0.78)
        .addScaledVector(headDir, 0.5)
        .addScaledVector(headUp, 0.18)
        .normalize();

      // The socket: a short dark funnel pushed into the skull.
      const rimSteps = 8;
      const inner = new Vector3().copy(socket).addScaledVector(outward, -size * 1.5);
      const frame = makeFrame(outward, headUp, newFrame());
      const surfDark = [0.4, MAT.MAW, 0.12];
      const bind = [headBone, 1, 0, 0];
      for (let j = 0; j < rimSteps; j++) {
        const a0 = (j / rimSteps) * TAU;
        const a1 = ((j + 1) / rimSteps) * TAU;
        const p = (a, r, base) =>
          new Vector3()
            .copy(base)
            .addScaledVector(frame.right, Math.cos(a) * r)
            .addScaledVector(frame.up, Math.sin(a) * r);
        builder.flatQuad(
          p(a0, size * 2.05, socket),
          p(a1, size * 2.05, socket),
          p(a1, size * 1.02, inner),
          p(a0, size * 1.02, inner),
          [bind, bind, bind, bind],
          [surfDark, surfDark, surfDark, surfDark]
        );
      }

      // The eye itself, sunk just below the rim.
      const centre = new Vector3().copy(socket).addScaledVector(outward, -size * 0.5);
      builder.bind1(headBone);
      builder.blob(centre, size, size, size, {
        rings: 6,
        radial: 9,
        mat: MAT.EYE,
        plate: 0,
        ao: 1,
        bind
      });
      eyes.push(centre);
    }
  }

  return { eyes };
}

/** Three toes and a dew claw — the part of the leg the player sees planted. */
function buildFoot(builder, leg, A, h, random) {
  const ball = leg.joints[3];
  const tip = leg.joints[4];
  const bone = leg.bones[3];
  const toeBone = leg.bones[4];
  const forward = new Vector3().copy(tip).sub(ball).normalize();
  const side = new Vector3().crossVectors(_WORLD_UP, forward).normalize();

  const toes = 3;
  for (let i = 0; i < toes; i++) {
    const spread = (i / (toes - 1) - 0.5) * 2;
    const dir = new Vector3()
      .copy(forward)
      .addScaledVector(side, spread * 0.55)
      .addScaledVector(_WORLD_UP, -0.06)
      .normalize();
    const base = new Vector3().copy(ball).addScaledVector(side, spread * h * 0.022);
    const len = h * A.footClaw * (i === 1 ? 1.15 : 0.9) * (0.85 + random() * 0.3);
    builder.bind2(bone, toeBone, 0.65);
    builder.spike(base, dir, _WORLD_UP, len, h * 0.021, {
      bend: 0.42,
      radial: 6,
      steps: 5,
      mat: MAT.KERATIN,
      taper: 0.6,
      capStart: true
    });
  }

  // The dew claw, back and up — it is what makes the ankle read as an ankle.
  const heel = new Vector3().copy(leg.joints[2]);
  builder.bind1(leg.bones[2]);
  builder.spike(
    heel,
    new Vector3().copy(forward).multiplyScalar(-0.8).addScaledVector(_WORLD_UP, -0.5).normalize(),
    side,
    h * A.footClaw * 0.7,
    h * 0.016,
    { bend: 0.3, radial: 5, steps: 4, mat: MAT.KERATIN, capStart: true }
  );
}

/** A palm and clawed fingers. The hands are the weapon; they get the detail. */
function buildHand(builder, arm, A, h, bulk, random) {
  const wrist = arm.joints[2];
  const knuckle = arm.joints[3];
  const bone = arm.bones[3];
  const forward = new Vector3().copy(knuckle).sub(wrist).normalize();
  const side = new Vector3().crossVectors(_WORLD_UP, forward).normalize();
  if (side.lengthSq() < 0.5) side.set(1, 0, 0);
  const palmUp = new Vector3().crossVectors(forward, side).normalize();
  const scale = arm.scale * bulk;

  // Palm: a flattened block so the hand has a back and a grip side.
  const palmR = h * 0.042 * scale;
  const sections = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    sections.push({
      c: new Vector3().lerpVectors(wrist, knuckle, t),
      right: side.clone(),
      up: palmUp.clone(),
      dir: forward.clone(),
      rx: palmR * (0.72 + 0.5 * Math.sin(t * Math.PI * 0.9)),
      ry: palmR * 0.52,
      exp: 3.0,
      bind: [arm.bones[2], Math.max(0, 0.5 - t), bone, Math.min(1, 0.5 + t)],
      plate: 0.7,
      mat: MAT.FLESH,
      ao: 0.6 + 0.3 * t
    });
  }
  builder.loft(sections, 9, { capStart: true, capEnd: true });

  const fingers = A.fingers;
  for (let i = 0; i < fingers; i++) {
    const spread = fingers === 1 ? 0 : (i / (fingers - 1) - 0.5) * 2;
    const base = new Vector3()
      .copy(knuckle)
      .addScaledVector(side, spread * palmR * 0.85)
      .addScaledVector(forward, -palmR * 0.1 * Math.abs(spread));
    const dir = new Vector3()
      .copy(forward)
      .addScaledVector(side, spread * 0.42)
      .addScaledVector(palmUp, -0.22)
      .normalize();
    const len = h * A.fingerLen * scale * (i === Math.floor(fingers / 2) ? 1.12 : 0.92);
    builder.bind1(bone);
    // Two phalanges then a claw, each hooking further — a straight finger
    // reads as a stick, a hooked one reads as a grab.
    builder.spike(base, dir, palmUp, len * 0.55, h * 0.02 * scale, {
      bend: 0.3,
      radial: 6,
      steps: 3,
      mat: MAT.FLESH,
      taper: 0.35,
      plate: 0.6,
      capStart: true
    });
    const mid = new Vector3().copy(base).addScaledVector(dir, len * 0.52);
    const dir2 = new Vector3().copy(dir).addScaledVector(palmUp, -0.3).normalize();
    builder.spike(mid, dir2, palmUp, len * 0.5, h * 0.016 * scale, {
      bend: 0.35,
      radial: 6,
      steps: 3,
      mat: MAT.FLESH,
      taper: 0.4,
      plate: 0.65
    });
    const clawBase = new Vector3().copy(mid).addScaledVector(dir2, len * 0.46);
    const dir3 = new Vector3().copy(dir2).addScaledVector(palmUp, -0.45).normalize();
    builder.spike(
      clawBase,
      dir3,
      palmUp,
      h * A.clawLen * scale * (0.8 + random() * 0.4),
      h * 0.015 * scale,
      { bend: 0.75, radial: 6, steps: 6, mat: MAT.KERATIN, taper: 0.72, flat: 0.72 }
    );
  }
}

/**
 * The shoulder plate.
 *
 * Pure silhouette work. Nothing else the generator builds changes the outline
 * as much per triangle spent: a shell over the shoulder joint widens the top of
 * the creature, which is what sells "this is heavier than you".
 */
function buildPauldron(builder, arm, chestBone, A, h, bulk, random) {
  const size = A.pauldron;
  if (size < 0.01) return;
  const shoulder = arm.joints[0];
  const side = arm.side;
  const bone = arm.bones[0];

  const rx = h * 0.075 * size * bulk;
  const ry = h * 0.085 * size * bulk;
  const rz = h * 0.09 * size * bulk;
  // Domed outward and up, with the lower half cut away so the arm clears it.
  const rings = 5;
  const radial = 10;
  const centre = new Vector3()
    .copy(shoulder)
    .addScaledVector(_WORLD_UP, ry * 0.28)
    .add(new Vector3(side * rx * 0.18, 0, 0));

  const axis = new Vector3(side * 0.72, 0.66, -0.1).normalize();
  const frame = makeFrame(axis, _FWD, newFrame());
  const sections = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI * 0.62;
    const s = Math.sin(phi);
    const cph = Math.cos(phi);
    sections.push({
      c: new Vector3().copy(centre).addScaledVector(axis, rz * (1 - cph) * 0.85 - rz * 0.2),
      right: frame.right.clone(),
      up: frame.up.clone(),
      dir: axis.clone(),
      rx: Math.max(1e-4, rx * (0.35 + s * 1.05)),
      ry: Math.max(1e-4, ry * (0.35 + s * 1.05)),
      exp: 2.6,
      bind: [chestBone, 0.55, bone, 0.45],
      plate: 1,
      mat: MAT.FLESH,
      ao: 0.55 + 0.45 * (i / rings)
    });
  }
  builder.loft(sections, radial, { capStart: true });

  // Two or three spikes raking backward off the crown of the plate.
  const spikes = size > 1.0 ? 3 : 2;
  for (let i = 0; i < spikes; i++) {
    const a = (i / Math.max(1, spikes - 1) - 0.5) * 1.5;
    const base = new Vector3()
      .copy(centre)
      .addScaledVector(axis, rz * 0.62)
      .addScaledVector(frame.right, Math.sin(a) * rx * 0.8)
      .addScaledVector(frame.up, Math.cos(a) * ry * 0.5);
    const dir = new Vector3()
      .copy(axis)
      .multiplyScalar(0.65)
      .addScaledVector(_WORLD_UP, 0.35)
      .addScaledVector(_FWD, -0.55)
      .normalize();
    builder.bind2(chestBone, bone, 0.45);
    builder.spike(base, dir, _WORLD_UP, h * 0.075 * size * (0.7 + random() * 0.6), h * 0.019 * size, {
      bend: 0.4,
      radial: 6,
      steps: 5,
      mat: MAT.KERATIN,
      taper: 0.75,
      capStart: true
    });
  }
}
