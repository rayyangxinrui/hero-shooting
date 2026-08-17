/**
 * Compose `onBeforeCompile` callbacks.
 *
 * Several systems want to patch the same built-in material (CSM injects its
 * cascade lookup, we inject procedural colour). Assigning `onBeforeCompile`
 * naively would silently clobber whichever ran first, so all patching goes
 * through here.
 */
let _patchId = 0;

export function patchOnBeforeCompile(material, fn, cacheKey) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    fn.call(this, shader, renderer);
  };

  // --- the program cache key -------------------------------------------
  //
  // three's default is `onBeforeCompile.toString()`. Every material patched
  // through this helper gets the *same* wrapper function above, so every one
  // of them stringifies identically and they all collapse onto a single
  // compiled program — whichever compiled first wins, and the rest silently
  // render with someone else's shader.
  //
  // That is not a hypothetical: it is why gun steel, polymer, wood and the
  // glove all rendered as the same material. The patch bodies differ, but
  // three never saw a difference because it only ever looked at the wrapper.
  //
  // So give each patched material a genuinely distinct key. Callers that know
  // their variants pass an explicit `cacheKey` (materials sharing a key share
  // a program, which is the desirable case); anything else gets a unique id.
  const previousKey = material.customProgramCacheKey?.bind(material);
  const key = cacheKey ?? `patch-${(_patchId += 1)}`;
  material.customProgramCacheKey = function () {
    const base = previousKey ? previousKey() : '';
    // The base is the *default* implementation for an unpatched material, which
    // is the wrapper's source — useless and long. Drop it once we have our own.
    return cacheKey || previousKey ? `${base}|${key}` : key;
  };

  return material;
}

/**
 * Replace a token in a shader string, throwing in dev if the token vanished
 * after a three.js upgrade — silent no-ops here are painful to debug.
 */
export function replaceChunk(source, token, replacement) {
  if (!source.includes(token)) {
    console.warn(`[shaderPatch] token not found: ${token}`);
    return source;
  }
  return source.replace(token, replacement);
}

/** Prepend declarations to a shader stage. */
export function prependChunk(source, code) {
  return `${code}\n${source}`;
}
