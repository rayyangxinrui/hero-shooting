/**
 * settings.js — the single source of truth for every tweakable value.
 *
 * Same contract as the ability sandbox this project grew out of: systems may
 * only ever *sample* these values, never snapshot one at spawn time and read it
 * back later. That is what lets the tuning UI reshape a spell that is already
 * in the air, and what lets a critic agent drive a value and re-screenshot
 * without a rebuild.
 *
 * The ability blocks (ice / thunder / meteor / beam / snare / glacier) are
 * inherited wholesale from the reference engine and re-exported below, so the
 * spell VFX keep their full tuning surface. What is new here is everything a
 * shooter needs: the player, the weapons, the monsters and the FPS camera.
 */

import { settings as castingSettings, CAST_ANIMATIONS } from './castingSettings.js';

export { CAST_ANIMATIONS, CastShape, ELEMENT_META, castShapeOf } from './castingSettings.js';

/** Ability ids, in bar order. */
export const ELEMENTS = ['thunder', 'ice', 'meteor', 'beam', 'snare', 'glacier'];

/** Weapon ids, in slot order. */
export const WEAPONS = ['rifle', 'smg', 'pistol'];

export const settings = {
  ...castingSettings,

  /* ================================================================== */
  /* Player — movement, stance and the feel of standing up                */
  /* ================================================================== */
  /**
   * Source-style movement, because that is what CS2's feel actually is: ground
   * acceleration is capped by a projection against current velocity, so
   * strafing while turning gains speed and holding W into a wall does not.
   */
  player: {
    height: 1.72, // eye height standing, metres
    crouchHeight: 1.06, // ... crouched
    radius: 0.42, // collision capsule radius, metres
    crouchTime: 0.14, // seconds to fully crouch
    mass: 80,

    walkSpeed: 3.1, // m/s while walking (shift)
    runSpeed: 5.6, // m/s baseline
    crouchSpeed: 1.9,
    airSpeed: 1.2, // how much control you keep in the air
    accelerate: 11.0, // ground acceleration, 1/s
    airAccelerate: 55.0, // air acceleration — high on purpose, it is capped by projection
    friction: 6.2, // ground friction, 1/s
    stopSpeed: 1.4, // below this, friction is applied at a floor value
    jumpVelocity: 5.05, // m/s, gives ~1.3 m of clearance
    gravity: -18.6, // m/s² — heavier than real, which is what game jumps use
    stepHeight: 0.42, // metres of ledge the capsule walks up without jumping

    /* --- what the body does to the camera --- */
    // Kept small. Every one of these reads as nausea at twice these values, and
    // CS2's own view punch is far subtler than people remember.
    bobAmount: 0.021, // metres the view bobs at a run
    bobSpeed: 10.4, // bobs/second at a run
    bobRoll: 0.55, // degrees of roll on the bob
    landPunch: 0.085, // metres the view dips on landing
    landPunchHeavy: 0.2, // ... after a long fall
    strafeRoll: 0.85, // degrees the view banks into a strafe
    strafeRollSpeed: 7.0, // how fast it banks
    stepInterval: 2.1, // metres between footsteps at a run

    /* --- looking --- */
    sensitivity: 0.0022, // radians per pixel of mouse movement
    zoomSensitivity: 0.72, // multiplier while aiming down sights
    maxPitch: 1.5533, // 89°, in radians
    fov: 90, // degrees, horizontal-ish (three uses vertical, converted at build)
    fovSprint: 96, // fov while sprinting, degrees
    fovLerp: 9.0, // 1/s the fov chases its target

    maxHealth: 100,
    maxArmor: 100,
    maxMana: 100,
    manaRegen: 7.5, // per second
    manaRegenDelay: 1.1 // seconds after a cast before regen resumes
  },

  /* ================================================================== */
  /* Weapons                                                             */
  /* ================================================================== */
  /**
   * The numbers are CS2/CoD-adjacent on purpose: 600 RPM is an AK, first-shot
   * accuracy is perfect and the spray pattern is a *fixed* curve with a small
   * random cone around it, which is the thing that makes a shooter feel learned
   * rather than random.
   */
  weapons: {
    /**
     * Where the viewmodel sits, metres, in view space.
     *
     * `z` is the important one and it is *not* a taste value. The weapon models
     * are authored at true scale — the rifle is 85 cm from butt to muzzle — so
     * an offset of only -0.34 m puts the stock about 2.5 cm from the eye, where
     * it subtends most of the screen and reads as an enormous slab rather than
     * as a rifle. Pushing the whole weapon forward to -0.5 m puts the butt about
     * 25 cm away, which is roughly where a shouldered rifle's stock actually is
     * relative to the shooting eye, and the gun snaps into a believable size.
     *
     * `viewmodelScale` then trims it slightly under true scale, which is what
     * every shipped shooter does: a 1:1 rifle still crowds the frame at any
     * usable fov, so the model is shrunk a little and the muzzle kept forward.
     */
    viewmodelPos: { x: 0.155, y: -0.125, z: -0.42 },
    // The ADS pose is *solved*, not authored: `WeaponSystem.solveAdsOffsets`
    // places each weapon so its own rear sight lands on the crosshair, using
    // `adsEyeRelief` below. What is left here is only the residual nudge — the
    // small drop that keeps the receiver from covering the aperture. Authoring
    // an absolute position here instead would break the moment a weapon's sight
    // geometry moved.
    viewmodelAdsPos: { x: 0.0, y: -0.014, z: -0.3 },
    viewmodelScale: 0.8,
    /**
     * How far the *rear sight* sits from the eye when aiming, metres.
     *
     * Read by `WeaponSystem.solveAdsOffsets`, which places each weapon so its
     * own sight line lands on the crosshair — so this is the one number that
     * decides the sight picture for every weapon at once. 22 cm is roughly what
     * a real cheek weld gives you, and it is what keeps the front post small
     * enough to aim with rather than a wall of steel filling the aperture.
     *
     * This was previously read but never defined, which made every weapon's ADS
     * z-offset NaN and silently broke aiming entirely.
     */
    adsEyeRelief: 0.22,
    viewmodelFov: 62, // the viewmodel is rendered with its own narrower fov
    adsTime: 0.16, // seconds to raise into sights
    sway: 0.022, // how far the gun lags behind the look, metres
    swaySpeed: 11.0, // how fast it catches up
    bobScale: 1.0, // multiplier on the movement bob applied to the gun
    lowerOnSprint: 0.42 // radians the gun is dropped while sprinting
  },

  rifle: {
    name: 'VK-74',
    slot: 0,
    rpm: 600, // rounds/minute
    damage: 36,
    headshotMultiplier: 4.0,
    armorPenetration: 0.775,
    falloffStart: 26, // metres before damage begins to drop
    falloffEnd: 78,
    falloffMin: 0.55, // fraction of damage kept at max range
    magazine: 30,
    reserve: 90,
    reloadTime: 2.35,
    reloadEmptyTime: 3.05, // slower when the bolt has to be released
    drawTime: 0.7,
    range: 120,
    penetration: 1, // how many surfaces a round punches through
    /* --- recoil: the fixed pattern is what makes it learnable --- */
    recoilVertical: 1.95, // degrees per shot at the start of the spray
    recoilHorizontal: 0.42, // ... sideways
    recoilRise: 0.62, // how fast the vertical climb saturates
    recoilPatternX: [0, 0.02, -0.05, -0.12, -0.2, -0.28, -0.3, -0.18, 0.08, 0.34, 0.55, 0.62, 0.5, 0.28, 0.02, -0.24, -0.45, -0.55, -0.5, -0.32, -0.08, 0.18, 0.4, 0.52, 0.5, 0.36, 0.14, -0.1, -0.3, -0.42],
    recoilRecovery: 7.2, // 1/s the view falls back toward where it started
    recoilViewFactor: 0.62, // how much of the recoil is actually pushed onto the view
    spreadBase: 0.0008, // radians — first shot, standing still
    spreadMoving: 0.021, // added at full run
    spreadAir: 0.052, // added in the air
    spreadCrouch: -0.0004, // subtracted while crouched
    spreadPerShot: 0.0022, // added per round in the spray
    spreadMax: 0.038,
    spreadRecovery: 6.5, // 1/s it tightens back up
    adsSpreadScale: 0.35, // spread multiplier in sights
    kick: 0.055, // metres the viewmodel is punched back
    kickRoll: 0.09, // radians it twists on the punch
    muzzleFlashSize: 0.29,
    muzzleFlashTime: 0.045,
    shellEject: true,
    tracerEvery: 3, // one tracer per N rounds
    manaCost: 0
  },

  smg: {
    name: 'MP-9K',
    slot: 1,
    rpm: 857,
    damage: 24,
    headshotMultiplier: 3.4,
    armorPenetration: 0.62,
    falloffStart: 14,
    falloffEnd: 44,
    falloffMin: 0.42,
    magazine: 35,
    reserve: 120,
    reloadTime: 2.0,
    reloadEmptyTime: 2.6,
    drawTime: 0.55,
    range: 90,
    penetration: 0,
    recoilVertical: 1.25,
    recoilHorizontal: 0.55,
    recoilRise: 0.5,
    recoilPatternX: [0, -0.04, -0.1, -0.16, -0.14, -0.02, 0.16, 0.32, 0.42, 0.4, 0.26, 0.06, -0.16, -0.34, -0.44, -0.42, -0.28, -0.06, 0.18, 0.36, 0.46, 0.42, 0.26, 0.04, -0.2, -0.38, -0.46, -0.4, -0.22, 0.0],
    recoilRecovery: 8.4,
    recoilViewFactor: 0.55,
    spreadBase: 0.0026,
    spreadMoving: 0.014,
    spreadAir: 0.044,
    spreadCrouch: -0.0008,
    spreadPerShot: 0.0018,
    spreadMax: 0.034,
    spreadRecovery: 7.5,
    adsSpreadScale: 0.45,
    kick: 0.036,
    kickRoll: 0.07,
    muzzleFlashSize: 0.22,
    muzzleFlashTime: 0.04,
    shellEject: true,
    tracerEvery: 4,
    manaCost: 0
  },

  pistol: {
    name: 'D-17',
    slot: 2,
    rpm: 400,
    damage: 33,
    headshotMultiplier: 4.0,
    armorPenetration: 0.58,
    falloffStart: 12,
    falloffEnd: 40,
    falloffMin: 0.5,
    magazine: 17,
    reserve: 68,
    reloadTime: 1.75,
    reloadEmptyTime: 2.3,
    drawTime: 0.4,
    range: 70,
    penetration: 0,
    semiAuto: true,
    recoilVertical: 2.4,
    recoilHorizontal: 0.5,
    recoilRise: 0.9,
    recoilPatternX: [0, 0.1, -0.14, 0.2, -0.24, 0.28, -0.3, 0.26, -0.2, 0.14],
    recoilRecovery: 9.5,
    recoilViewFactor: 0.7,
    spreadBase: 0.0012,
    spreadMoving: 0.019,
    spreadAir: 0.05,
    spreadCrouch: -0.0005,
    spreadPerShot: 0.004,
    spreadMax: 0.04,
    spreadRecovery: 8.0,
    adsSpreadScale: 0.4,
    kick: 0.048,
    kickRoll: 0.12,
    muzzleFlashSize: 0.2,
    muzzleFlashTime: 0.04,
    shellEject: true,
    tracerEvery: 2,
    manaCost: 0
  },

  /* ================================================================== */
  /* Combat feel — what a hit is worth                                   */
  /* ================================================================== */
  combat: {
    hitmarkerTime: 0.22, // seconds the marker stays up
    hitmarkerSize: 13, // pixels
    killmarkerTime: 0.4,
    damageNumberTime: 0.95,
    damageNumberRise: 0.9, // metres it floats
    impactDecalLife: 22, // seconds a bullet hole survives
    impactDecalMax: 220, // ring buffer size
    fleshPenetration: 0.6,
    tracerSpeed: 340, // m/s — real tracers are slow enough to read
    tracerLength: 5.2, // metres
    tracerWidth: 0.030,
    tracerLife: 0.32,
    /**
     * A tracer 60 m away is under a pixel wide and simply disappears, which
     * reads as the tracer *stopping* rather than as distance. Widening it in
     * world space by its own view depth holds a constant minimum on screen —
     * the same trick every engine's line renderer uses.
     */
    tracerMinPixels: 2.1,
    tracerHeadBoost: 2.4, // how much hotter the leading tip burns
    // Screen shake per shot is deliberately tiny: recoil is felt through the
    // crosshair climbing, not through the whole frame juddering.
    fireShake: 0.012,
    hitFlashTime: 0.18, // red vignette pulse when the player is hit

    /* ---------------- muzzle flash ---------------- */
    /**
     * A global multiplier over each weapon's `muzzleFlashSize`, so the flash can
     * be art-directed without reaching into weapon balance. 1 = as authored.
     */
    muzzleFlashScale: 1.0,
    muzzleFlashCore: 0.34, // core quad, as a fraction of the star
    muzzleFlashGlow: 2.0, // glow ball, ditto
    muzzleFlashConeLength: 1.75, // unburnt-powder plume, ditto
    muzzleFlashConeRadius: 0.30,
    muzzleFlashAdsScale: 0.46, // how far the flash shrinks in the sights
    muzzleFlashAdsPush: 0.06, // metres it is pushed down the bore in ADS
    /**
     * The dynamic light is the whole reason a flash reads as happening *in* the
     * world. It is deliberately brief and deliberately large: a rifle flash
     * genuinely throws light across a room, and a 7 m radius only ever lit the
     * player's own feet.
     */
    muzzleLightIntensity: 62,
    muzzleLightRadius: 17,
    muzzleSmokeTime: 0.34, // seconds the powder smoke lingers

    /* ---------------- impacts ---------------- */
    impactSmokeLife: 1.15, // seconds the hanging dust cloud survives
    /**
     * Impacts in this arena land 25-50 m out, and debris authored for a 3 m
     * contact shot is invisible there. Everything is scaled by distance so a
     * far hit still reads without a near hit turning into an explosion.
     */
    impactFarDistance: 34, // metres at which the far scale is fully applied
    impactFarScale: 2.3, // size multiplier at that distance
    impactSparkFlash: 0.9 // brightness of the metal ricochet pop
  },

  /* ================================================================== */
  /* Monsters — procedurally generated, so these are the generator's dials*/
  /* ================================================================== */
  monsters: {
    maxAlive: 22,
    spawnInterval: 2.4, // seconds between spawns at wave start
    spawnDistanceMin: 22, // metres from the player
    spawnDistanceMax: 46,
    /** Species archetypes the generator interpolates between. */
    archetypes: ['stalker', 'brute', 'skitter', 'wraith'],

    /* --- body plan --- */
    heightMin: 1.5,
    heightMax: 3.4,
    limbSegments: 3, // joints per limb
    limbCountMin: 2,
    limbCountMax: 6,
    spineSegments: 7,
    boneJitter: 0.35, // how far the generator pushes proportions off the mean
    plateCount: 14, // armour plates grown over the body
    plateSpread: 0.6,
    spikeCount: 9,
    tendrilCount: 5,

    /* --- how they move --- */
    walkSpeed: 2.6,
    chargeSpeed: 6.4,
    turnRate: 3.2, // radians/second
    stepHeight: 0.42, // how high a foot lifts at full speed, metres
    strideLength: 1.5, // metres of ground covered per full gait cycle
    gaitFrequency: 1.65, // strides/second at walk speed
    lungeRange: 3.2, // metres it will lunge from
    lungeCooldown: 2.6,
    attackDamage: 14,

    /* --- what the legs do to the body ---
     * Small numbers on purpose. Weight reads through *phase* — the bob peaking
     * at footfall, the roll leading the stride — far more than through
     * amplitude, and doubling any of these reads as a limp. */
    bodyBob: 0.085, // metres the hips drop as weight transfers
    bodyRoll: 0.075, // radians the torso rolls toward the stance leg
    bodySway: 0.03, // metres the hips shift side to side
    bodyLean: 0.16, // radians the torso pitches down into a run

    /* --- what they are made of --- */
    health: 130,
    healthVariance: 0.35,
    armorPlates: 0.4, // fraction of the body that resists bullets
    headshotZone: 0.22, // fraction of the height that counts as head
    dismemberThreshold: 0.55, // fraction of a limb's HP before it comes off

    /* --- appearance ---
     * These are *albedos*, and the arena sun is 4.6 with ACES on top, so they
     * read far paler on screen than they look here. Solved backwards from the
     * screen value each surface has to hit: the sand floor tonemaps to ~93%
     * luma, so anything above ~35% albedo turns into a bone-white blob with no
     * silhouette against it. A predator has to be the dark shape in the frame —
     * the body sits at 20-30% screen luma, and only the thin bevel on a plate
     * seam, the claws and the eyes are allowed to be bright. That contrast
     * ratio, not the amount of detail, is what makes a creature read at 15 m.
     * The plate is pushed slightly *cool* so it separates from warm sand by
     * hue as well as by value. */
    colorFleshA: '#3f2119', // lit flesh          → ~29% screen luma
    colorFleshB: '#271413', // flesh in shadow    → ~15%
    colorFleshDeep: '#610e10', // subdermal veining and the light that bleeds through
    colorPlate: '#1e2023', // chitin, cool near-black → ~22%
    colorPlateEdge: '#3f3b32', // the bevel on a plate seam, which catches the key
    colorKeratin: '#423e33', // claws, horns, teeth → ~52%, the brightest body part
    colorMaw: '#140406', // the inside of the mouth — a hole, not a surface
    colorBlood: '#5e0d0d',
    colorEye: '#ff8a1e',
    eyeGlow: 4.6,
    subsurface: 0.7, // how much light bleeds through the flesh
    wetness: 0.72,
    roughnessFlesh: 0.72,
    /**
     * Chitin, not lacquer. At 0.34 the whole body carried one broad specular
     * sheen off a 4.6-intensity sun, which is what was reading as "pale" even
     * after the albedo was darkened — a dark surface with a bright, wide
     * highlight is still a bright surface. Real carapace is a *satin*: it has
     * a highlight, but a tight one, with the wet look confined to the seams
     * and the maw (see `wetness`).
     */
    roughnessPlate: 0.55,

    /* --- death --- */
    ragdollTime: 4.5, // seconds a corpse lies before sinking
    sinkTime: 2.0,
    gibCount: 16,
    bloodDecalLife: 30
  },

  /* ================================================================== */
  /* World                                                               */
  /* ================================================================== */
  arena: {
    size: 84, // metres across the playable area
    wallHeight: 9,
    coverCount: 26, // crates, pillars and ruins scattered for cover
    coverSeed: 20260813,

    /* --- surface palette: Dust II is three sandstones and a wood ----------
     * Values are the *albedo* the sun multiplies, so they read much paler on
     * screen than they look here. Real dry sandstone albedo is ~0.35-0.45.
     *
     * These were measured down from the originals. The walls were landing at
     * mean luma 192 against CS2's 110, and the reason is that ACES saturates:
     * with a hot key, an albedo change from 1.00 to 0.60 only moves a lit wall
     * from 240 to 179, so the key light has to do most of the work (it did —
     * see `sunIntensity`) and the albedo does the last third. What is left here
     * is a real sandstone reflectance rather than the near-white it was.
     */
    // Saturation is held near 28-30% for the stone family, which is what the
    // CS2 references measure. The first pass of this palette measured 49%
    // across the frame against CS2's 28: sandstone photographs as a *near
    // neutral* with a warm cast, and pushing the chroma up is the thing that
    // makes a desert map read as orange cartoon rather than as sun-bleached
    // rock. Only the terracotta trim and the rust are allowed to be chromatic,
    // because they are the accents the eye is meant to find.
    colorSandLight: '#ab9a80', // the pale plaster of the walls
    colorSandMid: '#8e7f66', // weathered blockwork
    colorSandDark: '#615546', // the shaded/dirty variant in the same family
    colorGroundA: '#8b7d63', // packed sand underfoot
    colorGroundB: '#6a5d4b', // the darker aggregate in it
    colorGrime: '#473e32', // what runs down a wall under a ledge
    colorWood: '#735c43',
    colorWoodDark: '#3e3123',
    colorMetal: '#5e594f',
    colorRust: '#5e4231',
    colorAccent: '#694b3f', // the terracotta trim band

    /* --- how dirty ------------------------------------------------------- */
    grime: 1.0, // master multiplier on dirt/streaks
    edgeWear: 1.0, // how bleached the exposed edges are
    detailScale: 1.0, // frequency multiplier on the surface noise
    normalStrength: 1.0, // relief depth
    aoStrength: 1.0, // strength of the baked cavity/contact term

    /* --- ground ---------------------------------------------------------- */
    groundTexScale: 3.2, // metres one tile of the rock photo covers
    /**
     * How much of the photo's own *hue* survives.
     *
     * The photo is cold grey cathedral stone. At 0.34 enough of that blue-grey
     * came through that the courtyard floor read as wet slate under warm
     * sandstone walls — two different places in one frame, and the single
     * loudest remaining mismatch once the walls were fixed. At 0.12 the photo
     * supplies its cracks, pitting and grain (which are its whole value) while
     * the sand albedo decides the colour.
     */
    groundTexTint: 0.12,
    groundDetail: 1.0 // gravel + drift noise on top of the photo
  },

  /* ================================================================== */
  /* Environment — overridden from the sandbox's dark stage to a real map */
  /* ================================================================== */
  environment: {
    ...castingSettings.environment,

    /* --- the key ---------------------------------------------------------
     * Hot afternoon sun. The ratio between this and the fill is the whole
     * ballgame: a sunlit sandstone face against its own shadow in a Dust II
     * screenshot is about 4:1, and anything flatter than ~3:1 reads as an
     * overcast grey-box no matter how good the textures are. Elevation 0.62 rad
     * (≈36°) throws shadows about 1.4× the height of what casts them, which is
     * the length that makes architecture legible.
     *
     * ## Why 2.5 and not 4.6
     *
     * At 4.6 the walls measured mean luma 192 with sd 30 — brighter than the
     * sky, near the top of the range, and *flat*, because ACES compresses
     * everything above about 0.8 linear into the last few code values. Nothing
     * placed in front of a wall like that has anything to sit against, which is
     * why every creature and every weapon in this project was reading as pasted
     * on. CS2's sandstone reference frames average 93-95 over the whole frame.
     *
     * The floor of this range is *not* taste. The monsters' armour plates are
     * albedo 0.0147 linear; below sun ≈ 2.0 they quantise into under two sRGB
     * code values and the creature becomes a black cutout. 2.5 puts a lit plate
     * around 32/255 — clearly readable — while bringing sunlit stone off the
     * ACES shoulder and back onto the part of the curve where albedo and
     * surface detail still translate into visible tonal separation.
     */
    // ## The sun-to-fill RATIO is the whole look
    //
    // Measured against the reference, our highlights came out at RGB
    // (164, 175, 190) — cool, i.e. the brightest thing in frame was the sky.
    // CS2's are (239, 209, 178): warm, i.e. the brightest thing is sunlit
    // stone. That 86-point swing in R-B is not a grade problem, it is a
    // lighting-ratio problem. Sun 2.5 against a combined fill of 1.80 is a
    // 1.4:1 ratio, which is overcast; a midday desert exterior is 4:1 to 6:1,
    // and at 1.4:1 the blue hemisphere simply out-competes the warm key on the
    // very surfaces the sun should own.
    //
    // Raising the sun and cutting the fill together moves the ratio without
    // touching exposure — raising exposure instead would only push the sky
    // further up the ACES shoulder, making the problem worse.
    sunIntensity: 4.0,
    sunColor: '#ffeccb',
    sunAzimuth: 2.34,
    sunElevation: 0.62,

    // Ambient is *off*. A uniform term added to every surface regardless of
    // orientation is precisely the thing that destroys the sense of a single
    // sun; the fill below is directional and carries colour instead.
    ambientIntensity: 0.0,
    ambientColor: '#6b7f9c',

    // Sky-blue from above, warm sand bounce from below. The ground colour is
    // the courtyard's own albedo — that is what makes an unlit face read as
    // "in shadow, outdoors" rather than "unlit".
    //
    // Cut with the key, and by slightly more: the *ratio* is what carries the
    // sense of a single hard sun, and a fill held at its old value against a
    // halved key would have flattened the frame far worse than the brightness
    // ever did. Sun-to-shadow here is about 4:1, which is the Dust II figure.
    //
    // The ground colour is doing the most important job in this block. A face
    // turned away from the sun in an open sandy courtyard is not dark, it is
    // *warm* — it is being lit by sunlight bouncing off the ground in front of
    // it, which is why the shadow side of a Dust II wall still shows its brick.
    // When this was too weak the surface shader's plaster and blockwork were
    // being drawn and then thrown away, which is the worst possible trade.
    hemiIntensity: 0.46,
    hemiSkyColor: '#9aaec6',
    hemiGroundColor: '#8d7b60',

    // Fill from the anti-sun quarter, standing in for the rest of the sky dome.
    rimIntensity: 0.24,
    rimColor: '#9bb0c7',
    rimAzimuth: 5.5,
    rimElevation: 0.5,

    envIntensity: 0.40,

    /* --- shadows ---------------------------------------------------------
     * Small radius: a 36° sun is a nearly-point source and CS2's shadows are
     * crisp at the contact and only soften over a metre or two. A big PCF blur
     * is the other classic tell of a hobby renderer.
     */
    shadowRadius: 1.35,
    shadowBias: -0.0004,
    shadowNormalBias: 0.05,

    /* --- the sky (baked procedurally at boot — see Environment.js) -------- */
    showSky: true,
    skyIntensity: 1.0,
    skyResolution: 1024,
    // ## Why this sky is dusty rather than blue
    //
    // Measured against the reference, the top 5% of our brightest pixels were
    // 68% sky, and that sky read RGB (103,125,152) — cool. CS2's equivalent
    // region reads (147,124,107): *warm*. Its map is not lit under a clear
    // alpine sky, it is lit under a hot dust haze, which is why its sunlit
    // stone can be the brightest thing in frame while the sky sits behind it.
    //
    // With a saturated blue zenith no amount of sun-to-fill tuning gets there:
    // the sky is a large, bright, cool area light, so it both wins the
    // highlight competition and pushes cool fill onto every up-facing surface.
    // Dropping the zenith's saturation and warming the whole dome is what lets
    // the sun own the highlights.
    skyZenith: '#7d8fa0', // hazy, desaturated — not a clear-day blue
    skyHorizon: '#c2ab8c', // dust taking over well before the skyline
    skyHaze: '#dcc09a', // the hot dusty band welded to the skyline
    skyGround: '#8a7454', // what the probe sees looking down: sand bounce
    // A sky brighter than the architecture in front of it is correct; a sky
    // brighter than it by 60 code values, as this was, silhouettes everything
    // and flattens the skyline into a cutout.
    skyLuminance: 0.82,
    skyGlow: 0.85, // Mie forward-scatter halo around the sun
    skyHazeAmount: 0.9,
    skySunDisc: 55,
    skySunSize: 1.2,
    cloudAmount: 0.9,
    cloudCoverage: 0.58,
    cirrusAmount: 0.22,
    cirrusCoverage: 0.62,
    cloudLit: '#fff6e8',
    cloudDark: '#b5a894',

    /* --- air -------------------------------------------------------------
     * Aerial perspective, not weather. The far wall of a 84 m courtyard should
     * sit a few percent toward the haze colour — that tiny wash is most of
     * what gives a big outdoor space its depth.
     */
    fogEnabled: true,
    fogColor: '#9c9182',
    fogNear: 34,
    fogFar: 190,
    backgroundColor: '#7fa8cf'
  },

  /* ================================================================== */
  /* Post — pushed toward a modern shooter's grade                       */
  /* ================================================================== */
  post: {
    ...castingSettings.post,
    enabled: true,

    // ACES already compresses the top end hard; the sun-facing sandstone should
    // land around 0.82-0.88 display, not clip. Above ~1.15 the whole frame
    // milks out and the sky loses its blue.
    //
    // Held above 0.85 because exposure scales the *scene*: it takes the dark
    // end down with the bright end, and the monsters' armour crushes below
    // that. 1.20 is where the measured full-frame mean lands near CS2's 93
    // without pushing sunlit stone back onto the ACES shoulder — the tonal
    // *range* was already correct at sd 49 against CS2's 48.6, so this is a
    // level correction and nothing else moves.
    exposure: 1.20,

    // Bloom on a daylight scene is a *veiling* effect only — a thin halo off
    // the sky and the brightest lit stone. Anything stronger reads as a lens
    // smeared with vaseline, which is the giveaway of a hobby renderer.
    //
    // The threshold is in post-tone-map terms, so lowering the key moved what
    // qualifies. 0.78 keeps it on the sky and the hottest stone only.
    bloomStrength: 0.14,
    bloomRadius: 0.72,
    bloomThreshold: 0.78,

    chromaticAberration: 0.35, // in the shader's own units: ~0.7% at the corner
    vignette: 0.3,

    // The S-curve equivalent: mild contrast with a hair of lift, so the shadows
    // sit slightly off black the way a real camera's toe does rather than
    // crushing to zero.
    //
    // Contrast separates the midtones without moving the mean much — which is
    // exactly what a frame with sd 30 needed, and what simply darkening
    // everything would not have given.
    //
    // `contrastPivot` is the fulcrum the contrast turns about.
    //
    // ## Correcting what this comment used to claim
    //
    // It previously said a lower pivot protects the shadows. That is backwards,
    // and the arithmetic says so plainly: a linear contrast about pivot P has a
    // hard black point at bp = P − P/C, so *lowering* P lowers P/C by less and
    // the black point goes UP. At C = 1.14, pivot 0.50 clips at 0.0439 and
    // pivot 0.42 clips at 0.0516 — the "protective" pivot clipped harder.
    //
    // The real protection is operator order, not the pivot: GradeShader now
    // applies the shadow toe *before* the contrast, so the darkest values are
    // uncrushed before the contrast can clamp them, and floors at `shadowFloor`
    // rather than at zero. With that in place the pivot is only a taste control
    // over where the extra contrast is spent, and 0.44 is a reasonable place to
    // spend it. Anyone re-tuning this should change the order-of-operations
    // reasoning in GradeShader.js first, not this number.
    contrast: 1.14,
    contrastPivot: 0.44,
    // Below 1: the lighting is already warm from both the key and the sand
    // bounce, and multiplying that by a saturation boost put the frame at 49%
    // mean chroma against the CS2 references' 28%.
    saturation: 0.70,
    temperature: 0.028, // warm highlights, cool shadows fall out of the lighting
    // Applied as a film toe (see GradeShader), so it only reaches the bottom of
    // the range: dark surfaces stay off absolute black, the sky is untouched.
    lift: 0.026,
    /**
     * The value the contrast clamps to. Not zero: a shadow that is uniformly
     * 0 is a hole in the frame, one that varies between 0.004 and 0.02 is a
     * surface. Well below anything the eye reads as a lifted black.
     */
    shadowFloor: 0.004,
    gain: 1.0,
    grain: 0.014,
    distortion: 1.0
  }
};

/** Convenience: the config block for a weapon id. */
export function weaponConfig(id) {
  return settings[id];
}
