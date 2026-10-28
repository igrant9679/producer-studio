# Producer Studio — architecture

Cloud-hosted, multi-user web app: Producer's AI video production (recording → transcript → Claude script →
narration → assembled branded video) fused with a full CapCut-class timeline editor. Feature inventory:
[capcut-analysis.md](capcut-analysis.md).

```
apps/web      React 18 + Vite + TS + zustand. App shell (auth, home, library, templates, Voice Studio,
              Producer AI wizard, brand kit) and the editor (/edit/:id).
apps/server   Node 22, Hono. REST API + SSE + job worker (same codebase; ROLE=all|api|worker).
packages/core Shared project model, pure editing ops, evaluate() frame evaluator, StageRenderer (DOM),
              compileToHyperFrames(). Used by web (preview), server (AI assistant ops, export) and the
              export composition (runtime.js bundle).
```

## Rendering: one evaluator, two renderers
- **Preview** (browser): `StageRenderer` in `preview` mode draws `evaluate(project, t)` into a scaled stage div,
  owning `<video>`/`<audio>` playback (proxy media, native play with drift correction).
- **Export** (worker): `compileToHyperFrames(project)` writes `index.html` where every video/audio item is a timed
  HyperFrames media element (`data-start`, `data-duration`, `data-media-start`, `data-playback-rate`,
  `data-automation` volume lanes) and one paused GSAP timeline calls `StageRenderer.render(t)` in `export` mode.
  `hyperframes render` produces the MP4. Freeze frames → ffmpeg-extracted stills; reverse → pre-reversed proxy.
- **Sound** (`packages/core/src/audio.ts`): one function decides every clip's level (keyframes and fades, track
  volume, solo, crossfades across transitions, ducking under voiceovers and transcribed speech). `evaluate()` hands
  it to the preview; the compiler samples it into the volume lanes (a lane past 512 points becomes several
  elements on the same sound with 20 ms hand-overs). An export with a loudness target (YouTube -14, Podcast -16,
  Broadcast -23 LUFS) gets a two-pass ffmpeg `loudnorm` after the render (`apps/server/src/render/loudness.ts`),
  the picture copied untouched.
- **Export options** (`ExportRequest`): the job renders `projectForExport(project, request)` (core `exporting.ts`):
  a `range` is cut out of the edit as a split would cut it and starts at 0; `aspect` reframes a copy to a platform
  shape (as the ratio menu does); `captions` burns in all or one caption track, or leaves them out, and `sidecar`
  also writes an SRT/WebVTT file next to the export's file (`assets.meta.captions`, served by
  `GET /api/exports/:id/captions`). `mp3`/`wav` render the composition small at 10 fps and keep only its sound
  (ffmpeg), so audio-only exports sound exactly like the video. `coverAt` picks the thumbnail/poster frame.
- **Draft preview** (`preview: true`): the same pipeline at 360p, 24 fps, draft quality; the file goes to
  `ws/<workspace>/previews/<project>/<job>.mp4` (only the latest per project is kept, no export row, no asset) and
  `GET /api/projects/:id/previews/:jobId` plays it in the export dialog.
- Anything that changes the picture lives in core so both renderers get it: keyframe easing including custom
  cubic-bezier curves (`util.cubicBezier`, fixed iterations), per-word text spans and gradient fills
  (`text.ts`), and shrink-to-fit text, which `StageRenderer` measures in the DOM with a fixed search
  (`text.fitScale`) and re-measures when a font finishes loading (it also asks for every face the project's text
  uses up front, so the export's page waits for them). `glyphs.ts` lists which characters the export's fonts
  cover, for the editor's warning.
- **Colour grading** (`colour.ts`, `gradeRuntime.ts`): a clip's `grade` (tone curves, HSL by eight hue ranges, a
  3D LUT from a `.cube` file) is pixel work the CSS filter can't do. `StageRenderer` runs it in one WebGL context
  per renderer (a fragment shader that is `colour.gradePixel` line for line; the CPU fallback and the tests call
  `gradePixel` itself) and copies the result into a 2D canvas laid over the clip, the plain picture hidden under
  it. LUTs are kept in the project document (`project.luts`, at most 33³ points, bytes in base64), so they travel
  inside the export's composition with nothing else to ship. In the export, HyperFrames shows each video frame as
  an `<img class="__render_frame__">` next to the `<video>` after the timeline has been seeked; the renderer
  listens for `load` (capture) on its stage and grades that frame before the screenshot. Adjustment layers
  (`type: 'adjustment'` on an overlay track) draw a full-canvas element with `backdrop-filter` (their basic colour,
  filter and colour effects reach everything beneath, text included) and add their curves/HSL/LUT to every clip
  and image beneath (`spreadAdjustments`). The blurred letterbox fill behind a main-track clip is not graded.
  Verified 28 Oct 2026 with a real 1 s, 320×180 HyperFrames render (curves + HSL + LUT on colour bars, then an
  adjustment layer at saturation -100): every bar came out within 6 levels of `gradePixel` (an ungraded render
  shows the same few levels of encoder offset), and the adjustment layer's half was grey.
