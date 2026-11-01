# How to work on a Phase 5 group (Producer Studio)

Producer Studio is the owner's AI video editor (producerstudio.app). Monorepo: `packages/core` (document
types, timeline ops, evaluate, runtime, compile), `apps/web` (React/Vite/zustand), `apps/server` (Hono,
Postgres/PGlite via Drizzle, job queue + worker, S3 storage, and the desktop sync engine under
`src/desktop`), `apps/desktop` (Electron). `docs/architecture.md`, `docs/desktop.md` and
`docs/server-status.md` describe it. The enhancement list (every ID, what, why, size) is in
`C:\Users\Admin\AppData\Local\Temp\claude\C--Users-Admin\f1905b2c-a501-41dd-9a14-6da568192c2e\scratchpad\enh-raw.md`,
and the release plan (who builds what, and what phases 0–4 already delivered) in `phase5-plan.md` next to it.
Four other agents are building the other groups at the same time in their own worktrees; stay inside your group's
scope so the branches merge cleanly. Phases 0–4 fixed 186 bugs, so read the code before building: part of what an
enhancement asks for may already exist (then confirm it with a test and say so).

## Setup (you are in a fresh git worktree)
1. From the worktree root run
   `node C:\Users\Admin\AppData\Local\Temp\claude\C--Users-Admin\f1905b2c-a501-41dd-9a14-6da568192c2e\scratchpad\setup-worktree.mjs .`
   It junctions node_modules to the main checkout (C:\Users\Admin\producer-studio) and points `@producer/*`
   at THIS worktree's packages. Do not run `npm install` / `npm ci`.
2. Create your branch: `git checkout -b <the branch name in your brief>`.
3. Never touch the main checkout at C:\Users\Admin\producer-studio, never push, never merge, never change
   `main`. Never use bare `git stash`.

## How each enhancement lands
- **Tested behaviour.** Each enhancement gets tests that prove what the person can now do (server: Vitest
  against the Hono app, see `apps/server/src/test/helpers.ts` and existing tests; core: op tests in
  `packages/core`; web: component/store tests under `apps/web/src/**/__tests__`). If something truly can't be
  tested (pure UI wiring), say why in your report.
- **Small commits, one enhancement or one tight part of one each**, message naming the IDs, in the repo's style: a short
  plain-English subject, then a body with a short paragraph per enhancement ID saying what the person can now do (see
  `git log -3 8ce5858`). End every commit message with a blank line and
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The repo's git identity is already configured.
- Match the surrounding code: its naming, idiom and (sparse, plain) comment density. Prefer the line-number
  hints as starting points only; the code has moved since the evaluation.
- Build what the enhancement asks for, scoped so it works end to end (preview AND export where it affects the picture or sound: the export renders the same core runtime in headless Chrome via HyperFrames, see packages/core/src/compile.ts). If you scope a large item down, say exactly what was left out and why.
- Keep changes inside your scope. If your work needs a file another group owns (listed in your brief), make the
  smallest possible change there and call it out in your report. Don't edit `docs/server-status.md`.
- Never call production (producerstudio.app) or any external API. No dev servers against prod.
- **Line endings:** the repo stores LF. Before each commit, check nothing staged carries a carriage return:
  `git diff --cached --name-only | xargs -I{} sh -c 'git show ":{}" | grep -q "$(printf "\r")" && echo "CR in {}"'`
  and convert any file it names to LF (a previous agent committed a CRLF test file).
- **Screens:** most work here is UI. Match the existing look (CSS variables and classes in apps/web/src/**/*.css, the shared controls in apps/web/src/editor/controls.tsx and apps/web/src/shell/ui.tsx); everything new must work by keyboard and have accessible names, and viewers must not get write actions (see useEditGate). Prove them with component tests (React Testing Library under
  `apps/web/src/**/__tests__`, jsdom): keyboard (Tab order, Enter/Escape/arrow keys, focus moved and restored),
  roles and accessible names (`getByRole(..., { name })`), what a viewer sees, what happens on a 401 or a space
  switch. Layout at 375 px can't be measured in jsdom: test the behaviour (the drawer opens, the account menu holds
  the moved buttons) and say in your report what still needs a real-browser check. **No new npm dependencies** (node_modules is shared with the main checkout through junctions, so installing breaks it). If one is truly needed, build without it or stop that part and say which package and why in your report.
- **Servers you start:** don't use ports 5173 or 8787 (the coordinator's). If you start any dev server, watcher or
  long-running process, stop it before you finish and confirm with `Get-CimInstance Win32_Process` (PowerShell)
  that nothing whose command line contains your worktree path is still running. A leftover process last phase
  kept a worktree folder locked.
- **Desktop (apps/desktop):** it has no test runner. Put logic you change into small pure functions and test them
  from apps/server's Vitest (or add a minimal vitest config to apps/desktop using the root's vitest, no new deps).
  Don't build or launch Electron.
- **Real Postgres:** production runs Postgres. If you write raw SQL (jsonb operators, locks, sequences), also run the
  affected server test files with `TEST_DATABASE_URL=postgres://postgres:pgtest-local@127.0.0.1:55432/ps_test_<your group, lower case: e.g. r1a>`
  set (your group's own database; the tests write to it) (a throwaway Postgres 17 is running on this machine; if it isn't, say so rather than starting one).

## Checks before you finish
- `npm run typecheck` at the worktree root: clean.
- The test suites for the packages you touched: `npm test -w @producer/core`, `npm test -w @producer/web`,
  and for the server `cd apps/server && npx vitest run --no-file-parallelism` (the full server suite takes
  ~15 min serially; run targeted files while iterating, the full suite once at the end; one desktop-sync
  test is known to time out under parallel runs, which is why it's serial).
- All green, or a precise explanation of any failure and whether it also fails on `main`.

## Finish
1. Commit everything (nothing left uncommitted).
2. Run `node C:\Users\Admin\AppData\Local\Temp\claude\C--Users-Admin\f1905b2c-a501-41dd-9a14-6da568192c2e\scratchpad\teardown-worktree.mjs .`
   from the worktree root, so removing the worktree later can't follow a junction into the main checkout.
   This must be your last command.
3. Report back (this is the only thing the coordinator sees): the worktree path and branch, the commit list
   (`git log --oneline main..HEAD`), and per enhancement ID: done / partly done / already existed / not done, what changed for the
   person using the app, and the test that proves it. Then: check results (typecheck, each suite with
   counts), any file you touched outside your scope, any decision that belongs to the owner, and anything
   you noticed but left alone.

## Also for Phase 5
- **Migrations:** only the group whose brief says so may add a database migration (number it as the brief says).
  Others: no schema changes; store what you need in existing JSON columns, or report that a column is needed.
- **New API routes:** add them to the dev mock too (apps/web, see the mock API used by `npm run dev:mock` or
  the tests' mock), with the same role checks, so the mock never hides a missing route.
- **Shared files** (packages/core/src/ops.ts, types.ts, apps/web/src/editor/actions.ts, store.ts, shortcuts.ts,
  Timeline.tsx, PropertiesPanel.tsx): prefer putting new logic in NEW files (e.g. packages/core/src/links.ts)
  and keep edits to shared files small and additive, so five branches merge with few conflicts.
- **Document what you add** where a person will look: the in-app Help/shortcut list (apps/web/src/shell/modals.tsx
  SHORTCUTS and the editor's shortcut list) for new keys, and docs/architecture.md for new server pieces.
- Load on this machine is heavy (6 GB, five agents). Run targeted test files while iterating; the full suites once.
