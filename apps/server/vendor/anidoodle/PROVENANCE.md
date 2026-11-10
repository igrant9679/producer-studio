# anidoodle (vendored)

- **Source:** https://github.com/alexgreensh/anidoodle, commit `4ae27d2c281fcfd01bce87ab13dc5ad4df81a795`
  (2026-11-05), from `plugins/anidoodle/skills/anidoodle/engine/src/canvas-core/`.
- **Licence:** Apache License 2.0, Copyright 2026 Alex Greenshpun. `LICENSE` and `NOTICE` are the project's own,
  copied unchanged.
- **Files, unmodified:** `src/core.ts` (the art core: media, texture tiles, shape helpers, the `Gfx` drawing surface),
  `src/drawingMarks.ts` (strokes that draw themselves, hatching, contours), `src/fromPhoto.ts` (analysis fields that
  let a photo steer the marks).
- **Ours (not anidoodle's):** `entry.ts` and `../../scripts/build-anidoodle.mjs`, which bundle the three files into
  `anidoodle.js` (minified, no other change). The NOTICE's third-party material (the sound pack, the Van Gogh reference
  image) is not used or redistributed here.
- **Where it runs:** only inside the AI-drawing sandbox page (`src/media/drawing.ts`), as `env.doodle`, `env.shapes`,
  `env.marks` and the photo sketch (`src/media/sketch.ts`).

To update: copy the three files from a newer commit, update the hash above, run
`node apps/server/scripts/build-anidoodle.mjs`, and run the drawing tests.