- Verified 23 Sept 2026: lint 0/0, 10 s 720p render in ~22 s with title, captions, push transition, audio.

## Data
- **Postgres** (prod `DATABASE_URL`) / **PGlite** embedded (dev, `.data/pg`), via Drizzle.
- Tables: `users`, `sessions`, `workspaces`, `memberships(role)`, `projects(id, workspace_id, name, doc jsonb,
  version, thumbnail, duration, width, height, is_template, trashed_at, created_by, timestamps)`,
  `assets(id, workspace_id, kind, name, mime, size, storage keys, meta jsonb, status)`, `jobs(id, kind,
  status, progress, message, input jsonb, result jsonb, error, project_id, workspace_id, user_id,
  timestamps, locked_by, locked_at)`, `exports`, `share_links(token, project_id, export_id, expires_at,
  password_hash, allow_download, allow_comments, views, last_viewed_at)`, `brand_kits(workspace_id, doc jsonb)`,
  `project_versions` (saved versions, v10), `idempotency_keys` (v10), `comments`, `activity` (v11, see Collaboration),
  `extra_brand_kits`, `brand_fonts`, `space_settings`, `member_settings` (v14, see Brand kits, voice and onboarding).
- **Object storage**: S3-compatible (`S3_*` env; R2/Railway buckets) with presigned PUT uploads and signed GET;
  dev falls back to local disk `.data/storage` with the same interface.
- The project document is the `Project` type from core. Asset `src` = storage key; the client resolves media via
  `/api/media/:assetId/:variant` (variant `source|proxy|thumb|filmstrip|audio`), which redirects to a signed URL
  (S3) or streams with Range support (local).
- Captions and transcripts in the document (core `captions.ts`, `transcript.ts`, `captionLines.ts`): a project holds
  any number of caption tracks, each with a `language`; the shown ones are what the preview draws and the export burns
  in (`showOnlyCaptionTrack`), and `captionsToText(project, 'srt'|'vtt'|'ass'|'lrc', {trackId, karaoke, range})` writes
  one as a subtitle file (`parseCaptions` / `importCaptions` read them). Words cut in the transcript aren't stored: they
  are the stretch of the recording between two adjacent pieces of a clip (`struckWords`), and `restoreCut` plays it
  again. Caption tracks follow transcript cuts and restores. `project.fillerWords` is the transcript's filler list;
  speaker labels live on the clip's transcript segments (`speaker`), saved with `PATCH /api/assets/:id`.

## Library: trash, exports, search, copies (migration v13; contract in `packages/core/src/library.ts`)
- **Media trash** (`assets.trashed_at`, `services/library.ts`, `routes/assets.ts`): `DELETE /api/assets/:id` only
  trashes (projects keep playing the clip); `GET /api/assets?trashed=1` is the trash, `POST .../restore` takes one
  back, `GET .../usage` names the projects that use it (`doc->'assets'->id`). `POST /api/assets/trash/empty` is the
  one hand-made permanent delete: jobs stop, exports made of the clips and their links go, rows (tombstoned for
  desktops) and files go. `MEDIA_TRASH_DAYS` (30; 0 off) and `EXPORT_RETENTION_DAYS` (0 = keep; a working share
  link keeps its export) run in the worker's housekeeping (`sweepLibrary`, from `services/retention.ts`).
- **Replace in place**: `POST /api/assets/:id/replace` (ticket) → PUT → `.../replace/complete` swaps the clip's file
  under the same id (same kind only), drops what was derived from the old one and processes it again. Desktops drop
  a cloud clip's cached copy when its sha256 changes, and mirror the cloud's trash.
- **Exports** (`routes/library.ts`): `GET /api/exports?workspaceId=&q=&format=` pages every export of a space;
  `DELETE /api/exports/:id` removes it, its links and its file (kept as a clip when a project uses it).
