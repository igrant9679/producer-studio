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
- Verified 23 Sept 2026: lint 0/0, 10 s 720p render in ~22 s with title, captions, push transition, audio.

## Data
- **Postgres** (prod `DATABASE_URL`) / **PGlite** embedded (dev, `.data/pg`), via Drizzle.
- Tables: `users`, `sessions`, `workspaces`, `memberships(role)`, `projects(id, workspace_id, name, doc jsonb,
  version, thumbnail, duration, width, height, is_template, trashed_at, created_by, timestamps)`,
  `assets(id, workspace_id, kind, name, mime, size, storage keys, meta jsonb, status)`, `jobs(id, kind,
  status, progress, message, input jsonb, result jsonb, error, project_id, workspace_id, user_id,
  timestamps, locked_by, locked_at)`, `exports`, `share_links(token, project_id, export_id)`,
  `brand_kits(workspace_id, doc jsonb)`.
- **Object storage**: S3-compatible (`S3_*` env; R2/Railway buckets) with presigned PUT uploads and signed GET;
  dev falls back to local disk `.data/storage` with the same interface.
- The project document is the `Project` type from core. Asset `src` = storage key; the client resolves media via
  `/api/media/:assetId/:variant` (variant `source|proxy|thumb|filmstrip|audio`), which redirects to a signed URL
  (S3) or streams with Range support (local).

## Jobs
Postgres-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`), polled by the worker loop. Kinds:
`asset.process` (probe, H.264 proxy ≤720p, thumbnail, filmstrip sprite, waveform peaks, silence detection),
`ai.transcribe` (whisper.cpp), `ai.tts` (Kokoro-82M, 24 voices), `ai.produce.script` (Claude),
`ai.produce.assemble` (TTS per scene + timeline assembly), `export.render` (HyperFrames). Progress is pushed
to clients over SSE (`/api/events`).

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
- The web editor reloads silently when an SSE `project` event arrives for the open project with no unsaved edits; otherwise it shows the conflict banner.

### Desktop hardening (lessons from the Producer 0.1.x review)
Signed builds, `sandbox: true` + context isolation, a narrow validated preload API (no generic `invoke`), `shell.openExternal` limited to http(s), no bundled test artefacts or personal paths, and skills/configs never written into the user's global `~/.claude`.

## Deploy
Single Docker image (Node 22 + ffmpeg + chrome-headless-shell deps + whisper.cpp) on Railway: `web` (API +
static SPA) and `worker` services from the same image, Postgres plugin, S3-compatible bucket.
