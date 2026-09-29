/**
 * canvasAdapter.js
 * -----------------------------------------------------------------------------
 * Supplies the browser classes (Canvas, Image, ImageData) that face-api needs in
 * order to run under Node, from whichever canvas package is actually installed.
 *
 * Two backends, tried in order:
 *
 *   1. `canvas` (node-canvas)  — the reference implementation. Needs a prebuilt
 *      binary for your platform and Node ABI, or a C++ toolchain to compile.
 *
 *   2. `@napi-rs/canvas`       — ships prebuilt binaries as platform-specific
 *      optional dependencies. Nothing ever compiles, which makes it the
 *      dependable choice on Windows and on brand-new Node releases where
 *      node-canvas has no prebuild yet.
 *
 * If node-canvas is installed and working, nothing changes: this file hands back
 * exactly what it did before. The adapter only comes into play as a fallback.
 */

'use strict';

/** face-api does `new env.Canvas()` with no arguments, then assigns .width and
 *  .height afterwards. node-canvas tolerates that; @napi-rs/canvas requires the
 *  dimensions up front and throws without them. Defaulting to 1x1 gives
 *  face-api a valid object to resize. */
function makeLenientCanvas(NapiCanvas) {
  return class Canvas extends NapiCanvas {
    constructor(width, height) {
      super(width || 1, height || 1);
    }
  };
}

function load() {
  // --- Backend 1: node-canvas -------------------------------------------
  try {
    const nodeCanvas = require('canvas');
    return {
      backend: 'canvas',
      Canvas: nodeCanvas.Canvas,
      Image: nodeCanvas.Image,
      ImageData: nodeCanvas.ImageData,
      loadImage: nodeCanvas.loadImage,
    };
  } catch (err) {
    // MODULE_NOT_FOUND means it simply is not installed, which is the case we
    // are here to handle. Anything else (a corrupt build, a missing DLL) is a
    // real problem and should not be swallowed behind a confusing fallback.
    if (err.code !== 'MODULE_NOT_FOUND' || !/'canvas'/.test(err.message)) {
      throw err;
    }
  }

  // --- Backend 2: @napi-rs/canvas ---------------------------------------
  try {
    const napi = require('@napi-rs/canvas');
    return {
      backend: '@napi-rs/canvas',
      Canvas: makeLenientCanvas(napi.Canvas),
      Image: napi.Image,
      ImageData: napi.ImageData,
      loadImage: napi.loadImage,
    };
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  // --- Neither is available ---------------------------------------------
  throw new Error(
    'No canvas implementation is installed.\n\n' +
      'face-api needs one to decode images in Node. Install either:\n\n' +
      '  npm install @napi-rs/canvas     (prebuilt binaries, never compiles)\n' +
      '  npm install canvas              (needs a prebuild or a C++ toolchain)\n\n' +
      'On Windows and on very new Node versions, prefer @napi-rs/canvas.'
  );
}

module.exports = load();
