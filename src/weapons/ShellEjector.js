import {
  InstancedMesh,
  CylinderGeometry,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  Quaternion,
  Euler,
  Color,
  DynamicDrawUsage
} from 'three';
import { LAYER } from '../core/Layers.js';

const CAPACITY = 48;
const _dummy = new Object3D();
const _vec = new Vector3();
const _camPos = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler();

/**
 * Ejected brass.
 *
 * Small, cheap, and one of the highest-value details in a shooter: a casing
 * tumbling out of the port, catching the sun and bouncing off the floor is the
 * clearest possible signal that the gun is a mechanism rather than a particle
 * emitter.
 *
 * Physics is a ballistic arc with one floor bounce and angular velocity — no
 * collision against the world, because a casing that lands 30 cm inside a crate
 * is invisible anyway and a real solve here costs more than the effect is worth.
 */
export class ShellEjector {
  constructor(scene) {
    this.scene = scene;

    // 5.45×39 brass: 39 mm long, 10 mm across.
    const geo = new CylinderGeometry(0.0048, 0.0052, 0.039, 8);
    this.geometry = geo;
    this.material = new MeshStandardMaterial({
      color: new Color('#c9a227'),
      roughness: 0.28,
      metalness: 1.0,
      envMapIntensity: 1.6
    });

    this.mesh = new InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER.WORLD);
    scene.add(this.mesh);

    this.shells = [];
    for (let i = 0; i < CAPACITY; i++) {
      this.shells.push({
        alive: false,
        position: new Vector3(),
        velocity: new Vector3(),
        spin: new Vector3(),
        rotation: new Vector3(),
        age: 0,
        life: 3.2,
        bounced: 0
      });
    }
    this.cursor = 0;

    // Park everything off-screen until it is used.
    _dummy.position.set(0, -1000, 0);
    _dummy.scale.setScalar(0.001);
    _dummy.updateMatrix();
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, _dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Vector3} position  the eject port, world space
   * @param {THREE.Camera} camera     supplies the right/up axes of the throw
   */
  eject(position, camera) {
    const shell = this.shells[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;

    shell.alive = true;
    shell.age = 0;
    shell.bounced = 0;
    shell.position.copy(position);

    // Out to the right and slightly up and back, in *camera* space — which is
    // where the port actually points on a right-handed rifle.
    _vec.set(1, 0, 0).applyQuaternion(camera.quaternion);
    shell.velocity.copy(_vec).multiplyScalar(2.4 + Math.random() * 1.1);
    _vec.set(0, 1, 0).applyQuaternion(camera.quaternion);
    shell.velocity.addScaledVector(_vec, 1.5 + Math.random() * 0.7);
    _vec.set(0, 0, 1).applyQuaternion(camera.quaternion);
    shell.velocity.addScaledVector(_vec, 0.4 + Math.random() * 0.5);

    shell.spin.set(
      (Math.random() - 0.5) * 34,
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 34
    );
    shell.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
  }

  update(dt) {
    if (dt <= 0) return;
    let dirty = false;

    for (let i = 0; i < CAPACITY; i++) {
      const shell = this.shells[i];
      if (!shell.alive) continue;

      shell.age += dt;
      shell.velocity.y -= 19 * dt;
      shell.position.addScaledVector(shell.velocity, dt);

      shell.rotation.x += shell.spin.x * dt;
      shell.rotation.y += shell.spin.y * dt;
      shell.rotation.z += shell.spin.z * dt;

      // One floor bounce, then it settles. Brass is not bouncy.
      if (shell.position.y < 0.006) {
        shell.position.y = 0.006;
        if (shell.bounced < 2 && Math.abs(shell.velocity.y) > 0.6) {
          shell.velocity.y = -shell.velocity.y * 0.32;
          shell.velocity.x *= 0.55;
          shell.velocity.z *= 0.55;
          shell.spin.multiplyScalar(0.45);
          shell.bounced++;
        } else {
          shell.velocity.set(0, 0, 0);
          shell.spin.set(0, 0, 0);
          // Lie flat once it has stopped rolling.
          shell.rotation.x = Math.PI / 2;
        }
      }

      if (shell.age >= shell.life) {
        shell.alive = false;
        _dummy.position.set(0, -1000, 0);
        _dummy.scale.setScalar(0.001);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        this.mesh.setMatrixAt(i, _dummy.matrix);
        dirty = true;
        continue;
      }

      // Fade by shrinking over the last third — an alpha fade would need a
      // transparent material and its sorting cost for a 1 cm object.
      const t = shell.age / shell.life;
      const scale = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;

      _dummy.position.copy(shell.position);
      _dummy.rotation.set(shell.rotation.x, shell.rotation.y, shell.rotation.z);
      _dummy.scale.setScalar(Math.max(0.001, scale));
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
      dirty = true;
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
