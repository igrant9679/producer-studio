# Social Vertical — template

9:16 for LinkedIn, Reels and Shorts: footage on top, big type and stacked callouts below.

**Aspect:** 9:16 · **Canvas:** dark · **Brand defaults:** canvas `#0b1830`, accent `#ff5a5f`, ink `#f3f5fa`, headline `Montserrat`, labels `IBM Plex Mono`.

## Reference scenes (copy these, change only content, footage windows and beat times)

- `compositions/hook.html` — cold-open title scene
- `compositions/footage.html` — footage scene with chapter tag, three KPI count-up cards, chips and a punch-in
- `compositions/close.html` — flow diagram + closing line + logo plate

## Geometry

Canvas 1080×1920 (set `data-width="1080" data-height="1920"` on every root and the index). Footage card `left 40 / top 180 / 1000×497`; video 1000×562 at `top −42`. Headline 88 px at `top 740`. Full-width KPI rows from `top 1000`, values 84 px right-aligned. Chips at `top 1560`. Footer tag at `bottom 60`. Keep all text inside the 40 px margins.

## Rules that apply to every template

- Callouts are content-sized cards or chips, never a panel stretched to the column height.
- Values 56–112 px / 900 (League Gothic 400), titles ≥ 30 px, chips ≥ 15 px mono, list items ≥ 20 px; mono is for eyebrows and chips only.
- Crop browser chrome as the footage scene does; verify on a snapshot.
- Beats land on the spoken words; nothing arrives at t=0 except the stage.
- Replace `assets/brand/logo.png` with the project's actual logo file if it has another name; drop the plate if the brief has no logo.
