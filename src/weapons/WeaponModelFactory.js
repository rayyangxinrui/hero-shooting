import { Group, Mesh, Object3D } from 'three';
import {
  chamferedBox,
  barrel,
  sightRing,
  loft,
  place,
  mergeGeometries,
  bakeOcclusion
} from './GunGeometry.js';
import { GunMaterial, SURFACE } from './GunMaterial.js';
import { Hands } from './Hands.js';

/**
 * Procedural weapon viewmodels.
 *
 * Real dimensions in metres throughout — an AK is 88 cm overall with a 41 cm
 * barrel — because the viewmodel's distance from the eye is what sells its
 * weight, and eyeballed numbers put it in the uncanny middle.
 *
 * ## What makes these read as weapons rather than as boxes
 *
 *  1. **Every part is chamfered.** See `GunGeometry.js`: a sharp 90-degree edge
 *     catches light in an infinitely thin line and renders as a hard
 *     discontinuity, so a box-built gun goes flat and dark. A chamfer catches a
 *     highlight *along* its face, and that highlight is what reads as metal.
 *  2. **The barrel is hollow** and the muzzle has a crown. A capped cylinder
 *     reads as a dowel.
 *  3. **The rear sight has a hole in it.** A solid rear sight cannot be looked
 *     through, which turns ADS into two black blocks over the middle of the
 *     screen.
 *  4. **Part count is spent on the silhouette.** Selector lever, charging
 *     handle, ejection port, magazine catch, sling loops, stock comb — the
 *     details you would name if asked to describe the weapon.
 *
 * The contract with the rest of the project stays `{ id, group, muzzlePoint,
 * ejectPoint }`, so none of this leaks outward.
 */
export class WeaponModelFactory {
  constructor() {
    this.materials = {
      steel: new GunMaterial(SURFACE.STEEL, { grainScale: 1.0, seed: 0.2 }),
      dark: new GunMaterial(SURFACE.PARKERISED, { grainScale: 1.1, seed: 1.7 }),
      polymer: new GunMaterial(SURFACE.POLYMER, { grainScale: 1.0, seed: 3.1 }),
      wood: new GunMaterial(SURFACE.WOOD, { grainScale: 1.0, seed: 5.4 })
    };
    this._geometries = [];
  }

  _mat(key) {
    return this.materials[key].material;
  }

  /**
   * Start a new weapon.
   *
   * Parts are accumulated per material and merged at the end, so a weapon with
   * 80 parts still costs four draw calls. That is what makes detail free here:
   * the reason the old models were sparse was a one-mesh-per-part habit, not a
   * triangle budget — a whole rifle at this fidelity is under 6k triangles
   * against a 25k budget.
   */
  _begin() {
    this._parts = { steel: [], dark: [], polymer: [], wood: [] };
  }

  /**
   * Add a chamfered box.
   *
   * ## On chamfer size
   *
   * The rifle spans roughly 650 px on a 1920-wide frame, so one millimetre of
   * gun is about 0.74 px. A 1.2 mm chamfer is therefore *sub-pixel* — it can
   * never produce the edge highlight it exists for, and the gun reads as a
   * black slab no matter how the material is tuned. Shipped viewmodels
   * exaggerate chamfers for exactly this reason. 3-5 mm is the useful range:
   * two to four pixels of lit bevel, which is what the eye reads as a machined
   * edge.
   */
  _box(w, h, d, materialKey, x = 0, y = 0, z = 0, bevel = 0.0035, rotation = null) {
    const geometry = chamferedBox(w, h, d, bevel);
    place(geometry, { x, y, z }, rotation ?? {});
    this._parts[materialKey].push(geometry);
    return geometry;
  }

  /** A hollow barrel running along -Z. */
  _barrel(outer, outerEnd, bore, length, materialKey, x, y, z, segments = 22) {
    const geometry = barrel(outer, outerEnd, bore, length, segments);
    place(geometry, { x, y, z });
    this._parts[materialKey].push(geometry);
    return geometry;
  }

  /** A lofted solid — magazines, grips, stocks: anything with a section that changes. */
  _loft(sections, materialKey, x = 0, y = 0, z = 0, cornerSteps = 3) {
    const geometry = loft(sections, cornerSteps);
    place(geometry, { x, y, z });
    this._parts[materialKey].push(geometry);
    return geometry;
  }

