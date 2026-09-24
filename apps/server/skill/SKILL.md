---
name: producer-pipeline
description: House production recipe for Producer Studio — turn a screen recording plus a locked script and recorded narration into a HyperFrames composition that passes check, the seam gate and a footage audit. Load whenever a project folder contains producer.json, before writing any composition HTML or editing one. Overrides generic HyperFrames creative guidance where they differ.
---

# Producer pipeline — from script + narration to a verified composition

You are inside a Producer project. The app has already: copied the recording to `assets/src.*`,
transcribed it, confirmed the brief (`brief.json`), locked the script (`script.json`), and recorded
narration (`assets/vo/sNN.wav`, real lengths in `assets/vo/durations.json`). Your job is the
composition and its verification. Never touch narration; never render.

## 0. Start from the chosen template — do not re-derive the look

`templates/<id>/` in this skill holds one folder per visual template (the app passes the chosen id in
its build prompt; `brief.json` carries it as `template`). Each folder has `README.md` (geometry and
rules), `template.json` (aspect, canvas, brand defaults) and `compositions/hook.html`, `footage.html`,
`close.html` — the approved reference scenes. For every scene: copy the closest reference scene from
THAT template, keep its CSS and structure verbatim, change only content, footage windows and beat
times. `templates/studio-dark/` also carries extra scene types (footage-cards, footage-chips,
footage-panels, diagram) that any template may adapt. `examples/` is the full approved Studio Dark cut.
A build that re-imagined the layout from prose (column-height grey panels, 13-px mono body text,
uncropped browser chrome) was rejected outright.

Vertical templates (9:16) use a 1080×1920 canvas: every scene root and `index.html` must carry
`data-width="1080" data-height="1920"`, and headlines shrink to 2–4 words.

## 0b. Write files with the Write tool

