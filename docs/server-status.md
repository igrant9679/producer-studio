# Server status (apps/server)

_Living document for the web and desktop agents. Last update: 23 Sept 2026, 23:55 — all planned routes live._

## Running now (dev)

| | |
|---|---|
| URL | `http://localhost:8787` (Vite should proxy `/api` → here; cookies, media and SSE are all same-origin under `/api`) |
| Started with | `npm run dev -w @producer/server` (tsx watch; restarts on server/core source changes) |
| PIDs | npm `50800` → tsx watch `1412` → server `53728` (the server PID changes on every watch restart) |
| Log | `apps/server/.data/logs/dev.log` (JSON lines) |
| Seed user | **demo@producer.studio / demo-password-1** (workspace "Demo's space": 2 processed sample videos, "Sample project", "Studio Dark starter") |
| Data | PGlite at `apps/server/.data/pg`, files at `apps/server/.data/storage` |

Stop it: `taskkill /PID 50800 /T /F`. Re-seed (idempotent; PGlite is single-process, so stop the server first): `npm run seed -w @producer/server`.
Tests: `npm test -w @producer/server` (63 tests). Typecheck: `cd apps/server && npx tsc --noEmit -p .`

## Endpoints

Everything in `packages/core/src/api.ts` is implemented with those shapes. Status: ✅ verified live with curl · 🧪 unit/integration-tested · ⚠️ needs credentials.

