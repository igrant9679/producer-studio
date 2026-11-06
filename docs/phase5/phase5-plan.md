# Phase 5: the 93 enhancements

The full text of every enhancement (ID, what, why, which bug it finishes, size) is in
`C:\Users\Admin\AppData\Local\Temp\claude\C--Users-Admin\f1905b2c-a501-41dd-9a14-6da568192c2e\scratchpad\enh-raw.md`.
Phases 0–4 (bug fixes) already delivered several of them; each group below first checks what is already there
and builds only the rest.

## Already delivered by phases 0–4 (confirm, don't rebuild)
- E-4 keyboard timeline (phase 4, EDT-37): grid with one Tab stop, arrows, Alt+arrows, [ and ], Shift+F10.
- A-3 loading/error states (QA-7, APP-34), A-4 responsive shell (APP-19), A-5 AI status up front (QA-9),
  A-25 mock API + test timeout (APP-40): phase 4.
- A-1 accept-invite page, expiry, single use, revoke: phase 0. (Invite EMAIL is not done: release 3.)
- P-2 job watchdog, P-3 quick-job lane, P-4 graceful drain: phase 3. (P-3's per-workspace fairness: release 3.)
- P-6 fast delivery: phase 0 (hidden source maps) + phase 4 (brotli/gzip, immutable cache, editor split).
- P-12 config checked at start: phase 1.
- P-13 cursor paging + light records: phase 4 (SEC-18).
- D-10 Move data folder: phase 4 (DSK-17). (Database backup before a migration: release 4.)

## Owner-dependent (build the mechanism; it stays off until the owner supplies the account)
- Email (A-1 invite mail, A-8 email notifications, A-17/P-22 reset and verification): one HTTP mail transport,
  provider Resend (`RESEND_API_KEY`, `MAIL_FROM`); unset → the app shows the link instead of sending, as now.
- D-3 code signing: needs an Azure Trusted Signing account; wire the build step behind env, document it.
- D-4 auto-update: needs signed builds and a release feed (GitHub Releases); mechanism behind a setting.
- D-17 macOS: needs an Apple developer account and a Mac to notarise; Linux build can be done.
- P-20 multilingual transcription: code ready; production needs the multilingual whisper model (owner item).
- Retention (P-11): the owner's decision 5 was still open; use the recommendation (finished jobs 30 days,
  temp files immediately, tombstones 90 days), each an env variable, 0 = keep forever.

## Releases (5 parallel groups each, merged and pushed one release at a time)

### Release 1: editor
- R1-A timeline editing: E-1 linked groups, E-6 snapping + markers + beat detection, E-7 zoom, E-9 drop onto
  the timeline, E-24 freeze duration + freeze at end, E-25 history panel, E-26 shortcuts in tooltips.
- R1-B audio: E-13 audio crossfades + J/L cuts, E-14 ducking + loudness normalisation + solo/per-track
  volume, E-15 volume rubber band + fade handles.
- R1-C captions and transcript: E-11 Descript-style transcript editing, E-12 caption line editor + formats.
- R1-D canvas, text, keyframes: E-16 keyframe editing + curve editor, E-18 canvas snapping/guides/align/crop
  handles, E-19 text fit + per-word styling + effects + missing-glyph warning.
- R1-E playback and export: E-5 export options, E-8 JKL/in-out/loop/preview speed/proxy toggle, E-23 draft
  render of a range, E-10 replace clip + split by scene detection.

### Release 2: saves, collaboration, looks
- R2-A saves: E-2 local journal + honest save states, E-3/P-15 version history + automatic merge, P-14
  idempotency keys, P-16 resumable live updates.
- R2-B colour: E-20 HSL, curves, LUT upload, scopes, copy/paste attributes, adjustment layers.
- R2-C smart tools: E-21 masks, chroma key, background removal, stabilisation, denoise.
- R2-D speed: E-17 speed ramps + pitch toggle + smooth slow motion.
- R2-E collaboration: E-22 timecoded review comments, A-23 presence + activity feed, A-16 share-link
  management.

### Release 3: app — DONE, live 10-28 as 68048f6 (migrations v12–v15)
- R3-A accounts and mail: mail transport, A-1 invite email, A-2 member management, A-17 account settings,
  P-22 password reset + verification + device-token limits, A-8 notifications.
- R3-B library and search: A-10 command palette, A-11 search everything, A-12 sticky views + tags, A-13 bulk
  actions, A-14 media trash + "used in N projects" + replace in place, P-23 export deletes + retention, A-15
  virtualised grid, A-19 exports page.
- R3-C Producer, voice, brand: A-6 onboarding, A-7 Producer autosave/versions/re-narrate, A-20 Voice Studio,
  A-21 brand kits, A-22 templates.
- R3-D usage and fairness: P-1 Postgres-backed limits and metering, A-18 usage page, A-9 queue visibility,
  P-3 per-workspace fairness.
- R3-E accessibility and polish: A-24, plus anything release 1–2 reports as left over in the app shell.

### Release 4: platform and desktop
- R4-A operations: P-7 observability, P-8 security audit log, P-9 liveness/readiness + worker health, P-10
  admin tooling, P-11 retention janitor, P-24 OpenAPI.