Create and edit every file (script.json, SCRIPT.md, compositions/*.html, index.html) with the Write/Edit tools.
Do not use shell heredocs, `echo`/`printf` redirection or `python -c` to write files: on Windows hosts long shell
commands fail with exit code 2 and leave truncated files. Use Bash only to run commands (ffmpeg, hyperframes, ls).

## 1. Read first

1. `brief.json` (brand + tone), `script.json` (scenes), `assets/vo/durations.json`, `source-info.json`.
2. `/hyperframes-core` composition contract (`references/sub-compositions.md`, `composition-patterns.md`,
   `creator-editing-recipes.md`) and `/motion-doctrine` (seam law) + `/cut-the-curve` (seam mechanics).
3. Look at `assets/stills/sheet-*.png`. Grab any frame you need to read exactly:
   `ffmpeg -ss <sec> -i assets/src.mp4 -frames:v 1 assets/stills/at_<mm-ss>.png`.

## 2. Timing rule (mechanical — never hand-tune)

For scene N with voice length `dur[N]`:

- scene duration = `round(dur[N] + 0.5 lead + tail, 1)`; tail = 1.4 s normally, 1.8 s for the close.
- the voice `<audio id="vo-sNN">` starts 0.5 s after the scene starts and carries
  `data-duration="<dur[N] to 3 decimals>"` (lint otherwise reports overlapping audio).
- scene slots are edge to edge on track 1: `start[N+1] = start[N] + duration[N]`.
- root `data-duration` = sum of scene durations.

Write these numbers into `ledger.json` cut times and into `index.html` in one pass.

## 2b. Narration text vs on-screen text

Narration in `script.json` is what the voice SAYS; headlines and visuals are what the viewer READS.
Spell product numerals as spoken in narration (Data 360 → "Data three sixty"; 2 CFR 200 → "two C F R
two hundred") while keeping the official spelling on screen. Avoid homographs the voice misreads
(live/lives, read, lead) by rephrasing.

## 3. Design system (defaults when the brief has no design spec)

- Canvas colour = `brand.primary`, ink = `brand.ink`, accent = `brand.accent`. Headline font =
  `brand.headlineFont` (900), labels = `brand.labelFont` (mono, uppercase, letter-spacing .18em).
  Both fonts must be from the HyperFrames bundled set (Montserrat / IBM Plex Mono are safe).
- Background per scene: opaque `#root` in canvas colour + one radial accent glow (≈25 % opacity,
  bleeds off canvas, marked `data-layout-allow-overflow`) + a faint 96 px grid. The glow drifts
  once across the scene with `ease: "none"` (a moving light, never a breathing loop).
- **Footage window card** (every footage scene, identical geometry so seams read as one film):
  `left 80 top 150 width 1320 height 656`, radius 18, 2 px ink border at 18 %, deep shadow, white
  fill. Inside: `.zo` (transform-origin 50% 50%) › `.zi` › the `<video class="clip">` at
  `left 0 top −55 width 1320 height 742` — this crops the browser chrome of a 1920×1080 recording.
  Punch-ins use coordinate-target-zoom: scale on `.zo`, counter-translate on `.zi`, both with the same
  duration and ease; card-space offset = frame coords × 0.6875, minus (660, 328), T = −offset.
- **Story column** right of the card: chapter tag (mono, accent) at `left 1460 top 150`, then callouts
  from `top 210`, width 380–400. Callouts are **content-sized cards or chips** (see `examples/`) — never
  one panel stretched to the column height, never a bare list of mono text. Values 56–112 px / 900,
  titles 30 px / 700, chips 21 px / 700, list items ≥ 20 px; the mono font is for eyebrows only.
  Callouts land on the spoken beat (spoken word position at 2.8 words/s inside the voice line).
- **Headline band**: `left 80 top 856 width 1400`, 84 px, 900 weight, tracking −.035em, last word(s) in
  accent, arriving as a waterfall entry (binary reveal + `power4.out` whip from below).
- Title/diagram scenes (hook, building blocks, close) use the same canvas and type but centre their
  own layout; the close puts the logo on a white plate if the brand logo is dark-on-transparent.
- Numbers on screen are the exact strings seen in the footage; count-ups use a proxy object with
  `Math.round`/fixed decimals and `tabular-nums`; the number's scale tween shares the count's ease.

## 4. Footage handling

- Cut source ranges with `data-media-start`; several clips per scene are fine (edge to edge, one
  `<video>` per range, unique ids, `muted playsinline`).
- **Audit every window at 1 fps before you commit to it**:
  `ffmpeg -ss S -t D -i assets/src.mp4 -vf "fps=1,scale=320:-1,tile=10x3" -frames:v 1 audit.png`
  and LOOK. Blank white frames, spinners, "loading" placeholders and half-rendered dashboards are
  reloads — move the window until it is clean for its whole length.
- A screen visible for < 3 s becomes a **held still**: extract the frame and place it as
  `<img class="clip" data-start data-duration style="position:absolute;left:0;top:-55px;width:1320px;height:742px">`
  in the same `.zi` wrapper. Static pages look identical; nothing is lost.
- Slow motion (`data-playback-rate` 0.5–0.8) is acceptable on static screens when a window is a
  little short; never on scrolling or typing footage.

## 5. Seams

- One film current: cut-the-curve LEFT at ordinary boundaries. Spend at most two reserved vectors:
  a Z-pull (inverse zoom-through) into the payoff/dashboard scene, an UP cut into the close.
- Write `ledger.json` (schema in motion-doctrine `references/seam-gate.md`), then stamp:
  `node ~/.claude/skills/motion-doctrine/scripts/seam-stamp.mjs --ledger ledger.json --write index.html`.
  `index.html` must register `window.__timelines["main"]` and carry the `// <seams:auto>` … `// </seams:auto>`
  markers inside its script.
- The scene entered by a Z-pull must arrive composed: no scale-up entrances in its first 0.7 s.

## 6. Verification loop (all must pass)

1. `hyperframes lint` → 0 errors. Common fixes: add `tl.set(el,{opacity:0}, t)` hard kills after exit
   fades that end on a clip boundary; give every `<audio>` a `data-duration`; mark decorative
   overflow with `data-layout-allow-overflow`; no near-invisible ghost text (audits treat it as
   unreadable text — drop it).
2. `hyperframes check` → prints "Check passed" (runtime, layout, motion, contrast).
3. Seam gate: `node ~/.claude/skills/motion-doctrine/scripts/seam-gate.mjs verify --ledger ledger.json --project .`
   (set `CHROME_PATH` to the chrome-headless-shell under `~/.cache/hyperframes/chrome/` if it cannot find one).
4. `hyperframes snapshot . --at <every scene midpoint>` → open `snapshots/contact-sheet-1.jpg` and
   look for: clipped or overlapping text, callouts colliding with cards, blank footage windows,
   headline wrapping into the rule below it. Fix and re-run.
5. Animation map (optional, multi-scene): `node ~/.claude/skills/hyperframes-animation/scripts/animation-map.mjs . --out .hyperframes/anim-map` — no dead zones.

When everything passes, write `STORYBOARD.md` (frame per scene: duration, footage windows, status: animated)
and finish with a compact summary. Do not render — the app renders.

## 7. Editing an existing composition (prompt edits from Studio)

- Read the target scene file first; edit in place; keep ids and the timeline registration.
- Timing changes ripple: update the scene's `data-duration`, every later slot's `data-start`, the
  matching `<audio data-start>`, root `data-duration`, ledger cut times, then re-stamp seams.
- Narration text changes are script edits (`script.json` + `SCRIPT.md`) — tell the producer which
  scene ids need their voice regenerated; the app owns `assets/vo`.
- Finish every edit with lint + check + a snapshot of the affected scene.
