# Producer Studio

AI video production plus a full timeline editor, in two editions that share one codebase and one project store:

- **Web**: a hosted, multi-user app (workspaces, invites, sharing). AI runs on API keys: the server's Anthropic key and/or keys each workspace adds for Anthropic, Google Gemini or OpenAI.
- **Desktop** (Windows): an Electron app that runs the same UI and server locally. AI uses your installed Claude Code CLI (your Claude subscription), and transcription, voiceover and rendering run on your machine. Projects sync with your cloud account, so either edition can open any project.

## What it does

- **Producer AI**: turn a screen recording into a narrated, branded video. It transcribes the recording (whisper.cpp), writes a script (Claude, Gemini or OpenAI), generates narration (Kokoro TTS) and assembles the timeline in one of eight looks.
- **Editor**: multi-track timeline, canvas transforms, keyframes, text and captions (auto, karaoke, SRT), transcript-based editing, pause and filler removal, effects, filters, transitions, speed and freeze frames, and an AI assistant that edits the timeline for you.
- **Export**: rendered by [HyperFrames](https://www.npmjs.com/package/hyperframes) at 720p–4K (drawn natively at the output resolution), 24–60 fps, as MP4, WebM or GIF, with share links.

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Project model, pure editing ops, frame evaluator, DOM renderer, HyperFrames compiler, API types |
| `apps/web` | React + Vite app: shell pages and the editor |
| `apps/server` | Hono API, job worker (media processing, transcription, TTS, AI, export), cloud and desktop modes |
| `apps/desktop` | Electron shell and Windows installer |
| `docs/` | `architecture.md`, `desktop.md`, `server-status.md`, `capcut-analysis.md` |

## Development

Requires Node 22+ and ffmpeg.

```bash
npm install
npm run dev -w @producer/server     # API on :8787 (PGlite + local storage in apps/server/.data)
npm run dev -w @producer/web        # UI on :5173, proxies /api to :8787
npm run seed -w @producer/server    # demo@producer.studio / demo-password-1 (stop the server first)
npm test --workspaces --if-present
```

Desktop: `npm run dev -w @producer/desktop`; installer: `npm run dist -w @producer/desktop` (see `docs/desktop.md`).

## Deployment

`Dockerfile` builds one image (API + SPA + worker) with ffmpeg, whisper.cpp, Chrome for rendering and the Kokoro model. `railway.json` deploys it on Railway with Postgres (`DATABASE_URL`), an S3-compatible bucket (`S3_*`), a volume at `/data` and `SECRETS_KEY` for encrypting stored AI keys. All environment variables are listed in `.env.example`.
