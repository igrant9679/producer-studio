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
  **Failed clips in the editor**: the tile says why (`failedReason`), Retry shows only when the file reached storage,
  failed clips sort last, and two or more get "Remove all" (to the media trash).
- **AI**: provider = Anthropic API (`claude-opus-5`, adaptive thinking, `fallbacks: "default"`). Without `ANTHROPIC_API_KEY` every AI
  route returns 503 `{code:'server', error:'AI is not configured on this server'}` before starting a stream/job.
  `GET /api/system` reports `ai.available`.

## Known gaps

- Claude routes (`write`, `produce/script`, `assistant`) are unit-tested (prompt building, tool handlers) but have not been run against
  the live API here: no `ANTHROPIC_API_KEY` or `ant` profile on this machine.
- `webm`/`gif` export formats are wired but only `mp4` was rendered end-to-end.
- S3 storage is implemented but untested against a real bucket (browser uploads need bucket CORS allowing PUT from the app origin).
- Postgres (`DATABASE_URL`) path is implemented (same SQL, LISTEN/NOTIFY bridge for split api/worker services) but only PGlite was run.
- Change feed: a write whose transaction commits after a later seq was already read could be skipped (writes here are single-statement,
  so the window is tiny); a desktop client can re-read with a small lookback (`since = cursor - 100`) to be safe.
- Template thumbnails are the skill's `preview.png`; workspace templates use their first clip's thumbnail. No `previewUrl` videos yet.
- Desktop mode (`MODE=desktop`, see [desktop.md](desktop.md)) is implemented: `POST /api/desktop/session` (per-launch secret),
  `POST /api/desktop/claude/login`, `GET/PUT /api/settings`, `/api/sync/link|unlink|now|status`, `POST /api/projects/:id/sync`,
  on-demand cloud media in `/api/media`, and the Claude Code CLI provider (`src/ai/cli.ts` + `src/ai/cli/`, MCP server in
  `scripts/mcp-server.mjs`). `GET /api/system?refresh=1` re-probes the AI provider. Tests: `cli.test.ts`, `desktop-sync.test.ts`.
- `/api/health` `features.ai` still reflects only the Anthropic API credentials (use `/api/system` for the active provider).
