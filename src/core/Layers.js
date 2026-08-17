/**
 * Render layers.
 *
 * WORLD       — opaque environment + monsters. Written to the depth prepass,
 *               receives shadows, is what soft particles fade against.
 * VFX         — every transparent ability mesh and particle system.
 * DISTORTION  — invisible-to-the-main-pass proxies that write screen-space UV
 *               offsets for heat shimmer / refraction.
 * CONTACT     — additional flag for the contact-shadow pass.
 * VIEWMODEL   — the first-person weapon. Drawn by its own camera at its own
 *               narrow fov *after* the world, so a rifle held 30 cm from the eye
 *               never clips through a wall the player is standing against. This
 *               is how every shooter does it; a single camera cannot express
 *               "near plane at 1 cm for this object and 10 cm for the world".
 */
export const LAYER = Object.freeze({
  WORLD: 0,
  VFX: 1,
  DISTORTION: 2,
  CONTACT: 3,
  VIEWMODEL: 4
});

/** Put an object and all of its descendants on a single layer. */
export function setLayerRecursive(object, layer) {
  object.traverse((node) => node.layers.set(layer));
  return object;
}

/** Add a layer to an object and all of its descendants, keeping existing ones. */
export function enableLayerRecursive(object, layer) {
  object.traverse((node) => node.layers.enable(layer));
  return object;
}
