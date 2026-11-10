// What Producer Studio takes from anidoodle (Apache-2.0, see LICENSE, NOTICE and PROVENANCE.md): the art core (media,
// textures, shape helpers), the drawing marks (strokes that draw themselves, hatching, contours) and the photo
// analysis that steers marks from a picture. scripts/build-anidoodle.mjs bundles this into anidoodle.js, a browser
// script the AI-drawing sandbox (src/media/drawing.ts) loads as `window.anidoodle`.
export * as core from './src/core'
export * as marks from './src/drawingMarks'
export * as photo from './src/fromPhoto'
