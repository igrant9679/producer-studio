# three.js (vendored bundle)

- **Source:** the npm package `three` at the version in the bundle's banner (r186, `three@0.186.1`, published
  2026-09-24), a dev dependency of `@producer/server`; https://github.com/mrdoob/three.js.
- **Licence:** MIT, Copyright © 2010-2026 three.js authors. `LICENSE` is the package's own, copied unchanged.
- **What is bundled, unmodified:** the core (`three`) and two of its examples,
  `examples/jsm/environments/RoomEnvironment.js` and `examples/jsm/geometries/RoundedBoxGeometry.js`.
- **Ours (not three.js's):** `entry.js` and `../../scripts/build-three.mjs`, which bundle them into `three.js`
  (minified, no other change).
- **Where it runs:** only inside the AI-drawing sandbox page (`src/media/drawing.ts`), and only for drawings whose code
  uses `env.stage3d` / `env.THREE` (the 3D drawing styles). It renders with WebGL on Chrome's software renderer
  (SwiftShader), so it needs no GPU.

To update: `npm i -D three@<version> -w @producer/server`, run `node apps/server/scripts/build-three.mjs`, update the
version above, and run the drawing tests.
