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

## Auth & tenancy
Email + password (scrypt), httpOnly `ps_session` cookie (30 days, sliding). Every user gets a personal workspace;
workspaces are the tenancy boundary (projects, assets, brand kit). Roles: owner, editor, viewer.

## Deploy
Single Docker image (Node 22 + ffmpeg + chrome-headless-shell deps + whisper.cpp) on Railway: `web` (API +
static SPA) and `worker` services from the same image, Postgres plugin, S3-compatible bucket.
