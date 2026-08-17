/**
 * Final look pass (runs after tone mapping, in display space).
 *
 * Combines the cheap-but-high-impact grading operations into one pass so the
 * frame is only resampled once: chromatic aberration, lift/gain/contrast/
 * saturation/temperature grading, vignette, film grain and the impact flash.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.35 },
    uVignette: { value: 0.4 },
    uContrast: { value: 1.05 },
    uPivot: { value: 0.42 },
    uSaturation: { value: 1.1 },
    uTemperature: { value: 0.05 },
    uLift: { value: 0.0 },
    /** Floor the contrast clamps to, so shadows vary instead of being a hole. */
    uShadowFloor: { value: 0.004 },
    uGain: { value: 1.0 },
    uGrain: { value: 0.03 },
    uFlashColor: { value: null },
    uFlashStrength: { value: 0 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uContrast;
    uniform float uPivot;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uLift;
      uniform float uShadowFloor;
    uniform float uGain;
    uniform float uGrain;
    uniform vec3  uFlashColor;
    uniform float uFlashStrength;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- chromatic aberration (radial, strongest at the corners) ------
      vec3 color;
      if (uAberration > 0.001) {
        vec2 offset = centered * r2 * uAberration * 0.02;
        color.r = texture2D(tDiffuse, uv + offset).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv - offset).b;
      } else {
        color = texture2D(tDiffuse, uv).rgb;
      }

      // ---- grading -------------------------------------------------------
      //
      // ## Why the pivot is 0.42 and not 0.5
      //
      // A contrast boost pivoted at 0.5 subtracts from *everything* below 0.5,
      // which in a frame whose shadows already sit around 0.25 means the
      // shadowed side of every wall gets darker the more contrast you ask for.
      // That is how this scene lost the surface detail on its shadow faces: the
      // material was drawing plaster and brick, and the grade was flattening it
      // to a silhouette. Pivoting below the midpoint puts the fulcrum in the
      // lower midtones, so contrast opens up the highlights — which is where a
      // sunlit exterior actually has room — instead of eating the shadows.
      // ## The toe runs BEFORE the contrast, not after
      //
      // A linear contrast about a pivot has a hard black point at
      // 'bp = P - P/C' — every input below it maps to a negative value and is
      // clamped to exactly zero. At the shipped contrast 1.14 / pivot 0.42 that
      // point is 0.0516, i.e. 13/255, and the clamp discarded a quarter of the
      // frame: a measured 326,816 pixels landed on exactly 0 against ~7,500 at
      // each of values 1-13, a 43x cliff that is a clamp rather than a natural
      // shadow rolloff.
      //
      // Applying the toe afterwards cannot undo that. It lifts zero to a flat
      // 6.6/255, but the *variation* below the black point has already been
      // destroyed, so shadowed faces come back as a uniform dark shape with the
      // plaster and brick detail gone. That is the whole reason this scene's
      // shadow sides read as silhouettes while its lit sides read as material.
      //
      // Lifting first puts the darkest values above the black point before the
      // contrast can clip them, so the contrast steepens detail that still
      // exists instead of erasing it.
      float toe = 1.0 - clamp(dot(color, vec3(0.333)) / 0.30, 0.0, 1.0);
      color += uLift * toe * toe;

      // ## Contrast, floored rather than clamped
      //
      // Even with the toe first, a steep enough contrast can still drive the
      // darkest pixels negative. Flooring at a small positive value rather than
      // at 0.0 keeps them distinguishable from each other: a shadow that is
      // uniformly 0.0 is a hole, one that varies between 0.004 and 0.02 is a
      // surface. The floor is well below anything the eye reads as lifted.
      color = (color - uPivot) * uContrast + uPivot;
      color = max(color, uShadowFloor) * uGain;

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);       // saturation

      // Temperature: push warm into R/B, cool the other way.
      color.r += uTemperature * 0.12;
      color.b -= uTemperature * 0.12;

      // ---- vignette ------------------------------------------------------
      // Falls off from the centre and reaches (1 - uVignette) in the corners,
      // so the control maps directly onto "how much darker the corners are".
      color *= 1.0 - uVignette * smoothstep(0.15, 0.72, r2 * 1.9);

      // ---- impact flash --------------------------------------------------
      if (uFlashStrength > 0.001) {
        color = mix(color, uFlashColor, clamp(uFlashStrength, 0.0, 1.0) * 0.75);
      }

      // ---- grain ---------------------------------------------------------
      if (uGrain > 0.0005) {
        float grain = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0) - 0.5;
        color += grain * uGrain;
      }

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `
};
