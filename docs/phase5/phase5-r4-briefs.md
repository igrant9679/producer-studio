# Phase 5, release 4: platform and desktop

Four groups build at once (the rules file says "four other agents": here it is three). Each group OWNS the files
listed for it (large edits fine); a file owned by another group gets only small, additive edits, called out in the
report. Shared everywhere (small additive edits only, new logic in new files): packages/core/src/api.ts, types.ts,
index.ts, apps/web/src/lib/api.ts, apps/web/src/shell/ShellRoutes.tsx, Layout.tsx, modals.tsx,
apps/web/src/shell/dev/mockApi.ts, apps/server/src/app.ts, config.ts, .env.example, docs/architecture.md,
docs/desktop.md, apps/server/src/db/migrate.ts, schema.ts, apps/server/src/test/helpers.ts.
Base: main after release 3 (the coordinator tells you the commit in your prompt).

Releases 1–3 added (read before building, reuse rather than duplicate): R1 the editor; R2 version history,
idempotency keys (`apps/server/src/idempotency.ts`, web `reqOnce`), resumable live updates (`apps/server/src/events.ts`,
web `subscribeEvents`), colour, masks/key, speed, viewer mode, comments, presence (`services/presence.ts`), the
activity feed (`services/activity.ts`), share-link management; R3 the mail transport (`apps/server/src/mail/`,
off unless RESEND_API_KEY + MAIL_FROM), accounts (`/api/account`, `auth.ts` DEVICE_ROUTES allow-list for device
tokens), limits and metering in Postgres (`limits.ts` `hit()`, `services/metering.ts`, `rate_windows`,
`usage_daily`), fair claims and queue info (`jobs/queue.ts`, `jobs/queue-info.ts`), job history + retry
(`routes/jobs.ts`), the media trash and library sweep (`services/retention.ts` `sweepLibrary`, MEDIA_TRASH_DAYS,
EXPORT_RETENTION_DAYS), search (`routes/library.ts`), several brand kits + fonts + space/member settings (v14:
`extra_brand_kits`, `brand_fonts`, `space_settings`, `member_settings`), the a11y helpers (`lib/announce.ts`,
`lib/motion.ts`, `SkipLink`, the audit tests). Schema is at v15.

**Migrations** (append to the ordered list in `apps/server/src/db/migrate.ts`, never edit a shipped entry, idempotent
SQL with `IF NOT EXISTS`, mirrored in `schema.ts`, affected server tests also run against your own Postgres
database): R4-A = 16, R4-B = 17, R4-C = 18. R4-D adds none. Set `SCHEMA_VERSION` to your number; the coordinator
fixes the order at merge. The desktop runs the same migrations on its local PGlite.

**Load:** the machine is shared by four agents. Full suites can time out under load: run targeted files while
iterating, each touched package's full suite once at the end, and re-run any timed-out file on its own before
calling it a failure. The coordinator runs everything again after the merge.

**Owner-dependent (build the mechanism, off until the owner supplies the account):** code signing (Azure Trusted
Signing), auto-update (signed builds + GitHub Releases feed), macOS notarisation (Apple account + a Mac), the
multilingual whisper model on production, crash reporting's endpoint. Never call any real external service.

## R4-A operations — branch `p5-r4-ops`, test database `ps_test_r4a`, migration v16
Enhancements: P-7, P-8, P-9, P-10, P-11, P-24, plus carried items.
- P-7 observability: a request id on every request (header in and out, in every log line and in error bodies the
  app shows, so a person can quote it), a metrics endpoint (Prometheus text, guarded by a token env, off when
  unset: queue depth and lag per lane, job durations and failures per kind, live SSE connections, failed
  sign-ins), and per-job wait, run time and peak memory recorded on the job (the worker already measures some).
- P-8 a security audit log table: sign-ins (ok / failed), password and email changes, resets, device tokens made and
  revoked, invites made, resent, accepted and withdrawn, role changes and hand-overs, AI key and built-in AI
  changes, workspace and account deletes; who, when, IP, user agent; readable by space owners for their space
  (an "Audit" tab next to Activity) and by an operator.
- P-9 liveness (`/api/health/live`: the process answers) and readiness (`/api/health/ready`: database, storage,
  migrations at SCHEMA_VERSION) separate from today's `/api/health` (keep it, same shape); worker health with queue
  lag so a stuck worker reports unhealthy (role=worker processes). Document what to point Railway's health check at.
- P-10 operator tooling: an operator is named by env (`OPERATOR_EMAILS`, off when unset). An Operator page: find a
  user, disable or re-enable them (sessions and device links end), send a reset (mail) or show a one-time reset
  link (no mail); inspect, requeue or cancel any job; storage per workspace; find and remove orphaned storage
  objects (dry run first, then confirm). Every operator action goes to the audit log.
