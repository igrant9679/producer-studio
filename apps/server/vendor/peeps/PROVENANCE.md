# Open Peeps (character art)

- Art: Open Peeps by Pablo Stanley, openpeeps.com, released under CC0 (public domain; no credit needed).
- Source: react-peeps (github.com/CeamKrier/react-peeps, branch master, last pushed 2023-10-05), which holds the
  Open Peeps drawings as React components; its code is MIT (`LICENSE`, from that repository).
- `peeps.json` is built from react-peeps' `src/peeps` by `scripts/build-peeps.mjs` (paths, fills and the head
  layout only; no React code). Rebuild: `node scripts/build-peeps.mjs <react-peeps>/src/peeps`; check with `--check`.
