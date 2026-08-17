import { MeshStandardMaterial, Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * The arena's surfaces.
 *
 * ## Why this file exists
 *
 * A flat `MeshStandardMaterial` colour is the single loudest tell of a hobby
 * renderer, and it was what every wall and every crate in this arena used to
 * be. The reference is Dust II / Inferno, and what those walls actually are is
 * *layers*: lime plaster troweled over cut blockwork, water streaking down from
 * every ledge, the plaster gone in patches where it has spalled, chipped
 * corners showing the aggregate underneath, and every block a slightly
 * different colour because they were quarried from different beds.
 *
 * None of that can be expressed with three numbers, so it is generated. One
 * shader body, one compiled program, driven entirely by uniforms — see the
 * `cacheKey` argument threaded through `patchOnBeforeCompile`: the plaster, the
 * bare block, the crates and the containers all share one program and differ
 * only in what is fed to it.
 *
 * ## The layer stack, in the order the shader builds it
 *
 *  1. **Blockwork** — running-bond courses with recessed mortar joints. Every
 *     block gets its own value and hue from a hash of its (row, column), which
 *     is the "colour variation between adjacent stones" that photographs of
 *     real masonry always show and grey-box levels never do.
 *  2. **Plaster** — a stucco skin over the block, present or absent according
 *     to a low-frequency noise field biased by *where plaster actually fails*:
 *     at the bottom of a wall where it wicks damp, and along exposed corners.
 *     Where it is present it sits about a centimetre proud of the block, so the
 *     boundary of a patch has a real lip that catches the sun.
 *  3. **Aggregate** — a hash-grid speckle in the plaster, faded out by screen
 *     derivative so it never aliases into a shimmering mess at range.
 *  4. **Chipping** — corners are eaten away by noise thresholded against the
 *     true distance to the box edge (exact, because every vertex carries its
 *     object's centre and half-extent). Under a chip: the deep aggregate
 *     colour. On the surviving arris: sun-bleached lightening.
 *  5. **Grime** — vertical streaks whose strength decays with distance below
 *     the object's own top edge, so runoff always starts at a ledge, plus a
 *     splash band at the base where the ground throws dirt up the wall.
 *  6. **Contact darkening** — the thing that makes an object look *placed*.
 *     Every fragment knows how far it is above its object's base, and the
 *     ground samples a baked occlusion map (see `bakeContactMap`).
 *
 * The relief is turned into a normal with the screen-space derivative trick
 * three itself uses for bump maps: one height evaluation instead of three taps,
 * which is what keeps this inside the frame budget on a wall that fills a third
 * of the screen.
 */

/** Which family of surface a material is. Selected by uniform, not by define. */
export const SURFACE_KIND = Object.freeze({
  STONE: 0, // plaster over block; `plaster` uniform picks how much survives
  WOOD: 1, // sawn crate planking
  METAL: 2 // painted, ribbed and rusting steel
});

/* ------------------------------------------------------------------ */
/* The shared GLSL                                                     */
/* ------------------------------------------------------------------ */

const SURFACE_PARS = /* glsl */ `
uniform vec3  uColA;        // the pale lime plaster
uniform vec3  uColB;        // weathered blockwork
uniform vec3  uColDark;     // the shaded/dirty member of the same family
uniform vec3  uColDeep;     // what is under a chip: raw aggregate / brick
uniform vec3  uColGrime;    // what runs down a wall from a ledge
uniform float uKind;        // SURFACE_KIND
uniform float uPlaster;     // 0 = bare block, 1 = fully rendered
uniform float uGrime;
uniform float uEdgeWear;
uniform float uDetail;      // frequency multiplier
uniform float uBump;        // relief depth
uniform float uAOAmt;
uniform float uRough;
uniform float uSeed;
uniform float uCourse;      // metres per masonry course / plank

varying vec3 vSurfW;        // world position
varying vec3 vSurfN;        // world normal
varying vec3 vSurfC;        // world centre of the box this fragment belongs to
varying vec3 vSurfH;        // its half-extent
varying float vSurfR;       // its yaw, so the box can be un-rotated

/* Feature fade: returns 0 once one period of a feature is under a couple of
   pixels, which is the only way a hash-grid speckle survives being viewed from
   40 m without turning into crawling noise. */
float surfLod(float period, float texel) {
  return 1.0 - smoothstep(period * 0.8, period * 2.6, texel);
}

/* Local fbm with a per-octave *offset*.
 *
 * The shared fbm3 in the noise library scales its input by 2.02 per octave
 * without translating it, so every octave is centred on the same origin and
 * their lattices stay in phase along the axes. On a big flat wall that shows up
 * as faint regular banding — which is precisely what the first pass of this
 * plaster was doing. Rotating and offsetting each octave decorrelates them.
 *
 * Left local rather than fixed in the shared library: that file is used by every
 * VFX material in the project and changing the noise under them mid-flight
 * would silently restyle six abilities.
 */
float surfFbm(vec2 p, float seed, int octaves) {
  float v = 0.0;
  float a = 0.5;
  float total = 0.0;
  vec2 q = p;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    v += a * snoise(vec3(q, seed + float(i) * 19.7));
    total += a;
    q = rot2(0.73) * q * 2.07 + vec2(13.4, -7.9);
    a *= 0.5;
  }
  return v / max(total, 1e-4);
}

/* All of the per-fragment work. Written as out-params rather than a struct so
   the caller can take screen derivatives of the height afterwards. */
void arenaSurface(
  vec3 pW, vec3 nW, vec3 ctr, vec3 hlf, float rotY,
  out vec3 albedo, out float rough, out float metal, out float ao, out float height
) {
  /* ---- into the object's own frame ----
   *
   * ## Why this rotation is not optional
   *
   * The edge distance below is what places every chip, and it is computed by
   * comparing a position against a half-extent. Both have to be in the *same*
   * frame. Half-extents are the box's own; positions were world. For every
   * piece of cover placed at a yaw that is not a multiple of 90 degrees, the
   * two disagreed, so the shader believed the object's edge ran somewhere
   * through the middle of a face and painted a chip stripe down it — the
   * terracotta band that was appearing on the corner of every rotated pillar.
   *
   * It is a cheap fix because the level is authored with yaw only: one 2x2
   * rotation, no matrix inverse and no extra attribute beyond the angle.
   */
  float cy = cos(-rotY);
  float sy = sin(-rotY);
  vec3 d = pW - ctr;
  vec3 p = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
  vec3 n = vec3(nW.x * cy - nW.z * sy, nW.y, nW.x * sy + nW.z * cy);
  vec3 an = abs(n);

  /* ---- project onto the face. Everything here is a box in its own frame, so
     the face basis is just "drop the axis the normal points down". ---- */
  vec2 fc;
  if (an.y > 0.5)      fc = vec2(p.x, p.z);
  else if (an.x > 0.5) fc = vec2(p.z, p.y);
  else                 fc = vec2(p.x, p.y);
  float upFace = step(0.5, an.y);

  float texel = max(fwidth(fc.x), fwidth(fc.y)) + 1e-5;

  /* ---- where we are on the object ---- */
  vec3  dEdge   = hlf - abs(p);
  vec3  inPlane = 1.0 - step(0.5, an);
  float edge = min(min(mix(9.0, dEdge.x, inPlane.x),
                       mix(9.0, dEdge.y, inPlane.y)),
                   mix(9.0, dEdge.z, inPlane.z));

  // Height is measured off the object, but *gravity* is world: yaw does not
  // tilt anything, so p.y is already the world offset from the centre.
  float above = p.y + hlf.y;          // metres above this object's own base
  float below = hlf.y - p.y;          // metres below its own top
  float aboveGround = max(pW.y, 0.0); // metres above the courtyard floor

  /* ---- per-object identity: this is what makes two identical crates two
     different crates rather than one crate drawn twice ---- */
  float oid  = hash13(ctr * 2.13 + uSeed);
  float oid2 = hash13(ctr.zxy * 3.71 + uSeed + 11.3);

  float ds = uDetail;

  /* ================= common noise, shared by all three kinds ============
   *
   * Three octave bands rather than one, because a surface that varies at only
   * one scale reads as noise applied to a wall rather than as a wall. The
   * blotch band is the metre-scale patchiness that carries most of the sense
   * of an aged render; coarse is the trowel; fine is the sand in the mix.
   */
  float blotch = surfFbm(fc * 0.30 * ds, uSeed * 1.1, 2);
  float coarse = surfFbm(fc * 1.7 * ds, uSeed * 1.7, 2);
  // 11 cm features. This is the band that carries the surface at conversational
  // distance — the range at which a player is actually looking at a wall — and
  // it was at 7.0 (14 cm) with only two octaves, which left a smooth gradient.
  float fine   = surfFbm(fc * 9.0 * ds, uSeed * 0.7, 3);

  vec2  gcell = floor(fc * 74.0 * ds);
  float spk   = hash13(vec3(gcell, uSeed));
  float grit  = (spk - 0.5) * surfLod(1.0 / (74.0 * ds), texel);

  /* ---- seams ----
   *
   * ## Where weathering actually starts
   *
   * A join between two materials is not a clean line on a real building. It is
   * the *first* place water gets in, so it is where the render lifts, where the
   * salts bloom, where the moss sits and where the mortar has been repointed in
   * a slightly wrong colour. Every join in this arena — brick plinth to stucco
   * wall, wall to ground, coping to parapet — was a geometric butt: two
   * materials meeting at a perfectly straight edge with nothing happening.
   *
   * Two seams are known without any extra data. The base of the object is one
   * (that is where the plinth or the ground meets it) and the top is the other
   * (that is where the coping sits). Both get a noisy band that the plaster
   * loss, the chipping and the grime all key off, so the transition dissolves
   * into damage instead of being drawn as a line.
   */
  float seamNoise = snoise(vec3(fc.x * 3.1 * ds, fc.y * 1.4 * ds, uSeed * 7.7)) * 0.5 + 0.5;
  float seamBand = 0.16 + seamNoise * 0.30;             // 16-46 cm of wander
  float seamLow  = 1.0 - smoothstep(0.0, seamBand, above);
  float seamHigh = 1.0 - smoothstep(0.0, seamBand * 0.7, below);
  float seam = max(seamLow, seamHigh * 0.75) * (1.0 - upFace);
  // The courtyard floor is the strongest seam of all: everything standing on it
  // is wicking damp out of it.
  float groundSeam = (1.0 - smoothstep(0.0, 0.28 + seamNoise * 0.34, aboveGround)) * (1.0 - upFace);

  /* ---- grime: streaks from every ledge, splash at every base ----
   * Stretched ~25:1 along Y. Runoff is directional and the whole reason it
   * reads is that the streak is far longer than it is wide. */
  /* Two bands at incommensurate horizontal frequencies, gated by a slow one.
     A single band gives evenly spaced runs of near-identical width — a comb,
     not runoff. Real staining is clustered: long clean stretches, then several
     streaks together where a coping joint leaks. */
  /* ## Runoff is a wash, not a set of drips
   *
   * Three things were wrong and together they read as melting paint: the
   * streaks were 20 cm wide (so a nine-metre wall carried dozens of them at
   * even spacing, like comb teeth), the threshold let most of the noise
   * through (so they were everywhere rather than occasional), and they decayed
   * over a 2.4 m half-life (so they ran the full height of the wall).
   *
   * Real staining under a coping is a broad, soft, low-contrast wash that is
   * strongest in the first metre or so and has faded out well before the
   * bottom, with only a few distinct runs where a joint actually leaks.
   */
  float streakN = surfFbm(vec2(fc.x * 2.6 * ds, fc.y * 0.14 * ds), uSeed * 5.0, 2);
  // The clustering gate is a single snoise rather than an fbm: it is only ever
  // read through a smoothstep, so the extra octaves were invisible and were
  // costing a measurable 8 fps across walls that fill a third of the screen.
  float streakWhere = smoothstep(-0.20, 0.34, snoise(vec3(fc.x * 0.55 * ds, fc.y * 0.05 * ds, uSeed * 8.3)));
  float streak = smoothstep(0.10, 0.54, streakN) * exp(-max(below - 0.25, 0.0) * 0.95);
  streak *= (1.0 - upFace) * streakWhere;
  float splash = exp(-above * 2.4);
  float dust = upFace * (0.35 + 0.4 * (fine * 0.5 + 0.5)); // settles on horizontals
  float grime = clamp(
    (streak * 0.55 + splash * 0.7 + dust * 0.5 + seam * 0.5 + groundSeam * 0.65) * uGrime,
    0.0, 1.0);

  /* ---- chipping, thresholded against the true distance to the arris ----
   *
   * Two scales, and the slow one is what makes this read as damage rather than
   * as a painted stripe. A single noise threshold against the edge distance
   * produces a chip *everywhere* along every arris — a continuous ribbon of
   * exposed aggregate outlining the object, which is exactly what this was
   * doing. Real chipping is occasional: long intact runs of arris with the
   * occasional knock taken out of it. The slow band gates the fast one so most
   * of the edge is untouched, and the bite itself is 1-3 cm, not 10.
   *
   * Seams get chipped far harder than plain arrises, which is the whole point:
   * it is the transition that has to stop reading as a drawn line.
   */
  float chipWhere = smoothstep(0.04, 0.30, coarse * 0.6 + blotch * 0.5 + 0.25);
  chipWhere = clamp(chipWhere + seam * 0.45 + groundSeam * 0.55, 0.0, 1.0);
  float chipN  = snoise(vec3(fc * 9.0 * ds, uSeed * 3.3)) * 0.5 + 0.5;
  float chipCut = (0.004 + chipN * chipN * 0.030) * uEdgeWear * chipWhere;
  float chipped = smoothstep(0.0, 0.012, edge - chipCut); // 0 = material gone
  float arris = (1.0 - smoothstep(0.0, 0.030, edge)) * uEdgeWear;

  metal = -1.0; // sentinel: leave the material's own metalness alone

  if (uKind < 0.5) {
    /* =================== stone: plaster over blockwork ================== */
    float courseH = uCourse;
    float blockW  = uCourse * 2.05;
    float row  = floor(fc.y / courseH);
    float rowF = fract(fc.y / courseH);
    float u    = fc.x / blockW + fract(row * 0.5);
    float col  = floor(u);
    float colF = fract(u);
    float bh   = hash13(vec3(col, row, uSeed));
    float bh2  = hash13(vec3(col * 1.7, row * 2.3, uSeed + 3.0));

    // Joints widen to a pixel at range for the same reason the patch edges do:
    // a 3 cm mortar line seen from 40 m is a quarter of a pixel, and a
    // sub-pixel smoothstep aliases into a shimmering moire across a big wall.
    // Derivatives are taken of the *un-wrapped* coordinates: fwidth of a
    // fract() spikes to ~1 on the wrap line, which would blow one column of
    // joints wide open on every wall.
    float joint = 0.030;
    float jwx = max(joint / blockW,  fwidth(u)      * 1.1);
    float jwy = max(joint / courseH, fwidth(fc.y / courseH) * 1.1);
    float jx = smoothstep(0.0, jwx, min(colF, 1.0 - colF));
    float jy = smoothstep(0.0, jwy, min(rowF, 1.0 - rowF));
    float blockM = mix(1.0, jx * jy, surfLod(courseH, texel));

    /* Plaster survives in patches. It fails from the bottom up (rising damp)
       and from the corners in, which is exactly where it fails on a real
       building — so the pattern reads as decay rather than as noise.

       ## The threshold has to sit inside the noise's actual range

       This is where the first version quietly did nothing. surfFbm returns a
       *normalised* fbm, so lossN lands in roughly 0.25-0.75 rather than 0-1,
       and the old expression added a constant 0.34 before a smoothstep whose
       edges were 0.0 and 0.10. Every sample cleared the upper edge, the mask
       was 1.0 across the entire wall, and the blockwork branch below was dead
       code everywhere except within a few centimetres of a seam. The wall was
       one uniform stucco, which is exactly the flatness this was written to
       cure — and it looked plausible enough that only the histogram found it.

       Now the survival threshold is compared directly against the noise on its
       own scale, and the smoothstep width is what plaster edges are: a hard
       lip, a few centimetres of ragged margin. */
    /* ## Render fails by the block, not by the blob
     *
     * This is the piece that took several attempts to get right, and the reason
     * is that the obvious implementation is wrong in a way that still looks
     * busy. Thresholding a smooth noise field against a constant gives patches
     * whose boundaries are smooth curves — puddles with a cartoon outline. No
     * amount of extra octaves fixes it, because the *topology* is wrong: the
     * boundary has no relationship to the wall it is on.
     *
     * What actually happens is that render keys mechanically into the mortar
     * joints, so it comes away in block-sized sheets. The unit of failure is a
     * block. So the field is sampled at the *centre of each block* and gets a
     * per-block coin flip: every block is then wholly rendered or wholly bare,
     * the slow field makes neighbouring blocks agree so damage comes in
     * passages rather than as a checkerboard, and a small high-frequency term
     * evaluated at the true position ravels the edges so they are not
     * mechanically straight.
     *
     * The result steps along the courses, which is what a photograph of a
     * failing rendered wall shows and what none of the noise-only versions
     * managed.
     *
     * ## The per-block coin flip has to be weak
     *
     * This is the knob that decides whether the wall reads as masonry or as a
     * quilt. At plus/minus 0.26 every block flipped independently and the wall
     * became a chequerboard of light and dark rectangles — a patchwork, which
     * is if anything a worse tell than the flat cream it replaced. The slow
     * field has to dominate so that *neighbours agree*: damage arrives as a
     * passage of several adjacent blocks, with the per-block term only ragging
     * its boundary and occasionally taking out a lone block in the middle of
     * sound render, which is what real spalling looks like. */
    /* Quantise to a *patch* of several blocks, not to one block.
     *
     * Sampling the field per block still gives a decision per rectangle, and at
     * this frequency neighbouring blocks disagree often enough that the wall
     * reads as digital camouflage: two-tone rectangles the size of a block,
     * evenly distributed. Real render comes away in sheets covering several
     * courses at once. Dividing the quantised coordinate first makes the unit
     * of failure a group of roughly 3x2 blocks, which is what turns the pattern
     * from camouflage into masonry. */
    vec2 fcQ = vec2((col + 0.5 - fract(row * 0.5)) * blockW, (row + 0.5) * courseH);
    float lossN = surfFbm(fcQ * 0.17 * ds, uSeed * 2.1 + 4.0, 2) * 2.3;
    lossN += (hash13(vec3(floor(col / 3.0), floor(row / 2.0), uSeed + 41.0)) - 0.5) * 0.30;
    lossN += (hash13(vec3(col, row, uSeed + 41.0)) - 0.5) * 0.10;
    /* ## Keep the ragged term below the mask width
     *
     * This exists to stop patch boundaries running mechanically along the
     * courses. At 0.16 it was wider than the smoothstep deciding the mask, so
     * it did not rag the edges — it *created* its own islands: thin isolated
     * slivers of surviving render scattered over the exposed block, each drawn
     * with the dark lip around it. Close up that read as a mess of dark worms
     * crawling over the brick. At 0.06 it perturbs a boundary without ever
     * carrying it across the threshold on its own.
     */
    lossN += surfFbm(fc * 7.5 * ds, uSeed * 2.1 + 9.0, 2) * 0.06;

    /* ## This term has to be tiny
     *
     * The joint is where render first lets go, so biasing the threshold by the
     * joint mask is right in principle. But the mask swings a full 0-1 across a
     * 3 cm line, and at 0.14 that swing was twice the width of the smoothstep
     * deciding plaster-or-block — so the *joints themselves* flipped the mask,
     * and every wall came out with a plaster/block boundary tracked exactly
     * around every single block. Close up that reads as embossed cartoon
     * brickwork with a bevel on each stone, which is what the impact shot was
     * showing: the joint pattern was being drawn twice, once as relief and once
     * as a material change.
     *
     * At 0.03 it does what it was meant to: nudges blocks already near the
     * threshold over it, without ever deciding the outcome on its own. */
    lossN += (blockM - 0.5) * 0.03;

    /* ## Damage is clustered, not evenly sprinkled
     *
     * An unmodulated threshold spreads patches at a constant density over every
     * surface in the level, which is the signature of a procedural texture
     * rather than of a building: it reads as camouflage. Real decay is local —
     * one bay is ruined, the next is nearly sound — so a slow field biases the
     * threshold, giving whole passages of intact render between the damaged
     * ones. That contrast is what makes the damaged parts read as damage. */
    // Reuses the blotch band rather than sampling a fourth slow field: both
    // are metre-scale and read only through a threshold, so a second one was
    // a full snoise for no visible difference.
    lossN += blotch * 0.30;
    float bias = 0.12 * exp(-above * 0.9)
               + 0.10 * exp(-max(edge - 0.05, 0.0) * 5.0)
               + 0.20 * seam           // render lifts at every material join
               + 0.18 * groundSeam;    // ... and worst of all at the floor
    // uPlaster 1 keeps almost all of it, 0 strips almost all of it, and the
    // interesting values in between actually vary across a wall.
    float keep = mix(0.30, -0.30, uPlaster) + bias;

    /* ## The edge width has to be at least a pixel
     *
     * A fixed 0.035 threshold width is fine close up and is *sub-pixel* at
     * range, so the patch boundary became a hard binary edge that crawled and
     * stair-stepped — the 'stencil' look. Widening the smoothstep to at least
     * one screen derivative of the field itself is the standard analytic
     * antialias: the transition is always about a pixel wide however far away
     * the wall is, so it resolves cleanly without the geometry MSAA (which
     * never sees an in-shader edge) having to help. */
    float lossW = max(0.030, fwidth(lossN) * 0.9);
    float plaster = clamp(smoothstep(keep - lossW, keep + lossW, lossN), 0.0, 1.0);

    /* ## Fade the patch *contrast*, not the patch mask
     *
     * Close up, the spalling is the best thing on these walls. At 30 m it was
     * the worst thing in the entire project: the patches quantise to the block
     * grid, so once a block is only a few pixels across the boundary becomes a
     * literal staircase, and the mid-ground walls read as Minecraft terrain.
     *
     * Pushing the *mask* toward 1 with distance does not fix it, because the
     * region still in transition draws exactly those stepped edges — it just
     * moves the problem further away.
     *
     * The fix is to fade what the mask *selects between*. Where the two layers
     * are the same colour, no boundary can be visible however stepped the mask
     * is, and the surface degrades gracefully into plain sandstone with its
     * coursing — which is precisely what a real wall looks like at that
     * distance once air and acuity have washed the contrast out. Handled below,
     * where the block colour is blended toward the render colour.
     *
     * The thresholds are in metres-per-pixel and this scene's camera gives
     * 1.04 mrad per pixel, so 0.026 is about 25 m and 0.075 is about 72 m. That
     * band matters: at 0.010 (under 10 m) the fade was reaching the *near*
     * walls and stripping the spalling out of the whole level, which traded one
     * artefact for the loss of the feature.
     */
    float patchFade = smoothstep(0.026, 0.075, texel);

    /* ## The relief edge must be wider than the colour edge
     *
     * These two want opposite things and using one mask for both is what was
     * scattering black pixels along every patch boundary.
     *
     * The *colour* boundary should be as sharp as the screen can show — one
     * pixel, antialiased. But feeding that same one-pixel ramp to the height
     * field means the full 1.4 cm thickness of the render is climbed inside a
     * single pixel, and since the normal is read from the screen derivative of
     * the height, one pixel of run against 1.4 cm of rise is a near-vertical
     * face. Grazing sun then shades it black, at every patch edge, everywhere.
     *
     * So the height uses its own deliberately wider ramp. Physically this is
     * the correct shape anyway: the lip of a spall is a chamfer a few
     * centimetres across, not a knife edge. */
    float reliefW = max(0.10, lossW * 2.5);
    float plasterSoft = clamp(smoothstep(keep - reliefW, keep + reliefW, lossN), 0.0, 1.0);

    /* ---- relief ----
     *
     * ## Why the grit is not in here
     *
     * It was, and it was the single worst artefact on these walls: a hash-grid
     * speckle has a *discontinuous* derivative, and this shader reads its normal
     * out of dFdx of the height. Feeding a step function to a derivative gives
     * a full-amplitude spike at every cell boundary, so 1 cm aggregate turned
     * into 10 cm lumps and the plaster read as cottage cheese. Aggregate belongs
     * in the albedo and the roughness, where it is *seen* rather than *lit* —
     * which is also how it works on a real wall at any distance past arm's
     * length. Everything left in the height field here is band-limited noise.
     *
     * The amplitudes are slopes, not depths: fine spans 14 cm, so 1.5 mm of
     * relief on it is a 1% gradient, which is about what troweled lime has.
     */
    /* ## Two numbers that were making cartoon brick
     *
     * A 2.6 cm joint recess plus a 1 cm per-block height jitter gives every
     * block a pronounced bevel all round and a domed face — a pillowed,
     * moulded-plastic brick, which is exactly what the close-range impact shot
     * was showing. Real coursed masonry is nearly flush: the mortar sits maybe
     * 8 mm back and the block faces are within a couple of millimetres of each
     * other. The joint reads through *colour and occlusion*, which this shader
     * already does, far more than through depth.
     *
     * The plaster in turn needed the opposite treatment. Its relief was all at
     * half-metre-and-up scale, so intact render at 6 m was a featureless soft
     * gradient with nothing for the eye to catch. The fine band is now a real
     * stipple: 9 cm features at 3.5 mm, which is a 4% slope and reads as
     * troweled lime rather than as paint.
     */
    float hBlock  = (blockM - 1.0) * 0.008 + (bh - 0.5) * 0.003 * blockM;
    float hSkin   = fine * 0.0035 + coarse * 0.005 + blotch * 0.012;
    // assigned below, once the patch lip is known

    /* ---- colour ----
     *
     * ## Exposed brick is not a dark hole
     *
     * The block under a failed patch has to read as a *material* — a warm,
     * slightly redder, slightly darker masonry with visible courses. When it was
     * mixed toward the shade colour it came out near-black, and every spall
     * looked like a hole punched through the wall rather than like brickwork
     * showing. The value gap between intact render and exposed block on a real
     * building is maybe 25%, not 70%. The mortar between the blocks is the
     * *lighter* element, which is also the opposite of how it started.
     */
    /* Lime mortar is warm, not blue. It was mixing toward uColA, which is the
       *plaster* colour and the palest thing in the family; against the darker
       brick that read as a cool blue-grey lattice, and a blue grid on a warm
       wall is one of the loudest possible tells. Biased warm and kept close in
       value to the block it beds. */
    vec3 mortar = mix(uColB, uColA, 0.30) * (0.96 + 0.10 * bh2);
    mortar *= vec3(1.05, 1.0, 0.90);
    /* Block-to-block variation, held to a few percent. Real ashlar out of one
     * quarry is *nearly* uniform — the variation is what you notice on second
     * look, not what you see first. At 18% the courses read as a mosaic of
     * deliberately different stones, which is a stylisation, not realism.
     *
     * The mix toward uColDeep is also small on purpose. Exposed block is only
     * about 20% darker than the render over it; at a 40% gap the two layers
     * read as two unrelated colours stencilled together, which is the other
     * half of what was making these walls look like camouflage. */
    vec3 stone  = mix(uColB, uColDeep, 0.10 + bh * 0.13);
    stone *= 0.99 + (bh2 - 0.5) * 0.09;
    // Blocks differ in hue as well as value — they came out of different beds.
    // Kept to a few percent: any more and masonry reads as a mosaic.
    stone *= vec3(1.0 + (bh - 0.5) * 0.05, 1.0, 1.0 - (bh - 0.5) * 0.06);
    // The block face needs its own grain, or an exposed patch is a flat brown
    // rectangle sitting next to beautifully stippled plaster — which is a worse
    // look than no exposed block at all. Cut sandstone is coarser than render,
    // so it gets the same bands at greater amplitude.
    stone *= 1.0 + coarse * 0.11 + fine * 0.14 + grit * 0.30;
    stone  = mix(mortar, stone, blockM);

    /* The render itself varies at metre scale, which is what stops a big wall
     * from being one value with noise sprinkled on it.
     *
     * The mix is deliberately *gentle* and the dark end is only reached at the
     * extreme of the noise. Driving it symmetrically between two well-separated
     * colours produced round dark islands — the wall read as a leopard rather
     * than as weathered lime, because real patina is a slow gradient with the
     * occasional dark passage, not a two-tone field. Most of the wall now sits
     * between the mid and the pale, and only the tail goes dirty. */
    float wash = clamp(blotch * 1.9 + 0.5, 0.0, 1.0);
    vec3 skin = mix(uColB, uColA, smoothstep(0.10, 0.92, wash));
    skin = mix(skin, mix(uColDark, uColB, 0.45), smoothstep(0.34, 0.0, wash) * 0.7);
    /* The high-frequency bands carry most of the close-range read. Weak values
     * here are why intact plaster looked like flat painted card from two metres
     * away — all the variation was at metre scale, and there was nothing at
     * hand scale for the eye to resolve as a surface. */
    skin *= 1.0 + coarse * 0.14 + fine * 0.15 + grit * 0.26;
    // Lime render is faintly mottled in hue as well as value: it carbonates
    // unevenly. A couple of percent is enough and is the difference between a
    // surface and a swatch.
    skin *= vec3(1.0 + coarse * 0.035, 1.0, 1.0 - coarse * 0.045);

    // Converge the two layers with distance — see the patch fade above. At range
    // the exposed block keeps only a hint of its own colour, so the stepped
    // mask boundary has almost nothing to draw with.
    stone = mix(stone, skin, patchFade * 0.88);
    albedo = mix(stone, skin, plaster);

    /* ---- the lip of a patch ----
     *
     * A spall is not a flat stencil. The render is 1-2 cm thick, so the edge of
     * a surviving patch is a small cliff: its own thickness shades the block
     * just inside the boundary, and the arris of the lip catches the sun. That
     * narrow band is the entire difference between "plaster over brick" and
     * "two textures cross-faded", which is what the first pass looked like.
     */
    float lip = smoothstep(0.0, 0.30, plaster) * (1.0 - smoothstep(0.30, 0.72, plaster));
    // The cut edge of the render is a fresh, pale break — lime that has never
    // been weathered — with the block shaded immediately under it. Both halves
    // matter: without the bright arris the patch reads as a flat camouflage
    // blob rather than as a layer with thickness.
    // Both lip terms fade with the same distance factor: they are the highest
    // contrast thing on the patch boundary, so they alias hardest.
    float lipFade = 1.0 - patchFade;
    albedo = mix(albedo, albedo * 0.74, lip * 0.55 * lipFade);
    albedo = mix(albedo, uColA * 1.06, smoothstep(0.62, 0.86, plaster) * 0.22 * lipFade);

    /* under a chip: raw aggregate */
    albedo = mix(mix(uColDeep, uColDark, 0.45) * (0.85 + 0.35 * chipN), albedo, chipped);
    albedo = mix(albedo, albedo * 1.16 + 0.02, arris * chipped * 0.45);

    rough = uRough + (1.0 - plaster) * 0.05 + grit * 0.09 - grime * 0.10;

    /* ---- occlusion ----
     *
     * ## The joints must be masked by the plaster
     *
     * This was the loudest remaining artefact: the mortar-joint occlusion was
     * applied unconditionally, so the course grid was darkening *through* fully
     * intact render. A wall showed a complete, evenly-spaced brick lattice with
     * stucco blobs floating on top of it — the exact opposite of the real thing,
     * where the courses are only visible where the render has gone. Gating it on
     * the same mask that picks the albedo is what makes the two layers agree.
     */
    ao = mix(1.0, mix(1.0 - 0.5 * uAOAmt, 1.0, blockM * 0.6 + 0.4), 1.0 - plaster);
    ao *= mix(1.0 - 0.36 * uAOAmt, 1.0, chipped);
    ao *= 1.0 - lip * 0.30 * uAOAmt * lipFade;
    // The relief has to be masked for the same reason, or the normal keeps
    // drawing joints the albedo has already covered over.
    // Driven by the soft mask, so the render's own thickness is climbed over a
    // few centimetres of chamfer rather than inside one pixel.
    height = mix(hBlock, hSkin + 0.014, plasterSoft);

  } else if (uKind < 1.5) {
    /* ========================== sawn timber ============================ */
    float plankH = uCourse;
    float pRow = floor(fc.y / plankH);
    float pF   = fract(fc.y / plankH);
    float ph   = hash13(vec3(pRow, 7.0, uSeed));
    float gapM = mix(1.0, smoothstep(0.0, 0.055, min(pF, 1.0 - pF)), surfLod(plankH, texel));

    /* Grain is noise stretched hard *along* the plank. Getting the anisotropy
       backwards is what makes game wood read as marble. */
    float grain = surfFbm(vec2(fc.x * 1.5 * ds, fc.y * 22.0 * ds + ph * 60.0), uSeed, 3);
    float rings = sin(fc.y * 26.0 * ds + grain * 4.5 + ph * 30.0) * 0.5 + 0.5;
    float split = smoothstep(0.72, 0.98, abs(grain)); // checked/split fibres

    /* Nails, clustered toward the ends of the planks where they actually are */
    float nx = fract(fc.x / 0.46 + ph * 0.7) - 0.5;
    float nd = length(vec2(nx * 0.46, (pF - 0.5) * plankH));
    float nail = (1.0 - smoothstep(0.009, 0.015, nd)) *
                 (1.0 - smoothstep(0.10, 0.55, edge));

    height = (gapM - 1.0) * 0.020 + rings * 0.004 + grain * 0.003 - split * 0.010;
    height += nail * 0.004;

    vec3 wood = mix(uColB, uColDark, rings * 0.62 + (1.0 - grain) * 0.14);
    wood *= 0.86 + 0.30 * ph;
    wood *= vec3(1.0 + (ph - 0.5) * 0.08, 1.0, 1.0 - (ph - 0.5) * 0.10);
    /* Sun-bleached silver on the up-facing and exposed timber */
    wood = mix(wood, mix(wood, uColA, 0.55), (upFace * 0.6 + arris * 0.5) * uEdgeWear);
    wood = mix(uColDeep, wood, gapM);
    albedo = mix(uColDeep * 0.9, wood, chipped);
    albedo = mix(albedo, vec3(0.30, 0.29, 0.27), nail * 0.85);

    rough = uRough + split * 0.12 - rings * 0.06 - nail * 0.35 + grit * 0.05;
    metal = nail * 0.7;
    ao = mix(1.0 - 0.45 * uAOAmt, 1.0, gapM);
    ao *= mix(1.0 - 0.3 * uAOAmt, 1.0, chipped);

  } else {
    /* ====================== painted, rusting steel ===================== */
    float rib = fc.x / uCourse;
    float ribF = abs(fract(rib) - 0.5) * 2.0;
    float ribM = smoothstep(0.25, 0.75, ribF);
    float ribFade = surfLod(uCourse, texel);
    height = mix(0.0, (ribM - 0.5) * 0.045, ribFade);

    /* Rust starts at the ribs, the base and the corners, and bleeds down. */
    float rustN = surfFbm(fc * 1.9 * ds, uSeed * 4.1, 3) * 0.5 + 0.5;
    float rustBias = 0.34 * exp(-above * 1.5)
                   + 0.30 * exp(-max(edge - 0.03, 0.0) * 6.0)
                   + 0.16 * (1.0 - ribM);
    float rust = smoothstep(0.44, 0.80, rustN + rustBias + streak * 0.30);
    float blister = smoothstep(0.55, 0.9, surfFbm(fc * 12.0 * ds, uSeed * 6.0, 2) * 0.5 + 0.5);

    vec3 paint = uColB * (0.90 + 0.22 * (coarse * 0.5 + 0.5));
    paint *= 0.88 + 0.26 * oid;
    paint = mix(paint, uColDark, (1.0 - ribM) * 0.25);
    albedo = mix(paint, uColDeep * (0.8 + 0.5 * rustN), rust);
    albedo = mix(albedo, uColDeep * 0.7, (1.0 - chipped) * 0.85);
    albedo = mix(albedo, albedo * 1.18, arris * 0.4);
    height += rust * blister * 0.006 - (1.0 - chipped) * 0.006;

    rough = uRough + rust * 0.34 + blister * rust * 0.12 + grit * 0.05;
    metal = mix(1.0, 0.18, rust * 0.9);
    ao = mix(1.0 - 0.28 * uAOAmt, 1.0, ribM * 0.5 + 0.5);
  }

  /* ================== everything that applies to all kinds ============= */

  /* Per-object colour drift. Real cover is salvage: no two pieces came out of
     the same batch, and holding them all at one value is the flattest thing a
     renderer can do. */
  albedo *= mix(0.84, 1.16, oid);
  albedo *= vec3(1.0 + (oid2 - 0.5) * 0.13, 1.0 + (oid - 0.5) * 0.04, 1.0 - (oid2 - 0.5) * 0.15);

  // Grime *darkens and desaturates* what is underneath; it does not replace it
  // with an opaque colour. Mixing 62% of the way to a flat dark brown was what
  // made these streaks read as paint running down the wall rather than as
  // dirt in it. Multiplying keeps the surface's own material visible through
  // the stain, which is what a photograph of a dirty wall shows.
  vec3 stained = albedo * mix(vec3(1.0), uColGrime * 2.4, 0.55);
  albedo = mix(albedo, stained, grime * 0.8);

  /* ---- contact darkening ----
   *
   * The crate meeting the floor, the wall meeting the ground. Without it
   * nothing reads as resting on anything.
   *
   * ## The band has to be short, and it has to be capped
   *
   * It was 62 cm deep at 62% strength, which is fine on a nine-metre wall and
   * catastrophic on a 95 cm plinth: two thirds of the object was inside the
   * band, and it stacked multiplicatively with the splash grime (which peaks at
   * the same place) and with the darker palette those low parts use. The
   * plinths, kerbs and rubble came out near-black — reading as holes cut in the
   * floor rather than as the stone the walls stand on.
   *
   * A real contact shadow is *tight*: the darkening is concentrated in the
   * first ten or twenty centimetres, which is also what makes it read as
   * contact rather than as a gradient. Shorter and stronger at the line, gone
   * by knee height, and floored so the stack can never reach black.
   */
  float contact = mix(1.0 - 0.55 * uAOAmt, 1.0, smoothstep(0.0, 0.26, above));
  contact *= mix(1.0 - 0.18 * uAOAmt, 1.0, smoothstep(0.0, 0.22, below));
  ao *= contact;
  ao = max(ao, 0.30);

  rough = clamp(rough, 0.12, 1.0);
  ao = clamp(ao, 0.0, 1.0);

  /* ---- relief LOD ----
   *
   * ## Why the bump has to fade with distance
   *
   * The normal here is read out of dFdx of the height, so its magnitude is the
   * height *step per pixel*, not per metre. A 2 cm plaster lip crossed over
   * half a metre is a gentle slope; the same 2 cm crossed inside one pixel — a
   * wall 40 m away, where a pixel covers 4 cm — is a cliff, and the derivative
   * reports a near-vertical surface. That is what was scattering black dots
   * along every patch boundary and every mortar joint on the far walls, and no
   * amount of clamping fixes it because the input really is that steep.
   *
   * The answer is the same one mipmapping uses: once a feature is smaller than
   * a pixel it should stop contributing to shading and survive only in the
   * albedo, where it averages instead of aliasing. Relief here is authored at
   * 1-4 cm, so it fades out between roughly 15 m and 45 m — beyond which the
   * walls are carried by their colour, which is exactly how they read in a
   * photograph anyway.
   */
  height *= uBump * (1.0 - smoothstep(0.018, 0.055, texel));
}
`;

const SURFACE_VERTEX_PARS = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aHalf;
attribute float aRot;
varying vec3 vSurfW;
varying vec3 vSurfN;
varying vec3 vSurfC;
varying vec3 vSurfH;
varying float vSurfR;
`;

const SURFACE_VERTEX_BODY = /* glsl */ `
  vSurfW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vSurfN = normalize(mat3(modelMatrix) * objectNormal);
  vSurfC = (modelMatrix * vec4(aCenter, 1.0)).xyz;
  vSurfH = aHalf;
  vSurfR = aRot;
`;

/* The one shared program key: every arena surface compiles once. */
const SURFACE_CACHE_KEY = 'arena-surface-v1';

function surfacePatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${SURFACE_VERTEX_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SURFACE_VERTEX_BODY}`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${SURFACE_PARS}`)
    .replace(
      '#include <map_fragment>',
      /* glsl */ `
      vec3  surfAlbedo;
      float surfRough;
      float surfMetal;
      float surfAO;
      float surfHeight;
      arenaSurface(vSurfW, normalize(vSurfN), vSurfC, vSurfH, vSurfR,
                   surfAlbedo, surfRough, surfMetal, surfAO, surfHeight);
      diffuseColor.rgb *= surfAlbedo;
      float surfDhdx = dFdx(surfHeight);
      float surfDhdy = dFdy(surfHeight);
      vec3  surfDpdx = dFdx(vSurfW);
      vec3  surfDpdy = dFdy(vSurfW);
      `
    )
    .replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n  roughnessFactor = surfRough;'
    )
    .replace(
      '#include <metalnessmap_fragment>',
      '#include <metalnessmap_fragment>\n  if (surfMetal >= 0.0) metalnessFactor = surfMetal;'
    )
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>
      {
        // Mikkelsen's derivative bump: build the surface gradient from the
        // screen-space derivatives of one height sample rather than from three
        // extra taps of the noise. Same result, a third of the cost.
        vec3 wn = normalize(vSurfN);
        vec3 r1 = cross(surfDpdy, wn);
        vec3 r2 = cross(wn, surfDpdx);
        float det = dot(surfDpdx, r1);
        vec3 grad = sign(det) * (surfDhdx * r1 + surfDhdy * r2);

        // ## The gradient has to be clamped
        //
        // This is the failure mode of derivative bump mapping, and it was
        // visible as a rash of black speckle along every plaster patch edge and
        // every mortar joint. The height field has genuine cliffs in it — the
        // 2 cm lip where the render has spalled, the recess of a joint — and a
        // cliff crossed inside one 2x2 quad gives a derivative bounded only by
        // the step size. The resulting gradient dwarfs 'det', the normal tips
        // past 90 degrees from the true surface, and the fragment shades as if
        // it faced away from the sun: a black dot.
        //
        // Limiting the gradient to a multiple of det caps how far the normal
        // can ever be tilted (here about 76 degrees). Detail below that is
        // untouched; only the pixels that were producing garbage change.
        // 1.0 = at most a 45 degree tilt. Real plaster and masonry relief is
        // nowhere near that steep, so nothing legitimate is being limited; 4.0
        // still left enough overshoot for grazing sun to produce black pixels
        // along the patch lips.
        float scale = abs(det);
        float gl = length(grad);
        float glMax = scale * 1.0;
        if (gl > glMax) grad *= glMax / max(gl, 1e-8);

        vec3 bumped = normalize(scale * wn - grad);
        // back to view space, which is where three does its shading
        normal = normalize(mat3(viewMatrix) * bumped);
      }
      `
    )
    .replace(
      '#include <aomap_fragment>',
      /* glsl */ `
      #include <aomap_fragment>
      /* ## Occluded surfaces go blue, and they should not
       *
       * The fill in this scene is a hemisphere: blue from the sky, warm from
       * the ground. Occlusion scales that fill uniformly, so a crevice keeps
       * the *same* sky-to-ground ratio as an open face while losing brightness
       * — and once the warm sun is subtracted too, what is left in a mortar
       * joint is almost pure sky blue. That is why the joints on a warm
       * sandstone wall were reading as cold blue lines, which is one of the
       * most recognisable tells of a renderer with no bounce.
       *
       * In reality a crevice in a warm wall is lit almost entirely by the warm
       * wall around it: the deeper the occlusion, the *warmer* it gets, not the
       * bluer. Tinting the occluded fraction toward the surface's own albedo is
       * the cheap approximation of exactly that, and it is what a bounce
       * solution would produce.
       */
      vec3 surfCavity = mix(vec3(1.0), normalize(surfAlbedo + 0.001) * 1.55, 1.0 - surfAO);
      reflectedLight.indirectDiffuse *= surfAO * surfCavity;
      reflectedLight.indirectSpecular *= surfAO;
      // A slice of the occlusion on the direct term too. Not physical, but a
      // contact line that vanishes the moment the sun reaches it is the exact
      // failure that makes objects look pasted on, and every shipped shooter
      // cheats here for the same reason.
      //
      // Held at 0.20 rather than the 0.42 this started at. Occlusion belongs on
      // the *indirect* term, which is where the sky and the bounce come from;
      // multiplying it into the direct term as well was stacking with the
      // grade's black-point clamp and flattening the shadow faces into
      // silhouettes. 0.20 is enough to keep contact lines legible where the sun
      // does reach them without spending the shadow detail to get it.
      float surfDirectAO = mix(1.0, surfAO, 0.20);
      reflectedLight.directDiffuse *= surfDirectAO;
      reflectedLight.directSpecular *= surfDirectAO;
      `
    );
}