- R4-B media pipeline: P-5 resumable multipart uploads, P-17 better proxies, P-18 faster processing and
  export, P-19 normalise at upload (what phase 3 didn't), P-20 multilingual, P-21 storage retries + dedupe.
- R4-C desktop sync: D-1 sync panel, D-5 first-link preview, D-6 safe sync feed, D-7 resumable parallel
  uploads, D-8 sync on network return, D-9 available offline, D-11 one lock.
- R4-D desktop app: D-2 tray, D-3 signing (prep), D-4 auto-update (mechanism), D-10 backup before
  migration, D-12 hardening, D-13 startup health check, D-14 crash reports + diagnostics, D-15 uninstaller
  option, D-16 Claude CLI flags, D-17 Linux build, D-18 configurable boot wait.

## Carried into later releases (found in R1)
- R2-E: the editor has no read-only mode. A viewer can open a project and change it locally; every save then 403s.
  Build a viewer mode (store flag from the workspace role; every write action/shortcut/drag disabled with the
  viewer tip; comments allowed), and the same when the project is opened from a share link.
- Done in R1/R2: the dev mock API has POST /api/projects/:id/export; the editor viewer mode (R2-E).
- R1-D's caption tab drops karaoke timings on text edits (switch to setCaptionText) — check at R1 merge.
- The editor's shared Menu popover closes on Tab (transition popover hard to use by keyboard): R3-E.
- Assistant caption tools can't pick a language track: R3-C or R3-E.
- Owner: speaker detection mapped but off (needs a tinydiarize whisper model); filler list per project.

## Carried into later releases (found in R2)
- R4-B (P-17/P-19): untagged video (no colour matrix) decodes differently in the preview (Chrome: BT.709 for HD) and
  the export (HyperFrames' ffmpeg frames: BT.601) — the seed's Sample A green is 216 vs 254, so a chroma key or grade
  tuned in the preview misses in the export. Tag proxies and the export's copy with the matrix the source was made in
  (or convert at upload) so both read the same pixels. Tagged phone/camera footage is fine.
- R4-C: comments and activity don't sync to desktops; a project deleted through desktop sync (desktop/sync.ts) keeps
  its comments rows; shell/system.ts opens its own EventSource instead of the resumable client.
- R4-A: presence lives in the API process's memory (one API service only); If-Match on asset/brand/space is
  check-then-write (a same-millisecond race); orphaned local journals for deleted projects. (All done: presence and
  If-Match in R4-A; journals 6 Nov 2026, cleared when a project is deleted and after a month unopened.)
- R3-C: the assistant can't set speed ramps (its speed tool sets one constant speed); can't pick a caption language track.
- R3-E: real-browser checks at 375 px for the Colour / Smart / Speed tabs, the version history panel, the comments
  panel, the Share-for-review dialog and the Activity page; Menu closing on Tab.
- Left as decided by the groups: LUTs stored in the project document (~144 KB each); smooth slow-motion copies are
  visible library items; journals stay in the browser after sign-out; downloads-off links still stream.
- Not graded yet: ~~the blurred letterbox fill~~ (done 1 Nov 2026, and the export no longer covers the clip with
  it); ~~text/shapes under an adjustment layer get its CSS colour but not its curves/HSL/LUT~~ (done 6 Nov 2026: an
  SVG colour transfer measured on a grey ramp through the same grade maths, so curves are exact and HSL / LUT follow
  neutral tones, in the preview and the export); ~~reversed clips ignore ramps~~ (done 1 Nov 2026; the export's reversed copy also lost stray frames
  of the rest of the recording at its start whenever its range was a hair over whole 2 s chunks).
- Owner: S3 bucket CORS (GET from producerstudio.app) for graded previews of cloud media; BG_REMOVAL_CMD for background
  removal; DENOISE_MODEL optional; production ffmpeg's libvidstab / libvpx-vp9 decide which clean-up tools show.

## Carried into later releases (found in R3)
- R4-A: the sign-in rate limiter in auth.ts is still in memory per process (move it onto limits.ts `hit`); two
  workers claiming at the same instant can give one space two slots for that round; job errors show raw tool output
  with server file paths (e.g. ffprobe's) in Job history and toasts: keep the raw text in logs, show a plain reason.
- R4-B: copying a large file between spaces runs inside the request: make it a job.
- R4-C: extra brand kits, brand fonts, space / member settings (pronunciations, favourites) and the media trash state
  for cloud-only rows don't sync to desktops (a desktop sees the default kit only). (Done: kits and fonts in R4-C;
  6 Nov 2026 a linked desktop reads and writes a cloud space's settings and its member settings in the cloud, and a
  trash or restore made on a desktop goes up.)
- R4-D (or any group touching the shell): Voice Studio's AI writer pop-up doesn't trap focus, close on Escape or
  give focus back; the Background jobs popover stays open after its Job history link (Popover has no
  close-on-navigate); `render-cost.test.tsx` fails under machine load, also on main (make it count, not time).
- Real-browser look still owed (the pane couldn't screenshot at R3): 375 px for Account, Members, Usage, Job history,
  the palette, the kit bar, Compare voices, the CSV batch table and the footage picker; focus rings and bottom
  sheets in light and dark; FontFace + brand-font embedding in a real export; eight live template previews at once.
- Owner (R3): RESEND_API_KEY + MAIL_FROM + PUBLIC_URL for mail; who may switch on the server's AI key (now any space
  owner); OpenAI / Gemini cost rates; SAMPLE_PROJECT; whether invite acceptance needs a confirmed email.