- **Search** (`GET /api/search?workspaceId=&q=`): projects/templates (name, tags, script narration), media (name,
  transcript segment text with its time, voiceover text), voices, exports, members; every word, any order, plain
  `ILIKE` with `%`/`_` escaped (no extensions: PGlite and Postgres answer alike). The web's command palette
  (`shell/palette/`, Ctrl+K) shows it beside its commands.
- **Copies between spaces**: `POST /api/projects/:id/copy` and `/api/assets/:id/copy` `{workspaceId, move?}` copy
  the files to new ids in the other space and rewrite the document to them (`remapAssetIds`); `move` trashes the
  original. Project tags are `doc.tags` (`PATCH /api/projects/:id {tags}`), so they sync with the document.

## Saving, versions and live updates
- **Saves** are `PUT /api/projects/:id {project, baseVersion}` (409 with the current document when another save
  won). The editor merges its changes onto that document when they don't overlap (`apps/web/src/editor/rebase.ts`,
  clip by clip and field by field) and saves again; only overlapping changes raise the conflict banner. Until the
  server has them, unsaved changes are kept in the browser (`editor/journal.ts`, localStorage per person and project)
  and offered back on the next open.
- **Version history** (`project_versions`, migration v10, `services/versions.ts`, `routes/versions.ts`): every save
  is kept with author, time, size and a label (autosave, named, before-restore, before-ai), thinned to the last
  `PROJECT_VERSIONS_KEEP` (50), one per 10 minutes for a day, one an hour for 7 days, one a day for 30 days after, and every named one. List, read,
  name and restore under `/api/projects/:id/versions`; a restore is a new save that keeps what it replaced.
- **Base versions on small records**: `PATCH /api/projects/:id` takes `baseVersion`; asset, brand kit and workspace
  updates answer with an `ETag` of what they edit and refuse a stale `If-Match` with 412 (`etag.ts`). Without one,
  they write as before.
- **Idempotency keys** (`idempotency.ts`, table `idempotency_keys`): a POST with `Idempotency-Key` runs once per
  person and key; a repeat answers with the first (successful) answer for 24 h. The web client sends one with every
  job-creating request and retries a lost answer with the same key.
- **Live updates** (`/api/events`, SSE; `events.ts` + `routes/jobs.ts`): one publish function,
  `ctx().bus.publish(workspaceId, event, data, { id?, inline?, replay? })`. Events carry ids; each workspace's last
  500 (10 min) are kept, so a stream reopened with Last-Event-ID (or `?lastEventId=`) gets what it missed, or
  `resync` when that can't be told; `ready` carries the resume point. Streams close when access changes (removed,
  role lowered, signed out, device revoked: `bus.accessChanged(userId)`).