/**
 * Build one arena surface.
 *
 * @param {object} options
 * @returns {THREE.MeshStandardMaterial}
 */
export function createSurfaceMaterial(options = {}) {
  const a = settings.arena;
  const {
    kind = SURFACE_KIND.STONE,
    colA = a.colorSandLight,
    colB = a.colorSandMid,
    colDark = a.colorSandDark,
    colDeep = a.colorAccent,
    colGrime = a.colorGrime,
    plaster = 1.0,
    grime = 1.0,
    edgeWear = 1.0,
    detail = 1.0,
    bump = 1.0,
    aoAmount = 1.0,
    roughness = 0.86,
    metalness = 0.0,
    envMapIntensity = 0.6,
    course = 0.46,
    seed = 3.17,
    receiveShadow = true
  } = options;

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness,
    metalness,
    envMapIntensity
  });
  material.userData.arenaSurface = true;
  material.userData.receiveShadow = receiveShadow;

  const uniforms = {
    uColA: { value: getColor(colA).clone() },
    uColB: { value: getColor(colB).clone() },
    uColDark: { value: getColor(colDark).clone() },
    uColDeep: { value: getColor(colDeep).clone() },
    uColGrime: { value: getColor(colGrime).clone() },
    uKind: { value: kind },
    uPlaster: { value: plaster },
    uGrime: { value: grime * a.grime },
    uEdgeWear: { value: edgeWear * a.edgeWear },
    uDetail: { value: detail * a.detailScale },
    uBump: { value: bump * a.normalStrength },
    uAOAmt: { value: aoAmount * a.aoStrength },
    uRough: { value: roughness },
    uSeed: { value: seed },
    uCourse: { value: course }
  };
  material.userData.uniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      surfacePatch(shader);
    },
    SURFACE_CACHE_KEY
  );

  return material;
}

