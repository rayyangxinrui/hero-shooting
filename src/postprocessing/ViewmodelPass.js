import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Draws the first-person weapon over the already-rendered world.
 *
 * This cannot be a plain `RenderPass`. A RenderPass renders the *scene*, and
 * rendering a scene draws its `background` first — so a second RenderPass for
 * the viewmodel repaints the sky over everything the world pass just drew, and
 * the frame comes out as sky plus gun. Suppressing the background for the
 * duration of the pass is the whole reason this class exists.
 *
 * The depth buffer is cleared first and the colour buffer is not, which is what
 * guarantees the gun is never occluded by geometry the player is pressed
 * against while still compositing over the world. Because it writes into the
 * composer's buffer rather than to the screen, the weapon goes through bloom,
 * tone mapping and the grade with everything else — a gun that skipped those
 * would read as a sticker pasted on the frame.
 */
export class ViewmodelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.clear = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const previousBackground = this.scene.background;
    const previousAutoClear = renderer.autoClear;
    const previousTarget = renderer.getRenderTarget();

    this.scene.background = null;
    renderer.autoClear = false;

    // `readBuffer` is what the previous pass wrote and what the next pass will
    // read, so the gun has to land in *that* buffer, not in the write buffer.
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    this.scene.background = previousBackground;
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
  }

  dispose() {}
}
