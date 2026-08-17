import {
  Group,
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  PlaneGeometry,
  Matrix4,
  Euler,
  Quaternion,
  Box3,
  Vector3,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  SRGBColorSpace,
  Float32BufferAttribute
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import {
  SURFACE_KIND,
  createSurfaceMaterial,
  createGroundMaterial,
  syncSurfaceUniforms,
  bakeContactMap
} from './SurfaceMaterial.js';

/**
 * Deterministic PRNG — mulberry32.
 * The arena has to be identical between the builder's run and the critic's
 * screenshot, or every comparison is against a different level.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _matrix = new Matrix4();
const _euler = new Euler();
const _quaternion = new Quaternion();
const _scale = new Vector3();
const _position = new Vector3();

/**
 * The play space: a sandstone courtyard.
 *
 * ## What changed and why
 *
 * This used to be a flat plane, four flat walls and twenty-six randomly
 * scattered boxes, all in three flat colours. It read as a greybox test level,
 * which is what it was, and because it is the backdrop of literally every frame
 * in the project it dragged everything photographed against it down with it.
 *
 * Three things were wrong, in order of how much they cost:
 *
 *  1. **The surfaces were constants.** Fixed by `SurfaceMaterial.js`: plaster
 *     over blockwork, grime running from every ledge, chipped arrises, and
 *     per-object colour drift so no two pieces of cover are the same value.
 *  2. **Nothing was occluded.** A box on a floor with no darkening where the
 *     two meet reads as a decal, not an object. The ground now samples a
 *     contact map baked from the real footprints, and every vertical face
 *     darkens toward its own base.
 *  3. **There was no depth.** A single flat plane with scattered cover gives
 *     the eye nothing to measure distance against. Dust II reads deep because
 *     it is built in *layers*: something close framing the shot, cover in the
 *     middle, and a skyline of buildings you can never reach behind it. So this
 *     arena now has a perimeter with plinths, buttresses, a coping and a
 *     doorway punched through it, arches and a raised platform in the middle
 *     ground, ruins and rubble scattered against the walls, and a ring of
 *     background architecture outside the play space purely to break the
 *     skyline.
 *
 * ## Draw calls
 *
 * Every part is a description first and geometry second: `_box`/`_cyl` push a
 * record, and `_flush` bakes all records sharing a material into one merged
 * mesh. That is what makes 300 pieces of architecture cost seven draw calls
 * instead of three hundred — and it is also what lets each vertex carry its
 * *own object's* centre, half-extent and yaw, which is the data the surface
 * shader needs to know where an object's edges and base actually are.
 */
export class Arena {
  constructor(collider) {
    this.collider = collider;
    this.group = new Group();
    this.group.name = 'Arena';
    this.materials = {};
    this._parts = [];
    this._footprints = [];
    this._boxGeo = new BoxGeometry(1, 1, 1);
    this._cylGeo = new CylinderGeometry(0.5, 0.5, 1, 12, 1);
    this._meshes = [];
    this._materialList = [];
  }

  async load(assets) {
    const size = settings.arena.size;
    const half = size / 2;

    /* ---- the floor keeps its photographed rock; see createGroundMaterial --- */
    const [color, normal] = await Promise.all([
      assets.loadTexture('./textures/cathedral/color.jpg'),
      assets.loadTexture('./textures/cathedral/normal.jpg')
    ]);
    for (const map of [color, normal]) {
      map.wrapS = RepeatWrapping;
      map.wrapT = RepeatWrapping;
      map.anisotropy = 16;
    }
    color.colorSpace = SRGBColorSpace;
    this._groundMaps = { color, normal };

    /* ---- build the level as records ---- */
    this._parts.length = 0;
    this._footprints.length = 0;

    this._makeMaterials();
    this._buildPerimeter(size);
    this._buildBackdrop(size);
    this._buildArchitecture(size);
    this._buildCover(size);

    /* ---- occlusion is baked from the footprints the level just produced ---- */
    this._contactExtent = size * 0.82;
    const contactData = bakeContactMap(this._footprints, this._contactExtent, 1024);
    this._contactMap = new DataTexture(
      contactData,
      1024,
      1024,
      RGBAFormat,
      UnsignedByteType
    );
    this._contactMap.minFilter = LinearFilter;
    this._contactMap.magFilter = LinearFilter;
    this._contactMap.wrapS = ClampToEdgeWrapping;
    this._contactMap.wrapT = ClampToEdgeWrapping;
    this._contactMap.generateMipmaps = false;
    this._contactMap.needsUpdate = true;

    this._buildGround(size);
    this._flush();

    this.group.traverse((node) => {
      node.layers.set(LAYER.WORLD);
    });
    void half;

    return this;
  }

  /* ================================================================== */
  /* Materials                                                           */
  /* ================================================================== */

  /**
   * Six surfaces. All six share one compiled shader program — the explicit
   * cache key in `createSurfaceMaterial` is what makes that safe now that
   * `patchOnBeforeCompile` no longer collapses unrelated patches together.
   */
  _makeMaterials() {
    const a = settings.arena;

    // The main wall face: lime plaster still mostly intact over cut block.
    this.materials.plaster = createSurfaceMaterial({
      kind: SURFACE_KIND.STONE,
      plaster: 0.86,
      course: 0.26,
      roughness: 0.88,
      seed: 3.17
    });

    // Plinths, copings, kerbs, ruins: the plaster is long gone here, because
    // these are the parts that get rained on and kicked.
    this.materials.block = createSurfaceMaterial({
      kind: SURFACE_KIND.STONE,
      colA: a.colorSandMid,
      colB: a.colorSandDark,
      colDark: a.colorGrime,
      plaster: 0.16,
      course: 0.21,
      roughness: 0.9,
      grime: 1.25,
      seed: 8.41
    });

    // The terracotta trim band and the door surround.
    this.materials.trim = createSurfaceMaterial({
      kind: SURFACE_KIND.STONE,
      colA: a.colorAccent,
      colB: a.colorRust,
      colDark: a.colorGrime,
      colDeep: a.colorGrime,
      plaster: 0.55,
      course: 0.22,
      roughness: 0.82,
      grime: 1.1,
      seed: 21.9
    });

    // Everything beyond the perimeter. Flatter and hazier on purpose: detail
    // that cannot be resolved at 70 m is detail that only costs fill rate, and
    // a distant building reading slightly softer is *correct*.
    this.materials.backdrop = createSurfaceMaterial({
      kind: SURFACE_KIND.STONE,
      plaster: 0.7,
      course: 0.55,
      detail: 0.55,
      bump: 0.45,
      grime: 0.7,
      edgeWear: 0.35,
      roughness: 0.9,
      seed: 55.3
    });

    this.materials.wood = createSurfaceMaterial({
      kind: SURFACE_KIND.WOOD,
      colA: '#a9a08c',
      colB: a.colorWood,
      colDark: a.colorWoodDark,
      colDeep: '#2b1d10',
      course: 0.19,
      roughness: 0.74,
      envMapIntensity: 0.4,
      seed: 12.7
    });

    this.materials.metal = createSurfaceMaterial({
      kind: SURFACE_KIND.METAL,
      colA: '#8f8b82',
      colB: a.colorMetal,
      colDark: '#3c3a35',
      colDeep: a.colorRust,
      course: 0.16,
      roughness: 0.52,
      metalness: 0.85,
      envMapIntensity: 0.9,
      seed: 30.1
    });

    this._materialList = Object.values(this.materials);
  }

  /* ================================================================== */
  /* Part records                                                        */
  /* ================================================================== */

  /**
   * Push a box.
   *
   * `y` is the *bottom* of the box, which is how a level is actually authored —
   * things sit on other things.
   */
  _box(x, y, z, w, h, d, material, surface, options = {}) {
    const { rotY = 0, collide = true, cast = true, occlude = true } = options;
    this._parts.push({
      geo: 'box',
      x,
      y: y + h / 2,
      z,
      w,
      h,
      d,
      rotY,
      material,
      cast
    });

    const hw = Math.abs(w * Math.cos(rotY)) + Math.abs(d * Math.sin(rotY));
    const hd = Math.abs(w * Math.sin(rotY)) + Math.abs(d * Math.cos(rotY));

    if (collide) {
      const box = new Box3(
        new Vector3(x - hw / 2, y, z - hd / 2),
        new Vector3(x + hw / 2, y + h, z + hd / 2)
      );
      this.collider.add(box, surface);
    }
    // Only things standing on the floor throw a contact shadow onto it.
    if (occlude && y < 0.35) {
      this._footprints.push({ x, z, hx: hw / 2, hz: hd / 2, h });
    }
    return this;
  }

  /** Push a cylinder — barrels and pipes, so the cover is not all rectangles. */
  _cyl(x, y, z, radius, h, material, surface, options = {}) {
    const { collide = true, cast = true, occlude = true, rotY = 0 } = options;
    this._parts.push({
      geo: 'cyl',
      x,
      y: y + h / 2,
      z,
      w: radius * 2,
      h,
      d: radius * 2,
      rotY,
      material,
      cast,
      // Inflate the horizontal extent the *shader* sees. A cylinder's real
      // arrises are its two rims; leaving the true radius in here would have
      // the edge-chipping logic find a false edge down the silhouette and paint
      // a vertical scar on every barrel.
      shaderInflate: 1.55
    });
    if (collide) {
      const box = new Box3(
        new Vector3(x - radius * 0.92, y, z - radius * 0.92),
        new Vector3(x + radius * 0.92, y + h, z + radius * 0.92)
      );
      this.collider.add(box, surface);
    }
    if (occlude && y < 0.35) {
      this._footprints.push({ x, z, hx: radius, hz: radius, h });
    }
    return this;
  }

  /* ================================================================== */
  /* The level                                                           */
  /* ================================================================== */

  /**
   * The perimeter.
   *
   * Not one extruded rectangle per side. A real courtyard wall has a plinth it
   * stands on, buttresses at intervals, a string course, a coping that
   * overhangs, and at least one way through — and each of those is a horizontal
   * line at a different height, which is what stops nine metres of wall from
   * reading as a blank screen-filling slab.
   */
  _buildPerimeter(size) {
    const half = size / 2;
    const h = settings.arena.wallHeight;
    const t = 1.2;
    const plinth = { h: 0.95, out: 0.28 };
    const coping = { h: 0.42, out: 0.26 };
    const trimY = 4.35;

    /** One side, expressed in that side's own frame then mapped to world. */
    const side = (axis, sign) => {
      // axis 0 → wall runs along z at x = sign*half; axis 2 → along x at z = sign*half
      const place = (u, y, len, thick, height, material, surface, options) =>
        axis === 0
          ? this._box(sign * half + thick, y, u, thick * 2, height, len, material, surface, options)
          : this._box(u, y, sign * half + thick, len, height, thick * 2, material, surface, options);

      // The doorway: one gap in the north run, deliberately off the axis the
      // impact shot fires down.
      const gap = axis === 2 && sign === -1 ? { at: -19, w: 6.4 } : null;

      if (gap) {
        const leftLen = gap.at - gap.w / 2 + half + t;
        const rightLen = half + t - (gap.at + gap.w / 2);
        const leftMid = -half - t + leftLen / 2;
        const rightMid = gap.at + gap.w / 2 + rightLen / 2;
        for (const [mid, len] of [
          [leftMid, leftLen],
          [rightMid, rightLen]
        ]) {
          place(mid, 0, len, t / 2, h, this.materials.plaster, 'concrete');
          place(mid, 0, len, t / 2 + plinth.out, plinth.h, this.materials.block, 'concrete');
          place(mid, h, len, t / 2 + coping.out, coping.h, this.materials.block, 'concrete', {
            collide: false,
            occlude: false
          });
          place(mid, trimY, len, t / 2 + 0.1, 0.3, this.materials.trim, 'concrete', {
            collide: false,
            occlude: false
          });
        }
        // Lintel over the opening, and the jambs framing it.
        place(gap.at, 3.55, gap.w, t / 2, h - 3.55, this.materials.plaster, 'concrete', {
          collide: false,
          occlude: false
        });
        place(gap.at, h, gap.w, t / 2 + coping.out, coping.h, this.materials.block, 'concrete', {
          collide: false,
          occlude: false
        });
        place(gap.at, 3.25, gap.w + 0.9, t / 2 + 0.16, 0.42, this.materials.trim, 'concrete', {
          collide: false,
          occlude: false
        });
        for (const s of [-1, 1]) {
          place(
            gap.at + s * (gap.w / 2 + 0.28),
            0,
            0.56,
            t / 2 + 0.16,
            3.6,
            this.materials.trim,
            'concrete'
          );
        }
        /* Behind the opening: a dark recess. Two jobs — it stops the player
           walking out of the level, and it is the darkest value in the frame,
           which is exactly what a courtyard lit by one hard sun needs. */
        this._box(gap.at, 0, -half - 3.4, gap.w + 3.0, h + 1.0, 5.0, this.materials.block, 'concrete', {
          occlude: false
        });
      } else {
        place(0, 0, size + t * 2, t / 2, h, this.materials.plaster, 'concrete');
        place(0, 0, size + t * 2, t / 2 + plinth.out, plinth.h, this.materials.block, 'concrete');
        place(0, h, size + t * 2, t / 2 + coping.out, coping.h, this.materials.block, 'concrete', {
          collide: false,
          occlude: false
        });
        place(0, trimY, size + t * 2, t / 2 + 0.1, 0.3, this.materials.trim, 'concrete', {
          collide: false,
          occlude: false
        });
      }

      /* Buttresses. Spaced off the centreline so the axis every capture shoots
         down stays clear. */
      for (const u of [-34, -25, -12, -3, 6, 15, 28, 37]) {
        if (gap && Math.abs(u - gap.at) < 5.6) continue;
        const bh = 6.4 + ((u * 7919) % 17) / 17 * 1.9;
        const inward = t / 2 + 0.62;
        const at =
          axis === 0
            ? this._box(
                sign * (half - 0.62 + t / 2) * 1,
                0,
                u,
                1.24,
                bh,
                1.15,
                this.materials.plaster,
                'concrete'
              )
            : this._box(
                u,
                0,
                sign * (half - 0.62 + t / 2),
                1.15,
                bh,
                1.24,
                this.materials.plaster,
                'concrete'
              );
        void at;
        void inward;
        // A capstone, so the buttress does not end in a bare cut.
        if (axis === 0) {
          this._box(
            sign * (half - 0.62 + t / 2),
            bh,
            u,
            1.5,
            0.3,
            1.42,
            this.materials.block,
            'concrete',
            { collide: false, occlude: false }
          );
        } else {
          this._box(
            u,
            bh,
            sign * (half - 0.62 + t / 2),
            1.42,
            0.3,
            1.5,
            this.materials.block,
            'concrete',
            { collide: false, occlude: false }
          );
        }
      }
    };

    side(2, -1); // north, z = -half
    side(2, 1); // south
    side(0, -1); // west
    side(0, 1); // east
  }

  /**
   * The town outside the walls.
   *
   * Nothing here is reachable and nothing here collides. It exists because a
   * skyline is how the eye judges the size of a space: with a bare horizon the
   * courtyard could be four metres across or four hundred. Fog does the rest —
   * `fogFar` is set so these sit a few percent toward the haze, which is the
   * whole of aerial perspective.
   *
   * ## Scale references
   *
   * A cuboid carries no size. A viewer shown a plain box against the sky cannot
   * tell whether it is three metres tall or thirty, and the first version of
   * this backdrop was exactly that — a skyline of anonymous blocks that gave
   * depth without giving *scale*. What fixes it is putting something of known
   * human size on the facades: a window is about 1.2 m, a door about 2 m, a
   * floor about 3 m. Once those are readable the eye solves the whole building,
   * and through it the courtyard in front of it.
   *
   * They are recessed boxes rather than texture, because at 60-120 m a painted
   * window is a smudge while a 25 cm reveal still throws a real shadow.
   */
  _buildBackdrop(size) {
    const random = mulberry32(settings.arena.coverSeed ^ 0x5bd1);
    const half = size / 2;
    const options = { collide: false, cast: false, occlude: false };

    /** Punch a grid of window reveals into one facade. */
    const windows = (x, z, w, bh, rotY, facing) => {
      const floorH = 3.0; // storey height: the strongest scale cue there is
      const floors = Math.max(1, Math.floor((bh - 1.6) / floorH));
      const winW = 1.1;
      const winH = 1.5;
      const cols = Math.max(1, Math.floor((w - 1.6) / 2.6));
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      for (let f = 0; f < floors; f++) {
        const y = 1.5 + f * floorH;
        if (y + winH > bh - 0.5) break;
        for (let c = 0; c < cols; c++) {
          if (random() < 0.12) continue; // a few bricked up
          const u = (c - (cols - 1) / 2) * 2.6;
          // Sit the reveal just proud of the facade so it is never z-fighting.
          const nx = facing.x * 0.14;
          const nz = facing.z * 0.14;
          this._box(
            x + cos * u + nx,
            y,
            z - sin * u + nz,
            winW,
            winH,
            0.3,
            this.materials.block,
            'concrete',
            { ...options, rotY }
          );
        }
      }
    };

    for (let ring = 0; ring < 3; ring++) {
      const radius = half + 9 + ring * 16;
      const count = 9 + ring * 3;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + random() * 0.4 + ring * 0.7;
        const r = radius + (random() - 0.5) * 12;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        const w = 7 + random() * 15;
        const d = 7 + random() * 15;
        // Storey-quantised heights, for the same reason the windows exist: a
        // building 4.5 storeys tall is a shape, one 5 storeys tall is a place.
        const storeys = 2 + Math.floor(random() * 4) + (ring > 1 ? 1 : 0);
        const bh = 1.4 + storeys * 3.0;
        this._box(x, 0, z, w, bh, d, this.materials.backdrop, 'concrete', {
          ...options,
          rotY: random() * Math.PI
        });

        // Face the windows at the courtyard — that is the only side anyone
        // ever sees, and skipping the other three saves three quarters of them.
        const inward = { x: -Math.cos(angle), z: -Math.sin(angle) };
        const faceYaw = Math.atan2(-inward.z, inward.x);
        if (ring < 2) windows(x, z, Math.min(w, d) * 1.4, bh, faceYaw, inward);

        // Roof parapets and stair housings: the little steps in a silhouette
        // are what stop a skyline reading as a bar chart.
        if (random() < 0.7) {
          this._box(
            x + (random() - 0.5) * w * 0.4,
            bh,
            z + (random() - 0.5) * d * 0.4,
            w * (0.3 + random() * 0.3),
            1.4 + random() * 3.4,
            d * (0.3 + random() * 0.3),
            this.materials.backdrop,
            'concrete',
            options
          );
        }
        // A parapet lip along the roofline. Two jobs: it reads as a real
        // building edge, and it is a second horizontal at a known height.
        if (random() < 0.6) {
          this._box(x, bh, z, w * 1.03, 0.7, d * 1.03, this.materials.block, 'concrete', {
            ...options,
            rotY: 0
          });
        }
      }
    }

    /* Two towers, well outside, to give the skyline a vertical. */
    for (const [x, z, bh, w] of [
      [-64, -58, 26, 7.5],
      [72, 26, 21, 6.4]
    ]) {
      this._box(x, 0, z, w, bh, w, this.materials.backdrop, 'concrete', options);
      this._box(x, bh, z, w * 1.28, 1.1, w * 1.28, this.materials.block, 'concrete', options);
      this._box(x, bh + 1.1, z, w * 0.5, 3.2, w * 0.5, this.materials.backdrop, 'concrete', options);
    }
  }

  /**
   * Mid-ground architecture: the layer that makes the space readable.
   *
   * Arches frame; a raised platform gives the floor a second height; a ruined
   * wall gives a broken silhouette against the sky. These are placed by hand
   * rather than sampled, because the whole point of them is composition and
   * composition is not something a rejection sampler has an opinion about.
   */
  _buildArchitecture(size) {
    const random = mulberry32(settings.arena.coverSeed ^ 0x2f11);
    const P = this.materials.plaster;
    const B = this.materials.block;
    const T = this.materials.trim;

    /** A free-standing arch: two piers, a lintel, a parapet over it. */
    const arch = (x, z, rotY, span = 4.6, height = 4.3) => {
      const pierW = 1.25;
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      for (const s of [-1, 1]) {
        const px = x + cos * s * (span / 2 + pierW / 2);
        const pz = z - sin * s * (span / 2 + pierW / 2);
        this._box(px, 0, pz, pierW, height, pierW * 1.05, P, 'concrete', { rotY });
        this._box(px, 0, pz, pierW + 0.34, 0.7, pierW * 1.05 + 0.34, B, 'concrete', { rotY });
        this._box(px, height, pz, pierW + 0.3, 0.3, pierW * 1.05 + 0.3, B, 'concrete', {
          rotY,
          collide: false,
          occlude: false
        });
      }
      const total = span + pierW * 2 + 0.3;
      this._box(x, height + 0.3, z, total, 0.85, pierW * 1.05, P, 'concrete', {
        rotY,
        collide: false,
        occlude: false
      });
      this._box(x, height + 0.22, z, total, 0.22, pierW * 1.05 + 0.2, T, 'concrete', {
        rotY,
        collide: false,
        occlude: false
      });
      this._box(x, height + 1.15, z, total, 0.9, pierW * 1.05 + 0.16, B, 'concrete', {
        rotY,
        collide: false,
        occlude: false
      });
    };

    arch(-13.5, -6.0, 0.0);
    arch(11.0, -17.0, Math.PI / 2, 5.2, 4.6);
    arch(-25.0, 16.0, 0.28, 4.2, 3.9);

    /* ---- a raised terrace, so the floor is not one plane ---- */
    const terrace = { x: 20, z: 12, w: 15, d: 13, h: 0.92 };
    this._box(terrace.x, 0, terrace.z, terrace.w, terrace.h, terrace.d, B, 'concrete');
    // steps up the west face
    for (let i = 0; i < 3; i++) {
      const sh = (terrace.h / 3) * (i + 1);
      this._box(
        terrace.x - terrace.w / 2 - 0.45 * (3 - i) + 0.22,
        0,
        terrace.z - 1.5,
        0.5,
        sh,
        4.2,
        B,
        'concrete'
      );
    }
    // a low parapet along two of its edges — cover you can shoot over
    this._box(terrace.x, terrace.h, terrace.z + terrace.d / 2 - 0.3, terrace.w, 1.02, 0.6, P, 'concrete');
    this._box(
      terrace.x + terrace.w / 2 - 0.3,
      terrace.h,
      terrace.z - 2.2,
      0.6,
      1.02,
      terrace.d - 4.4,
      P,
      'concrete'
    );
    this._box(
      terrace.x,
      terrace.h + 1.02,
      terrace.z + terrace.d / 2 - 0.3,
      terrace.w,
      0.2,
      0.78,
      T,
      'concrete',
      { collide: false, occlude: false }
    );

    /* ---- a ruined wall run: descending, broken, with its own rubble ---- */
    const ruin = (x0, z0, dirX, dirZ, heights) => {
      let x = x0;
      let z = z0;
      for (const rh of heights) {
        const len = 2.0 + random() * 1.4;
        this._box(x, 0, z, len, rh, 1.05, P, 'concrete', { rotY: (random() - 0.5) * 0.06 });
        // The break at the top of a ruined wall is where the block shows.
        this._box(x, rh, z, len * (0.5 + random() * 0.4), 0.28 + random() * 0.5, 1.05, B, 'concrete', {
          collide: false,
          occlude: false
        });
        // Fallen stone at its foot.
        for (let i = 0; i < 3; i++) {
          const s = 0.24 + random() * 0.42;
          this._box(
            x + (random() - 0.5) * len,
            0,
            z + (random() > 0.5 ? 1 : -1) * (0.7 + random() * 1.5),
            s * (1 + random()),
            s,
            s * (1 + random() * 0.7),
            B,
            'concrete',
            { rotY: random() * Math.PI }
          );
        }
        x += dirX * (len + 0.05);
        z += dirZ * (len + 0.05);
      }
    };

    ruin(-30, -22, 1, 0.06, [4.4, 3.1, 2.2, 3.6, 1.4, 2.8]);
    ruin(6, 24, 0.1, -1, [3.2, 4.6, 2.4, 1.6]);
    ruin(28, -30, -1, 0.0, [2.6, 3.8, 1.9]);

    void size;
  }

  /**
   * Cover: crates, barrels, low walls and rubble.
   *
   * Still rejection-sampled, because the sightlines have to stay open and that
   * is a spatial constraint rather than an aesthetic one. What changed is the
   * vocabulary — six kinds instead of four, cylinders among them, clustered
   * rather than evenly spread, and every piece getting its own colour out of
   * the surface shader.
   */
  _buildCover(size) {
    const random = mulberry32(settings.arena.coverSeed);
    const limit = size / 2 - 7;
    const count = settings.arena.coverCount;
    const placed = [];

    /* Existing architecture is registered as occupied so cover is never buried
       inside an arch or standing on the terrace's edge. */
    for (const seed of [
      { x: -13.5, z: -6, r: 5.0 },
      { x: 11, z: -17, r: 5.4 },
      { x: -25, z: 16, r: 4.6 },
      { x: 20, z: 12, r: 11.0 },
      { x: -25, z: -21, r: 8.0 },
      { x: 7, z: 20, r: 6.5 },
      { x: 25, z: -30, r: 6.0 },
      { x: 0, z: 6, r: 6.5 } // the spawn point
    ]) {
      placed.push(seed);
    }

    const fits = (x, z, r) => {
      if (Math.abs(x) > limit || Math.abs(z) > limit) return false;
      for (const other of placed) {
        const dx = x - other.x;
        const dz = z - other.z;
        const rr = r + other.r;
        if (dx * dx + dz * dz < rr * rr) return false;
      }
      return true;
    };

    for (let i = 0; i < count; i++) {
      const kind = random();
      let x = 0;
      let z = 0;
      let radius = 2.4;
      let ok = false;
      for (let attempt = 0; attempt < 60 && !ok; attempt++) {
        x = (random() * 2 - 1) * limit;
        z = (random() * 2 - 1) * limit;
        ok = fits(x, z, radius);
      }
      if (!ok) continue;
      placed.push({ x, z, r: radius });

      if (kind < 0.30) {
        /* ---- a stack of crates ---- */
        const w = 1.05 + random() * 0.75;
        const h = w * (0.82 + random() * 0.3);
        this._box(x, 0, z, w, h, w, this.materials.wood, 'wood', {
          rotY: (random() - 0.5) * 0.7
        });
        if (random() < 0.62) {
          const w2 = w * (0.6 + random() * 0.3);
          this._box(
            x + (random() - 0.5) * (w - w2),
            h,
            z + (random() - 0.5) * (w - w2),
            w2,
            w2 * (0.85 + random() * 0.3),
            w2,
            this.materials.wood,
            'wood',
            { rotY: (random() - 0.5) * 1.1 }
          );
        }
        if (random() < 0.5) {
          const w3 = w * (0.7 + random() * 0.3);
          this._box(
            x + (0.6 + random() * 0.4) * w,
            0,
            z + (random() - 0.5) * w,
            w3,
            w3 * (0.7 + random() * 0.4),
            w3,
            this.materials.wood,
            'wood',
            { rotY: (random() - 0.5) * 0.9 }
          );
        }
      } else if (kind < 0.46) {
        /* ---- a cluster of barrels ---- */
        const n = 2 + Math.floor(random() * 3);
        for (let b = 0; b < n; b++) {
          const angle = random() * Math.PI * 2;
          const dist = b === 0 ? 0 : 0.62 + random() * 0.5;
          const r = 0.31 + random() * 0.07;
          const bh = 0.86 + random() * 0.14;
          const bx = x + Math.cos(angle) * dist;
          const bz = z + Math.sin(angle) * dist;
          if (random() < 0.18) {
            // one knocked over, lying on its side
            this._box(bx, 0, bz, bh, r * 2, r * 2, this.materials.metal, 'metal', {
              rotY: random() * Math.PI
            });
          } else {
            this._cyl(bx, 0, bz, r, bh, this.materials.metal, 'metal');
            if (random() < 0.3) {
              this._cyl(bx, bh, bz, r * 0.96, bh, this.materials.metal, 'metal');
            }
          }
        }
      } else if (kind < 0.62) {
        /* ---- a broken low wall, the classic peek-over cover ---- */
        const len = 3.6 + random() * 3.0;
        const rot = Math.floor(random() * 4) * (Math.PI / 2) + (random() - 0.5) * 0.16;
        const segments = 2 + Math.floor(random() * 2);
        for (let s = 0; s < segments; s++) {
          const segLen = len / segments;
          const off = (s - (segments - 1) / 2) * (segLen + 0.06);
          const sh = 1.0 + random() * 0.55;
          this._box(
            x + Math.cos(rot) * off,
            0,
            z - Math.sin(rot) * off,
            segLen,
            sh,
            0.62 + random() * 0.22,
            this.materials.plaster,
            'concrete',
            { rotY: rot }
          );
          this._box(
            x + Math.cos(rot) * off,
            sh,
            z - Math.sin(rot) * off,
            segLen * (0.7 + random() * 0.3),
            0.2 + random() * 0.22,
            0.72,
            this.materials.block,
            'concrete',
            { rotY: rot, collide: false, occlude: false }
          );
        }
      } else if (kind < 0.80) {
        /* ---- a pillar / column stub: the vertical in the mid ground ---- */
        const w = 0.86 + random() * 0.62;
        const ph = 2.6 + random() * 3.6;
        this._box(x, 0, z, w, ph, w, this.materials.plaster, 'concrete', {
          rotY: (random() - 0.5) * 0.2
        });
        this._box(x, 0, z, w + 0.4, 0.42 + random() * 0.2, w + 0.4, this.materials.block, 'concrete', {
          rotY: (random() - 0.5) * 0.2
        });
        if (random() < 0.55) {
          this._box(x, ph, z, w + 0.34, 0.3, w + 0.34, this.materials.block, 'concrete', {
            collide: false,
            occlude: false
          });
        }
        for (let r = 0; r < 3; r++) {
          const s = 0.2 + random() * 0.34;
          this._box(
            x + (random() - 0.5) * 3.0,
            0,
            z + (random() - 0.5) * 3.0,
            s * (1 + random() * 0.6),
            s,
            s * (1 + random() * 0.6),
            this.materials.block,
            'concrete',
            { rotY: random() * Math.PI }
          );
        }
      } else {
        /* ---- a shipping container: the big readable silhouette ---- */
        const w = 3.0 + random() * 2.6;
        const d = 1.5 + random() * 0.55;
        const ch = 1.9 + random() * 0.6;
        const rot = Math.floor(random() * 4) * (Math.PI / 2);
        this._box(x, 0, z, w, ch, d, this.materials.metal, 'metal', { rotY: rot });
        this._box(x, ch, z, w * 1.02, 0.14, d * 1.03, this.materials.metal, 'metal', {
          rotY: rot,
          collide: false,
          occlude: false
        });
        if (random() < 0.4) {
          const w2 = w * (0.5 + random() * 0.3);
          this._box(x, ch + 0.14, z, w2, 0.9 + random() * 0.5, d * 0.9, this.materials.wood, 'wood', {
            rotY: rot + (random() - 0.5) * 0.5
          });
        }
      }
    }

    /* ---- rubble and drift piled against the perimeter, which is where it
       actually collects. This is cheap and it is most of what stops the base
       of a wall reading as a clean seam. ---- */
    const half = size / 2 - 1.6;
    for (let i = 0; i < 90; i++) {
      const edge = Math.floor(random() * 4);
      const along = (random() * 2 - 1) * (half - 3);
      const inward = 0.3 + random() * random() * 4.5;
      let x;
      let z;
      if (edge === 0) {
        x = along;
        z = -half + inward;
      } else if (edge === 1) {
        x = along;
        z = half - inward;
      } else if (edge === 2) {
        x = -half + inward;
        z = along;
      } else {
        x = half - inward;
        z = along;
      }
      const s = 0.14 + random() * random() * 0.55;
      this._box(
        x,
        0,
        z,
        s * (1 + random() * 0.9),
        s * (0.6 + random() * 0.5),
        s * (1 + random() * 0.9),
        random() < 0.75 ? this.materials.block : this.materials.plaster,
        'concrete',
        { rotY: random() * Math.PI, collide: false }
      );
    }
  }

  /* ================================================================== */
  /* Geometry                                                            */
  /* ================================================================== */

  _buildGround(size) {
    const geo = new PlaneGeometry(size * 1.9, size * 1.9, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.materials.ground = createGroundMaterial(
      this._groundMaps,
      this._contactMap,
      this._contactExtent
    );
    this._materialList = Object.values(this.materials);

    this.ground = new Mesh(geo, this.materials.ground);
    this.ground.position.y = 0;
    this.ground.castShadow = false;
    this.ground.receiveShadow = true;
    /**
     * The one per-frame hook the arena needs.
     *
     * Every art value in `settings.arena` has to be *sampled*, not snapshotted,
     * or the tuning knobs are decorative. `App.frame` is not this agent's file
     * to add a call to, and the ground is drawn in every pass anyway — so the
     * sync rides along here. It is twenty assignments; it does not show up in a
     * profile.
     */
    this.ground.onBeforeRender = () => syncSurfaceUniforms(this._materialList);
    this.group.add(this.ground);
  }

  /**
   * Turn the part records into merged meshes.
   *
   * Each vertex is tagged with its own object's world centre, *local* half
   * extent and yaw. That is the whole trick behind the surface shader: after
   * merging there is no per-object anything left, so the object has to travel
   * inside the vertex data or the shader cannot know where an edge is, how far
   * a fragment is above the floor, or which of two adjacent crates it is on.
   */
  _flush() {
    const byMaterial = new Map();

    for (const part of this._parts) {
      const source = part.geo === 'cyl' ? this._cylGeo : this._boxGeo;
      const geometry = source.clone();

      _position.set(part.x, part.y, part.z);
      _euler.set(0, part.rotY, 0);
      _scale.set(part.w, part.h, part.d);
      _quaternion.setFromEuler(_euler);
      _matrix.compose(_position, _quaternion, _scale);
      geometry.applyMatrix4(_matrix);

      const count = geometry.attributes.position.count;
      const centers = new Float32Array(count * 3);
      const halves = new Float32Array(count * 3);
      const rots = new Float32Array(count);
      const inflate = part.shaderInflate ?? 1;
      for (let i = 0; i < count; i++) {
        centers[i * 3] = part.x;
        centers[i * 3 + 1] = part.y;
        centers[i * 3 + 2] = part.z;
        halves[i * 3] = (part.w / 2) * inflate;
        halves[i * 3 + 1] = part.h / 2;
        halves[i * 3 + 2] = (part.d / 2) * inflate;
        rots[i] = part.rotY;
      }
      geometry.setAttribute('aCenter', new Float32BufferAttribute(centers, 3));
      geometry.setAttribute('aHalf', new Float32BufferAttribute(halves, 3));
      geometry.setAttribute('aRot', new Float32BufferAttribute(rots, 1));

      // Shadow casting is per mesh, so parts are bucketed by material *and* by
      // whether they cast. The backdrop does not: it is 40 m outside the shadow
      // frustum and drawing it into the map is pure fill rate.
      const key = `${this._materialKey(part.material)}|${part.cast ? 1 : 0}`;
      let bucket = byMaterial.get(key);
      if (!bucket) {
        bucket = { material: part.material, cast: part.cast, list: [] };
        byMaterial.set(key, bucket);
      }
      bucket.list.push(geometry);
    }

    for (const bucket of byMaterial.values()) {
      const merged = mergeGeometries(bucket.list, false);
      for (const geometry of bucket.list) geometry.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, bucket.material);
      mesh.castShadow = bucket.cast;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this._meshes.push(mesh);
    }

    this._parts.length = 0;
  }

  _materialKey(material) {
    for (const [name, value] of Object.entries(this.materials)) {
      if (value === material) return name;
    }
    return material.uuid;
  }

  dispose() {
    this._boxGeo.dispose();
    this._cylGeo.dispose();
    this._contactMap?.dispose();
    this._groundMaps?.color?.dispose();
    this._groundMaps?.normal?.dispose();
    for (const mesh of this._meshes) mesh.geometry.dispose();
    this.ground?.geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
