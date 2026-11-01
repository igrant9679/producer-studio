# Phase 5, release 2: saves, collaboration, looks

Five groups build at once. Each group OWNS the files listed for it (large edits fine); a file owned by another
group gets only small, additive edits, called out in the report. Shared everywhere (small additive edits only, new
logic in new files): packages/core/src/ops.ts, types.ts, index.ts, api.ts, evaluate.ts, runtime.ts, compile.ts,
apps/web/src/editor/actions.ts, store.ts, shortcuts.ts, editor.css, PropertiesPanel.tsx, Timeline.tsx,
apps/web/src/shell/modals.tsx (shortcut list), apps/web/src/shell/dev/mockApi.ts, apps/server/src/db/migrate.ts,
schema.ts. Base: main after release 1 (the coordinator tells you the commit in your prompt).

Release 1 added (read before building, reuse rather than duplicate): core `links.ts`, `markers.ts`, `freeze.ts`,
`audio.ts` (every clip's level, preview and export), `captions.ts`/`captionLines.ts`/`transcript.ts`,
`keyframes.ts` (easing incl. cubic-bezier), `text.ts`/`textEffects.ts`/`glyphs.ts`, `exporting.ts` (export
options: range, aspect, captions, cover, audio-only, draft preview), `replace.ts`; web `HistoryPanel.tsx`,
`Markers.tsx`, `KeyframePanel.tsx`, `CurveEditor.tsx`, `CanvasGuides.tsx`, `AlignTools.tsx`, `TextTools.tsx`,
`TransportControls.tsx`, `clipMedia.tsx`, `audio/`; server `render/loudness.ts`, the `media.scenes` job.

**Migrations:** only R2-A (number 10) and R2-E (number 11) may add one. Append to the ordered list in
`apps/server/src/db/migrate.ts` (never edit a shipped entry), idempotent SQL (`IF NOT EXISTS`), mirrored in
`schema.ts`, and run the affected server tests against your own Postgres database too.

## R2-A saves — branch `p5-r2-saves`, test database `ps_test_r2a`, migration v10
Enhancements: E-2, E-3, P-15, P-14, P-16.
- E-2 a local journal of unsaved edits (IndexedDB or localStorage, per project and user; survives closing the tab
  and a crash; offered back on reopen with "Restore unsaved changes / Discard"), and honest save states in the top
  bar: Saved, Saving…, Offline (will retry, with the real retry happening), Sign in again (401: keep the journal,
  re-save after sign-in), Too large (413: say what is large), Conflict, Failed (with Retry). Never claim "will
  retry" unless a retry is scheduled.
- P-15 server-side version history: keep the last N saves per project (N = env `PROJECT_VERSIONS_KEEP`, default
  50, plus one per hour for the last 7 days thinned beyond), with author, time, size and a label (autosave /
  named / before restore / before AI). Routes to list, read and restore (restore is itself a new version;
  editors only).
- E-3 a Version history panel in the editor (list, preview a version read-only on the canvas, restore, name a
  version), and automatic merging: when a save hits a version conflict, rebase the local changes on the server's
  version when they don't overlap (`rebase.ts` exists: extend it), and only show the conflict choice when they do.
- P-14 a base version (or ETag/If-Match) on every update route that can lose an edit (project rename, asset
  rename/meta, brand kit, workspace settings), and idempotency keys (`Idempotency-Key` header, stored with a TTL)
  on export, voice/TTS and other job-creating POSTs so a retry never makes a second job.
- P-16 live updates that resume after a reconnect (event ids, `Last-Event-ID`, a bounded replay buffer or the
  change feed) and close when the user's access changes (removed from the space, role lowered, signed out).
OWNS: apps/web/src/editor/persistence.ts, rebase.ts, the save/version parts of store.ts, TopBar save status,
a new VersionsPanel, apps/server/src/routes/projects.ts (save/versions), apps/server/src/events.ts and the live
update stream in apps/web/src/shell/stores.ts / lib/api.ts, a new idempotency middleware.

## R2-B colour — branch `p5-r2-colour`, test database `ps_test_r2b`
Enhancement: E-20.
- HSL adjustments (per-hue-range hue/saturation/lightness), curves (RGB master + per channel, a curve editor
  reusing the R1 curve editor's interaction patterns), LUT upload (.cube; stored as a library asset or project
  file, applied in preview AND export identically: implement in the core runtime, e.g. WebGL or canvas LUT
  sampling that headless Chrome also runs), scopes (waveform, vectorscope, histogram of the current frame, in a
  panel), copy and paste attributes across clips (colour, effects, transform, speed, volume: a "Paste attributes"
  dialog with checkboxes), adjustment layers (a new item type on an overlay track whose colour/effects apply to
  everything beneath it for its duration, preview and export).
OWNS: the colour / effects sections of PropertiesPanel (move them to a new ColourPanel file), core colour code
(new packages/core/src/colour.ts), the colour/filter parts of runtime.ts and compile.ts, a new Scopes component.

## R2-C smart tools — branch `p5-r2-smart`, test database `ps_test_r2c`
Enhancement: E-21.
- Masks: shape masks (rectangle, ellipse, a drawn path) on a clip with feather, invert and expansion, keyframable,
  drawn on the canvas with handles; preview and export identical.
- Chroma key: key colour picker (eyedropper on the canvas), tolerance, softness, spill suppression; preview and
  export identical (runtime).
- Background removal: a server job producing an alpha-matted copy of a clip's source (WebM with alpha or PNG
  sequence). No new npm dependency: if no model or tool is available on the machine, build the mechanism behind an
  env setting (e.g. `BG_REMOVAL_CMD`), off by default, with the UI saying it is not set up; report it as an owner
  item. Don't download models.
