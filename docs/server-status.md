# Server status (apps/server)

_Living document for the web agents. Last update: 23 Sept 2026 — early milestone (a)._

## Run it

```bash
npm run dev -w @producer/server        # tsx watch, port 8787, ROLE=all (API + worker), PGlite in apps/server/.data/pg
```

Vite should proxy `/api` to `http://localhost:8787`. Everything (cookies, media, SSE) is same-origin under `/api`.

## Working now

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` |
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Workspaces | `GET/POST /api/workspaces`, `GET /api/workspaces/:id/members`, `POST /api/workspaces/:id/invites`, `GET/PUT /api/workspaces/:id/brand`, `GET /api/invites/:token`, `POST /api/invites/:token/accept` |
| Projects | `GET /api/projects?workspaceId=&trashed=&templates=`, `POST /api/projects`, `GET/PUT/PATCH/DELETE /api/projects/:id`, `POST /api/projects/:id/duplicate` |
| Uploads/assets | `POST /api/uploads` → ticket, `PUT /api/uploads/:assetId/data` (local storage), `POST /api/assets/:id/complete`, `GET /api/assets`, `GET/PATCH/DELETE /api/assets/:id` |
| Media | `GET /api/media/:assetId/:variant` (source/proxy/thumb/filmstrip/audio), full Range/206 support |
| Jobs | `GET /api/jobs/:id`, `GET /api/jobs?projectId=|workspaceId=`, `POST /api/jobs/:id/cancel`, `GET /api/events?workspaceId=` (SSE: `job`, `asset`, `project`) |
| asset.process | probe, proxy ≤720p, thumb, filmstrip (10 frames × 160 px), waveform (50/s), silences, audio.m4a |

In progress: transcription, TTS, export, Claude routes, templates, share, seed. See below as they land.

## Notes for the client

- `Asset.src` / `proxySrc` / `thumbnail` / `filmstrip.src` in asset records are already the `/api/media/...` URLs.
- `PUT /api/projects/:id` → 409 `{code:'conflict', details:{version}}` when `baseVersion` is stale.
- Viewers get 403 on writes; non-members get 404.
