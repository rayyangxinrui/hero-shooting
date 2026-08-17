import {
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  BufferAttribute,
  Mesh,
  ShaderMaterial,
  AdditiveBlending,
  Sphere,
  Vector3,
  DynamicDrawUsage
} from 'three';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';

const CAPACITY = 96;

/**
 * Bullet tracers — the visible half of a hitscan shot.
 *
 * A tracer is not the bullet. The damage was resolved instantly at the trigger
 * pull; this is a light streak that *travels* the same path afterwards, which is
 * what makes fire read as ballistic without putting travel time between the
 * crosshair and the hit. Every shooter does exactly this.
 *
 * One instanced quad per tracer, camera-facing, stretched along the shot axis in
 * the vertex shader. The whole flight — head position, tail length, taper, fade
 * — is a function of `(uTime - aSpawn)`, so the CPU writes six numbers at the
 * trigger pull and then never touches the tracer again.
 */
export class TracerSystem {
  constructor(scene) {
    this.scene = scene;
    this.cursor = 0;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.aStart = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(
      DynamicDrawUsage
    );
    this.aEnd = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(
      DynamicDrawUsage
    );
    this.aSpawn = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1).setUsage(
      DynamicDrawUsage
    );
    this.aSeed = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1).setUsage(
      DynamicDrawUsage
    );
    this.aSpawn.array.fill(-1000);

    geometry.setAttribute('aStart', this.aStart);
    geometry.setAttribute('aEnd', this.aEnd);
    geometry.setAttribute('aSpawn', this.aSpawn);
    geometry.setAttribute('aSeed', this.aSeed);
    geometry.instanceCount = CAPACITY;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      uniforms: sharedUniforms({
        uSpeed: { value: settings.combat.tracerSpeed },
        uLength: { value: settings.combat.tracerLength },
        uWidth: { value: settings.combat.tracerWidth },
        uLife: { value: settings.combat.tracerLife }
      }),
      vertexShader: /* glsl */ `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute float aSpawn;
        attribute float aSeed;

        uniform float uTime;
        uniform float uSpeed;
        uniform float uLength;
        uniform float uWidth;
        uniform float uLife;

        varying float vAlpha;
        varying vec2  vUv;
        varying float vSeed;

        void main() {
          float age = uTime - aSpawn;
          vSeed = aSeed;

          vec3 axis = aEnd - aStart;
          float total = length(axis);
          if (total < 0.0001 || age < 0.0 || age > uLife) {
            // Park dead instances on the near plane behind the camera.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vAlpha = 0.0;
            vUv = uv;
            return;
          }
          axis /= total;

          // Where the head of the streak is, and how long the streak is. The
          // tail is clamped at the muzzle so a tracer never appears detached
          // from the gun on the first frame.
          float travel = age * uSpeed;
          float head = min(travel, total);
          float tail = max(0.0, head - uLength);

          // Fade in the last stretch rather than at a fixed time: a tracer that
          // hits a wall 4 m away must not linger for the full lifetime.
          float arrived = step(total, travel);
          float arrivedAge = max(0.0, travel - total) / max(0.0001, uSpeed);
          float fade = 1.0 - smoothstep(0.0, 0.09, arrivedAge * mix(0.0, 1.0, arrived));
          vAlpha = fade;

          vec3 headPos = aStart + axis * head;
          vec3 tailPos = aStart + axis * tail;

          vec3 center = mix(tailPos, headPos, uv.x);
          vec3 segment = headPos - tailPos;

          // Camera-facing ribbon: width is perpendicular to both the shot axis
          // and the view ray, so the streak keeps its thickness at any angle.
          vec4 viewCenter = viewMatrix * vec4(center, 1.0);
          vec3 viewAxis = normalize((viewMatrix * vec4(segment, 0.0)).xyz + vec3(1e-6));
          vec3 viewSide = normalize(cross(viewAxis, vec3(0.0, 0.0, 1.0)) + vec3(1e-6));

          // Taper: thin at the tail, full at the head.
          float w = uWidth * mix(0.25, 1.0, uv.x);
          viewCenter.xyz += viewSide * (uv.y - 0.5) * 2.0 * w;

          vUv = uv;
          gl_Position = projectionMatrix * viewCenter;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vAlpha;
        varying vec2  vUv;
        varying float vSeed;
        uniform float uGlobalGlow;

        void main() {
          if (vAlpha <= 0.001) discard;

          // Hot white core inside a copper halo — a real tracer is burning
          // phosphor, so the head is white and the wake cools.
          float across = abs(vUv.y - 0.5) * 2.0;
          float core = 1.0 - smoothstep(0.0, 0.42, across);
          float halo = 1.0 - smoothstep(0.0, 1.0, across);

          float along = vUv.x;
          float headHeat = smoothstep(0.55, 1.0, along);

          vec3 cool = vec3(1.0, 0.42, 0.12);
          vec3 warm = vec3(1.0, 0.78, 0.42);
          vec3 hot  = vec3(1.0, 0.97, 0.9);

          vec3 color = mix(cool, warm, along);
          color = mix(color, hot, headHeat * core);

          float alpha = (core * 0.9 + halo * 0.35) * vAlpha;
          alpha *= mix(0.35, 1.0, along);

          gl_FragColor = vec4(color * (1.0 + headHeat * 1.6) * uGlobalGlow, alpha);
        }
      `,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);

    this._dirty = false;
  }

  /**
   * @param {THREE.Vector3} from  the muzzle
   * @param {THREE.Vector3} to    where the round landed
   */
  spawn(from, to) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CAPACITY;

    const i3 = i * 3;
    this.aStart.array[i3] = from.x;
    this.aStart.array[i3 + 1] = from.y;
    this.aStart.array[i3 + 2] = from.z;
    this.aEnd.array[i3] = to.x;
    this.aEnd.array[i3 + 1] = to.y;
    this.aEnd.array[i3 + 2] = to.z;
    // Stamped from the shared frame clock, which is what the shader reads —
    // keeping a second clock here would drift the instant the sim is paused.
    this.aSpawn.array[i] = frame.uTime.value;
    this.aSeed.array[i] = Math.random();
    this._dirty = true;
  }

  update() {
    this.material.uniforms.uSpeed.value = settings.combat.tracerSpeed;
    this.material.uniforms.uLength.value = settings.combat.tracerLength;
    this.material.uniforms.uWidth.value = settings.combat.tracerWidth;
    this.material.uniforms.uLife.value = settings.combat.tracerLife;

    if (this._dirty) {
      this.aStart.needsUpdate = true;
      this.aEnd.needsUpdate = true;
      this.aSpawn.needsUpdate = true;
      this.aSeed.needsUpdate = true;
      this._dirty = false;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