## Jobs
Postgres-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`), polled by the worker loop. Kinds:
`asset.process` (probe, H.264 proxy ≤720p, thumbnail, filmstrip sprite, waveform peaks, silence detection),
`ai.transcribe` (whisper.cpp), `ai.tts` (Kokoro-82M, 24 voices), `ai.produce.script` (Claude),
`ai.produce.assemble` (TTS per scene + timeline assembly), `export.render` (HyperFrames), `media.scenes` (ffmpeg
scene score over a clip's proxy in a source range → cut times, for "Split at scene changes"; a quick job,
`POST /api/assets/:id/scenes`), `media.smooth` (smooth slow motion: ffmpeg `minterpolate` over a source range of a
clip's file → a new library asset with frames made in between, `origin: 'smooth'`, processed like an upload;
`POST /api/assets/:id/smooth`, editors only; the editor records it on the clip as `smooth`, see `packages/core/src/
speed.ts`). Progress is pushed to clients over SSE (`/api/events`).

**Fair share (P-3).** `claimNext` picks, within the lane it claims for (any job, or the quick lane's kinds), the
space with the fewest jobs of that lane running, then the oldest job: one space's pile of exports can't make the
others wait. Every claim stamps `started_at`. **Queue visibility (A-9):** `jobs/queue-info.ts` replays the claim
order (slots per worker seen, what runs now, the fair-share rule, each kind's average run time over the last week
from metering) to give each queued job its place in line, an estimated wait (or unknown) and the reason
(`GET /api/jobs/queue`). **History (A-8):** `GET /api/jobs/history` lists finished, failed and cancelled jobs
(newest first, by outcome), `POST /api/jobs/:id/retry` queues a failed or cancelled job's work again under the same
limits. When a job ends in the worker, `afterJob` in `jobs/worker.ts` runs the follow-ups (metering its run time;
the place to add notifications).

## Usage and limits (P-1, A-18)
`limits.ts` holds the abuse brakes and quotas (cloud only, every one an env value where 0 = off; see `.env.example`).
Request rates (AI calls per person per minute and day and per space per day, sign-ups per IP and overall, device
links) are windows in Postgres (`rate_windows`): one conditional upsert per rule inside one transaction, so every
replica shares the count and two requests can't both take the last place. `services/metering.ts` adds what was used
to `usage_daily` (per space, person, UTC day, metric and subject): every AI call (`getProvider` returns a metered
provider; the Anthropic, OpenAI and Gemini providers report each response's tokens with `noteTokens`), charged to the
request's signed-in person or the job's starter (`withActor`), and each job run's time by kind. Monthly quotas (AI
tokens per space and per person, job minutes per space) and storage per space (the sum of its clips' sizes, checked
when an upload starts) read those totals. On cloud a space uses the server's own Anthropic key only when an owner
turns it on (`workspace_usage_settings`, `PUT /api/usage/builtin-ai`; spaces from before v15 keep it on); its own keys
work either way. `GET /api/usage` is the Usage page: AI requests, tokens and an estimated cost per provider and model
(list prices in `packages/core/src/usage.ts`, labelled as an estimate), job minutes by kind, storage per space, the
limits with what is used of each, and for owners who used what.

## Speed (`packages/core/src/speed.ts`)
One mapping from a clip's time to its source time, read by everything: `evaluate` and the preview player, the export
(a HyperFrames rate lane in `data-automation` on the clip's `<video>` and `<audio>` elements for a speed ramp,
`data-playback-rate` for a constant speed), trims, splits, J/L cuts, linked sound, freeze frames, the transcript,
captions, beat markers and replace. A ramp is `speedRamp` points (speed at seconds from the clip's start, log-scale
between, held outside), presets in `RAMP_PRESETS`. `pitchShift` lets a clip's pitch follow its speed: the preview
turns the player's `preservesPitch` off, and the export plays a copy resampled to the clip's speed that
`render/pitch.ts` makes before the render (HyperFrames' own rate keeps the pitch). `smooth` points the clip's picture
at a `media.smooth` copy (time 0 = source `from`) while it covers what the clip plays; the sound stays the source's.

### Smart tools (E-21)
- **Masks and chroma key** live in the document (`masks.ts`, `key.ts`): `item.mask` (rect / ellipse / path, in fractions
  of the clip's frame; its numbers are keyframes `maskX`…`maskExpand` among the clip's others) and `item.chromaKey`.
  `evaluate` gives the layer `smart: { mask, key }`; `smartRuntime.ts` puts the mask on the layer wrapper as a CSS
  `mask-image` (an SVG image with an SVG `<mask>`, feGaussianBlur for the feather, a stroke for the expansion) and the
  key on the picture as `filter: url(#ps-key-…)` (an sRGB SVG filter in a hidden `<svg data-ps-keys>` in the stage:
  chroma-distance matrices → alpha table → spill step → picture × matte). Both modes draw the same; HyperFrames copies
  a video's computed filter onto the frame image it draws in the video's place, and the mask is on the wrapper above.
- **Processed copies** are jobs, one file each under `media/`: `media.stabilise` (`stabilise.ts`: vid.stab two-pass,
  else deshake), `media.denoise` (`denoise.ts`: afftdn / arnndn with `DENOISE_MODEL` for sound over the whole file,
  picture copied; hqdn3d / nlmeans for the picture over the clip's part), `media.bgremove` (`bgremove.ts`: runs
  `BG_REMOVAL_CMD` with `{in}` / `{out}`, no shell; PNG frames or `out.webm` → VP9 WebM with alpha; off when unset).
  `smartTools.ts` holds the shared part: `GET /api/smart-tools` (what this ffmpeg and config can do, and why not),
  the source range, saving the copy as a new clip (`origin: 'smart'`, `meta.derivedFrom { assetId, tool, offset,
  settings }`, the transcript moved along) processed inside the job. Routes: `POST /api/assets/:id/stabilise |
  denoise | remove-background` (editors; 501 before queuing when the tool is missing). The editor swaps the copy in
  with core's `applyProcessedCopy` (offset, then Replace media's rules), one undo step.
