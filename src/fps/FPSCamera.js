import { PerspectiveCamera, Vector3, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';

const _offset = new Vector3();

/**
 * The first-person rig: two cameras that share a transform.
 *
 * `camera` draws the world. `viewCamera` draws only the VIEWMODEL layer, at a
 * narrower fov and with a near plane at 1 cm. They are separate because a
 * single camera cannot hold a rifle 30 cm from the eye and a corridor 40 m away
 * without either clipping the gun through walls or wrecking depth precision.
 * Every shipped shooter splits them; this is the same split.
 *
 * The fov here is authored horizontally (90 is what a CS player means by 90)
 * and converted to the vertical fov three wants, against the live aspect ratio.
 */
export class FPSCamera {
  constructor(aspect = 16 / 9) {
    this.aspect = aspect;

    this.camera = new PerspectiveCamera(70, aspect, 0.06, 400);
    this.camera.layers.enable(LAYER.WORLD);
    this.camera.layers.enable(LAYER.VFX);
    this.camera.rotation.order = 'YXZ';

    this.viewCamera = new PerspectiveCamera(settings.weapons.viewmodelFov, aspect, 0.01, 12);
    this.viewCamera.layers.disableAll();
    this.viewCamera.layers.enable(LAYER.VIEWMODEL);
    this.viewCamera.rotation.order = 'YXZ';

    this.fov = settings.player.fov;
    this.fovTarget = settings.player.fov;
    this.shakeOffset = new Vector3();
    this.shakeRoll = 0;

    this.setAspect(aspect);
  }

  /** Horizontal fov in degrees → three's vertical fov, for this aspect. */
  static horizontalToVertical(hfovDeg, aspect) {
    const h = MathUtils.degToRad(hfovDeg);
    return MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect));
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.viewCamera.aspect = aspect;
    this.camera.fov = FPSCamera.horizontalToVertical(this.fov, aspect);
    // The viewmodel fov is authored vertically — it is a framing choice for one
    // object, not a field of view onto the world.
    this.viewCamera.fov = settings.weapons.viewmodelFov;
    this.camera.updateProjectionMatrix();
    this.viewCamera.updateProjectionMatrix();
  }

  /** Ask for a horizontal fov; it is chased rather than snapped. */
  requestFov(hfovDeg) {
    this.fovTarget = hfovDeg;
  }

  /**
   * @param {PlayerController} player
   * @param {number} dt
   */
  update(player, dt) {
    const p = settings.player;

    /* ---- fov ---- */
    const target = this.fovTarget;
    this.fov += (target - this.fov) * Math.min(1, p.fovLerp * dt);
    if (Math.abs(this.fov - target) > 0.01) {
      this.camera.fov = FPSCamera.horizontalToVertical(this.fov, this.aspect);
      this.camera.updateProjectionMatrix();
    }

    /* ---- position: eye + bob + landing dip + shake ---- */
    _offset.copy(player.bobOffset);
    // The bob is authored in view space, so it has to be rotated into the world
    // by the yaw — otherwise the gun sways north-south no matter where you face.
    const cos = Math.cos(player.euler.y);
    const sin = Math.sin(player.euler.y);
    const bx = _offset.x * cos - _offset.z * sin;
    const bz = _offset.x * sin + _offset.z * cos;

    this.camera.position.set(
      player.position.x + bx + this.shakeOffset.x,
      player.position.y + _offset.y + player.landDip + this.shakeOffset.y,
      player.position.z + bz + this.shakeOffset.z
    );

    this.camera.rotation.set(player.euler.x, player.euler.y, player.viewRoll + this.shakeRoll, 'YXZ');

    this.viewCamera.position.copy(this.camera.position);
    this.viewCamera.rotation.copy(this.camera.rotation);
  }

  /** Additive shake, written by the shake system each frame. */
  setShake(x, y, z, roll = 0) {
    this.shakeOffset.set(x, y, z);
    this.shakeRoll = roll;
  }
}
