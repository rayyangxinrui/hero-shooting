#!/usr/bin/env node
/**
 * Predict what a surface will actually measure on screen.
 *
 * The arena's brightness has now been wrong in both directions, and both times
 * it was because a value was chosen by eye and then the *pipeline* did
 * something non-obvious to it. ACES is the culprit: it is close to linear in
 * the shadows and compresses hard above about 0.6, so the same albedo change
 * that moves a shadowed wall by 40 code values moves a sunlit one by 8. Guessing
 * against that curve does not converge; this does the arithmetic instead.
 *
 * Mirrors, in order: Lambert → ACES (three's RRTAndODTFit) → sRGB OETF →
 * GradeShader's contrast/lift/gain/saturation.
 *
 *   node tools/tone.mjs                 # the table
 *   node tools/tone.mjs solve 93        # what exposure lands a frame mean of 93
 */

const PI = Math.PI;

/* three.js ACESFilmicToneMapping, on a neutral (the in/out matrices are very
   close to luminance-preserving for greys, which is all we need here). */
function acesFit(v) {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return Math.max(0, Math.min(1, a / b));
}

function aces(linear, exposure) {
  return acesFit(linear * (exposure / 0.6));
}

function srgbEncode(x) {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbDecode(x) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** hex → linear reflectance (what three's Color does with a '#rrggbb'). */
export function albedoOf(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = srgbDecode(((n >> 16) & 255) / 255);
  const g = srgbDecode(((n >> 8) & 255) / 255);
  const b = srgbDecode((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Radiance leaving a surface, in three's units.
 * Direct: dotNL * intensity * albedo / PI   (BRDF_Lambert divides by PI)
 * Indirect: irradiance * albedo / PI, and the hemisphere/env terms are already
 * irradiance.
 */
export function radiance({ albedo, sun = 2.5, dotNL = 0.85, hemi = 0.34, env = 0.34, ao = 1 }) {
  const direct = (dotNL * sun * albedo) / PI;
  const indirect = ((hemi + env * PI * 0.5) * albedo * ao) / PI;
  return direct + indirect;
}

/**
 * The grade pass, on a 0..1 display value.
 *
 * Pivot is 0.42, not 0.5, and the lift is a *toe* rather than a flat offset —
 * both mirror GradeShader. Pivoting a contrast boost about 0.5 subtracts from
 * everything below 0.5, which on this frame meant the shadowed side of every
 * wall (and the monsters' 0.014-albedo armour) was pushed to zero and lost all
 * the surface detail it had. See the comment in GradeShader.js.
 */
export function grade(x, { contrast = 1.1, lift = 0.02, gain = 1.0, pivot = 0.42 } = {}) {
  let v = (x - pivot) * contrast + pivot;
  v = Math.max(0, v) * gain;
  const toe = 1 - Math.min(1, Math.max(0, (v - 0) / 0.3)) ** 2;
  v += lift * toe;
  return Math.max(0, Math.min(1, v));
}

export function pipeline(linear, exposure, gradeOptions) {
  return grade(srgbEncode(aces(linear, exposure)), gradeOptions) * 255;
}

/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);

if (args[0] === 'solve') {
  /* Given the *measured* mean of the current frame, what exposure lands the
     target? Solved through the real curve rather than assumed linear, because
     the curve is exactly what makes the naive answer wrong. */
  const target = Number(args[1] ?? 93);
  const measured = Number(args[2] ?? 56.7);
  const exposure = Number(args[3] ?? 0.92);

  // Back out the scene linear value that produced the measured mean, then find
  // the exposure that puts it at the target.
  let lo = 0.0001;
  let hi = 4;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (pipeline(mid, exposure) < measured) lo = mid;
    else hi = mid;
  }
  const sceneLinear = (lo + hi) / 2;

  let elo = 0.05;
  let ehi = 12;
  for (let i = 0; i < 80; i++) {
    const mid = (elo + ehi) / 2;
    if (pipeline(sceneLinear, mid) < target) elo = mid;
    else ehi = mid;
  }
  const needed = (elo + ehi) / 2;

  console.log(`measured mean ${measured} at exposure ${exposure}`);
  console.log(`  implies scene linear ≈ ${sceneLinear.toFixed(4)}`);
  console.log(`  exposure for mean ${target}: ${needed.toFixed(3)}  (${(needed / exposure).toFixed(2)}x)`);
  console.log(`  equivalent scene-brightness multiplier at fixed exposure: ${(function () {
    let l = 0.0001;
    let h = 40;
    for (let i = 0; i < 80; i++) {
      const m = (l + h) / 2;
      if (pipeline(m, exposure) < target) l = m;
      else h = m;
    }
    return (((l + h) / 2) / sceneLinear).toFixed(2);
  })()}x`);
  process.exit(0);
}

/* The table: how each candidate wall albedo lands, lit and in shadow. */
const exposures = [0.92, 1.0, 1.1, 1.2, 1.3, 1.45];
const swatches = [
  ['plaster  #a08a68', '#a08a68'],
  ['plaster  #b09a76', '#b09a76'],
  ['plaster  #bfa87f', '#bfa87f'],
  ['block    #8a7350', '#8a7350'],
  ['ground   #9d8760', '#9d8760'],
  ['plate    #1e2023', '#1e2023']
];

console.log('sun 2.5 · hemi 0.34 · env 0.34\n');
console.log(
  'surface              ' + exposures.map((e) => `e${e.toFixed(2)}`.padStart(7)).join('')
);
for (const [name, hex] of swatches) {
  const albedo = albedoOf(hex);
  const lit = radiance({ albedo, dotNL: 0.85 });
  const shade = radiance({ albedo, dotNL: 0.0 });
  console.log(
    `${name.padEnd(20)}` +
      exposures.map((e) => pipeline(lit, e).toFixed(0).padStart(7)).join('') +
      '   lit'
  );
  console.log(
    `${''.padEnd(20)}` +
      exposures.map((e) => pipeline(shade, e).toFixed(0).padStart(7)).join('') +
      '   shadow'
  );
}