- Stabilisation: a server job using ffmpeg (vidstabdetect/vidstabtransform when the build has libvidstab, else
  deshake), producing a stabilised copy that replaces the clip's media in one undo step (reuse R1's replace).
- Denoise: audio denoise (ffmpeg afftdn / arnndn if a model ships) and video denoise (hqdn3d / nlmeans) as server
  jobs producing a cleaned copy; or as export-time filters where cheaper, preview noting it.
OWNS: new packages/core/src/masks.ts and key.ts, their runtime parts (new files mounted from runtime.ts with a
small edit), a new Smart tools tab/section in the Properties panel (own file, mounted with a small edit), new
server jobs under apps/server/src/media/ (one file per tool) and their routes.

## R2-D speed — branch `p5-r2-speed`, test database `ps_test_r2d`
Enhancement: E-17.
- Speed ramps: speed keyframes over a clip (presets: ramp up, ramp down, montage, hero, bullet) with the source
  time mapping computed in core so preview, export, trims, splits, the transcript and captions all agree.
- Pitch toggle: keep the voice's pitch at any speed (preview `preservesPitch`; export the same, check how the
  export renders sound and make it match) or let it shift.
- Smooth slow motion: frame blending / optical flow (ffmpeg `minterpolate`) as a server job making a smooth copy
  for slowed clips, used in preview and export; the clip shows it is processing.
OWNS: core speed / time-mapping code (move it to a new packages/core/src/speed.ts), the Speed tab of the Properties
panel (move it to a new SpeedPanel file; R1-A's freeze controls stay in it), the timing parts of runtime.ts and
compile.ts, a new server job for smooth slow motion.

## R2-E collaboration — branch `p5-r2-collab`, test database `ps_test_r2e`, migration v11
Enhancements: E-22, A-23, A-16, plus the editor's viewer mode.
- Viewer mode (found in R1): the editor has no read-only mode; a viewer can change a project locally and every
  save then fails. Make the editor read-only for viewers and for share-link visitors: a store flag from the
  workspace role, `commit()` refuses, every write control, drag, shortcut, menu item and AI tool disabled with the
  viewer tooltip (`useEditGate` / `viewOnlyTip`), play / scrub / export-if-allowed / comment still work.
- E-22 timecoded review comments: on the share page and in the editor, a comment pinned to a time (and optionally
  a point on the frame), threaded replies, resolve/reopen, shown as marks on the timeline ruler and in a Comments
  panel; share-page visitors comment with a name (no account) when the link allows comments.
- A-23 presence and an activity feed: who has the project open now (avatars in the editor top bar, live, through
  the live-update stream; R2-A owns the stream transport, use its publish function), a per-space activity feed
  (created, renamed, exported, shared, commented, member changes) on a page in the shell.
- A-16 share-link management: a list of a project's (and the space's) share links with created by / views /
  last viewed, revoke, expiry, password, allow download, allow comments; the share page honours each.
OWNS: apps/server/src/routes/share.ts (except R1-E's export schema lines), new comments and activity routes and
tables, apps/web share page, a new Comments panel and ruler marks (own component, mounted from Timeline with a
small edit), presence avatars (own component in the top bar), the activity page, the share-link management UI, the
viewer flag in store.ts.