- A clip with transparency (`probe().alpha`: VP9 `alpha_mode`, yuva/rgba pixel formats) gets a VP9-alpha WebM proxy
  (`proxy.webm`, served as `video/webm`); the export reads the original, whose alpha HyperFrames keeps (PNG frames).

## AI (Claude API, `@anthropic-ai/sdk`)
- Model `claude-opus-5`, adaptive thinking, server-side refusal fallbacks (`fallbacks: "default"`,
  beta `server-side-fallback-2026-07-01`), streaming for long outputs.
- **Producer script**: structured output (zod) → `ScriptScene[]` from transcript + brief + contact sheets.
- **AI writer** (`/` in Voice Studio and text panels): short streamed completions.
- **Editor assistant**: tool-use loop whose tools map 1:1 to core ops (`split`, `trim`, `move`, `add_text`,
  `add_transition`, `generate_captions`, `remove_silences`, `set_filter`, …). The server applies the ops to the
  posted project and returns the new document plus a summary; the client pushes it onto its undo stack.
- The API key lives only on the server (`ANTHROPIC_API_KEY`).

### Bring-your-own-key providers (`ai/openai.ts`, `ai/gemini.ts`, `ai/anthropic.ts` with a key)
- Every feature talks to `AiProvider` (`ai/provider.ts`; `ClaudeProvider` is an alias). Ids: `anthropic-api` (server
  env credentials), `anthropic-key`, `openai` (Responses API), `gemini` (AI Studio key), `claude-cli`, `none`.
- Each provider implements streamed `write`, native JSON-schema `structured` (zod → `z.toJSONSchema` → dialect
  adapter in `ai/common.ts`, validated with zod, one repair turn) and a manual tool-call loop `runAgent` over the same
  `ToolSpec`s + `runTool` (parallel calls, tool errors returned to the model, `maxIterations`, abort).
- Settings (`GET/PUT /api/ai/settings`, `PUT/DELETE /api/ai/keys/:provider`, `POST /api/ai/keys/:provider/test`):
  `{defaultProvider, perFeature: {writer, script, assistant}, providers: {openai|gemini|anthropic: {model, hasKey,
  keyLast4, models}}}`. The test call lists models (chat/text-capable ones only); the UI offers them in a dropdown with
  a free-text fallback.
- Resolution (`ai/resolve.ts`, `getProvider(scope, feature)`): per-feature override → default provider → built-in
  (cloud: server `ANTHROPIC_API_KEY`; desktop: Claude CLI) → none (503 "AI is not configured — add a key in Settings").
  Key providers are cached per scope + provider + model + key hash.
- Storage: cloud `workspace_ai_settings` (JSON) + `ai_keys` (AES-256-GCM, key from `SECRETS_KEY`, AAD = workspace +
  provider), owners edit, members read masked settings; desktop: the `ai` block of the local settings file with keys
  sealed by the safeStorage-protected key. Neither is part of the sync change feed. Keys never appear in responses.

## Auth & tenancy
Email + password (scrypt), httpOnly `ps_session` cookie (30 days, sliding). Every user gets a personal workspace;
workspaces are the tenancy boundary (projects, assets, brand kit). Roles: owner, editor, viewer.

A viewer opens the editor read-only (`editor/viewer.tsx`): the store's `readOnly` flag follows the role in the
project's space, `commit`/undo/redo refuse while it is set, write controls sit in a disabled fieldset (`<ViewOnly>`)
with the viewer tooltip, and drags, drops and the canvas/timeline handles are off. Viewers still play, scrub, inspect
and comment.

## Collaboration (migration v11; contract in `packages/core/src/collab.ts`)
- **Share links** (`routes/share.ts`): each link has `expires_at` (410 after), an optional `password_hash` (the page,
  video, poster and comments answer 401 until `POST /api/share/:token/unlock` gives a key, an HMAC over the token and
  an expiry keyed by the password hash, sent back as `?k=` or `X-Share-Key`), `allow_download`, `allow_comments`,
  `views` and `last_viewed_at`. `PATCH /api/share/:token` changes them (editors); `GET /api/workspaces/:id/shares`
  lists a space's links. The share page fetches without cookies.
- **Review comments** (`services/comments.ts`, `routes/collab.ts`, table `comments`): threads pinned to a project
  time and optionally a frame point (0–1); replies name the first comment. Members comment (viewers too); share
  visitors comment with a name when the link allows it, at video times mapped through the export's range. Changes go
  out as `comment` events on the workspace stream.
