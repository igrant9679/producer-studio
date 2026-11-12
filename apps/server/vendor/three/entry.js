// What the AI-drawing sandbox takes from three.js (MIT, see LICENSE and PROVENANCE.md): the whole core plus two of its
// examples, RoomEnvironment (a soft studio light to reflect, the base of every lit 3D look) and RoundedBoxGeometry.
// scripts/build-three.mjs bundles this into three.js, a browser script the sandbox (src/media/drawing.ts) loads as
// `window.THREE` only for drawings that use 3D.
export * from 'three'
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
export { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
