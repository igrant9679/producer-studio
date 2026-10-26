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
  the workspace's own key (OpenAI or Gemini stills; Gemini Omni clips, at most 3 per video; Pexels stock via `PEXELS_API_KEY`),
  stored as assets with `meta.generated` and reused while the prompt/search is unchanged; a scene whose visual can't be made
  falls back to motion and the job result carries `notes`. Model ids and fallbacks: top of `ai/generate/capabilities.ts`.
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