| Area | Route | |
|---|---|---|
| Health | `GET /api/health` (adds `storageStatus` ok/error/unknown; never gates the 200; the reason is only in `/api/system` `storage`, for signed-in people) | ✅🧪 |
| System | `GET /api/system` → `SystemInfo` (public) | ✅🧪 |
| Auth | `POST /api/auth/signup`, `/login`, `/logout`, `GET /api/auth/me` | ✅🧪 |
| Workspaces | `GET/POST /api/workspaces`, `GET /:id/members`, `POST /:id/invites` (owner), `GET /:id/invites` + `DELETE /:id/invites/:token` (owner: pending list, withdraw), `PATCH /:id/members/:userId {role}` (owner), `DELETE /:id/members/:userId` (owner removes; anyone leaves; never the last owner, never someone's own personal space; their pending invites are withdrawn), `GET/PUT /:id/brand` | ✅🧪 |
| Invites | `GET /api/invites/:token` → `InviteInfo`, `POST /api/invites/:token/accept`; the web page is `/invite/:token`. Only the invited email can accept, once, within 7 days | ✅🧪 |
| Projects | `GET /api/projects?workspaceId=&trashed=&templates=`, `POST`, `GET/PUT/PATCH/DELETE /:id`, `POST /:id/duplicate` | ✅🧪 |
| Uploads | `POST /api/uploads` → ticket; `PUT /api/uploads/:assetId/data` (local storage; S3 gets a presigned URL); `POST /api/assets/:id/complete` (also re-runs processing for an `error` asset whose file is in storage); `POST /api/assets/:id/abort {reason}` (the browser's PUT failed) | ✅🧪 |
| Assets | `GET /api/assets?workspaceId=&kind=`, `GET/PATCH/DELETE /api/assets/:id` | ✅ |
| Media | `GET/HEAD /api/media/:assetId/:variant` (`source`, `proxy`, `thumb`, `filmstrip`, `audio`); Range/206/416; S3 → 302 signed URL | ✅🧪 |
| Jobs | `GET /api/jobs/:id`, `GET /api/jobs?projectId=|workspaceId=`, `POST /api/jobs/:id/cancel` | ✅🧪 |
| Events | `GET /api/events?workspaceId=` SSE: `job`, `asset`, `project`, `workspace` (rename, delete, `members: true`), plus `: keepalive` every 20 s. Access is re-checked every 20 s and after every `workspace` event (membership, session, device token); the stream closes when it's gone. At most 20 streams per user; a reader 2,000 events behind is dropped | ✅🧪 |
| Transcribe | `POST /api/ai/transcribe` → Job `{assetId, transcript}` (whisper.cpp, word timings) | ✅ |
| TTS | `POST /api/ai/tts` → Job `{asset, duration}`; `GET /api/ai/voices`; `GET /api/ai/voices/:id/sample` (cached WAV) | ✅ |
| AI writer | `POST /api/ai/write` SSE `delta`/`done`/`error` | ⚠️ 503 without a key (verified) |
| Producer | `POST /api/ai/produce/script` (⚠️ AI key; `assetIds` may be empty when `brief.source = 'idea'`), `POST /api/ai/produce/assemble` (✅ no text AI needed; idea scenes may make images/clips on the space's own key), `GET /api/ai/produce/capabilities?workspaceId=` → `ProduceCapabilities` | 🧪 |
| Assistant | `POST /api/ai/assistant` SSE `text`/`tool`/`done`/`error` | ⚠️ tools 🧪 |
| Export | `POST /api/projects/:id/export` → Job `ExportResult`; `GET /api/exports?projectId=` | ✅🧪 |
| Share | `POST /api/projects/:id/share {exportId?}` → `ShareLink` (that export or the latest; reuses its link; 409 before any export); `GET /api/projects/:id/shares`; `DELETE /api/share/:token` (editor: stop sharing); `GET /api/share/:token` → `SharedVideo` (public: name, size, duration only) and `/api/share/:token/video` (public, Range). Links made before 26 Oct are pinned to their export on first view | ✅🧪 |
| Templates | `GET /api/templates?workspaceId=` (8 built-in `tpl:<look>` + workspace templates); `GET /api/templates/tpl:<id>/preview` (PNG) | ✅🧪 |
| Devices | `POST /api/devices {name}` (session cookie, or `{name, email, password}`; a device token can't create another) → `{deviceId, token}`; `GET`; `DELETE /:id`. A token unused for 90 days stops working | ✅🧪 |
| Sync feed | `GET /api/sync/changes?since=<cursor>&limit=` → `SyncChanges` | ✅🧪 |

Timings on this machine: a 6 s 720p upload processes in ~3 s; TTS of 2 sentences ~2 s warm; whisper small.en on 9 s ~3 s;
export of a 20 s 1080p project at 720p draft ~50 s.

## Behaviour notes for clients

- **Auth**: `ps_session` httpOnly cookie (30-day sliding). Any route also accepts `Authorization: Bearer <device token>`.
  401 `{code:'unauthorized'}` when signed out; non-members get **404** on workspace resources, viewers get **403** on writes.
  Login is rate-limited (429 `{code:'quota'}`): 8 failures in 15 min per IP+email, 30 per email, 50 per IP. The client IP is
  the `TRUST_PROXY_HOPS`-th X-Forwarded-For entry from the end (the hop Railway appends), never the client-chosen first one.
- **Hardening (25 Oct 2026, evaluation phase 0)**: cloud responses carry a CSP (`script-src 'self'`, `frame-ancestors 'none'`),
  nosniff, `X-Frame-Options: DENY`, HSTS in production (`security.ts`). Request bodies are capped before they are read: 64 MB
  for project create/save and the assistant, 8 MB for `/api/ai`, `/api/voice`, `/api/sync`, 1 MB for everything else (413
  `{code:'quota'}`); the local upload stream keeps its `MAX_UPLOAD_MB` cap. Uploads must be video, audio or an image
  (415 for HTML, scripts, documents; an unknown type with no media extension is kept as octet-stream for processing to
  judge), and media is served inline only for video, audio and raster images. SVG (logos) keeps its type, so `<img>`
  draws it, but is `attachment` + `CSP: sandbox`; anything else stored goes out as `application/octet-stream`,
  `attachment`, `CSP: sandbox`. Abuse limits (`limits.ts`, env in `.env.example`):
  AI writing per user per day/minute, sign-ups per IP/hour, device tokens per user/hour, and queued exports / voiceovers /
  transcriptions / Producer AI runs per workspace (429 `{code:'quota'}`; upload processing is never capped). Source maps are
  built hidden and `.map` files are never served.
- **Hardening, phase 1 (26 Oct 2026)**: S3 upload URLs sign the declared length (the bucket takes no other size), and
  `complete` refuses (and deletes) anything over `MAX_UPLOAD_MB`; processing always checks a declared sha256 on S3 and fails
  the clip on a mismatch. Of two concurrent `complete`s only one queues processing; concurrent duplicates that hit a
  unique key answer 409 instead of 500. Another workspace's project/asset id gets a plain 409 (no `exists` detail), and
  a `projectId` naming another workspace's project is refused (404). A workspace's saved AI key that can't be decrypted
  answers 503 "enter it again" instead of falling back to the server's key. Desktop voice-profile pushes: only the
  creating device or user may update, consent is written once at creation, timestamps are clamped to server time.
  The worker prunes expired sessions, finished jobs older than 30 days and spent invites older than 30 days
  (`services/retention.ts`, 3 min after start, then every 6 h).
- **Asset URLs**: in asset records and in `project.assets`, `src`, `proxySrc`, `thumbnail` and `filmstrip.src` are already
  `/api/media/...` URLs. `GET /api/projects/:id` refreshes `project.assets` from the assets table (proxy/filmstrip/transcript
  appear there once processing finishes).
- **Uploads**: after `complete`, the asset is `processing`; watch SSE `asset` events (thumb + filmstrip + waveform arrive first,
  then the proxy, then status `ready`). `audio` = AAC extract of a video's soundtrack (falls back to source).
  asset.process job events carry `assetId`, so a client can show per-clip progress (`message`, `progress`).
- **Stuck clips** (23 Oct 2026, `services/asset-recovery.ts`): an asset never stays `uploading`/`processing` for good. The client
  reports a refused PUT (`/abort`); the worker sweep (30 s after start, then every 5 min) fails uploads older than 2 h and
  processing clips whose latest asset.process job ended after the clip last changed (error, cancelled, or the stale-recovery
  give-up, which now fails the clip too). `error` holds a sentence for a person (`friendlyProcessingError`: no server paths).
- **Storage self-check** (`services/storage-health.ts`, cloud mode): writes (through the streamed `putFile` path that proxies and
  renders use), reads and deletes `_health/<instance>.txt` on start and every 5 min; the result is in `/api/health` and `/api/system` (`storage`), and the editor shows a banner while it fails.
  Signed URLs are computed locally, so a revoked bucket key is otherwise invisible to the server.
- **Saving**: `PUT /api/projects/:id {project, baseVersion}` → `{version, updatedAt}`; stale → 409
  `{code:'conflict', details:{version, project, summary}}` (`project` = current server doc, for merge / keep-both).
  Every save emits SSE `project {id, version}` (server-side jobs such as assemble also save and emit).
- **Create**: `POST /api/projects` accepts optional `id` (client-generated, `[A-Za-z0-9_-]{6,80}`; a retry in the same workspace
  returns the existing project; the id existing in another workspace → 409 `details.exists`) and optional `project`
  (a full document to create with — extension used by desktop pushes). `templateId: 'tpl:<look>'` builds a starter project
  (title card, subtitle, lower third, close card in the look's palette/fonts/aspect); a workspace template id deep-copies with fresh ids.
- **Uploads for replicas**: `POST /api/uploads` accepts optional `assetId` and `sha256`; if that asset id exists → 409
  `{code:'conflict', details:{exists:true, asset?, sha256?}}`. `sha256` is computed on `complete` (local storage) or in `asset.process` (S3);
  a declared hash that doesn't match the bytes → 400.
- **Change feed**: DB triggers stamp a global `change_seq` on every insert/update of projects, assets, brand kits, workspaces and
  memberships; hard deletes of projects/assets write tombstones. `cursor` = last change_seq returned; page while `more`.
  Joining a workspace re-stamps its content so the new member's replicas receive it. `workspaces` lists every workspace on `since=0`,
  otherwise only changed ones.
- **Jobs**: `progress` 0..1; `message` is a short human status. Cancel works for queued and running jobs (running ones are killed
  between steps / child processes killed). Worker concurrency 2.
- **Export**: `quality` draft|standard|high → HyperFrames draft|looks|delivery; renders at project size then ffmpeg-scales to the
  requested short side. `draft` renders from proxies. The result `url` is `/api/media/<assetId>/source`; the export also appears
  as an asset with `origin:'render'`.
- **Assemble** (`/api/ai/produce/assemble {projectId, scenes}`): TTS per scene (brief voice; reuses a scene's voice when the narration
  is unchanged), whisper word timings for captions, then rebuilds the timeline: title card, per-scene footage cut to
  `voice + 0.5 + 1.4 s` (1.8 s close) with slow-down or held last frame, voice track at +0.5 s, headline per scene (look styles,
  brand colours), crossfades (slide-up into the close), caption track, close card. Saves `project.ai.status = 'assembled'`.
- **Videos from an idea** (26 Oct 2026; `ai/scenes.ts`, `ai/scene-layout.ts`, `ai/generate/*`): with `brief.source = 'idea'` the
  script job skips transcription and the writer plans each scene's `visual` (`SceneVisual`): `motion` (headline + up to 4 points),
  `diagram` (steps, cycle, hub, bars, compare, timeline, stat), `image` (AI still + Ken Burns), `stock` (Pexels clip), `aiVideo`
  (AI clip). Motion and diagrams are built from editable shape/text items on shared "Graphics n" (overlay) and "Graphic text n"
  (text) tracks, each part revealed when the narration's word timings say it. Images and clips are made during assembly on
  the workspace's own key (OpenAI or Gemini stills; Gemini Omni or Wan-on-fal.ai clips, at most 3 per video; Pexels stock via `PEXELS_API_KEY`),
  stored as assets with `meta.generated` and reused while the prompt/search is unchanged; a scene whose visual can't be made
  falls back to motion and the job result carries `notes`. Model ids and fallbacks: top of `ai/generate/capabilities.ts`.
  **Your own clips and images** (1 Nov 2026): in idea mode the script request's `assetIds` are the person's library media,
  not recordings: never transcribed, listed for the writer as m1…mN (name, kind, length, any stored transcript) with a
  picture of each (the image, or three frames across a clip), and offered as a `media` visual (`{ kind: 'media', assetId,
  start?, end? }`). Assembly looks them up with the footage (in the project's space only; one that's gone becomes a card) and
  places a clip like a stock clip (filling the frame, from `start`) and an image like an AI still (slow pan and zoom).
  **Free stock, photos and animations** (2 Nov 2026): stock clips and the new `photo` visual (`{ kind: 'photo', query }`,
  a still with a slow pan) search free libraries in turn (`ai/generate/stock.ts`): Pexels and Pixabay when the server has
  their free keys (`PEXELS_API_KEY`, `PIXABAY_API_KEY`), then Openverse (photos) and Wikimedia Commons (clips and photos),
  which need no key (`FREE_MEDIA=off` turns those off). Only licences allowing commercial use and changes are kept (CC0,
  public domain, CC BY, CC BY-SA; no NC/ND, nothing with Commons restrictions); a CC BY / BY-SA file sets `credit.licence`
  and the scene gets an editable credit line in the top corner. The `animation` visual (`{ kind: 'animation', style,
  objects: [{ name, label? }] }`, styles row · journey · orbit · grow · burst · change) is built in `scene-layout.ts` from
  image items with keyframes (editable, identical in preview and export): each object's illustration comes from Iconify's
  open-source colour sets (Fluent Emoji MIT, Noto Apache 2.0; `ai/generate/icons.ts`, mirrors tried), drawn to a 1024 px
  PNG with sharp, stored with `meta.generated.kind = 'illustration'` and reused across the space; an object with none
  found is a labelled disc. `GET /api/ai/produce/capabilities` adds `stockSources`.
  **AI-drawn animation** (2 Nov 2026): the `drawn` visual (`{ kind: 'drawn', prompt, code?, assetId? }`) is a scene the
  space's AI draws in code (`ai/drawn.ts`): from the writer's note, the narration and the voice's word timings it writes
  `function draw(ctx, t, env)` (canvas 2D + Rough.js; rules distilled from explainroo and video-director, both MIT);
  `media/drawing.ts` runs it in headless Chrome (the export's `CHROME_PATH`) with a CSP that allows only inline script,
  the network APIs removed, a dead proxy for every request, WebRTC off UDP, seeded randomness and the frame's time as
  the clock; a frame over 8 s (an endless loop) stops it. A failing run gets one fix round with the error, then the model
  looks at four of its frames once and may fix what it sees (a fix that breaks keeps the working code). The frames are
  encoded to an mp4 asset (`meta.generated.kind = 'drawn'`, keyed on code + length + frame + word timings, so an unchanged
  scene reuses it and a changed narration re-renders the same code); assembly places it like a stock clip. At most
  `MAX_DRAWN` (6) per video; offered when the export browser exists.
  **Drawing media and styles** (9 Nov 2026): the sandbox also loads anidoodle's art core (github.com/alexgreensh/anidoodle,
  Apache-2.0, three files vendored unchanged in `vendor/anidoodle/src` at a pinned commit, bundled to
  `vendor/anidoodle/anidoodle.js` by `scripts/build-anidoodle.mjs`; a test fails when the bundle is stale; LICENSE,
  NOTICE and PROVENANCE.md beside it). Drawings get `env.doodle(ctx, t, medium)` (pencil, ink, riso, chalk and marker
  lines that draw on and boil, watercolour washes, shaded forms, hatching, layer groups with paper tooth and multiply
  registration, paper grain), `env.shapes` (point lists, halftone dots, noise), `env.marks` (strokes, contours and
  hatching built once and laid down in order with `env.marks.play`), `env.memo` (built once per page, keyed) and
  `env.image(name)` (pictures passed as data URLs in `DrawingEnv.images`, decoded before the first frame). A brief's
  `drawingStyle` (core's `DRAWING_STYLES`: clean, pencil sketch, pencil and watercolour, ink and wash, storybook,
  risograph, newsprint, blueprint, chalkboard, whiteboard; absent = clean) adds that style's recipe to the drawing
  prompt (`DRAWING_RECIPES`, ours) and draws on its own paper and ink with the brand's accent; a scene keeps the style
  its code was written for (`visual.style`), so changing it redraws.
  **Sketch it in** (9 Nov 2026): `POST /api/assets/:id/sketch` (`{ style: pencil|ink|charcoal|chalk, colour, seconds }`,
  editors, pictures only, 501 without the export browser) queues `media.sketch` (`media/sketch.ts`): the picture is
  drawn in, stroke by stroke, by fixed code in the same sandbox (no AI): anidoodle's photo fields give its edges and the
  direction its texture runs, our tracer walks the strong edges into contour lines (biggest first), anidoodle's
  hatching shades the darks in two directions (the lights, for chalk), and with `colour` the picture fades up under the
  lines at the end. The video is made at the picture's shape (long side 960 to 1920) and saved like the other smart
  copies (`derivedFrom.tool = 'sketch'`); the editor's Smart tab puts it in the image clip's place as a muted video clip
  with the same framing, look and keyframes (core `applySketch`, one undo step). Same idea as Sketch2Motion (photo →
  line drawing → drawing-on animation), written fresh: that repo has no licence.
  **AI clips with Wan on fal.ai** (10 Nov 2026; `ai/generate/fal.ts`): a space can store a **fal.ai** key
  (`PUT /api/ai/keys/fal`, a `MediaKeyProvider`: clips only, never a writing provider, so it isn't in `providers`,
  `defaultProvider` or `perFeature`; `AiSettings.media.fal` reports it). The key test is fal's price list
  (`GET api.fal.ai/v1/models/pricing`, free), which also gives the price the card shows. Clips go through fal's queue
  (submit → poll `status_url` → `response_url` → download from fal's CDN without the key; `cancel_url` on stop or after
  15 min); the key is only sent to `*.fal.run` over https. Models in order: Wan 2.2 A14B (`num_frames` at 16 fps, 2–10 s,
  720p) then Wan 2.7 (2–15 s, 720p), used when fal answers 404 for 2.2 (fal says 2.2 goes on 4 Jan 2027). With Gemini and
  fal keys both stored, `AiSettings.videoProvider` (`PUT /api/ai/settings`, Settings → AI → "AI video clips") picks who
  makes clips; automatic is Gemini first, and a key whose last test failed hands clips to the other.
  **Professional animation** (11 Nov 2026). *Animation model*: AI-drawn scenes are their own AI feature, `animation`
  (`perFeature.animation`), and on a key-backed provider they run on `AiSettings.animationModel` (`PUT /api/ai/settings`,
  Settings → AI → "Animation model"; must be on that provider's model list) or, when none is chosen, the most capable
  model on the key's list (core `strongestModel`: the tier its name says, then the highest version; image, audio, mini
  and similar ids passed over). Writing keeps the provider's own model. On the built-in provider nothing changes.
  *Review rounds*: a drawing gets up to `MAX_FIXES` (2) fixes when it doesn't run and up to `MAX_LOOKS` (3) looks at its
  own frames, each fixing what it sees, until the model says nothing more needs changing (a fix that breaks it keeps the
  last working version). *3D*: three new drawing styles, `clay3d`, `studio3d` and `isometric3d`, draw with three.js r186
  (MIT, vendored as `vendor/three/three.js`, rebuilt with `scripts/build-three.mjs`, a test checks it) on a lit stage the
  sandbox builds (`env.stage3d`: key light with soft shadows, fill, rim, RoomEnvironment reflections, a shadow-only
  ground, a camera; `env.material3d` for clay, plastic, glossy, metal, glass, matte and glow; `stage.project` pins 2D
  labels to 3D things); `THREE_GUIDE` in `ai/drawn.ts` is what the model is told. Only code that uses it loads three.js
  and gets WebGL, on Chrome's software renderer (`--use-angle=swiftshader --enable-unsafe-swiftshader`: no GPU, the same
  frames everywhere); every other drawing has WebGL refused in the page as well as by flags. A 3D frame takes about a
  quarter of a second at 1080p after ~25 s to start, so 3D pages get 90 s per frame, 15 min per render, and are tried at
  4 frames a second. *Look*: a brief's `aiLook` (core `AI_LOOKS`: cinematic, 3D animated film, 2D cartoon, anime,
  claymation, motion graphics, watercolour, paper cut-out; absent/`auto` = none) is added to every generated image and
  clip prompt (`withAiLook`), so the scenes look like one film; the writer is told not to name a style, and to describe
  a recurring person, place or thing in the same words every time. *Picture first*: when Wan on fal makes the clips and
  the space has an image key, each clip starts from its opening frame painted by the image AI (`firstFramePrompt`),
  sent to Wan's image-to-video (`FAL_IMAGE_VIDEO_MODELS`: 2.2 A14B, then 2.7) as a data URI; a picture that can't be
  made leaves the clip to the words. Gemini clips stay text-to-video. `ProduceCapabilities.video.fromPicture` says so,
  and `pricePerSecond` comes from fal's price list (only while it names the model in use). *Full motion*: a brief's
  `motion: 'full'` makes every scene a clip (the writer is told so, scenes of 12-24 words, about one per 8 s) and allows
  `MAX_AI_CLIPS_FULL_MOTION` (16) clips; the wizard shows an estimate of the clips and their cost before assembly.
  **Blender scenes** (12 Nov 2026). A drawing style, `blender`: the space's animation model writes a Blender 5.2 Python
  script (`def build(scene, env)`, `BLENDER_SYSTEM` in `ai/drawn.ts`) that builds, lights and keyframes the scene; the
  same write, fix (2) and look (3) loop tries it as half-size test renders. `media/blender.ts` runs it on this
  computer's Blender (desktop edition, or `BLENDER_LOCAL=1`; found at `BLENDER_PATH` or where Blender installs) and
  `media/runpod.ts` on a graphics card rented from RunPod with the space's own media key (`runpod`, Settings → AI, web
  edition; needs S3 storage): one pod per video (`RUNPOD_GPUS`, RunPod's CUDA image, Blender 5.2.4 from blender.org
  checked against its SHA-256), deleted when the video's visuals are done; the pod deletes itself after 30 min without
  a job or 4 h in all. The server never connects to the pod and gives it no key: one presigned manifest link, jobs
  written to presigned slots in storage, results uploaded through presigned links (`blender/boot.sh`, `blender/pod.py`).
  Blender always runs `blender/harness.py`: the script is parsed and refused if it imports anything beyond bpy, bmesh,
  mathutils, math, random, colorsys, names exec/eval/open/getattr and the like, touches `_` attributes, file, path,
  script, handler or driver-expression APIs, or bpy.ops outside modelling; while it runs an audit hook refuses files,
  imports, processes and the network (processes and network stay refused while rendering); Blender starts with factory
  settings, auto-run scripts off, a throwaway folder and no secrets in its environment. Renders: EEVEE, falling back to
  Cycles (OptiX/CUDA, else CPU). Without Blender or a key the style is not offered (`ProduceCapabilities.blender`), and
  a brief that asks for it is drawn in `studio3d` with a note. ⚠ Windows with Smart App Control on blocks the blender.org
  zip (its `blender_cpu_check.dll` is unsigned) and blender.org's MSIX is unsigned too: install Blender from the Microsoft
  Store there (found through its `WindowsApps\blender.exe` alias). Not yet run against a real Blender or a real RunPod key.
  **Lottie motion graphics and rigged characters** (13 Nov 2026). *Lottie*: a drawing style, `lottie`; the AI builds the
  scene with `env.motionGraphics(name, s => ...)` (`sandbox/lottie-mg.js`: text, rect, ellipse, circle, path and group
  layers with fadeIn, slideIn, move, pop, scaleTo, spin, drawOn and keyframes), compiled to standard Lottie (bodymovin
  v5) JSON and rendered frame by frame by lottie-web 5.13 (MIT, `vendor/lottie`, the light canvas build: no
  expressions, so an animation can't run code). lottie-web's canvas renderer only draws text from exported glyphs, so
  text layers stay in the JSON as real text layers but are drawn by the sandbox in the brand's fonts, in their place in
  the stacking order. `LOTTIE_GUIDE` is what the model is told. *2D people*: Open Peeps (Pablo Stanley, CC0) from
  react-peeps (MIT), built into `vendor/peeps/peeps.json` by `scripts/build-peeps.mjs` (33 faces, 51 hairstyles, 16
  facial hair, 9 accessories, 26 standing, 10 sitting and 28 bust poses; the bike pose left out). `env.peep(name,
  opts)` (`sandbox/peeps.js`) is a cut-out puppet: body pose swaps with a squash, a head on a neck pivot (nod, shake,
  tilt, idle life), expressions, a drawn mouth that opens and shuts on the narration's words (on faces with a no-mouth
  version; others swap to an open-mouth face), enter/exit/move/walk; heads are placed on each body at its shoulders,
  measured once from the art (react-peeps never aligned standing and sitting bodies with heads). Every 2D style's
  prompt carries `PEEPS_GUIDE`. *3D characters*: `env.character(name, opts)` (`sandbox/rig.js`) on the 3D stage, a
  jointed toy figure with a motion library (walk, run, idle, talk, dance, sit, wave, nod, shake, point, jump, cheer,
  clap, shrug, turn); the 3D styles' prompts carry `CHARACTER_GUIDE`. Each add-on loads only on pages whose code uses
  it (`usesLottie`, `usesPeeps`, `uses3d`).
  **The same characters in every clip** (15 Nov 2026, found by a real Full motion film on production: five Gemini
  clips, each a good shot, but the fox had green eyes in one and amber in the others and the bird was twice the size
  with another beak in the fourth). Every AI picture and clip is made on its own, from its own words, so nothing
  tied the clips to one design. *The cast* (`ai/cast.ts`): the idea script writer now lists the characters seen in
  more than one generated picture or clip (`cast` in `IdeaScriptSchema`: a name and a look "two painters would paint
  the same way", at most 4) and calls them by those names in the scene prompts; it is kept on the script
  (`ai.script.cast`, `ScriptCharacter` in core; the wizard's draft saves and an assembly leave it there). *In words*:
  at assembly every `image` and `aiVideo` request that shows a character (`castIn`: its name, or the last word of it)
  ends with the cast's own description of it (`withCast`), the same sentence every time. *In pictures*: where the clip
  model takes reference pictures (`GeminiVideoModel.references`: Omni 1.2 takes 6, three per character for two
  characters; `ProduceCapabilities.video.references`) and the space can paint, one picture of each character that is in
  more than one clip (at most `MAX_REFERENCED`, 2) is painted first (`characterPicture`: the whole character alone on a
  plain ground, in the video's look), kept with the project as "Character · <name>" (`meta.generated.kind`
  `character`, found again by its description, so the next assembly uses the same picture) and sent with every clip
  the character is in: image parts before the words, with `generation_config.video_config.task` `reference_to_video`
  so a picture is never taken for the clip's first frame, and the words say which picture shows whom. Only Google's
  guide vouches for that request shape, so a 400 naming the task has the pictures sent without it, and a 400 naming
  the pictures has the clip made from the words as before (`start` in `generate/video.ts`); a picture that can't be
  painted leaves its character to the words and the video says so. A script with no cast (written before this, or
  with no returning character) is asked for exactly as it was. Wan on fal.ai gets the words (its clips start from a
  first frame, which is painted from the same words).
  *Sizes* (16 Nov 2026, from the film that proved the above: the same fox and bird in every clip, but the bird the size
  of the fox's head in the two-shots and small again on its back). Each reference picture shows its character filling
  the frame, so nothing said how big one is beside the other. The cast now also says how tall each character stands
  (`heightCm`, true to life: a fox cub 30, a songbird 8); every prompt that shows two of them says how their heights
  compare in plain words (`sizesLine` / `tallAs` in `ai/cast.ts`: "the tiny blue bird is about a quarter as tall as the
  small orange fox ... never enlarge a smaller character so that it reads better"); and a clip that shows all the
  pictured characters is sent one more reference picture after theirs, the characters side by side on one line at those
  heights (`media/size-chart.ts`: each cut out of its own picture with sharp's trim, scaled, composited; made from the
  pictures already painted, so nothing more is paid for and nothing is added to the Library). A cast written before
  this has no heights and is asked for as it was.
  **A drawing that goes quiet no longer costs the video** (15 Nov 2026, found by a real video on production: three 3D
  scenes, one finished, then 20 minutes with no progress report, the watchdog stopped the job and nothing it had drawn
  was kept). *Why it went quiet*: the keep-alive of 14 Nov listened for stream events, and a model that is thinking
  sends none (thinking text isn't streamed on the strongest models, and the SDK drops the server's `ping` events; its
  request timeout only covers the wait for the first byte). Trying a drawing's frames in the sandbox reported nothing
  either. *Every step reports and has its own limit* (`ai/drawn.ts`): `stepReporter.during` says the step under way
  again every 20 s by the clock, with the minutes it has taken ("Drawing s02: Writing the animation (4 min)"), so the
  watchdog is no longer what bounds a drawing; `DRAWING_LIMITS` is (write 12 min, written again or fixed 8, a look 6,
  no new look after 15). An answer over its limit is given up, not the scene: the code is asked for once more at low
  effort (`TooSlowError`), a slow look is skipped because the code already runs. The sandbox (`media/drawing.ts`)
  bounds a try-out (90 s, 3D 4 min) and tells a drawing whose full render could not finish in time
  ("Too slow to render: a frame takes about … Build everything once …"), which goes back to the model as a fix
  while it can still be made lighter; a render reports at least every 5 s and says when it ran out of time.
  *One scene never costs the run* (`makeSceneVisuals` → `withinLimit`): a drawing that still isn't done after
  `DRAWN_LIMITS.sceneMs` (30 min: a hang nothing above caught) is given up and stood in for like any scene that
  can't be drawn, and the rest of the video is made. *Finished drawings are kept*: a drawn clip's asset row holds the
  code that draws it and what it was asked for (`meta.generated.code` / `.ask`, the note and the style hashed), so a
  later assembly of the same project uses a drawing an earlier run finished (`earlierDrawing`; the clip itself while
  the timing is the same, else the code is rendered again): a run that was stopped, failed or restarted pays only for
  the scenes it hadn't finished, as it already did for voices. A clip in the trash isn't picked up. *An honest bar*:
  the visuals' share of the job's progress (0.6 to 0.9) is what is done of all the scenes together, not the furthest
  scene's slot (the last scene finishing first read as 90% with "less than a minute left" for 20 minutes), and caption
  timing no longer moves the bar into that share and back.
  **Animated videos that actually get made** (14 Nov 2026, found by a real video on production). *Room to answer*: a
  structured answer on an Anthropic key (the script, every AI-drawn scene's code, its fixes and reviews) was asked for
  with `max_tokens: 16000`, which the model's thinking shares: on the strongest models every drawn scene came back
  "cut off" and the film was text cards. `AnthropicApiProvider.structured` now streams the request with
  `STRUCTURED_MAX_TOKENS` (64,000); a model that allows less refuses with a 400 naming `max_tokens` and is asked again
  within `STRUCTURED_MIN_TOKENS` (16,000) from then on. An answer that still runs out says so in plain words
  (`CUT_OFF`, all three providers). *Instead of a text card*: a scene whose visual can't be made is no longer left as
  animated text while something else can show it (`makeSceneVisuals` → `instead`): an AI clip that fails or is over the
  clip limit is drawn by the animation AI from the clip's own description, in the brief's drawing style (always in a
  full-motion film; otherwise when the brief's kinds include drawn), and a scene that can't be drawn becomes an AI
  picture when the brief's kinds include images; only then is it text. The note says what stands in and why
  ("s01, s02: The AI drew this scene because its clip couldn’t be made. …"). *The writer knows the drawing style*:
  the script prompt's `drawn` line (`drawnGuide` in `ai/scenes.ts`) names the brief's style and what it can show (2D
  styles: illustrated people who act; 3D styles: jointed 3D characters and a camera; Lottie: no characters; Blender),
  and tells the writer not to name a style of its own, so a 3D video is no longer described as "soft flat
  illustration". *Tone*: a new brief's tone follows the idea (`toneForIdea` in the wizard: calm, playful, energetic,
  professional, friendly, else confident), so a gentle story no longer gets the product-pitch voice and music.
  *Time*: a drawing takes 5 to 17 minutes on a strong model, nearly all of it waiting for the model, so
  `makeSceneVisuals` now runs in three passes: everything but the drawings in order, then the drawings
  `DRAWN_AT_ONCE` (2) at a time (Blender one by one), then what couldn't be drawn. While an answer streams in, its step
  is reported again every 20 s (`StructuredRequest.onActivity` → `stepReporter` in `ai/drawn.ts`), so the 20-minute
  no-progress watchdog doesn't stop a long answer; the wizard's estimate counts 5 / 9 / 17 minutes a drawing (Lottie /
  2D / 3D, `drawnSeconds`), two at a time, where it used to say 75 seconds. Where only text could stand in, the script
  keeps the visual it asked for (`asked`), so the next assembly tries again.
  *One film*: what the first real video showed (a coral "orange fox", built differently in every scene, small in pale
  studio sets, with an emoji scene between the 3D ones) is now said to the models. The drawing AI: a colour the
  director's note names is that thing's colour (the palette is for what the note leaves open), a named place is
  built in its own colours, the main character is at least a quarter of the frame's height, and a later scene is
  shown an earlier scene's code and told to build what appears again the same way (`reference` in
  `buildDrawingPrompt`; in `makeSceneVisuals` the first drawing leads and the others start when its code first runs,
  `onWorking`, or from a scene drawn in an earlier assembly). The script writer: a story is drawn in every scene, never
  an emoji animation between drawn scenes; and the word budget subtracts each scene's pauses (1.9 s) and the cards
  (6.5 s), so "30 seconds" comes out near 30 instead of 49. The wizard's "Just the animation" keeps whichever of the
  two animated kinds the person had ticked.
  *Settings documents*: `normalizeDoc` returns a copy of its own; before, every space that had saved nothing shared one
  `providers` / `perFeature` object in memory, so one space's first key test or per-feature choice showed in the others.
  **Shared AI keys** (13 Nov 2026, migration v19). An owner of two spaces can let one use a key stored in the other:
  `PUT /api/ai/keys/:provider/shares/:toWorkspaceId {workspaceId}` and `DELETE …?workspaceId=` (every stored key: the
  three writing keys, fal.ai and RunPod; cloud only, 404 on the desktop). Only owners, and only between spaces the
  caller owns (403 otherwise, 404 for a space they aren't in): the receiving space's work goes through the key's
  provider account. The share is a row in `ai_key_shares` (to, provider → from), never a copy: `keyMeta` and `readKey`
  in `ai/store.ts` follow it when the space has no key of its own, so replacing the key reaches every space that uses
  it and removing the key or the share ends their use at once. `AiSettings` shows it as `sharedWith` on the key (owners
  of the sharing space) and `shared` (whose key it is, no `keyLast4`) in the space that uses it. The receiving space
  keeps its own model and provider choices, gets the key's model list and last test (`ai/shares.ts`: `seedRecipient`,
  `mirrorTest`), and takes the key as its default when it had no AI at all. There, `DELETE /api/ai/keys/:provider`
  stops using it and saving a key of its own replaces it. A shared key can't be passed on (409), a space with its own
  key isn't overridden (409), and one key goes to at most `MAX_KEY_SHARES` (50) spaces. Both spaces get an audit entry
  (`ai.key.shared`, `ai.key.unshared`). Use is metered on the space that made the request; the provider bills the
  key's account. Settings → AI: "Shared with" on each key's card, "Shared by" on the card of a space that uses one.
  **Music and sound effects** (3 Nov 2026): a brief's `music` (`'auto'` = a style that suits the tone, one of core's
  `MUSIC_STYLES`, or `'off'`/absent = none) and `soundEffects` (absent = none; the wizard defaults new briefs to `'auto'`
  and on). The music is composed for the video on its scene cuts by huashu-motion's score engine (MIT), vendored in
  `scripts/music/` (dsp.js and score.js unchanged; soundtrack.js is the music half of its sound.js; samples.js a stub,
  so every instrument is synthesized). It runs as its own process (`scripts/music/compose.mjs`, about a minute per minute
  of video on one core, stopped after 15 min), levelled to `MUSIC_LUFS` (-30; Kokoro narrates near -22.5), encoded to AAC and stored as an asset
  (`meta.generated.kind = 'music'`, keyed on style + cuts + length, so an unchanged video reuses it). It goes on its own
  `Music` track that ducks `MUSIC_DUCK_DB` (10) under the voice in the editor, so moved or re-recorded narration stays
  ducked. The effects are earshot's kits (MIT): `launch`, `calm`, `crisp` and `minimal`, rendered once from its bank
  (at most 3 takes a role) and shipped as Ogg Opus in `sfx/` (~300 KB, `manifest.json` gives each take's sync point:
  its onset, or its peak for a whoosh). `ai/soundtrack.ts` puts a landing on the title, a whoosh on each cut, up to
  three spaced pops per scene as graphics appear (not on a cut), and a ding on the close card, each an ordinary clip
  on a `Sound effects` track; the kit follows the music style. Each take is copied into the space once
  (`kind = 'sfx'`). Neither stops an assembly: what can't be made is left out and said in the job's notes. The desktop
  build copies `scripts/music` and `sfx` (stage.mjs).
  **Videos without some parts** (5 Nov 2026): a brief's `narration`, `captions`, `onScreenText` and `cards` (false: left
  out; absent: kept; read through core's `videoParts`: only an idea can go without narration, and captions need it). No
  narration: no voices are made, a scene lasts as long as its `narration` text (then a description of what happens) would
  take to say, the writer and the animator are told nobody speaks, and the music is levelled to `MUSIC_ALONE_LUFS` (-18)
  with no duck. No words: headlines, chapter labels, animation labels and the stand-in discs' names go, motion and
  diagram leave the writer's choices, and the animator draws no text; a scene with nothing else to show keeps its
  headline, and a credit line a licence requires stays. No cards: the first scene starts at 0, and no whoosh goes into a
  close that isn't there. The wizard's "Just the animation" sets all four and asks for animation and drawn visuals.
  Since 16 Nov 2026 it keeps the moving kinds the person ticked (`animationKinds` in the wizard's `wizardLogic.ts`):
  animations, AI-drawn scenes and AI clips stay; with none of those, stock footage stays; only with nothing that moves
  ticked does it set animation and drawn. Undoing it puts the visuals back to the usual choice only when they are those
  two; it never sets the tone (that follows the idea when the first step is left, `toneForIdea`).
  **Found on the live site on 15 Nov 2026** (fixed 16 Nov): the preset above; the Assemble step's line now comes from
  `assembleLine` (no "narrated" without narration, "1 scene"); several drawings under way are one status line naming
  them all in scene order (`inWorkLine` in `ai/drawn.ts`: "Drawing s01 (checking, 3 min) and s02 (writing, 1 min)"; one
  scene alone reads as before), where each scene's own line used to replace the other's every 10 to 20 s; the wizard's
  estimate for three.js 3D drawn scenes is 12 minutes and 80,000 tokens in / 55,000 out a scene, about a quarter above
  the one run measured at medium effort (three studio3d scenes on claude-fable-5-2: 14.9 minutes, 221,054 in / 123,016
  out, $6.69), where it had said 26 minutes and $13 (`estimates.ts` says where each number comes from; 2D, Lottie and
  Blender are unchanged, having no measurement at medium effort); and AI clip seconds are on the Usage page
  (architecture.md → "Usage and limits").
  **Reported from the live site on 19 Nov 2026** (two bugs, one video of fourteen AI clips).
  *"Remove…" for clips not on the timeline did nothing.* Its menu opened 4 px below the bottom of the window: the
  menu's own class (`.ed-unusedpop`, position: absolute under its bar) lost to the general `.ed-menu` rule further down
  the stylesheet (position: fixed), so it was fixed at `top: 100%` of the window. The brand-colours popover of a colour
  field (`.ed-color-pop`) had the same fault. Both are now `.ed-menu.<class>`; a menu class that positions itself must
  outrank `.ed-menu` (`unused-media.test.tsx` reads the rule, since jsdom lays nothing out). With the menu in reach:
  "Move to the media trash" now takes the clip off the project's list first (`trashUnused`; a clip only trashed stayed
  listed, still counted); the bar no longer counts what the app keeps for itself, the project's exports
  (`origin: 'render'`) and its characters' reference pictures (`AssetRecord.reference`, from `meta.generated.kind ===
  'character'`): trashing an export from that bar would have lost the finished video, and a removed character picture is
  painted again, differently, at the next assembly; and the brand logo counts as used there as it does in
  `unusedAssetIds` (one `usedAssetIds` in core).
  *The export stopped at 18%, "ffmpeg couldn't decode it".* Four exports each lost four to six of the fourteen clips,
  different ones each time, within 25 s; the files were fine and 44 of 46 GB were free. `extractionFailure` said
  "couldn't decode" of every cause it didn't know, and what ffmpeg said was thrown away. The gate
  (`scripts/hf-ffmpeg.mjs`) had limited only the decoder's threads: ffmpeg's filter graph and frame encoder still sized
  themselves for every core the container reports (48), about seventy threads an extraction. Now all three pools get
  `PS_FFMPEG_THREADS`; an extraction that fails for no reason of its file (not killed, not a full disk, not a file
  ffmpeg can't read) is run again while it holds its slot, up to `PS_FFMPEG_RETRIES` (2) more times; HyperFrames' own
  one retry of a passing fault is on (`HF_VIDEO_EXTRACTION_MAX_RETRIES`); the gate's log records the failed try, its
  number of tries, `ok` when a later try worked, and the container's process count (`pids.current/pids.max`); a cause
  the export doesn't know is given in ffmpeg's own words (`ffmpegSaid`: its last line that reads like an error, without
  paths or log tags), "out of memory" is told by the kill signal and not by a 137 somewhere in the output, and
  everything ffmpeg and the renderer said goes on the job for an operator (`error_detail`, through `HttpError.details`
  and `rawJobError`). An export that only succeeded on a later try logs a warning with what the first try met. **Not
  known yet:** which fault the first tries met on production (nothing kept it); the next export that needs a second try
  says so in the server log.
  **Asked for on 19 Nov 2026** (the owner): sounds heard before they are used, a music library, and caption choices.
  *Music library*: 20 tracks composed by the server, replaced on 21 Nov by AI songs (below). The editor's Audio panel
  lists the library under the project's own sounds: Listen (a spinner until it plays) and + (adds it at the playhead).
  The editor's Help (?, the rail's and the top bar's Help buttons; it was the Keyboard shortcuts dialog) explains it;
  the app's Help → About points to it. *Hearing the brief*: Music has "Listen to <style>" (since 21 Nov a sample of
  that style composed by the server, `GET /api/music/style/:style/preview`, kept in `<dataDir>/style-samples`; another
  style picked stops it) and Sound effects "Listen to the effects" (whoosh, pop and ding of the kit that
  goes with the music, `sfxKitFor`, `GET /api/music/sfx/:kit/:role`). The Audio panel's play buttons now say when a
  sound is still on its way and when it can't be played. *Captions in the brief*: with Captions on, a look
  (`CAPTION_PRESETS`), a font (`FONTS`, else the brand's body font), a size (small/medium/large, `CAPTION_SIZES`) and a
  place (top/middle/bottom, `CAPTION_PLACES`; bottom is the look's own place), beside a sample frame of the video's shape;
  stored on the brief (`captionPreset`, `captionFont`, `captionSize`, `captionPosition`) and applied at assembly by
  `captionStyleForBrief` (absent: the brand kit's look in its body font, as before). The editor's Captions panel already
  turns a video's captions on and off and restyles them.
  **Asked for on 21 Nov 2026** (the owner): "remove the current music samples and create 20 additional music clip
  samples (a mix of genres) as well as 10 different animation video clips, and 10 different full motion video clips".
  The *media library* (`MUSIC_LIBRARY`, `CLIP_LIBRARY` in core `mediaLibrary.ts`; `services/media-library.ts`): 20
  instrumental songs of 20 genres from Google's Lyria (`ai/generate/music.ts`: Interactions API, `lyria-3.5` then
  `lyria-3-pro-preview`, MP3, billed per song), 10 animations drawn by the space's animation AI in ten drawing styles
  (8 s, 1920×1080, no words; two are 3D) and 10 full-motion Gemini clips (8 s, 16:9, 720p; Gemini only, whatever the
  space's video choice: `generateVideo({provider})`). Made once, on the cloud server, with the keys of a space an
  operator owns: Operator → Media library ("Make what's missing…", which says what it spends first; audit
  `operator.library.make`), as `library.make` jobs, one at a time (each queues the next, music, then full motion, then
  animations; a failed item doesn't stop the rest, and the next go makes only what is missing). Kept in storage under
  `library/music/<id>.v<version>.*` and `library/clips/<id>.v<version>.mp4|.jpg`, each with a `.json` saying its file,
  length, model and the space that paid; shared by every space. Routes: `GET /api/music` and `GET /api/clips` (each
  item with `ready` and `seconds`), `GET /api/music/:id/preview`, `GET /api/clips/:id/preview|poster` (from storage,
  Range), `POST /api/music|clips/:id/add {workspaceId, projectId?}` (the space's own copy, `meta.generated.kind
  'library'`, reused when added again), `GET /api/operator/library`, `POST /api/operator/library/make {workspaceId,
  kinds?}`. In the editor: Audio → Music library (made songs only, genre · mood · length) and Media → Clip library
  (Animations | Full motion, poster frames, plays on hover, + at the playhead); the Help's Media library tab explains
  both. The old composed tracks (`<dataDir>/music-library`) are deleted at start-up; spaces keep copies they added.
  *Making an item your own* (the owner, same day: "customize based on their needs/brand/topic", then "the branding
  doesn't need to affect the animations so much as the Narrative Text, Titles, Thumbnail, company stamp/logo"): the wand
  on a song or clip opens Make it your own (`editor/LibraryCustomize.tsx`). *In your brand* (clips): the clip goes on
  the timeline with an optional title (a lower third in the brand's headline font on its background colour), an
  optional line of narrative text (its body font on its accent) and the kit's logo stamped bottom-right over the whole
  clip on its own overlay track (the brand's name while the kit has no logo); free, made in the editor
  (`editor/libraryBrand.ts`), every piece editable. A recolouring of the animations from their kept code was tried on
  production first and dropped: the AI writes most colours into a drawing as fixed values, so a new palette barely
  changed them. *For your topic*: any item remade about the video's topic on the space's own keys (an animation redrawn
  by its animation AI from the library's drawing, a clip filmed again in the video's shape on its video key, a song
  written again in the same genre on its Gemini key); it says what it costs first (`libraryCustomCost`); a
  `library.custom` job (`POST /api/clips|music/:id/customize {workspaceId, projectId?, mode: 'topic', topic, aspect?}`).
  A library song added at the playhead is cut to end with the video's last picture, with a 2 s fade out
  (`fitSongToVideo`). Every clip (the library's and the space's own) has Watch: a player with sound before it is added.
  *A branded cover* (22 Nov, the owner's "Thumbnail" among the brand's places): Export → Cover → "Brand the cover"
  with a title (the project's name to start with; `ExportRequest.coverBrand {title}`). The export draws the cover
  frame with a dark fade, the title in the brand's headline font (up to two lines) over an accent bar, and the logo
  (else the brand's name) top right, at 720 px on the short side, by fixed code in the export's sandboxed browser
  (`render/cover.ts`, `testDrawing`); it becomes the export's thumbnail and share-page poster, and Exports & sharing
  shows each export's own cover with a Thumbnail download. A cover that can't be drawn leaves the plain 360p frame.
  Not in the desktop app (made on the cloud server; the panels say so there). All 40 items were made on production
  on 21-22 Nov (Lyria 3.5 songs, Gemini Omni clips).
  *Producer uses the library* (23 Nov): a new brief's music is `'library'` (the library song that suits the tone:
  `librarySongFor`, `LIBRARY_SONGS_BY_TONE`), or `'library:<id>'` for one picked in the brief and heard there first;
  `musicChoice` falls back to the tone's composed style where no song is made (a desktop). The song is fitted per
  video (`ai/soundtrack.ts` `fitSong`/`makeLibraryMusic`: cut, or looped with a 3 s crossfade, faded out over 2.5 s,
  two-pass loudnorm to the composed music's level; reused for the same length) and the effects use `libraryKitFor`.
  Scenes may show a library clip (visual kind `library {id, assetId?}`, on by default once clips are made: the writer
  gets them by id and in words, `readyLibraryClips`; the space's copy is made by `addLibraryItem` at assembly and
  fills the frame like a stock clip; one that can't be added shows the scene's words and the script keeps the pick).
  The brief's `logoStamp` (on for new briefs) puts the kit's logo, or its name while it has none, small in the
  bottom-right corner through the scenes (`stampCorner`/`logoStamp` in core brand.ts, shared with the editor's In your
  brand), and a kit's logo also goes above the title and on the closing card. The export of a video Producer made
  starts with Brand the cover ticked and the brief's title.
  Same day, after a real run: a title card's heading of two or more lines moves up by half a line per extra line
  (`headingLines`, an estimate at 0.6 em a character) so the name under it is never covered, and the logo above it
  moves up with it; and a motion scene's points are revealed in place (`wipeRight`) instead of sliding in from the
  left across their dots. The full-motion clips' sound (made by the video model, "out of tune" to the owner) is
  replaced by a stretch of a library song that suits each clip (`LibraryClip.song`, `CLIP_SOUND_VERSION`;
  `scoreClip`/`scoreLibraryClips` run once by the cloud server 20 s after it starts: picture copied untouched, the
  song from a quarter of the way in, faded, at -16 LUFS, `media/fit-song.ts`). The file as made is kept
  (`LibraryInfo.sound.original`); a space's copies added before keep their old sound (the copy key gains ` s1`).
  *A video's music changed to a library song* (24 Nov, the owner: the composed music in recent projects is "out of
  tune"): `POST /api/music/:id/use {projectId}` queues a `project.music` job (`services/project-music.ts`): the song
  fitted where the old music played (`musicSpan`), at the composed music's level under a narrator (louder without
  one), as the only item on the Music track (ducked when voiced); other music clips come off (`isMusicItem`: the Music
  track, or an asset named "Music · …"); saved with the version before kept (`before-ai`, note "Music changed to …");
  `ai.brief.music` becomes `library:<id>` so assembling again keeps it. No editor button yet.
  *The composer retuned* (24 Nov, same complaint): huashu-motion's synth voices only stand in for its sample pack,
  which Producer doesn't ship, so they are all anyone heard. Their chorus detuning (copies of a note up to ~20 cents
  apart) is now about 1-3 cents, struck voices' overtones sit on harmonics (marimba 4th partial was 24 cents flat;
  kalimba, glockenspiel, bell, glass), the piano's stretch is a quarter, the cowbell's fifth is 3:2 (`scripts/music/
  score.js`, `dsp.js`, headers say what changed). Measured by `scripts/music/tuning.js` (`node scripts/music-tuning.mjs
  [styles] [--no-drums]`): tonal energy more than 4 cents off, before → after: mallet 56% → 5%, funk 41% → 10%,
  ambient 20% → 9%, pulse 65% → 24%, cinematic 75% → 22% (9% without drums); what remains in rhythmic styles is
  repeated-note and sidechain sidebands, not detuning. `MUSIC_VERSION` 2: music composed before is composed again.
  *Stock pictures looked at* (24 Nov; a real run's "person stretching by window morning" scene got a water tower):
  `ai/stock-check.ts` `findStock` downloads each library's first results and has the space's AI (server key or the
  space's own; `effort: 'low'`, one small call each) look at a 512 px JPEG of the photo, or of a clip's typical frame
  in its first 8 s, against the search, headline and narration; one that doesn't show it is passed over, at most
  `STOCK_LOOKS` (6) per scene, then the scene stands in as a failed visual does, the note naming what they showed.
  Without an AI the first that downloads is used, as before. The editor's music library has a swap button (Use as
  this video's music → `POST /api/music/:id/use`, confirm, then the editor adopts the new version).
  **Failed clips in the editor**: the tile says why (`failedReason`), Retry shows only when the file reached storage,
  failed clips sort last, and two or more get "Remove all" (to the media trash).
  **Sign-up from meyousocial.com** (26 Nov 2026): `/api/provision/*` (signed with `PROVISION_SECRET`, HMAC-SHA256 over
  "<timestamp>.<body>"; off and 404 without it), `POST /api/auth/link` (one-time sign-in links, `/link/:token` in the app),
  `GET|POST /api/workspaces/:id/membership[/claim]`, `workspace_plans` (migration v21). An active membership turns the
  server's AI on for the space; any other status turns it off and the owner can't turn it back on; `seats` caps members
  plus pending invites. Since 26 Nov the server's AI is members-only: `PUT /api/usage/builtin-ai {enabled:true}` needs an
  active membership or an operator (`builtinAiRefusal`; `GET /api/usage` says why in `builtinAi.whyNot`); spaces that
  already had it on keep it. The full contract: docs/integrations/meyousocial.md.
  **Flow-style clips** (asked for on 24 Nov 2026: "add the Flow-style features"; Google's Flow app has no API, and it is
  built on Gemini Omni, which Producer already uses). Two brief options under Full motion, both off by default:
  *Flowing scenes* (`brief.flow`): an AI clip whose scene follows another AI clip starts on that clip's frame at its
  scene's cut, its last frame when the clip is no longer than the scene (`produce.ts` `frameAt`: ffmpeg on the stored
  original, JPEG; see "Flowing joins cut" below). Gemini gets the frame as the only
  picture, task `image_to_video`, its words prefixed with `FROM_FRAME`, and no reference pictures (two pictures read as
  first and last frames; the cast is still described in words); Wan on fal takes it as its first frame instead of a
  painted one. The clip records `meta.generated.from` (the clip it follows): turning flow on remakes the clips that
  follow another, a changed clip remakes the ones flowing on from it, and turning it off keeps them. Google refusing
  the picture makes the clip from the words, with a note. *Long shots* (`brief.longShots`, Gemini only:
  `capabilities.video.extendTo`, 30 for Omni 1.2): a scene 2 s or more past one generation (15 s) is extended 3–10 s a
  turn with `previous_interaction_id` (`generate/video.ts` `extendShot`, task `extend`, `EXTEND_WORDS` before the words)
  up to its length or 30 s. Google's guide doesn't say whether a turn returns the whole shot or only what it adds, so
  each turn's measured length decides: the whole shot replaces the file, a continuation is joined after it
  (`genDeps().join`, ffmpeg concat, re-encoded). Interactions are deleted once the shot is saved. A failed turn keeps
  the shot as far as it got (`notExtended`, a note on the assembly); `meta.generated.long` keeps a long clip when long
  shots are turned off and remakes a short one when they are turned on. The Usage page counts the whole shot's
  seconds. Neither request shape has been tried on a live key yet: only Google's docs vouch for them.
  **Flowing joins cut, on the frame handed on** (26 Nov 2026, the owner: the paper boat film's joins showed "a slight
  blur"; the frames inside each 0.5 s crossfade were measurably softer, the long shot's ffmpeg joins were clean). A
  crossfade over a flowing join laid two near-identical moving pictures over each other, so a scene whose clip the next
  one continues now has no transition: a straight cut. The next clip starts on the frame at the scene before's cut
  (`handOffAt`: its length, or the clip's end when the clip is shorter; `frameAt` takes the first frame from there),
  recorded as `meta.generated.fromAt` (and `fromFrame: false` when the model wouldn't use it). The timeline ends the
  clip before on that frame (`AssembleInput.flows`): a clip made before `fromAt` (from its last frame) starts later,
  or, when its own start continues the scene before's, plays up to `FLOW_SPEEDUP` (1.12×) faster. Captions from whisper
  now say the script's words at whisper's times (`scriptWords`: the two word lists lined up; "a wide, calm pond" had
  been captioned "a wide compound").
- **AI**: provider = Anthropic API (`claude-opus-5`, adaptive thinking, `fallbacks: "default"`). Without `ANTHROPIC_API_KEY` every AI
  route returns 503 `{code:'server', error:'AI is not configured on this server'}` before starting a stream/job.
  `GET /api/system` reports `ai.available`.

## Known gaps

(Reviewed 24 Nov 2026: entries proven by production since are gone. Production runs Postgres and S3 on Railway, and
the Claude routes run there on spaces' own keys and, since 23 Nov, the server's `ANTHROPIC_API_KEY`.)

- Claude routes (`write`, `produce/script`, `assistant`) are unit-tested here against stand-in providers; this machine
  has no key of its own, so live checks happen on production.
- `webm`/`gif` export formats are wired but only `mp4` has been rendered end-to-end.
- Browser uploads straight to S3 need the bucket's CORS to allow PUT from the app's origin (an owner setting; uploads
  through the server work without it).
- Change feed: a write whose transaction commits after a later seq was already read could be skipped (writes here are single-statement,
  so the window is tiny); a desktop client can re-read with a small lookback (`since = cursor - 100`) to be safe.
- Template thumbnails are the skill's `preview.png`; workspace templates use their first clip's thumbnail. No `previewUrl` videos yet.
- Desktop mode (`MODE=desktop`, see [desktop.md](desktop.md)): the media library comes from the linked cloud
  (`services/media-library.ts`, "the library on a desktop"); unlinked it lists nothing, and remaking an item for a
  topic stays on the web. The desktop's Claude Code CLI provider (`src/ai/cli.ts`) and sync are covered by
  `cli.test.ts`, `desktop-sync*.test.ts` and `desktop-library.test.ts`.
- `/api/health` `features.ai` still reflects only the Anthropic API credentials (use `/api/system` for the active provider).