  /** A ring of screws / rivets — cheap, and reads as fastened assembly. */
  _rivets(count, spacing, radius, materialKey, x, y, z, axis = 'z') {
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spacing;
      this._box(
        radius * 2,
        radius * 2,
        radius * 1.1,
        materialKey,
        x + (axis === 'x' ? offset : 0),
        y + (axis === 'y' ? offset : 0),
        z + (axis === 'z' ? offset : 0),
        radius * 0.45
      );
    }
  }

  /** Merge everything collected since `_begin` onto a group. */
  _finish(group) {
    // Bake occlusion across *every* part first, regardless of material. The
    // junctions that matter most are between materials — magazine into magwell,
    // wood handguard against the steel retainer — so baking per material would
    // miss exactly the seams it exists to darken.
    const all = Object.values(this._parts).flat();
    bakeOcclusion(all);

    for (const [key, list] of Object.entries(this._parts)) {
      if (!list.length) continue;
      const merged = mergeGeometries(list);
      this._geometries.push(merged);
      const mesh = new Mesh(merged, this._mat(key));
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    this._parts = null;
    return group;
  }

  build(id) {
    const built = this._buildById(id);

    // Publish where *this* weapon is held, so the hands the caller is about to
    // construct wrap the grip that actually exists rather than a rifle's.
    // Hands authored against one weapon's numbers pass straight through
    // another's: the forearm ends up inside the buttstock and the fingers curl
    // through the handguard, which is precisely how they were rendering.
    Hands.pendingAnchors = built.handAnchors ?? null;
    return built;
  }

  _buildById(id) {
    switch (id) {
      case 'rifle':
        return this._buildRifle();
      case 'smg':
        return this._buildSMG();
      case 'pistol':
        return this._buildPistol();
      default:
        return this._buildRifle();
    }
  }

  /* ================================================================== */

  /**
   * A Kalashnikov-pattern rifle: 88 cm overall, 41 cm barrel.
   *
   * ## The two rules this build follows
   *
   * **1. Parts overlap, never abut.** Two boxes whose faces meet at exactly the
   * same coordinate leave a hairline the background shines through, and at this
   * scale that hairline is a visible bright seam. Worse, it reads as a stack of
   * loose plates rather than as a machined assembly. Every part here is sunk
   * into its neighbour by a millimetre or two.
   *
   * **2. Chamfers are sized in pixels, not in millimetres.** See `_box`.
   */
  _buildRifle() {
    const group = new Group();
    this._begin();

    /* ================= receiver ================= */
    // The main box. Slightly taller than the visible sides so the dust cover
    // and the trigger group both sink into it rather than sitting on it.
    this._box(0.056, 0.084, 0.3, 'dark', 0, 0, -0.02, 0.004);
    // Sheet-steel receiver walls: the AK's sides are stamped and stand a hair
    // proud of the internals, which is a strong horizontal highlight line.
    this._box(0.0585, 0.05, 0.288, 'dark', 0, 0.004, -0.02, 0.0045);
    // The lightening dimple above the magazine well — an unmistakable AK read.
    //
    // Detail that is *wider* than the part it sits on stops reading as a
    // feature and starts reading as a fin sticking out of both flanks. Every
    // applied detail here is therefore inset a millimetre inside the receiver
    // wall (0.0585) rather than standing proud of it.
    this._box(0.0565, 0.019, 0.05, 'dark', 0, 0.0, -0.056, 0.005);

    // Dust cover, sunk 2 mm into the receiver so there is no gap, with the
    // characteristic longitudinal rib along its crown.
    //
    // The rib stops short of the rear sight. Run it the full length of the
    // cover and it passes straight through the rear aperture at sight height,
    // which turns ADS into a black wall with a crosshair on it — the sight is
    // open, but there is a rib parked in the middle of it.
    this._box(0.0565, 0.03, 0.235, 'dark', 0, 0.0525, -0.032, 0.005);
    this._box(0.03, 0.014, 0.15, 'dark', 0, 0.066, 0.005, 0.004);
    // Rear trunnion / receiver end cap.
    this._box(0.052, 0.056, 0.034, 'steel', 0, 0.006, 0.126, 0.0035);

    /* ---- ejection port: a raised lip around a dark recess ---- */
    this._box(0.005, 0.03, 0.09, 'steel', 0.0275, 0.026, -0.045, 0.0022);
    this._box(0.004, 0.022, 0.082, 'dark', 0.0295, 0.026, -0.045, 0.0015);
    // Charging handle: the stem through the port plus the knurled knob.
    this._box(0.03, 0.012, 0.016, 'steel', 0.038, 0.036, 0.012, 0.003);
    this._box(0.014, 0.017, 0.02, 'steel', 0.05, 0.036, 0.014, 0.004);

    /* ---- selector lever: the long stamped bar down the right side ---- */
    this._box(0.006, 0.07, 0.022, 'steel', 0.0295, 0.018, 0.028, 0.0025);
    this._box(0.007, 0.014, 0.03, 'steel', 0.0295, 0.045, 0.018, 0.002);

    /* ================= barrel group ================= */
    this._barrel(0.0122, 0.0112, 0.0039, 0.4, 'dark', 0, 0.028, -0.32);

    // ## Filling the front half
    //
    // The span between the handguard and the muzzle is where a rifle's
    // silhouette either reads as machined hardware or as a broom handle. The
    // gas block belongs at the *front edge of the handguard* (the wood ends
    // where the block begins — that is what clamps it), and the front sight
    // sits near the muzzle. Leaving 15 cm of naked tube between them, as this
    // did, is most of why the front of the gun looked skeletal.

    // Gas block. Proportioned to *hug the barrel*: roughly as deep as it is
    // wide, and only as tall as it needs to be to carry the gas port up to the
    // tube. A block that towers far above a 23 mm barrel stops reading as a
    // machined boss and starts reading as a fin bolted to a stick.
    this._box(0.03, 0.03, 0.032, 'dark', 0, 0.03, -0.334, 0.0035);
    // The riser that carries the gas up to the tube, sunk into the block.
    this._box(0.022, 0.026, 0.026, 'dark', 0, 0.046, -0.332, 0.003);
    // The gas port tube stub, angled up off the block toward the gas tube.
    this._box(0.02, 0.024, 0.02, 'dark', 0, 0.05, -0.316, 0.003, { x: -0.42 });
    // Sling swivel hanging under the gas block.
    this._box(0.008, 0.018, 0.012, 'steel', -0.014, 0.014, -0.334, 0.0018);

    // The cleaning rod, running under the barrel from the handguard to the
    // front sight. A thin bright line down the length of the front half, and
    // one of the AK's most recognisable details.
    this._barrel(0.0028, 0.0028, 0, 0.16, 'steel', 0, 0.0125, -0.408, 8);

    // A handguard retainer sleeve partway along, breaking up the bare span.
    this._box(0.024, 0.024, 0.016, 'dark', 0, 0.028, -0.386, 0.0025);

    // Front sight block: a barrel-hugging boss with a narrower tower on top
    // carrying the post between two protective ears.
    this._box(0.03, 0.03, 0.028, 'dark', 0, 0.03, -0.478, 0.0035);
    this._box(0.022, 0.026, 0.022, 'dark', 0, 0.048, -0.478, 0.003);
    // Front sight ears and the post between them.
    this._box(0.005, 0.026, 0.012, 'steel', 0.0105, 0.066, -0.478, 0.0018);
    this._box(0.005, 0.026, 0.012, 'steel', -0.0105, 0.066, -0.478, 0.0018);
    this._box(0.004, 0.022, 0.004, 'steel', 0, 0.064, -0.478, 0.0012);
    // Bayonet lug / cleaning-rod boss under the muzzle.
    this._box(0.016, 0.014, 0.052, 'dark', 0, 0.011, -0.466, 0.0025);

    /* ---- muzzle brake: a slanted can with cut ports ---- */
    // A stepped can: a narrow collar where it threads onto the barrel, then the
    // fatter body. The step is what makes it read as a fitted device rather
    // than as a block impaled on the end of a tube.
    this._barrel(0.0142, 0.0142, 0.0048, 0.014, 'steel', 0, 0.028, -0.503, 16);
    this._barrel(0.0168, 0.0162, 0.0052, 0.05, 'steel', 0, 0.028, -0.534, 18);
    // Ports cut *into* the brake: narrower than its 33 mm diameter, so they
    // read as slots rather than as tabs hanging off the sides.
    this._box(0.031, 0.01, 0.012, 'dark', 0, 0.035, -0.524, 0.0012);
    this._box(0.031, 0.01, 0.012, 'dark', 0, 0.035, -0.546, 0.0012);
    // The angled cut across the top front, which is what vents gas upward.
    this._box(0.026, 0.012, 0.014, 'dark', 0, 0.038, -0.556, 0.0015, { x: -0.5 });

    /* ---- gas tube, running from the receiver to the gas block ---- */
    this._barrel(0.0096, 0.0096, 0.0064, 0.185, 'dark', 0, 0.0535, -0.246, 14);
    this._box(0.024, 0.022, 0.014, 'steel', 0, 0.0535, -0.16, 0.0025);

    /* ================= handguard ================= */
    // Lower: a lofted body that swells in the middle where the hand sits, which
    // is what a real handguard does and what a plain box cannot express.
    this._loft(
      [
        { y: 0.02, z: -0.148, w: 0.05, h: 0.05, r: 0.011 },
        { y: 0.019, z: -0.2, w: 0.056, h: 0.054, r: 0.013 },
        { y: 0.019, z: -0.26, w: 0.055, h: 0.053, r: 0.013 },
        { y: 0.021, z: -0.318, w: 0.046, h: 0.046, r: 0.01 }
      ],
      'wood',
      0, 0, 0, 4
    );
    // Upper handguard, over the gas tube.
    this._loft(
      [
        { y: 0.056, z: -0.168, w: 0.044, h: 0.03, r: 0.009 },
        { y: 0.0565, z: -0.24, w: 0.048, h: 0.034, r: 0.011 },
        { y: 0.057, z: -0.31, w: 0.04, h: 0.028, r: 0.008 }
      ],
      'wood',
      0, 0, 0, 4
    );
    // Steel retainer bands at each end of the wood — they break the long run
    // and are where the wood is actually clamped.
    this._box(0.056, 0.058, 0.014, 'steel', 0, 0.019, -0.15, 0.0025);
    this._box(0.05, 0.05, 0.012, 'steel', 0, 0.021, -0.322, 0.0025);
    // Cooling cuts in the lower handguard's flanks. Inset inside the wood
    // (which is 0.056 at its widest) so they read as slots cut into it rather
    // than as plates stuck through it.
    for (let i = 0; i < 3; i++) {
      const z = -0.196 - i * 0.03;
      this._box(0.0535, 0.011, 0.018, 'dark', 0, 0.014, z, 0.0022);
    }

    /* ================= magazine well ================= */
    //
    // The housing the magazine seats into. Leaving it out is what made the
    // magazine and the pistol grip read as two identical bars dangling in
    // space: with nothing joining the magazine to the receiver, the eye has no
    // reason to group them, and an AK with two hanging masses and no visible
    // well reads as having two magazines.
    this._box(0.046, 0.03, 0.05, 'dark', 0, -0.036, -0.052, 0.004);
    // The front and rear lips of the well, which are what the magazine
    // actually rocks into.
    this._box(0.05, 0.022, 0.012, 'dark', 0, -0.038, -0.074, 0.003);
    this._box(0.05, 0.026, 0.012, 'dark', 0, -0.036, -0.03, 0.003);

    /* ================= magazine ================= */
    // One lofted body rather than three rotated boxes: a real magazine is a
    // single swept shell, and the box version showed two intersection seams
    // and leaked daylight between the segments.
    //
    // ## Which way the banana curves
    //
    // −Z is toward the muzzle here and +Z toward the stock. An AK magazine
    // hangs from the well and sweeps **back toward the shooter** as it drops —
    // the rounds stack along the curve of the case taper, and the follower
    // travels forward-and-up. Curving it the other way is the single most
    // recognisable thing you can get wrong on this weapon, and it reads as
    // "wrong gun" instantly even to someone who could not say why.
    // The sweep is gentle. An AK magazine leaves the well very close to
    // vertical and only curves back appreciably in its bottom third — total
    // travel is about a third of its drop, not most of it. Curving it too hard
    // swings the lower half back underneath the pistol grip, at which point the
    // two silhouettes overlap and the rifle reads as having two magazines.
    // The sweep travels about 40% of its drop — enough that the banana curve is
    // unmistakable in silhouette, not so much that the bottom swings back under
    // the pistol grip and merges with it. Both failure modes were hit on the way
    // here: 90% travel put the floorplate under the grip, and 25% left the
    // magazine hanging straight down where the trigger guard hid it.
    this._loft(
      [
        { y: -0.03, z: -0.056, w: 0.031, h: 0.031, r: 0.005 },
        { y: -0.072, z: -0.052, w: 0.03, h: 0.031, r: 0.006 },
        { y: -0.114, z: -0.04, w: 0.0295, h: 0.032, r: 0.006 },
        { y: -0.152, z: -0.021, w: 0.029, h: 0.033, r: 0.006 },
        { y: -0.184, z: 0.004, w: 0.028, h: 0.034, r: 0.006 },
        { y: -0.204, z: 0.026, w: 0.0275, h: 0.034, r: 0.006 }
      ],
      'polymer',
      0, 0, 0, 3
    );
    // Reinforcing ribs down the magazine's flank, following the curve. They
    // must be NARROWER than the magazine (which is 28-31 mm across) or they
    // protrude from both flanks as fins, and the baked occlusion then darkens
    // around them so the whole magazine reads as a hollow open channel.
    const ribs = [
      [-0.06, -0.054, 0.08],
      [-0.1, -0.046, 0.22],
      [-0.138, -0.03, 0.38],
      [-0.174, -0.006, 0.55]
    ];
    for (const [y, z, rot] of ribs) {
      this._box(0.0265, 0.016, 0.007, 'polymer', 0, y, z, 0.0016, { x: rot });
    }
    // Floor plate.
    this._box(0.033, 0.009, 0.034, 'polymer', 0, -0.208, 0.03, 0.002, { x: 0.6 });
    // Magazine catch and its shroud.
    this._box(0.018, 0.02, 0.014, 'steel', 0, -0.04, 0.004, 0.0025);

    /* ================= grip and trigger ================= */
    // Lofted so it swells for the palm and flares at the base.
    //
    // The section here is deliberately *deep* front-to-back (h, which runs
    // along the grip's own cross-section) rather than slim. A grip modelled as
    // a slim curved bar has the same silhouette as a magazine, and the eye then
    // reads an AK as having two magazines — which is precisely how this looked
    // before. A real pistol grip is a hand-filling club: about 45 mm deep and
    // noticeably wider at the palm swell than at either end.
    this._loft(
      [
        { y: -0.03, z: 0.056, w: 0.036, h: 0.056, r: 0.012 },
        { y: -0.066, z: 0.068, w: 0.042, h: 0.055, r: 0.017 },
        { y: -0.104, z: 0.081, w: 0.041, h: 0.052, r: 0.016 },
        { y: -0.136, z: 0.092, w: 0.044, h: 0.054, r: 0.012 }
      ],
      'polymer',
      0, 0, 0, 4
    );
    // Grip cap, proud of the grip on every side.
    this._box(0.047, 0.009, 0.056, 'polymer', 0, -0.141, 0.094, 0.0022, { x: 0.32 });

    // Trigger guard: a bow, built from four bars so it has a real opening and
    // both ends actually land on something. The rear leg runs up into the
    // grip and the front leg into the magazine well, which is what ties the
    // whole underside of the rifle into one assembly instead of leaving three
    // separate objects hanging off the receiver.
    this._box(0.03, 0.009, 0.064, 'steel', 0, -0.053, 0.034, 0.0022);
    this._box(0.03, 0.03, 0.009, 'steel', 0, -0.04, 0.064, 0.0022);
    this._box(0.03, 0.026, 0.009, 'steel', 0, -0.042, 0.005, 0.0022);
    // The flat under the receiver that the guard hangs from. It must start
    // BEHIND the magazine well: at 42 mm it is wider than the 31 mm magazine,
    // so any overlap hides the magazine completely from a three-quarter view.
    this._box(0.042, 0.014, 0.078, 'dark', 0, -0.034, 0.048, 0.003);
    // The trigger itself, curved back into the guard.
    this._box(0.008, 0.024, 0.01, 'steel', 0, -0.036, 0.03, 0.0018, { x: -0.2 });

    /* ================= stock ================= */
    this._loft(
      [
        { y: -0.004, z: 0.142, w: 0.042, h: 0.062, r: 0.011 },
        { y: -0.012, z: 0.196, w: 0.041, h: 0.07, r: 0.013 },
        { y: -0.022, z: 0.258, w: 0.04, h: 0.078, r: 0.013 },
        { y: -0.03, z: 0.308, w: 0.042, h: 0.086, r: 0.011 }
      ],
      'wood',
      0, 0, 0, 4
    );
    // The comb the cheek rests on.
    this._box(0.038, 0.02, 0.15, 'wood', 0, 0.023, 0.232, 0.005, { x: -0.05 });
    // Butt plate, with its trap door and the sling slot through the toe.
    this._box(0.044, 0.09, 0.012, 'steel', 0, -0.03, 0.316, 0.0035);
    this._box(0.024, 0.05, 0.006, 'dark', 0, -0.03, 0.322, 0.002);
    // Sling loop on the left flank.
    this._box(0.007, 0.018, 0.012, 'steel', -0.021, -0.04, 0.176, 0.0018);

    /* ================= rear sight ================= */
    const rearGeo = sightRing(0.028, 0.022, 0.0055, 0.009);
    place(rearGeo, { x: 0, y: 0.0655, z: -0.113 });
    this._parts.steel.push(rearGeo);
    // Rear sight leaf and its base, sunk into the dust cover. Both must stay
    // clear of the aperture, which spans y 0.060-0.071: a base that reaches up
    // into it blocks the bottom of the sight picture.
    this._box(0.032, 0.014, 0.034, 'dark', 0, 0.051, -0.113, 0.003);
    this._box(0.036, 0.012, 0.044, 'dark', 0, 0.045, -0.108, 0.003);

    this._finish(group);

    // Named helpers so `WeaponSystem.solveAdsOffsets` finds the real sights
    // rather than guessing from bounding boxes.
    const rearSight = new Object3D();
    rearSight.name = 'rearSight';
    rearSight.position.set(0, 0.0655, -0.113);
    group.add(rearSight);

    const frontSight = new Object3D();
    frontSight.name = 'frontSight';
    // The tip of the front post — must track the post geometry above, or ADS
    // lines the eye up on a point that is not on the sight.
    frontSight.position.set(0, 0.064, -0.478);
    group.add(frontSight);

    const muzzlePoint = new Object3D();
    muzzlePoint.position.set(0, 0.028, -0.559);
    group.add(muzzlePoint);

    const ejectPoint = new Object3D();
    ejectPoint.position.set(0.034, 0.03, -0.045);
    group.add(ejectPoint);

    // Where the shooting hand grips it — the pivot the viewmodel hangs from.
    return {
      id: 'rifle',
      group,
      muzzlePoint,
      ejectPoint,
      gripOffset: 0.074,
      // Mid-grip, and the middle of the lower handguard.
      //
      // `fore.top` is the surface the support fingers must crown *over*. It is
      // the top of the LOWER handguard (the loft peaks at y≈0.046), not the top
      // of the whole assembly: the upper handguard and gas tube sit above at
      // y≈0.0735, and a hand is wrapped around the lower wood with the gas tube
      // passing over the back of the fingers. Aiming at the assembly top would
      // put the fingers above the gas tube, holding thin air.
      handAnchors: {
        grip: { y: -0.076, z: 0.072 },
        fore: { y: 0.016, z: -0.238, top: 0.046 },
        gripWidth: 0.042
      }
    };
  }

  /* ================================================================== */

  /** A compact SMG: 60 cm extended, 19 cm barrel. */
  _buildSMG() {
    const group = new Group();
    this._begin();

    /* ---- upper and lower, overlapping at a visible split line ---- */
    this._box(0.048, 0.052, 0.235, 'dark', 0, 0.018, -0.01, 0.004);
    this._box(0.047, 0.04, 0.2, 'polymer', 0, -0.019, -0.005, 0.0045);
    // The seam itself: a thin proud strip, which is what actually reads as a
    // two-piece receiver rather than the gap between two boxes.
    this._box(0.0495, 0.005, 0.19, 'dark', 0, -0.001, -0.008, 0.0015);

    // Top rail: a spine plus crosswise teeth, sunk into it so no light leaks.
    this._box(0.026, 0.009, 0.192, 'dark', 0, 0.046, -0.02, 0.002);
    for (let i = 0; i < 7; i++) {
      this._box(0.028, 0.008, 0.011, 'dark', 0, 0.051, -0.095 + i * 0.026, 0.0022);
    }

    /* ---- hollow barrel and shroud ---- */
    this._barrel(0.0102, 0.0094, 0.0034, 0.19, 'dark', 0, 0.02, -0.215);
    this._loft(
      [
        { y: 0.02, z: -0.118, w: 0.042, h: 0.042, r: 0.011 },
        { y: 0.02, z: -0.18, w: 0.044, h: 0.044, r: 0.013 },
        { y: 0.02, z: -0.234, w: 0.038, h: 0.038, r: 0.01 }
      ],
      'polymer',
      0, 0, 0, 4
    );
    // A steel collar where the shroud meets the receiver. Without a hard
    // material change here the polymer shroud and the dark upper sit at almost
    // the same value and the join is invisible, so the whole front of the gun
    // reads as one undifferentiated bar.
    this._box(0.05, 0.05, 0.014, 'steel', 0, 0.02, -0.118, 0.003);
    // Heat-shield ribs along the top of the shroud.
    for (let i = 0; i < 3; i++) {
      this._box(0.03, 0.008, 0.03, 'dark', 0, 0.041, -0.145 - i * 0.035, 0.0022);
    }
    // Vent slots cut into the shroud's flanks — inset inside its 0.044 width.
    for (let i = 0; i < 4; i++) {
      this._box(0.0415, 0.011, 0.017, 'dark', 0, 0.031, -0.135 - i * 0.026, 0.0022);
    }
    // Muzzle device, with ports.
    this._barrel(0.014, 0.013, 0.0044, 0.044, 'steel', 0, 0.02, -0.328, 16);
    this._box(0.031, 0.007, 0.01, 'dark', 0, 0.027, -0.322, 0.001);
    this._box(0.031, 0.007, 0.01, 'dark', 0, 0.027, -0.338, 0.001);

    /* ---- charging handle and ejection port ---- */
    this._box(0.024, 0.011, 0.014, 'steel', 0.03, 0.03, -0.02, 0.0028);
    this._box(0.013, 0.014, 0.018, 'steel', 0.04, 0.03, -0.019, 0.0035);
    this._box(0.005, 0.024, 0.072, 'steel', 0.0235, 0.024, -0.03, 0.002);
    this._box(0.004, 0.017, 0.064, 'dark', 0.0255, 0.024, -0.03, 0.0014);

    /* ---- magazine: lofted, with a slight taper ---- */
    // Long enough to read as a magazine. A stick mag that stops level with the
    // pistol grip beside it gives two similar stubs and no silhouette, which is
    // the same failure the rifle had. An SMG magazine is the longest thing
    // under the gun and should clearly outrun the grip.
    this._loft(
      [
        { y: -0.03, z: -0.016, w: 0.029, h: 0.052, r: 0.006 },
        { y: -0.1, z: -0.02, w: 0.028, h: 0.051, r: 0.006 },
        { y: -0.17, z: -0.024, w: 0.027, h: 0.049, r: 0.006 },
        { y: -0.208, z: -0.026, w: 0.031, h: 0.052, r: 0.006 }
      ],
      'polymer',
      0, 0, 0, 3
    );
    // Witness holes down the magazine spine.
    for (let i = 0; i < 5; i++) {
      this._box(0.031, 0.008, 0.008, 'dark', 0, -0.062 - i * 0.032, -0.0465, 0.0015);
    }
    // Floor plate.
    this._box(0.035, 0.009, 0.056, 'polymer', 0, -0.212, -0.026, 0.002);
    this._box(0.032, 0.014, 0.054, 'dark', 0, -0.036, -0.018, 0.003);

    /* ---- grip and trigger ---- */
    this._loft(
      [
        { y: -0.03, z: 0.058, w: 0.032, h: 0.046, r: 0.009 },
        { y: -0.066, z: 0.069, w: 0.035, h: 0.048, r: 0.012 },
        { y: -0.102, z: 0.08, w: 0.034, h: 0.046, r: 0.012 },
        { y: -0.126, z: 0.087, w: 0.037, h: 0.046, r: 0.009 }
      ],
      'polymer',
      0, 0, 0, 4
    );
    // Trigger guard as a real bow, hanging a visible 30 mm below the lower
    // receiver. Sitting it 7 mm below, as it was, gives a slot rather than a
    // guard and the grip appears to grow straight out of the receiver.
    this._box(0.028, 0.008, 0.056, 'dark', 0, -0.066, 0.036, 0.002);
    this._box(0.028, 0.032, 0.009, 'dark', 0, -0.053, 0.06, 0.002);
    this._box(0.028, 0.024, 0.009, 'dark', 0, -0.05, 0.012, 0.002);
    this._box(0.007, 0.022, 0.009, 'steel', 0, -0.05, 0.034, 0.0018, { x: -0.18 });

    /* ---- folding stock: two rails and a pad ---- */
    this._box(0.008, 0.013, 0.17, 'dark', 0.019, 0.004, 0.165, 0.0022);
    this._box(0.008, 0.013, 0.17, 'dark', -0.019, 0.004, 0.165, 0.0022);
    this._box(0.05, 0.056, 0.016, 'polymer', 0, 0.004, 0.248, 0.004);
    // Hinge block where the rails meet the receiver.
    this._box(0.05, 0.028, 0.026, 'dark', 0, 0.004, 0.09, 0.003);

    /* ---- irons ---- */
    // The front sight has to stand on something. Sitting it out beyond the end
    // of the shroud and 40 mm clear of the barrel leaves it floating in mid-air
    // with a visible gap under it, which is what it was doing. It gets a base
    // that reaches down to the barrel, and moves back onto the shroud.
    this._box(0.018, 0.026, 0.018, 'dark', 0, 0.034, -0.228, 0.0025);
    this._box(0.004, 0.02, 0.005, 'steel', 0, 0.054, -0.228, 0.0014);
    this._box(0.004, 0.024, 0.009, 'steel', 0.0105, 0.053, -0.228, 0.0016);
    this._box(0.004, 0.024, 0.009, 'steel', -0.0105, 0.053, -0.228, 0.0016);

    const rearGeo = sightRing(0.024, 0.019, 0.0046, 0.008);
    place(rearGeo, { x: 0, y: 0.0605, z: -0.085 });
    this._parts.steel.push(rearGeo);
    this._box(0.028, 0.014, 0.026, 'dark', 0, 0.051, -0.085, 0.0028);

    this._finish(group);

    const rearSight = new Object3D();
    rearSight.name = 'rearSight';
    rearSight.position.set(0, 0.0605, -0.085);
    group.add(rearSight);

    const frontSight = new Object3D();
    frontSight.name = 'frontSight';
    frontSight.position.set(0, 0.054, -0.228);
    group.add(frontSight);

    const muzzlePoint = new Object3D();
    muzzlePoint.position.set(0, 0.02, -0.35);
    group.add(muzzlePoint);

    const ejectPoint = new Object3D();
    ejectPoint.position.set(0.028, 0.026, -0.03);
    group.add(ejectPoint);

    return {
      id: 'smg',
      group,
      muzzlePoint,
      ejectPoint,
      gripOffset: 0.072,
      // The support hand wraps the barrel shroud, whose loft peaks at y≈0.042.
      handAnchors: {
        grip: { y: -0.072, z: 0.07 },
        fore: { y: 0.016, z: -0.178, top: 0.042 },
        gripWidth: 0.04
      }
    };
  }

  /* ================================================================== */

  /** A service pistol: 20 cm slide, 11 cm barrel. */
  _buildPistol() {
    const group = new Group();
    this._begin();

    /* ---- slide ---- */
    this._box(0.027, 0.036, 0.178, 'steel', 0, 0.028, -0.048, 0.0035);
    // The slide's top is a shallow roof rather than a flat plane, which is what
    // puts a highlight line down the centre of every service pistol. It has to
    // stay clear of the sight line: this ridge peaked 2 mm under it, so with
    // chamfers it grazed the aperture and the sights could not be looked
    // through.
    this._box(0.019, 0.009, 0.174, 'steel', 0, 0.0425, -0.048, 0.003);
    // Cocking serrations, cut proud so they catch light. Sunk 1 mm into the
    // slide so no daylight shows between a serration and its parent.
    for (let i = 0; i < 6; i++) {
      this._box(0.029, 0.028, 0.0042, 'steel', 0, 0.028, 0.018 - i * 0.0082, 0.0012);
    }
    for (let i = 0; i < 4; i++) {
      this._box(0.029, 0.026, 0.0038, 'steel', 0, 0.028, -0.088 - i * 0.0082, 0.0011);
    }

    /* ---- frame and dust cover ---- */
    this._box(0.026, 0.028, 0.125, 'polymer', 0, -0.002, -0.022, 0.0035);
    this._box(0.024, 0.018, 0.062, 'polymer', 0, -0.006, -0.088, 0.003);
    // Accessory rail: two lips with a slot between them.
    this._box(0.02, 0.008, 0.052, 'polymer', 0, -0.016, -0.09, 0.0018);
    this._box(0.021, 0.006, 0.008, 'polymer', 0, -0.019, -0.076, 0.0012);
    this._box(0.021, 0.006, 0.008, 'polymer', 0, -0.019, -0.1, 0.0012);

    /* ---- hollow barrel through the slide ---- */
    this._barrel(0.0076, 0.0074, 0.0047, 0.03, 'steel', 0, 0.028, -0.148, 16);
    // Ejection port: raised lip plus dark recess.
    this._box(0.005, 0.021, 0.05, 'steel', 0.0135, 0.034, -0.052, 0.0018);
    this._box(0.004, 0.015, 0.043, 'dark', 0.0152, 0.034, -0.052, 0.0012);
    // Extractor.
    this._box(0.005, 0.008, 0.018, 'steel', 0.0135, 0.043, -0.03, 0.0012);

    /* ---- grip: lofted, raked back, with a palm swell ---- */
    this._loft(
      [
        { y: -0.014, z: 0.004, w: 0.03, h: 0.045, r: 0.008 },
        { y: -0.05, z: 0.017, w: 0.032, h: 0.046, r: 0.011 },
        { y: -0.088, z: 0.03, w: 0.031, h: 0.045, r: 0.011 },
        { y: -0.118, z: 0.04, w: 0.034, h: 0.046, r: 0.008 }
      ],
      'polymer',
      0, 0, 0, 4
    );
    // Magazine floorplate, proud of the grip but not a shelf: it only needs to
    // overhang by a couple of millimetres.
    this._box(0.036, 0.01, 0.046, 'polymer', 0, -0.122, 0.039, 0.0022, { x: 0.31 });
    // Backstrap texture: stacked ribs up the rear of the grip.
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      this._box(0.028, 0.006, 0.006, 'polymer', 0, -0.03 - t * 0.08, 0.026 + t * 0.028, 0.0014, { x: 0.31 });
    }

    /* ---- trigger group ---- */
    // The bow hangs a real 30 mm below the frame and its front leg is *forward*
    // of the trigger, closing the loop. Previously the "front" bar sat behind
    // the trigger, so the guard was an open hook and the grip appeared to meet
    // the frame with nothing between them.
    this._box(0.024, 0.008, 0.058, 'polymer', 0, -0.042, -0.024, 0.002);
    this._box(0.024, 0.03, 0.009, 'polymer', 0, -0.03, -0.049, 0.002);
    this._box(0.024, 0.022, 0.009, 'polymer', 0, -0.028, 0.0, 0.002);
    this._box(0.007, 0.022, 0.008, 'steel', 0, -0.026, -0.018, 0.0016, { x: -0.15 });
    // Slide stop and takedown lever.
    this._box(0.005, 0.009, 0.026, 'steel', 0.0145, 0.006, -0.012, 0.0016);
    this._box(0.005, 0.011, 0.011, 'steel', 0.0145, 0.004, -0.038, 0.0016);

    /* ---- irons: three-dot, with a real rear notch ---- */
    // Raised clear of the slide roof so there is genuinely air under the sight
    // line, plus small blocks so the sights stand on the slide rather than
    // floating above it.
    this._box(0.007, 0.008, 0.007, 'steel', 0, 0.0495, -0.126, 0.0012);
    this._box(0.006, 0.01, 0.005, 'steel', 0, 0.0575, -0.126, 0.0014);
    this._box(0.018, 0.008, 0.011, 'steel', 0, 0.0495, 0.03, 0.0014);
    const rearGeo = sightRing(0.02, 0.013, 0.0042, 0.007);
    place(rearGeo, { x: 0, y: 0.0585, z: 0.03 });
    this._parts.steel.push(rearGeo);

    this._finish(group);

    const rearSight = new Object3D();
    rearSight.name = 'rearSight';
    rearSight.position.set(0, 0.0585, 0.03);
    group.add(rearSight);

    const frontSight = new Object3D();
    frontSight.name = 'frontSight';
    frontSight.position.set(0, 0.0575, -0.126);
    group.add(frontSight);

    const muzzlePoint = new Object3D();
    muzzlePoint.position.set(0, 0.028, -0.163);
    group.add(muzzlePoint);

    const ejectPoint = new Object3D();
    ejectPoint.position.set(0.018, 0.038, -0.05);
    group.add(ejectPoint);

    return {
      id: 'pistol',
      group,
      muzzlePoint,
      ejectPoint,
      gripOffset: 0.03,
      // A pistol has no handguard: the support hand cups the shooting hand, so
      // the "fore" anchor sits just below and forward of the grip rather than
      // out at the barrel. Pointing it at the barrel is how you get a hand
      // floating in front of the muzzle.
      // A two-handed pistol hold is not a handguard grip: the support fingers
      // close over the *shooting hand's* fingers, not over the frame. So `top`
      // is the height of the shooting hand's knuckles rather than any part of
      // the weapon — aiming at the slide would put the support hand over the
      // ejection port, in front of the sights.
      handAnchors: {
        grip: { y: -0.066, z: 0.022 },
        fore: { y: -0.076, z: -0.006, top: -0.042 },
        gripWidth: 0.036
      }
    };
  }

  dispose() {
    for (const geometry of this._geometries) geometry.dispose();
    this._geometries.length = 0;
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