- P-11 retention and a janitor: expired sessions and auth tokens, finished jobs after JOB_RETENTION_DAYS (30),
  tombstones after TOMBSTONE_RETENTION_DAYS (90; check what desktop sync needs before deleting any: a desktop
  that last synced before the cut must do a full resync, not miss deletes), rate windows past their reset, temp and
  render folders cleaned at start; extend `services/retention.ts` (R3-B's sweep stays), each env, 0 = keep forever.
- P-24 an OpenAPI document generated from the existing zod request schemas (served at `/api/openapi.json`, no new
  dependency: build it from the schemas you find; where a route has no schema, list it with its path and method).
- Carried: presence works across several API processes (today it lives in one process's memory: keep it in
  Postgres with a short TTL, or say why not); If-Match on asset, brand and space writes is check-then-write: make it
  one conditional UPDATE so two same-millisecond saves can't both win; the in-memory sign-in limiter in `auth.ts`
  onto `limits.ts` `hit()`; job errors show raw tool output with server paths (ffprobe's) in Job history and
  toasts: keep the raw text in the log and on the job for operators, show people a plain reason; the fair claim's
  same-instant edge (two workers can give one space two slots for a round): fix it if it's small and safe, else say why.
OWNS: apps/server/src/logger / request-id middleware (new), a new metrics module, a new audit service, routes/health
(new or the health code in app.ts), a new operator route + web Operator page, services/retention.ts (additive),
services/presence.ts, the If-Match helpers, auth.ts's sign-in limiter only, the job-error presentation (dto / the
history and toast text), a new openapi module, web Audit tab (next to the Activity page).

## R4-B media pipeline — branch `p5-r4-media`, test database `ps_test_r4b`, migration v17
Enhancements: P-5, P-17, P-18, P-19, P-20, P-21, plus carried items.
- P-5 resumable multipart uploads to S3 (and the local store's equivalent): files over 5 GB, resume after a drop or
  a reload (the browser keeps the upload id), parts retried, the size enforced by the signed request; the desktop's
  upload path uses the same protocol where it can (R4-C owns desktop/sync.ts: give them a small client function
  and call it out).
- P-17 better proxies: 60 fps cap, HDR tone mapping, a 1080p proxy for 4K sources, shorter keyframe spacing for
  scrubbing; check what phase 3 already does in the media processing code first.
- P-18 faster processing and export: thumbnail and filmstrip from quick seeks, published as soon as they exist;
  hardware encoding where the ffmpeg build has it (probe at start; software fallback); long sources trimmed to the
  used windows before export; the renderer's cache on the data volume with an explicit worker count. Measure before
  and after on a local file and report the numbers.
- P-19 normalise at upload what phase 3 didn't: auto-orient photos, HEIC and TIFF, huge images downscaled, the
  first playable stereo track, audio the browser can't play converted. Check phase 3's handling first.
- P-20 multilingual transcription: code ready for language detection and a language picker; production needs the
  multilingual whisper model (owner item); the app says clearly which model is installed and what it can do.
- P-21 storage retries with backoff for passing errors, and skip reprocessing identical uploads (same sha256 in the
  same space → reuse the processed proxy, thumbs and waveform; a new asset row still).
- Carried: untagged video (no colour matrix) decodes differently in the preview (Chrome: BT.709 for HD) and the
  export (HyperFrames' ffmpeg frames: BT.601), so a key or grade tuned in the preview misses in the export. Tag
  the proxy and the export's source copy with the matrix the source was made in (or convert at upload) so both
  read the same pixels; prove it with a real export of the seed's Sample A (green 216 in the preview vs 254 in the
  export today; the debug recipe: copy `.data/renders/<jobId>` during an export, or KEEP_RENDERS=1, then
  `node node_modules/hyperframes/dist/cli.js render <dir> -o out.mp4 -q draft --fps 30`). Copying a large file
  between spaces (R3-B's `POST /api/assets/:id/copy`) runs inside the request: make it a job.
OWNS: the media processing code (apps/server/src/media/ or wherever asset processing lives), routes/uploads and the
storage layer (apps/server/src/storage/), routes/assets.ts upload/copy parts, render/export.ts preparation (source
trimming, colour tags), the transcription code (ai/whisper or similar), the web upload client
(apps/web/src/editor/uploads.ts upload parts and the shell's upload helpers).

## R4-C desktop sync — branch `p5-r4-sync`, test database `ps_test_r4c`, migration v18
Enhancements: D-1, D-5, D-6, D-7, D-8, D-9, D-11, plus carried items.
- D-6 first (the rest builds on it): a transaction-safe sync cursor (a monotonically increasing change sequence
  assigned at commit, so a change committed late can't be skipped), tombstone compaction that is safe (a desktop
  older than the compaction horizon does a full resync; agree the horizon with R4-A's TOMBSTONE_RETENTION_DAYS),
  pages sized by bytes (exists partly: `maxBytes`). Prove the skipped-change race on real Postgres.
- D-1 a sync panel in the desktop app's UI: pending and failed per item with the reason, upload progress and bytes,
  Retry and Skip, why sync is blocked (signed out, offline, storage, conflict), a preview of each conflict.
- D-5 a first-link preview: what will be merged or uploaded, with sizes, and a choice per space.
- D-7 resumable, parallel uploads with projects pushed before big media (use R4-B's multipart client if it lands;
  coordinate through a small function boundary, and say in your report which side you took).
- D-8 sync again as soon as the network comes back (online event / a cheap probe), not after up to 5 minutes.
- D-9 "Available offline" per project (its media pinned locally) and badges for media that's only in the cloud.
- D-11 one lock covering link, unlink, conflict resolution and sync cycles.
- Carried: comments and activity sync to desktops (or a documented decision not to, with the desktop showing the
  cloud's comments live when online); a project deleted through desktop sync keeps its comments rows (delete them
  as the cloud delete does); `shell/system.ts` opens its own EventSource instead of the resumable client; R3's
  cloud-only data (extra brand kits, brand fonts, space / member settings, the media trash state of cloud-only
  rows): sync what the desktop needs to edit offline (at least extra kits and fonts, since projects can use them),
  and say what stays cloud-only. Keep `auth.ts` DEVICE_ROUTES in step with any new route the engine calls.
OWNS: apps/server/src/desktop/ (the sync engine), routes/sync.ts, the sync feed / tombstones code, desktop-facing
UI in apps/web (the sync menu and a new sync panel), apps/web/src/shell/system.ts, DEVICE_ROUTES (additive).

## R4-D desktop app — branch `p5-r4-desktop`, no migration
Enhancements: D-2, D-3 (prep), D-4 (mechanism), D-10 (backup), D-12, D-13, D-14, D-15, D-16, D-17 (Linux; macOS
prepared), D-18, plus carried shell items.
- D-2 a tray icon with an explicit Quit and a "keep running for dictation and voice relay" setting.
- D-3 code signing prepared: the build step reads Azure Trusted Signing settings from env and signs when they are
  set; documented in docs/desktop.md; unsigned builds unchanged.
- D-4 auto-update mechanism (electron-updater or the built-in autoUpdater is only usable if it's already a
  dependency: check; else a small update check against a GitHub Releases feed that tells the person a new version
  exists and links to it), behind a setting, off for unsigned builds.
- D-10 a database backup before each migration (the local PGlite data directory copied, the last N kept) and
  restore instructions; Move data folder exists since phase 4 (confirm it copies).
- D-12 Electron hardening: the server in a utility process so Node-mode switches can be turned off, fuses set,
  archive integrity checks on where the build supports it. Don't launch Electron: prove the config with tests on
  pure functions and say what needs a real build.
- D-13 a startup health check for the bundled tools (ffmpeg, voice models, renderer), shown in the app.
- D-14 opt-in crash reports (off by default; the endpoint is an owner item, so only local capture + "Copy
  diagnostics": versions, paths, tool health, last log lines, no secrets).
- D-15 an uninstaller option to remove the VoiceStudio runtime and app data (NSIS custom page or a prompt).
- D-16 show which Claude CLI flags were detected and used, in Settings → AI.
- D-17 a Linux build target (AppImage/deb in electron-builder config) and a paste method for dictation on Linux
  (xdotool / wtype when present); macOS config prepared (notarisation is an owner item).
- D-18 a longer, configurable boot wait in the end-to-end desktop sync tests.
- Carried (shell): Voice Studio's AI writer pop-up traps focus, closes on Escape and gives focus back (use the
  shared Modal from shell/ui.tsx); the Background jobs popover closes after its Job history link (a close-on-navigate
  for Popover); `apps/web/src/editor/__tests__/render-cost.test.tsx` fails under machine load, also on main: make it
  count work, not time, so it is stable.
OWNS: apps/desktop/ (all of it), electron-builder config, docs/desktop.md (shared with R4-C: additive), the web
Settings → AI CLI-flags display, shell/ui.tsx Popover (close-on-navigate), the Voice Studio writer pop-up only, the
render-cost test.
