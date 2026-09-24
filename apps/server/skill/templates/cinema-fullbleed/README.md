# Cinema Full-Bleed — template

Footage fills the frame under a dark scrim; headlines and lower-thirds ride on top.

**Aspect:** 16:9 · **Canvas:** dark · **Brand defaults:** canvas `#07090f`, accent `#ff5a5f`, ink `#f5f6fa`, headline `Montserrat`, labels `IBM Plex Mono`.

## Reference scenes (copy these, change only content, footage windows and beat times)

- `compositions/hook.html` — cold-open title scene
- `compositions/footage.html` — footage scene with chapter tag, three KPI count-up cards, chips and a punch-in
- `compositions/close.html` — flow diagram + closing line + logo plate

## Geometry

Footage fills the frame: video at `left −126 / top −90`, 2172×1222 (1.131× so browser chrome falls outside). Bottom scrim 560 px, top scrim 220 px. Headline 96 px at `left 96 / top 790` with a text shadow. Lower-third KPI glass cards bottom-right (`right 96 / bottom 96`), values 56 px. Chips top-right. Hook and close use a blurred/dimmed still full-bleed.

## Rules that apply to every template

- Callouts are content-sized cards or chips, never a panel stretched to the column height.
- Values 56–112 px / 900 (League Gothic 400), titles ≥ 30 px, chips ≥ 15 px mono, list items ≥ 20 px; mono is for eyebrows and chips only.
- Crop browser chrome as the footage scene does; verify on a snapshot.
- Beats land on the spoken words; nothing arrives at t=0 except the stage.
- Replace `assets/brand/logo.png` with the project's actual logo file if it has another name; drop the plate if the brief has no logo.
