# Phase 5, release 1: the editor

Five groups build at once, all inside the editor, so file ownership matters. Each group OWNS the files listed
for it (large edits fine); a file owned by another group gets only small, additive edits, called out in the report.
Shared everywhere (small additive edits only, new logic in new files): packages/core/src/ops.ts, types.ts,
index.ts, apps/web/src/editor/actions.ts, store.ts, shortcuts.ts, editor.css, apps/web/src/shell/modals.tsx
(shortcut list). No group adds a database migration in this release. Base: main at the Phase 4 push (c51c681).

## R1-A timeline editing — branch `p5-r1-timeline`, test database `ps_test_r1a`
Enhancements: E-1, E-6, E-7, E-9, E-24, E-25, E-26.
- E-1 linked groups: a video and its separated audio (same `linkId`) split, trim, move and delete together
  everywhere (timeline drags, trims, keyboard, context menu, transcript cuts, the assistant's tools); Link /
  Unlink in the clip menu; an Attach shortcut for linking a selected video and audio. Phase 2 and 4 did parts
  (split carries linked audio, a main-track drag moves linked audio): find what's missing and finish it.
- E-6 snapping to clip edges, markers, keyframes and the playhead while dragging and trimming (with the existing
  snapping toggle, S); markers: M adds one at the playhead, they show on the ruler, can be named, moved, deleted,
  and jumped to; beat detection on a music clip (server or client analysis of the waveform data the app already
  has) that adds beat markers.
- E-7 zoom around the playhead (keyboard and Ctrl+wheel keep the playhead in place), Shift+wheel scrolls
  horizontally, Shift+Z fits the whole project.
- E-9 files dropped from the desktop onto the timeline upload and land on the timeline at the pointer (track and
  time), not just in the library.
- E-24 a freeze duration control and "freeze at end of clip".
- E-25 a history panel listing undo steps by label; click to jump back or forward.
- E-26 keyboard shortcuts shown in tooltips (the tooltip helper takes a key hint; use it across the editor).
OWNS: Timeline.tsx, timelineMath.ts, new files for markers/snapping/links/history.

## R1-B audio — branch `p5-r1-audio`, test database `ps_test_r1b`
Enhancements: E-13, E-14, E-15.
- E-13 audio crossfades during video transitions (both clips' sound overlaps and fades across the transition, in
  preview and export), and J and L cuts (audio of a linked clip leads or trails its video: trim the audio edge
  independently of the video, a modifier on the trim handle).
- E-14 music ducking under speech (a per-track or per-clip "duck under voice" that lowers music while voice or
  speech clips play, preview and export), loudness normalisation on export (target LUFS presets, e.g. -14 for
  YouTube / -16 podcasts, via ffmpeg loudnorm in the render pipeline), solo and per-track volume (track header
  controls; preview and export honour them).
- E-15 a volume rubber band drawn on the clip (drag to set volume keyframes) and fade handles on the clip edges.
OWNS: compile.ts audio parts, the audio parts of runtime.ts, apps/server/src/render/export.ts audio/loudness
steps, a new clip-overlay component for the rubber band and fade handles (mount it from Timeline.tsx with a
small edit), track header volume/solo (small edit in Timeline.tsx; coordinate by keeping it in its own component).

## R1-C captions and transcript — branch `p5-r1-captions`, test database `ps_test_r1c`
Enhancements: E-11, E-12.
- E-11 Descript-style transcript editing: deleting words strikes them through (restorable) instead of vanishing,
  restore brings the source back; speaker labels (detected where the transcriber gives them, otherwise
  editable/assignable); a filler-word list with per-word toggles (um, uh, like, you know… editable list);
  captions follow transcript edits (cutting words updates the caption lines over that range).
- E-12 a caption line editor: retime (drag or numeric), split and merge lines, edit karaoke word timings; import
  and export VTT, SRT, ASS and LRC (SRT may already exist: check); several caption tracks and languages per
  project (a language label per caption track; export picks which one to burn in or sidecar).
OWNS: panels/TranscriptPanel.tsx, panels/CaptionsPanel.tsx, core caption/transcript ops (move them to a new
packages/core/src/captions.ts if you restructure), server caption routes.

## R1-D canvas, text, keyframes — branch `p5-r1-canvas`, test database `ps_test_r1d`
Enhancements: E-16, E-18, E-19.
- E-16 keyframe editing: keyframe marks on the clip/timeline lane draggable, ease per keyframe, previous/next
  keyframe buttons, copy and paste keyframes, a curve editor (bezier ease) for a property. Easing must evaluate
  identically in preview and export (core evaluate).
- E-18 canvas snapping to canvas edges/centre, other objects and platform safe zones (TikTok / Reels / Shorts
  overlays toggle), rulers and draggable guides, align and distribute for multi-selection, multi-select
  transform, crop handles on the canvas.
- E-19 text that fits its box (auto-shrink option), per-word styling (colour/weight on a word range), a text
  effects library (a set of presets: outline, glow, shadow, gradient, neon...), templates/presets that adapt to the
  canvas shape (phase 4 EDT-20 sized them; check), and a warning when the text holds characters the export can't
  draw (phase 3 PIP-15 shipped fonts; warn for characters no bundled font covers).
OWNS: Canvas.tsx, PropertiesPanel.tsx (keyframe and text sections), core evaluate.ts text/easing parts, new files
for the curve editor, guides and text effects.

## R1-E playback and export — branch `p5-r1-export`, test database `ps_test_r1e`
Enhancements: E-5, E-8, E-23, E-10.
- E-5 export a range or the selection; audio only (MP3, WAV); captions burned in or as a sidecar file (SRT/VTT)
  downloaded alongside; platform presets (YouTube 16:9 1080p, Shorts/Reels 9:16, LinkedIn 1:1/4:5) that set
  size/fps/quality; a cover/thumbnail picker for the export; export in the background with a notification
  (browser notification if permitted, plus an in-app toast with Open) so people keep working.
- E-8 JKL shuttle (J/K/L, repeated L speeds up), in and out points (I/O) with loop playback, preview speed
  (0.5×–2×), a proxy/full-quality preview toggle, the next clip preloaded (phase 4 EDT-9 preloads: check).
- E-23 a quick draft render of a selected range (low resolution, fast, using the existing export pipeline with a
  range and draft quality), shown in a player in the export dialog.
- E-10 replace clip (swap a clip's media keeping its timing, effects and keyframes: from the library via the
  clip menu or by dropping media onto a clip with a modifier) and split by scene detection (server job using
  ffmpeg scene detection on the clip's source, returning cut times; the editor splits at them).
OWNS: Dialogs.tsx (export dialog), playback.ts, TopBar.tsx, apps/server/src/render/export.ts (except R1-B's
audio/loudness steps: keep yours in separate functions), routes for export options and scene detection.
