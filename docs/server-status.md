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
Tests: `npm test -w @producer/server` (39 tests). Typecheck: `cd apps/server && npx tsc --noEmit -p .`

## Endpoints

Everything in `packages/core/src/api.ts` is implemented with those shapes. Status: ✅ verified live with curl · 🧪 unit/integration-tested · ⚠️ needs credentials.

| Area | Route | |
|---|---|---|
| Health | `GET /api/health` | ✅ |
| System | `GET /api/system` → `SystemInfo` (public) | ✅🧪 |
| Auth | `POST /api/auth/signup`, `/login`, `/logout`, `GET /api/auth/me` | ✅🧪 |
| Workspaces | `GET/POST /api/workspaces`, `GET /:id/members`, `POST /:id/invites` (owner), `GET/PUT /:id/brand` | ✅🧪 |
| Invites | `GET /api/invites/:token`, `POST /api/invites/:token/accept` (the `inviteUrl` is `/invite/:token`) | 🧪 |
| Projects | `GET /api/projects?workspaceId=&trashed=&templates=`, `POST`, `GET/PUT/PATCH/DELETE /:id`, `POST /:id/duplicate` | ✅🧪 |
| Uploads | `POST /api/uploads` → ticket; `PUT /api/uploads/:assetId/data` (local storage; S3 gets a presigned URL); `POST /api/assets/:id/complete` | ✅🧪 |
| Assets | `GET /api/assets?workspaceId=&kind=`, `GET/PATCH/DELETE /api/assets/:id` | ✅ |
| Media | `GET/HEAD /api/media/:assetId/:variant` (`source`, `proxy`, `thumb`, `filmstrip`, `audio`); Range/206/416; S3 → 302 signed URL | ✅🧪 |
| Jobs | `GET /api/jobs/:id`, `GET /api/jobs?projectId=|workspaceId=`, `POST /api/jobs/:id/cancel` | ✅🧪 |
| Events | `GET /api/events?workspaceId=` SSE: `job`, `asset`, `project`, plus `: keepalive` every 20 s | ✅ |
| Transcribe | `POST /api/ai/transcribe` → Job `{assetId, transcript}` (whisper.cpp, word timings) | ✅ |
| TTS | `POST /api/ai/tts` → Job `{asset, duration}`; `GET /api/ai/voices`; `GET /api/ai/voices/:id/sample` (cached WAV) | ✅ |
| AI writer | `POST /api/ai/write` SSE `delta`/`done`/`error` | ⚠️ 503 without a key (verified) |
| Producer | `POST /api/ai/produce/script` (⚠️ Claude), `POST /api/ai/produce/assemble` (✅ no Claude needed) | |
| Assistant | `POST /api/ai/assistant` SSE `text`/`tool`/`done`/`error` | ⚠️ tools 🧪 |
| Export | `POST /api/projects/:id/export` → Job `ExportResult`; `GET /api/exports?projectId=` | ✅🧪 |
| Share | `POST /api/projects/:id/share` → `{url:'/r/:token', token}`; `GET /api/share/:token` and `/api/share/:token/video` (public, Range) | ✅ |
| Templates | `GET /api/templates?workspaceId=` (8 built-in `tpl:<look>` + workspace templates); `GET /api/templates/tpl:<id>/preview` (PNG) | ✅🧪 |
| Devices | `POST /api/devices {name}` (cookie/Bearer, or `{name, email, password}` with no auth) → `{deviceId, token}`; `GET`; `DELETE /:id` | ✅🧪 |
| Sync feed | `GET /api/sync/changes?since=<cursor>&limit=` → `SyncChanges` | ✅🧪 |

Timings on this machine: a 6 s 720p upload processes in ~3 s; TTS of 2 sentences ~2 s warm; whisper small.en on 9 s ~3 s;
export of a 20 s 1080p project at 720p draft ~50 s.

## Behaviour notes for clients

- **Auth**: `ps_session` httpOnly cookie (30-day sliding). Any route also accepts `Authorization: Bearer <device token>`.
  401 `{code:'unauthorized'}` when signed out; non-members get **404** on workspace resources, viewers get **403** on writes.
  Login is rate-limited per IP+email (429 `{code:'quota'}` after 8 failures in 15 min).
- **Asset URLs**: in asset records and in `project.assets`, `src`, `proxySrc`, `thumbnail` and `filmstrip.src` are already
  `/api/media/...` URLs. `GET /api/projects/:id` refreshes `project.assets` from the assets table (proxy/filmstrip/transcript
  appear there once processing finishes).
- **Uploads**: after `complete`, the asset is `processing`; watch SSE `asset` events (thumb + filmstrip + waveform arrive first,
  then the proxy, then status `ready`). `audio` = AAC extract of a video's soundtrack (falls back to source).
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
- Desktop-only routes (`/api/settings`, `/api/sync/link|unlink|now|status`, `/api/projects/:id/sync`) and the Claude CLI provider are
  left to the desktop agent (`src/ai/cli.ts` is the stub; `src/ai/provider.ts` is the seam).