/* ------------------------------------------------------------------ */
/* The ground                                                          */
/* ------------------------------------------------------------------ */

const GROUND_CACHE_KEY = 'arena-ground-v1';

const GROUND_PARS = /* glsl */ `
uniform vec3  uGroundA;
uniform vec3  uGroundB;
uniform vec3  uGroundDust;
uniform float uTexScale;
uniform float uTexTint;
uniform float uTexMean;   // mean linear luminance of the rock photo
uniform float uGroundDetail;
uniform float uAOAmt;
uniform float uContactExtent;
uniform vec3  uBounce;      // warm light off the surrounding walls
uniform sampler2D uContactMap;
varying vec3 vGroundW;
`;

/**
 * The floor.
 *
 * The rock photograph is the best surface detail in the project, so it stays —
 * but it is a cold grey cathedral stone, and a cold grey floor under a hot
 * sandstone courtyard is what was pulling the whole frame toward neutral. So
 * the photo is used for its *structure* — its luminance carries the grain,
 * the pitting and the cracks — and its colour is re-tinted into the sand
 * palette, with `groundTexTint` deciding how much of the original chroma
 * survives. Two samples at incommensurate scales cancel the tiling, which at
 * a 3 m tile over an 84 m courtyard is otherwise the first thing you see.
 */
function groundPatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGroundW;')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vGroundW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${GROUND_PARS}`)
    .replace(
      '#include <map_fragment>',
      /* glsl */ `
      vec2 gw = vGroundW.xz;
      vec2 uvA = gw / uTexScale;
      vec2 uvB = gw / (uTexScale * 3.37) + vec2(0.37, 0.11);
      vec3 texA = texture2D(map, uvA).rgb;
      vec3 texB = texture2D(map, uvB).rgb;
      // Blend the two scales by a slow field: the large tile hides the small
      // tile's repeat without ever showing its own.
      float blendN = snoise(vec3(gw * 0.035, 4.0)) * 0.5 + 0.5;
      vec3 tex = mix(texA, texB, smoothstep(0.25, 0.75, blendN) * 0.5);

      float lum = dot(tex, vec3(0.299, 0.587, 0.114));

      // Which sand: two beds, drifting over each other at courtyard scale.
      float bed = snoise(vec3(gw * 0.055, 11.0)) * 0.5 + 0.5;
      float drift = fbm3(vec3(gw * 0.28, 21.0)) * 0.5 + 0.5;
      vec3 sand = mix(uGroundB, uGroundA, smoothstep(0.25, 0.8, bed * 0.65 + drift * 0.35));

      // ## The normalisation constant is not a taste value
      //
      // The photo is sampled through an sRGB texture, so what comes back is
      // *linear*, and its mean linear luminance is 0.074 — not the ~0.4 an sRGB
      // mid-grey looks like it should be. Dividing by 0.4 multiplied the whole
      // floor by 0.18 and was single-handedly responsible for the floor
      // measuring 18/255 when it should have been near 70. Normalising against
      // the real mean makes the ratio below a *shading term* centred on 1, so
      // the sand keeps its authored albedo and the photo only supplies relief.
      //
      // The exponent then compresses that ratio: raw it spans 0.3-3.3, which
      // would blow the highlights off every pebble.
      float shade = pow(max(lum, 1e-4) / uTexMean, 0.62);
      vec3 tinted = sand * shade;

      // "How much of the photo's own colour survives" means its *hue*, not its
      // level — mixing toward the raw sample re-introduced the grey it was
      // being tinted out of, and darkened it again on the way.
      vec3 chroma = tex / max(lum, 1e-4);
      vec3 base = tinted * mix(vec3(1.0), chroma, uTexTint);

      // Loose grit and gravel scattered on top of the bedrock.
      vec2 cell = floor(gw * 26.0);
      float grav = hash13(vec3(cell, 3.0));
      float gravFade = 1.0 - smoothstep(0.02, 0.09, max(fwidth(gw.x), fwidth(gw.y)));
      base *= 1.0 + (grav - 0.5) * 0.22 * gravFade * uGroundDetail;

      // Wind-blown dust in the lee of everything, plus the contact occlusion
      // baked from the real cover footprints.
      vec2 cuv = gw / (uContactExtent * 2.0) + 0.5;
      vec3 contact = texture2D(uContactMap, cuv).rgb;
      float groundAO = mix(1.0, contact.r, uAOAmt);
      base = mix(base, uGroundDust, contact.g * 0.55 * uGroundDetail);
      base *= mix(0.88, 1.10, contact.b);

      diffuseColor.rgb *= base;

      float groundRough = 0.94 - (lum - 0.4) * 0.22 + contact.g * 0.06;
      `
    )
    .replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(groundRough, 0.35, 1.0);'
    )
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      {
        // The normal map is authored for the photo's own UVs; drive it from the
        // world-space set instead so the relief follows what is actually drawn.
        vec3 mapNA = texture2D(normalMap, uvA).xyz * 2.0 - 1.0;
        mapNA.xy *= normalScale;
        vec3 wn = normalize(vec3(0.0, 1.0, 0.0));
        vec3 bumped = normalize(vec3(mapNA.x, mapNA.z, -mapNA.y));
        bumped = normalize(mix(wn, bumped, 0.9));
        normal = normalize(mat3(viewMatrix) * bumped);
      }
      `
    )
    .replace(
      '#include <aomap_fragment>',
      /* glsl */ `
      #include <aomap_fragment>
      reflectedLight.indirectDiffuse *= groundAO;
      reflectedLight.indirectSpecular *= groundAO;
      float gDirect = mix(1.0, groundAO, 0.5);
      reflectedLight.directDiffuse *= gDirect;
      reflectedLight.directSpecular *= gDirect;

      /* ---- courtyard bounce ----
       *
       * ## Why the floor was coming out blue
       *
       * A hemisphere light gives an up-facing surface 100% of its *sky* colour
       * and none of its ground colour — which is correct for a plain in the open
       * and badly wrong for the floor of an enclosed yard. Here the floor is
       * ringed by nine metres of sunlit sandstone, and in reality most of the
       * fill reaching it is warm light bounced off those walls, not blue light
       * from the zenith. Without that term the floor rendered cold blue-grey
       * under warm walls: two different places in one frame, and the loudest
       * remaining mismatch once the walls were fixed.
       *
       * A real bounce needs a GI solution. This is the same trick a baked
       * lightmap would arrive at for a courtyard — tint the floor's indirect
       * toward the colour of what surrounds it — for the cost of one multiply.
       */
      reflectedLight.indirectDiffuse *= uBounce;
      `
    );
}

export function createGroundMaterial(maps, contactMap, contactExtent) {
  const a = settings.arena;

  const material = new MeshStandardMaterial({
    map: maps.color,
    normalMap: maps.normal,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.55
  });

  const uniforms = {
    uGroundA: { value: getColor(a.colorGroundA).clone() },
    uGroundB: { value: getColor(a.colorGroundB).clone() },
    uGroundDust: { value: getColor(a.colorSandLight).clone() },
    uTexScale: { value: a.groundTexScale },
    uTexTint: { value: a.groundTexTint },
    uTexMean: { value: 0.074 },
    uGroundDetail: { value: a.groundDetail },
    uAOAmt: { value: a.aoStrength },
    uContactExtent: { value: contactExtent },
    // Warm, and above 1 on red so it *adds* warmth rather than just dimming
    // blue. Tuned so the floor's shadowed passages sit in the same colour
    // family as the walls above them.
    uBounce: { value: getColor('#efe0cd').clone() },
    uContactMap: { value: contactMap }
  };
  material.userData.uniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      groundPatch(shader);
    },
    GROUND_CACHE_KEY
  );

  return material;
}

/** Push live settings into every arena material. Called once per frame. */
export function syncSurfaceUniforms(materials) {
  const a = settings.arena;
  for (const material of materials) {
    const u = material.userData.uniforms;
    if (!u) continue;
    if (u.uGrime) u.uGrime.value = (material.userData.grimeScale ?? 1) * a.grime;
    if (u.uEdgeWear) u.uEdgeWear.value = (material.userData.wearScale ?? 1) * a.edgeWear;
    if (u.uDetail) u.uDetail.value = (material.userData.detailScale ?? 1) * a.detailScale;
    if (u.uBump) u.uBump.value = (material.userData.bumpScale ?? 1) * a.normalStrength;
    if (u.uAOAmt) u.uAOAmt.value = (material.userData.aoScale ?? 1) * a.aoStrength;
    if (u.uTexScale) u.uTexScale.value = a.groundTexScale;
    if (u.uTexTint) u.uTexTint.value = a.groundTexTint;
    if (u.uGroundDetail) u.uGroundDetail.value = a.groundDetail;
  }
}

/* ------------------------------------------------------------------ */
/* Baked contact occlusion                                             */
/* ------------------------------------------------------------------ */

/**
 * Bake the ground's contact map from the arena's own footprints.
 *
 * A crate that sits on a floor darkens the floor around it. Screen-space AO
 * would find that too, at the price of a full-resolution pass and the halo
 * artefacts every SSAO implementation has; but the arena is static and its
 * cover is known at load, so the honest answer is to bake it. Three channels:
 *
 *   R — occlusion. 1 in the open, falling toward the footprint edge, with the
 *       reach scaled by how tall the occluder is.
 *   G — debris and wind-blown dust piled against the base of things.
 *   B — a slow tone field so the floor is never one value across 130 metres.
 *
 * @param {{x:number,z:number,hx:number,hz:number,h:number}[]} footprints
 * @param {number} extent  half-width of the covered square, metres
 * @param {number} [size]  texture resolution
 */
export function bakeContactMap(footprints, extent, size = 1024) {
  const data = new Uint8Array(size * size * 4);
  const occ = new Float32Array(size * size).fill(1);
  const dust = new Float32Array(size * size);

  const worldPerTexel = (extent * 2) / size;
  const toTexel = (w) => (w + extent) / worldPerTexel;

  for (const f of footprints) {
    // Reach grows with height: a 6 m pillar shades far more floor than a crate.
    const reach = Math.min(2.6, 0.30 + f.h * 0.34);
    const strength = Math.min(0.82, 0.34 + f.h * 0.10);

    const x0 = Math.max(0, Math.floor(toTexel(f.x - f.hx - reach)));
    const x1 = Math.min(size - 1, Math.ceil(toTexel(f.x + f.hx + reach)));
    const z0 = Math.max(0, Math.floor(toTexel(f.z - f.hz - reach)));
    const z1 = Math.min(size - 1, Math.ceil(toTexel(f.z + f.hz + reach)));

    for (let j = z0; j <= z1; j++) {
      const wz = (j + 0.5) * worldPerTexel - extent;
      const dz = Math.max(0, Math.abs(wz - f.z) - f.hz);
      for (let i = x0; i <= x1; i++) {
        const wx = (i + 0.5) * worldPerTexel - extent;
        const dx = Math.max(0, Math.abs(wx - f.x) - f.hx);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > reach) continue;

        const t = 1 - d / reach;
        // Squared falloff: tight, dark contact line rather than a soft blob.
        const a = t * t * strength;
        const index = j * size + i;
        occ[index] *= 1 - a;
        const g = t * t * t * Math.min(1, 0.35 + f.h * 0.08);
        if (g > dust[index]) dust[index] = g;
      }
    }
  }

  // A slow tone field, so the floor is never a single value edge to edge.
  const toneScale = 0.055 * worldPerTexel;
  for (let j = 0, p = 0; j < size; j++) {
    for (let i = 0; i < size; i++, p += 4) {
      const index = j * size + i;
      const n =
        Math.sin(i * toneScale * 1.7 + 1.3) * 0.5 +
        Math.sin(j * toneScale * 1.1 - 2.1) * 0.35 +
        Math.sin((i + j) * toneScale * 0.6) * 0.3;
      data[p] = Math.round(Math.max(0, Math.min(1, occ[index])) * 255);
      data[p + 1] = Math.round(Math.max(0, Math.min(1, dust[index])) * 255);
      data[p + 2] = Math.round(Math.max(0, Math.min(1, n * 0.28 + 0.5)) * 255);
      data[p + 3] = 255;
    }
  }

  return data;
}

export const SURFACE_COLOR = Color;
