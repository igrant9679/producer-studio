# Phase 5, release 3: the app

Five groups build at once. Each group OWNS the files listed for it (large edits fine); a file owned by another
group gets only small, additive edits, called out in the report. Shared everywhere (small additive edits only, new
logic in new files): packages/core/src/api.ts, types.ts, index.ts, apps/web/src/lib/api.ts,
apps/web/src/shell/ShellRoutes.tsx, Layout.tsx, modals.tsx (shortcut / help lists), apps/web/src/shell/dev/mockApi.ts,
apps/server/src/app.ts, config.ts, .env.example, docs/architecture.md, apps/server/src/db/migrate.ts, schema.ts.
Base: main after release 2 (the coordinator tells you the commit in your prompt).

Releases 1–2 added (read before building, reuse rather than duplicate): the editor's history, markers, keyframes,
captions, export options and draft preview (R1); version history + idempotency keys (`apps/server/src/idempotency.ts`,
web `reqOnce`), resumable live updates (`apps/server/src/events.ts`, `ctx().bus.publish(ws, event, data, { replay })`,
web `subscribeEvents(ws, { on: {...} })`), colour, masks/key, speed, the editor viewer mode (`editor/viewer.tsx`,
`useEditGate`), review comments, presence, the per-space **activity feed** (`services/activity.ts`,
`recordActivity`), and **share-link management** (A-16 is done: the Exports page lists the space's links) (R2).

**Migrations** (append to the ordered list in `apps/server/src/db/migrate.ts`, never edit a shipped entry, idempotent
SQL with `IF NOT EXISTS`, mirrored in `schema.ts`, affected server tests also run against your own Postgres
database): R3-A = 12, R3-B = 13, R3-C = 14, R3-D = 15. R3-E adds none. Set `SCHEMA_VERSION` to your number; the
coordinator fixes the order at merge.

**Mail (owner-dependent):** one HTTP mail transport (`apps/server/src/mail/`, built by R3-A), provider Resend
(`RESEND_API_KEY`, `MAIL_FROM`; plain `fetch`, no SDK). Unset → nothing is sent and the app shows the link or code
instead, as it does today for invites. Never call the real provider in tests (inject a fake transport).

## R3-A accounts and mail — branch `p5-r3-accounts`, test database `ps_test_r3a`, migration v12
Enhancements: A-1 (the invite email, resend, pending list), A-2, A-17, P-22, A-8.
- Mail transport as above, with a test double; every mail is plain HTML + text, names the app and the space.
- A-1: the accept-invite page, expiry and revoke exist (phase 0): add the invite email (sent on invite and on
  Resend), a pending-invites list with Resend / Revoke / expiry shown, and the link to copy when mail is off.
- A-2: member management in the space settings: change a role, remove a member, leave a space, transfer ownership
  (the last owner can't leave or be demoted; check what routes already exist first, e.g. access.test.ts).
- A-17: an Account page: profile (name, avatar initial), change email (verified through mail), change password,
  forgot password, delete account (what happens to spaces they own: refuse while they own a shared space), active
  sessions and devices with "sign out everywhere", notification preferences.
- P-22: password reset and email verification through the mail transport (single-use, expiring tokens, hashed at
  rest, rate-limited), device tokens limited to the sync routes with an expiry and last-seen.
- A-8: notifications when an export or long job finishes or fails: browser notifications (asked for on first
  long job, respecting the preference) and email (preference, default off), and toasts with Open / Retry / Undo
  where they apply. Hook into job completion with a small call from the worker (R3-D owns the queue).
OWNS: apps/server/src/auth.ts, routes/auth.ts, the members / invites parts of routes/workspaces.ts, a new
apps/server/src/mail/, new notification code, web account page (a new page; pages/SettingsPage.tsx gets a link),
pages/SpacePage.tsx members UI, pages/InvitePage.tsx, the toast component (apps/web/src/lib/toast).

## R3-B library and search — branch `p5-r3-library`, test database `ps_test_r3b`, migration v13
Enhancements: A-10, A-11, A-12, A-13, A-14, P-23, A-15, A-19.
- A-10 a command palette on Ctrl+K (new video, upload, switch space, open a project, jump to a Settings section,
  theme), fully keyboard driven.
- A-11 search everything: projects, media, templates, voices, exports, members and settings, plus words said in
  transcripts and narration (server-side search route; Postgres `ILIKE`/trigram-free so PGlite works too).
- A-12 library views that stick: tab, filter, sort and view in the URL; "Created by me"; tags for big spaces.
- A-13 bulk actions on projects and media: duplicate, save as template, move or copy to another space, download,
  delete (to trash); shift-click selects a range; keyboard selection.
- A-14 safer media deletes: a media trash (deletes are permanent today) with Empty trash and a retention notice,
  "Used in N projects" before deleting, replace a media file in place (every project using it follows).
- P-23 a reference check before deleting a clip's media, a delete endpoint for exports, and export retention
  (env, 0 = keep forever).
- A-15 big libraries: a virtualised, paged grid (cursor paging exists since phase 4) and next / previous in the
  media preview with its transcript and "Use in a new project".
- A-19 the Exports page: search and filter, delete, re-render, format badges, every project (not only the 24 most
  recent). The share-link list on it is R2's: keep it.
OWNS: apps/web/src/shell/pages/LibraryPage.tsx + libraryLogic.ts, shell/components/ProjectCard.tsx, pages/ExportsPage.tsx
(except the share-link section),
media preview, a new command palette and search, apps/server/src/routes/assets.ts deletes / trash, routes/projects.ts
list / bulk routes, a new search route.

## R3-C Producer, voice, brand — branch `p5-r3-producer`, test database `ps_test_r3c`, migration v14
Enhancements: A-6, A-7, A-20, A-21, A-22, plus two carried items.
- A-6 first-run onboarding: a checklist on Home (upload a recording, set the brand kit, make a first Producer
  video, invite a teammate) that ticks itself from real state, dismissible, and a sample project in new spaces.
- A-7 Producer AI: autosave of the script and brief with a "Saved" indicator and versions (reuse R2's version
  pattern where it fits), "Assemble into a copy", re-narrate one scene, a scrubbable footage picker, time estimates.
- A-20 Voice Studio: drafts kept per space, pause and emphasis markup, a pronunciation dictionary, batch voiceovers
  from a CSV, favourite voices, side-by-side comparison, whether the linked desktop is online in the voice picker.
- A-21 brand kits: several kits per space (today one row per workspace: the migration), colours pulled from a logo
  image (server-side, ffmpeg palette or a pure-JS quantiser; no website fetch), a contrast check, custom font
  upload, an unsaved-changes guard.
- A-22 templates: arrow keys and a deep link in the viewer, preview videos for built-in looks (rendered stills or
  short clips made locally, committed only if small; else generated on demand), filter by aspect, make a template
  from the brand kit.
- Carried: the assistant's speed tool can set a ramp preset (core `applyRampPreset`), and its caption tools can
  pick a caption / language track.
OWNS: apps/web/src/shell/pages/HomePage.tsx, shell/producer/ (and apps/server/src/ai/produce.ts UI-facing routes),
pages/VoiceStudio.tsx + shell/voicestudio/, pages/BrandPage.tsx + brand routes, pages/TemplatesPage.tsx,
apps/server/src/ai/tools.ts (the two carried tools only).

## R3-D usage and fairness — branch `p5-r3-usage`, test database `ps_test_r3d`, migration v15
Enhancements: P-1, A-18, A-9, P-3 (per-workspace fairness; the quick-job lane exists since phase 3), plus the job
history page from A-8.
- P-1 rate limits, quotas and usage metering per user and per workspace (AI tokens and requests, job minutes,
  storage), stored in Postgres so they hold across replicas (today's limits are in memory: keep their env names and
  defaults, 0 = off), and the built-in AI key opt-in per workspace (a space uses the server's key only when an owner
  turns it on).
- A-18 a Usage page: AI requests and cost per provider (the cost table in code, labelled as an estimate), job
  minutes, storage per space, against the limits.
- A-9 queue visibility in the jobs list: position, estimated wait (from recent durations, or "unknown"), and why a
  job is waiting (lane full, workspace's fair share, waiting for the desktop, …).
- P-3 per-workspace fairness: the claim query picks the workspace with the fewest running jobs first within a lane,
  so one space's exports can't starve another's; prove it on real Postgres too (it is raw SQL).
- A job history page (from A-8): finished and failed jobs, linked to their project, with Retry.
OWNS: apps/server/src/jobs/queue.ts, worker.ts, limits / abuse code (security/), a new metering service, the Usage
page, the jobs list / history UI.

## R3-E accessibility and polish — branch `p5-r3-polish`, no migration
Enhancement: A-24, plus what releases 1–2 left in the app shell and editor.
- A-24: a skip-to-content link, visible focus on cards, reduced motion for hover previews and autoplaying videos
  (`prefers-reduced-motion`), checked across the shell and the editor.
- The editor's shared Menu popover closes on Tab, so the transition popover is hard to use by keyboard: fix the
  Menu so Tab moves within it (or out, closing, by the WAI-ARIA menu pattern) without losing the selection.
- Phone width (375 px) for what release 2 added: the Colour, Smart and Speed tabs, the version history panel, the
  comments panel, the Share-for-review dialog and the Activity page: make them usable (no clipped controls, the tab
  row scrolls with a visible cue, panels become sheets), proving behaviour in tests and listing what needs a
  real-browser look.
- An audit pass with the existing tests' helpers: every icon-only button has an accessible name, every dialog
  traps and restores focus, live regions announce save state and job progress once.
OWNS: shared CSS (apps/web/src/**/*.css: small, scoped changes; avoid restyling other groups' pages), the shared
Menu / popover / dialog controls (apps/web/src/editor/controls.tsx, apps/web/src/shell/ui.tsx), the skip link in
Layout.tsx (small edit).