- **Presence** (`services/presence.ts`): open editors POST a heartbeat every 20 s per tab; the API process keeps who
  is in each project in memory (gone after 50 s without one) and publishes `presence` events when that changes. One
  API process is assumed; several replicas would each know only their own visitors.
- **Activity** (`services/activity.ts`, table `activity`): created, renamed, exported, shared, link changed/revoked,
  commented and member changes, recorded per space by the routes (and the export job) and listed newest first in
  pages (`GET /api/workspaces/:id/activity`), shown on the shell's Activity page.
- None of these tables sync to desktops.

## Accessibility (web)
- Shared controls carry the keyboard patterns: `shell/ui.tsx` (Modal / ConfirmDialog trap and restore focus,
  Popover + MenuList, Tabs, RadioCards, SkipLink) and `editor/controls.tsx` (Field names what sits in it; Menu:
  a popover keeps Tab inside, a menu closes on Tab). Build new screens from these.
- `lib/announce.ts` is the app's one polite live region: `announce(text)` / `useAnnounceChange(text)` say a change
  once. Don't put a percentage inside `role="status"`; announce the start and the end.
- Reduce motion (`data-reduce-motion`, the person's setting or the OS's): CSS animations stop (theme.css), hover
  previews stay still, and `lib/motion.ts` holds any `<video autoPlay>` until Play.
- Below 760 px the editor's side panels are sheets (`editor/phone.ts`, the phone block in editor.css).
- `editor/__tests__/audit.test.tsx` and `shell/__tests__/audit.test.tsx` fail on any control without a name.

## Brand kits, voice and onboarding (migration v14; contract in `packages/core/src/brand.ts`)
- **Several kits per space** (`services/brand.ts`, `routes/brand.ts`): `brand_kits` stays the space's default kit
  (synced to desktops, read by `GET/PUT /api/workspaces/:id/brand`); `extra_brand_kits` holds the others
  (`/api/workspaces/:id/brand-kits[/:kitId]`, If-Match on save). "Make default" moves a kit's settings into the default
  row and keeps the old default as another kit. Producer briefs, `POST /api/projects {templateId, brandKitId}` and
  `POST /api/templates/from-brand` take a kit id (`getBrandKit`; a deleted kit falls back to the default).
- **Colours from a logo** (`services/palette.ts`): a raster logo already in the space is shrunk by ffmpeg to 64×64 RGBA
  and quantised in JS (opaque pixels binned, near bins merged, most used first); an SVG gives the colours written in
  it. Nothing is fetched from the web.
- **Font files** (`brand_fonts`, stored under `ws/<id>/brand-fonts/`): sniffed by content (WOFF2, WOFF, TTF, OTF,
  ≤ 5 MB), usable as a kit's headline or body font (`customFonts` on the kit lists them, so `lookPalette` keeps them).
  The editor registers the space's fonts with the FontFace API; the export copies the files a project uses and declares
  them next to the bundled faces (`render/brandFonts.ts`).
- **Onboarding** (`services/onboarding.ts`, `routes/onboarding.ts`): `GET /api/workspaces/:id/onboarding` reads the
  Home checklist from the space's real state (an uploaded asset, a saved kit, an assembled Producer project, a second
  member or a pending invite); `PUT {dismissed}` hides it for that person (`member_settings`). `createWorkspace` adds a
  sample project (a look's starter) to each new cloud space and records it in `space_settings` (`SAMPLE_PROJECT=0`
  turns this off; the test harness does).
