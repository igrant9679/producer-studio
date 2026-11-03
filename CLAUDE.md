# Producer Studio — orientation for a fresh session

**Read `README.md` first.** It is short (~680 tokens) and current: what the product is, the
repository layout (`packages/core`, `apps/web`, `apps/server`, `apps/desktop`), the dev commands,
and how Railway deploys it. This file carries only what the README does not.

## ⚠ Context budget — read docs by section, never whole

`docs/` holds four large references. Reading one whole costs more than the work usually needs.
Open the heading you want:

| Doc | Size | Sections |
|---|---|---|
| `docs/architecture.md` | ~10.7K tok | Rendering (one evaluator, two renderers) · Data · Media pipeline (R4-B, migration v17) · Library (v13) · Saving, versions, live updates · Jobs · Usage and limits · Speed · AI (Claude API) · Auth & tenancy · Collaboration (v11) · Accessibility · Brand kits, voice, onboarding (v14) · Two products, one codebase |
| `docs/desktop.md` | ~6.8K tok | Run it · Process model · Settings → This computer · Bundled tools and CI · Code signing · Updates · Security · VoiceStudio · Sync behaviour · Known gaps |
| `docs/server-status.md` | ~3.8K tok | Running now (dev) · Endpoints · Behaviour notes for clients · Known gaps |
| `docs/voicestudio.md` | ~2.6K tok | Architecture · Voices · Cloud ↔ desktop · Feature map · Dictation · Licences · Gaps |

`docs/capcut-analysis.md` (~3.2K) is competitor research, not a spec — read it only if asked.

**Keep this file small.** It exists so a session can start without reading ~24K tokens of docs.
If it grows past ~2K tokens, move the detail into `docs/` and leave a pointer, the way
MeYouSocial's `CLAUDE.md` had to be split on 2026-10-30.

## ⚠ Current work (verified 2026-11-01)

**Every phase of the evaluation plan is live**, phase 5's four releases included (R4 since 31 Oct,
`27a8802`, migrations v16–v18). After it: desktop first-start fixes (`c98fd7d`), plain reasons for
jobs that failed before R4 (`2297569`), and videos from an idea with the person's own clips and
images (`e185e6d`, a `media` scene visual), then free stock photos and clips with no key (Wikimedia Commons,
Openverse; Pixabay with a free key) and `animation` scenes of open-source illustrations (Iconify), and `drawn` scenes the space's AI draws in code, run in a
sandboxed headless Chrome (`ai/drawn.ts`, `media/drawing.ts`), and free music composed on the cuts
(`scripts/music`, from huashu-motion) with sound effects from earshot's kits (`sfx/`, `ai/soundtrack.ts`) — see
`docs/server-status.md` → "Free stock, photos and animations", "AI-drawn animation" and "Music and sound effects". Work on branches or worktrees off `main`; the
`p5-*` and older feature branches are history, all merged.

The phase 5 planning docs are in **`docs/phase5/`** (recovered on 2026-10-30 from an old session
scratchpad). Almost all of the carry-over section at the end of `docs/phase5/phase5-plan.md` has
shipped; check `git log --grep` before redoing an item. Still open there: the grading gaps listed
under "Not graded yet", some real-browser checks, and the owner's decisions and accounts
(production AI key, code signing, mail, S3 CORS).

Production has **no server AI key** (`/api/health` shows `ai:false`): each space adds its own in
Settings → AI. Windows Smart App Control on this machine blocks newly built unsigned desktop exes,
so check desktop changes in dev mode.

## ⚠ House rules

- **Two editions, one codebase.** A change in `packages/core` or `apps/server` reaches both web
  and desktop. Check `docs/architecture.md` → "Two products, one codebase" before assuming a
  change is web-only.
- **Deploy** is `git push origin main` → Railway builds the `Dockerfile`. A Railway build has
  failed spuriously here before; an empty commit retried it successfully. Postgres, S3 and
  `SECRETS_KEY` are required — every variable is in `.env.example`.
- **Never commit secrets.** AI keys are encrypted at rest with `SECRETS_KEY`; the repo is the
  owner's and should stay free of real keys.
- **Windows machine.** Node is at `C:\Program Files\nodejs` and may not be on PATH in PowerShell;
  prefix `$env:Path = "C:\Program Files\nodejs;" + $env:Path` or call binaries directly. Node 22+
  and ffmpeg are required.
- **Before pushing:** `npm run typecheck` and `npm test --workspaces --if-present`.
- Commit and push only when asked.
