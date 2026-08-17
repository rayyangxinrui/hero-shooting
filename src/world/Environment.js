import {
  Scene,
  Fog,
  Vector3,
  Object3D,
  AmbientLight,
  HemisphereLight,
  DirectionalLight,
  DataTexture,
  RGBAFormat,
  FloatType,
  LinearFilter,
  RepeatWrapping,
  ClampToEdgeWrapping,
  EquirectangularReflectionMapping,
  PMREMGenerator
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

const _sunDir = new Vector3();

/**
 * Half-width of the shadowed area, in metres, centred on the player.
 *
 * Wide enough that the whole 84 m courtyard is inside the map from anywhere
 * near the middle — a perimeter wall that falls outside the shadow frustum
 * samples the clamped border texel and streaks. At 4096² this is 2.4 cm per
 * texel, which still resolves the contact line where a crate meets the floor.
 */
const SHADOW_EXTENT = 50;
const SHADOW_MAP_SIZE = 4096;

/* ------------------------------------------------------------------ */
/* A small CPU noise kit — the sky is baked once, on the CPU, at load.  */
/* ------------------------------------------------------------------ */

function hash2i(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise on a 2D lattice. */
function vnoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  const a = hash2i(xi, yi);
  const b = hash2i(xi + 1, yi);
  const c = hash2i(xi, yi + 1);
  const d = hash2i(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

function fbm2(x, y, octaves) {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * vnoise2(x, y);
    total += amplitude;
    x = x * 2.03 + 11.7;
    y = y * 2.03 - 5.3;
    amplitude *= 0.5;
  }
  return value / total;
}

/**
 * Scene, atmosphere and lighting.
 *
 * **The sky is generated, not loaded.** The project ships one HDR — a cold
 * sunrise — and no amount of grading turns that into hot desert afternoon. So
 * the environment bakes its own equirectangular radiance map at boot: a two
 * term vertical gradient, a Mie forward-scatter lobe around the sun, a thick
 * haze band welded to the horizon, and two cloud decks raymarched against flat
 * planes so they converge properly at the horizon instead of sitting on the
 * dome like wallpaper. That one texture then does three jobs at once — the
 * visible backdrop, the PMREM probe every PBR surface reflects, and the source
 * of the fill colour the shadowed faces are graded against. Because it is the
 * same data in all three roles, the sky the player sees is provably the sky
 * that is lighting the crates.
 *
 * The light rig is deliberately lopsided. Midday desert sun is *one* very
 * strong source and a large, weak, blue-from-above / warm-from-below fill;
 * the flat grey look of a test level comes from an ambient term strong enough
 * to compete with the key. Here the ambient light is off entirely, and the
 * fill is a hemisphere whose ground colour is the sand's own albedo, so a
 * face turned away from the sun gets warm bounce rather than neutral grey.
 */
export class Environment {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;

    this.scene = new Scene();
    this._bgColor = getColor(settings.environment.backgroundColor).clone();
    this.scene.background = this._bgColor;
    this._fog = new Fog(
      getColor(settings.environment.fogColor).clone(),
      settings.environment.fogNear,
      settings.environment.fogFar
    );
    this.scene.fog = settings.environment.fogEnabled ? this._fog : null;

    this.ambient = new AmbientLight(
      getColor(settings.environment.ambientColor).clone(),
      settings.environment.ambientIntensity
    );
    this.hemi = new HemisphereLight(
      getColor(settings.environment.hemiSkyColor).clone(),
      getColor(settings.environment.hemiGroundColor).clone(),
      settings.environment.hemiIntensity
    );

    this.sun = new DirectionalLight(
      getColor(settings.environment.sunColor).clone(),
      settings.environment.sunIntensity
    );
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = settings.environment.shadowBias;
    this.sun.shadow.normalBias = settings.environment.shadowNormalBias ?? 0.045;
    this.sun.shadow.radius = settings.environment.shadowRadius;

    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -SHADOW_EXTENT;
    shadowCamera.right = SHADOW_EXTENT;
    shadowCamera.top = SHADOW_EXTENT;
    shadowCamera.bottom = -SHADOW_EXTENT;
    shadowCamera.near = 0.5;
    shadowCamera.far = 260;
    shadowCamera.updateProjectionMatrix();

    this.sunTarget = new Object3D();

    /**
     * Sky fill from the anti-sun side. No shadows: this stands in for the
     * large-area skylight that a single hemisphere term flattens out, and it
     * is what keeps a shadowed wall from going to a dead flat value.
     */
    this.rim = new DirectionalLight(
      getColor(settings.environment.rimColor).clone(),
      settings.environment.rimIntensity
    );
    this.rimTarget = new Object3D();
    this.rim.target = this.rimTarget;

    this.scene.add(this.ambient, this.hemi, this.sun, this.sunTarget, this.rim, this.rimTarget);
    this.sun.target = this.sunTarget;

    this.focus = new Vector3();
    this._envMap = null;
    this._pmrem = null;
    this._rimDir = new Vector3();
    /** Snapped focus, so the shadow map does not swim as the player walks. */
    this._snapped = new Vector3();
    this._skyKey = '';
  }

  /* ================================================================== */
  /* Sky                                                                 */
  /* ================================================================== */

  /**
   * Bake an equirectangular HDR sky into a float texture.
   *
   * Layout matches three's `equirectUv`: u wraps the azimuth from -π at the
   * left edge, v runs nadir (0) to zenith (1), so row 0 of the buffer is
   * straight down.
   */
  _bakeSky() {
    const env = settings.environment;
    const W = env.skyResolution ?? 1024;
    const H = W >> 1;
    const data = new Float32Array(W * H * 4);

    const el = env.sunElevation;
    const az = env.sunAzimuth;
    const sx = Math.cos(az) * Math.cos(el);
    const sy = Math.sin(el);
    const sz = Math.sin(az) * Math.cos(el);

    const zen = getColor(env.skyZenith);
    const hor = getColor(env.skyHorizon);
    const haze = getColor(env.skyHaze);
    const grd = getColor(env.skyGround);
    const sunC = getColor(env.sunColor);
    const cloudLit = getColor(env.cloudLit);
    const cloudDark = getColor(env.cloudDark);

    const lum = env.skyLuminance ?? 1.6;
    const glow = env.skyGlow ?? 1.0;
    const hazeAmt = env.skyHazeAmount ?? 0.85;
    const discI = env.skySunDisc ?? 40;
    const discCos = Math.cos((env.skySunSize ?? 1.4) * Math.PI / 180);

    const cumAmt = env.cloudAmount ?? 0.55;
    const cumCov = env.cloudCoverage ?? 0.52;
    const cirAmt = env.cirrusAmount ?? 0.35;
    const cirCov = env.cirrusCoverage ?? 0.55;

    let p = 0;
    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      const elev = (v - 0.5) * Math.PI;
      const y = Math.sin(elev);
      const cy = Math.cos(elev);

      for (let i = 0; i < W; i++, p += 4) {
        const u = (i + 0.5) / W;
        const phi = (u - 0.5) * Math.PI * 2;
        const x = Math.cos(phi) * cy;
        const z = Math.sin(phi) * cy;

        const up = y > 0 ? y : 0;

        /* ---- vertical gradient: pale hot horizon into deep blue ---- */
        const k = Math.pow(up, 0.40);
        let r = hor.r + (zen.r - hor.r) * k;
        let g = hor.g + (zen.g - hor.g) * k;
        let b = hor.b + (zen.b - hor.b) * k;

        /* ---- the haze band ----
         *
         * Desert air is thick, and this band is what reads as *heat*.
         *
         * The falloff constant matters more than it looks. At exp(-up * 13) the
         * band is at half strength by 3 degrees of elevation and effectively
         * gone by 10 — but a 90 degree horizontal fov puts the horizon near
         * frame centre, so the sky the player actually sees spans roughly 0 to
         * 35 degrees. The band was therefore invisible across almost all of the
         * visible sky, leaving the saturated zenith to fill it, and the sky
         * came out as the coolest *and* brightest thing in frame. Measured:
         * ours read RGB (103,125,152) against the reference's (147,124,107).
         *
         * A slower falloff carries the dust up through the band of sky that is
         * actually on screen, which is what the reference has.
         */
        const band = Math.exp(-up * 3.4) * hazeAmt;
        r += (haze.r - r) * band;
        g += (haze.g - g) * band;
        b += (haze.b - b) * band;

        /* ---- Mie forward scatter around the sun ---- */
        const cosSun = x * sx + y * sy + z * sz;
        const c = cosSun > 0 ? cosSun : 0;
        const mie = (Math.pow(c, 11.0) * 0.9 + Math.pow(c, 2.6) * 0.20 + Math.pow(c, 1.0) * 0.05) * glow;
        r += sunC.r * mie;
        g += sunC.g * mie;
        b += sunC.b * mie;

        /* ---- clouds. Two decks, intersected against flat planes so the
               cells foreshorten toward the horizon like real cloud.

           ## Why the frequency is 4.4 and not 0.55

           The plane coordinate is `0.30 / sin(elevation)`, which collapses fast:
           at 15 deg above the horizon it is 1.1, at 40 deg it is 0.36. Scaled by
           0.55 the *entire* upper sky spanned about a third of one noise cell,
           so the whole dome sampled one smooth interpolant and baked out as a
           clean gradient with no cloud in it at all. That is why the sky
           measured sd 19 against the CS2 references' sd 51 — the cloud code was
           running and producing nothing.

           At 4.4 the visible band spans several cells and the deck actually
           resolves, with the foreshortening toward the horizon that the flat
           plane intersection was written to give. ---- */
        if (y > 0.012) {
          // low cumulus deck
          const t1 = 0.30 / y;
          const cx = x * t1 * 1.0;
          const cz = z * t1 * 1.0;
          if (cumAmt > 0.001 && t1 < 90) {
            /* ## The threshold was outside the noise's range
             *
             * `fbm2` averages `vnoise` (which is 0..1) with normalised weights,
             * so its output is *not* 0..1: five octaves land in roughly
             * 0.06-0.46 around a mean of 0.25, because the octaves rarely peak
             * together. After the `n * 1.35 - 0.16` remap the maximum is 0.462
             * — and the coverage threshold is `cumCov`, which ships at 0.54.
             *
             * So `n - cumCov` was negative at every one of the million pixels
             * in the bake and the cumulus deck contributed *nothing*, in every
             * capture this project has ever taken. The cirrus deck had the same
             * bug at 0.56. That is the whole reason the sky measured sd 19
             * against the references' sd 51: it was a bare two-term gradient.
             *
             * Remapping the noise onto its measured range first makes `cumCov`
             * mean what it says — a coverage fraction, where 0.54 leaves rather
             * more than half the sky clear.
             */
            let n = (fbm2(cx * 4.4 + 40.0, cz * 4.4 - 17.0, 5) - 0.10) / 0.30;
            let cov = (n - cumCov) / 0.30;
            cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
            cov = cov * cov * (3 - 2 * cov);
            // fade the deck out as it approaches the horizon haze
            cov *= 1.0 - Math.exp(-up * 5.0) * 0.85;
            cov *= cumAmt;
            if (cov > 0.002) {
              // Sunward side of a cloud is lit, the far side is a cool grey.
              const lit = Math.pow(c * 0.5 + 0.5, 2.6);
              const cr = cloudDark.r + (cloudLit.r - cloudDark.r) * lit;
              const cg = cloudDark.g + (cloudLit.g - cloudDark.g) * lit;
              const cb = cloudDark.b + (cloudLit.b - cloudDark.b) * lit;
              r += (cr - r) * cov;
              g += (cg - g) * cov;
              b += (cb - b) * cov;
            }
          }
          // high cirrus, stretched into streaks
          const t2 = 1.0 / y;
          if (cirAmt > 0.001 && t2 < 160) {
            // Same correction as the cumulus deck: the cirrus plane coordinate
            // is even smaller, so 0.20 put the whole sky inside one cell.
            const fx = x * t2 * 1.6;
            const fz = z * t2 * 1.6;
            // Same range remap as the cumulus deck — see the note there.
            let n = (fbm2(fx * 3.4 - 90.0, fz * 0.42 + 61.0, 4) - 0.09) / 0.32;
            let cov = (n - cirCov) / 0.26;
            cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
            cov = cov * cov * (3 - 2 * cov);
            cov *= (1.0 - Math.exp(-up * 4.0)) * cirAmt;
            if (cov > 0.002) {
              const lit = 0.55 + 0.45 * Math.pow(c * 0.5 + 0.5, 2.0);
              r += (cloudLit.r * lit - r) * cov;
              g += (cloudLit.g * lit - g) * cov;
              b += (cloudLit.b * lit - b) * cov;
            }
          }
        }

        /* ---- below the horizon: warm sand bounce. The player never sees
               this (the ground plane covers it) but the probe does, and it
               is what puts warm light back into every shadowed face. ---- */
        if (y < 0) {
          const t = Math.min(1, -y * 5.0);
          const s = t * t * (3 - 2 * t);
          r += (grd.r - r) * s;
          g += (grd.g - g) * s;
          b += (grd.b - b) * s;
        }

        r *= lum;
        g *= lum;
        b *= lum;

        /* ---- the disc itself ---- */
        if (cosSun > discCos) {
          const e = (cosSun - discCos) / (1 - discCos);
          const soft = Math.min(1, e * 3.0);
          r += sunC.r * discI * soft;
          g += sunC.g * discI * soft;
          b += sunC.b * discI * soft;
        }

        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 1;
      }
    }

    const texture = new DataTexture(data, W, H, RGBAFormat, FloatType);
    texture.mapping = EquirectangularReflectionMapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  /** Key of every setting the baked sky depends on — rebake when it changes. */
  _skySignature() {
    const e = settings.environment;
    return [
      e.sunElevation, e.sunAzimuth, e.sunColor, e.skyZenith, e.skyHorizon,
      e.skyHaze, e.skyGround, e.skyLuminance, e.skyGlow, e.skyHazeAmount,
      e.skySunDisc, e.skySunSize, e.cloudAmount, e.cloudCoverage,
      e.cirrusAmount, e.cirrusCoverage, e.cloudLit, e.cloudDark, e.skyResolution
    ].join('|');
  }

  _rebuildSky() {
    const previousEquirect = this.equirect;
    const previousEnv = this._envMap;

    this.equirect = this._bakeSky();
    this._skyKey = this._skySignature();

    this._pmrem = new PMREMGenerator(this.renderer.gl);
    this._pmrem.compileEquirectangularShader();
    const target = this._pmrem.fromEquirectangular(this.equirect);
    this._envMap = target.texture;
    this._pmrem.dispose();
    this._pmrem = null;

    this.scene.environment = this._envMap;
    this.scene.environmentIntensity = settings.environment.envIntensity;

    if (settings.environment.showSky !== false) {
      // The raw equirect, not the PMREM output: the probe is pre-blurred per
      // roughness level and using it as the backdrop softens the horizon and
      // the sun into mush. Blurriness is only meaningful on the probe anyway.
      this.scene.background = this.equirect;
      this.scene.backgroundIntensity = settings.environment.skyIntensity ?? 1.0;
      this.scene.backgroundBlurriness = 0;
    }

    frame.uEnvMap.value = this.equirect;

    previousEquirect?.dispose();
    previousEnv?.dispose();
  }

  /**
   * `hdrTexture` is the file the loader fetched. It is not used: see the class
   * comment. Disposed here so the 2 MB of float data does not sit in VRAM for
   * the whole session.
   */
  async loadEnvironment(hdrTexture) {
    hdrTexture?.dispose?.();
    this._rebuildSky();
  }

  registerShadowCaster(material) {
    return material;
  }

  /**
   * @param {THREE.Material} material
   * @param {Function} patch
   * @param {string} [cacheKey]  pass a stable key when several materials share
   *        one patch body, so they share a compiled program instead of each
   *        getting a unique one. Omit it and the material gets its own.
   */
  registerShadowCasterWithPatch(material, patch, cacheKey) {
    patchOnBeforeCompile(material, patch, cacheKey);
    return material;
  }

  setFocus(x, z) {
    this.focus.set(x, 0, z);
  }

  _computeLightDirection(out, azimuth, elevation) {
    const cosE = Math.cos(elevation);
    out.set(-Math.cos(azimuth) * cosE, -Math.sin(elevation), -Math.sin(azimuth) * cosE);
    return out.normalize();
  }

  update() {
    const env = settings.environment;

    // The sky is a baked product of a dozen settings. Re-baking costs ~200 ms,
    // so it only happens when one of those settings actually moved — which in
    // practice means a tuning session, never a gameplay frame.
    if (this.equirect && this._skySignature() !== this._skyKey) this._rebuildSky();

    this._computeLightDirection(_sunDir, env.sunAzimuth, env.sunElevation);

    // Snap the shadow focus to a texel grid. Without this, walking forward
    // makes every shadow edge crawl and shimmer — the single most visible
    // artefact in a first-person game with a moving shadow camera.
    const texelWorld = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
    this._snapped.set(
      Math.round(this.focus.x / texelWorld) * texelWorld,
      0,
      Math.round(this.focus.z / texelWorld) * texelWorld
    );

    this.sunTarget.position.copy(this._snapped);
    this.sun.position.copy(this._snapped).addScaledVector(_sunDir, -120);

    frame.uLightDir.value.copy(_sunDir).negate();

    this.sun.intensity = env.sunIntensity;
    this.sun.color.copy(getColor(env.sunColor));
    this.sun.shadow.radius = env.shadowRadius;
    this.sun.shadow.bias = env.shadowBias;
    this.sun.shadow.normalBias = env.shadowNormalBias ?? 0.045;

    this._computeLightDirection(this._rimDir, env.rimAzimuth, env.rimElevation);
    this.rimTarget.position.copy(this.focus);
    this.rim.position.copy(this.focus).addScaledVector(this._rimDir, -50);
    this.rim.intensity = env.rimIntensity;
    this.rim.color.copy(getColor(env.rimColor));

    this.ambient.intensity = env.ambientIntensity;
    this.ambient.color.copy(getColor(env.ambientColor));
    this.hemi.intensity = env.hemiIntensity;
    this.hemi.color.copy(getColor(env.hemiSkyColor));
    this.hemi.groundColor.copy(getColor(env.hemiGroundColor));

    this.scene.environmentIntensity = env.envIntensity;
    if (this.scene.background === this.equirect) {
      this.scene.backgroundIntensity = env.skyIntensity ?? 1.0;
    } else {
      this._bgColor.copy(getColor(env.backgroundColor));
    }

    this.scene.fog = env.fogEnabled ? this._fog : null;
    this._fog.color.copy(getColor(env.fogColor));
    this._fog.near = env.fogNear;
    this._fog.far = env.fogFar;
  }

  dispose() {
    this._envMap?.dispose();
    this.equirect?.dispose();
    this.sun.shadow.dispose();
  }
}