- **Voice scripts** (`packages/core/src/voice.ts`, `ai/voiceScript.ts`, `routes/voiceStudio.ts`): every TTS made in a
  space (Voice Studio, Producer narration, the assistant's voiceovers) goes through `speakScript`: the space's
  pronunciation dictionary (`space_settings.pronunciations`, whole words, longest first), then the markup —
  `[pause]` / `[pause 2s]` become real silence and `*words*` are voiced slower and 2.5 dB louder, a part at a time,
  joined by one ffmpeg concat. A plain script is one TTS call as before; the asset keeps the script as written, so
  Producer's voice reuse still matches. Cloned/designed voices (VoiceStudio) get the plain words (`spokenPlain`).
  `member_settings.voice` keeps each person's Voice Studio draft and favourite voices per space;
  `POST /api/workspaces/:id/voice-preview` voices a line (≤ 300 chars, built-in voices) without saving it, for the
  side-by-side comparison. Batch voiceovers from a CSV are parsed in the browser (`parseVoiceCsv`) and sent as
  ordinary TTS jobs, one at a time.
- **Producer AI** (`routes/producer.ts`): `GET /api/ai/produce/:projectId/script-versions` reads the brief and script out
  of the project's saved versions (`doc->'ai'`), newest first, one per change. A scene's `narrator` (voice, speed)
  overrides the brief's for that scene, and `renarrate: [sceneIds]` on assemble makes fresh takes of those scenes while
  the others reuse theirs; `brief.brandKitId` picks the kit.
- None of the v14 tables sync to desktops: a desktop sees the default kit only.

## Two products, one codebase

| | **Producer Studio Web** | **Producer Studio Desktop** |
|---|---|---|
| Shell | Browser | Electron (Windows first, macOS later) |
| Server | `apps/server` `MODE=cloud` on Railway | same `apps/server` in `MODE=desktop`, spawned by Electron on 127.0.0.1 |
| Users | Multi-user, workspaces, invites | One local user; linked to a cloud account for sync |
| DB / storage | Postgres + S3 | PGlite + local disk under the user's data folder |
| AI | Anthropic API (`claude-opus-5`, server key, metered) | Locally installed **Claude Code CLI** (user's own Claude subscription, no API tokens) |
| Transcribe / TTS / render | Worker containers | Local whisper.cpp, Kokoro, HyperFrames (free, offline) |

### Claude CLI provider (desktop)
- Detects `claude` the way Producer did (Claude desktop bundle `%APPDATA%\Claude\claude-code\<v>\claude.exe`, MSIX `Claude_*` package cache, `~/.local/bin`, `where claude`), or uses the path in Settings; `claude auth status` for sign-in state; Setup offers "Sign in to Claude".
- Runs `claude -p <prompt> --output-format stream-json --verbose` with a **local MCP server** (`--mcp-config`) that exposes the same editing tools as the cloud assistant (`get_timeline`, `split_at`, `add_text`, `generate_captions`, …) plus `submit_script` for structured Producer scripts. `--allowedTools` is restricted to those MCP tools (no Bash/Write, **no `--dangerously-skip-permissions`**); a per-run temp working dir; stream events relayed to the UI exactly like the API provider.
- Same `ClaudeProvider` interface as `AnthropicApiProvider`, so features are identical in both products.

### Sync (desktop ⇄ cloud)
- Cloud is the source of truth; the desktop is a full offline-capable replica. Ids are global, so a project/asset has one id everywhere.
- Link: Settings → sign in with the cloud account → the desktop gets a **device token** (Bearer, revocable under Devices).
- **Pull**: `GET /api/sync/changes?since=<cursor>` (server-wide monotonic `change_seq`, tombstones for deletes, paged) → upsert workspaces, projects, brand kits, asset records locally. Media downloads on demand (first open) or eagerly (setting), verified by sha256.
- **Push**: local writes are journaled (outbox). Assets: `POST /api/uploads {assetId, sha256}` → PUT bytes (skip on 409 exists) → complete. Projects: `PUT /api/projects/:id {baseVersion}`; new local projects `POST /api/projects {id}`.
- **Conflicts**: a 409 on push (both sides edited since the last sync) marks the project conflicted; the user picks Keep local (force-push over the cloud version), Keep cloud, or Keep both (local becomes "(conflicted copy)" with a new id). Assets are immutable, so they never conflict.
- Runs on launch, every 60 s while online, and immediately after local saves (debounced); state is surfaced in the top bar (`/api/sync/status`, SSE `sync`).
- The web editor reloads silently when an SSE `project` event arrives for the open project with no unsaved edits; otherwise it merges them onto the new version, and shows the conflict banner only when both changed the same thing.

### Desktop hardening (lessons from the Producer 0.1.x review)
Signed builds, `sandbox: true` + context isolation, a narrow validated preload API (no generic `invoke`), `shell.openExternal` limited to http(s), no bundled test artefacts or personal paths, and skills/configs never written into the user's global `~/.claude`.

## Deploy
Single Docker image (Node 22 + ffmpeg + chrome-headless-shell deps + whisper.cpp) on Railway: `web` (API +
static SPA) and `worker` services from the same image, Postgres plugin, S3-compatible bucket.
