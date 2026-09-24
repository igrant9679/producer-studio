# Minimal Mono — template

Black and white, hairline frames, one enormous condensed headline. Sparse and confident.

**Aspect:** 16:9 · **Canvas:** dark · **Brand defaults:** canvas `#0a0a0a`, accent `#ffffff`, ink `#f2f2f2`, headline `League Gothic`, labels `IBM Plex Mono`.

## Reference scenes (copy these, change only content, footage windows and beat times)

- `compositions/hook.html` — cold-open title scene
- `compositions/footage.html` — footage scene with chapter tag, three KPI count-up cards, chips and a punch-in
- `compositions/close.html` — flow diagram + closing line + logo plate

## Geometry

Black canvas with a 1 px frame inset 40 px. Footage card `left 80 / top 150 / 1320×656`, 1 px white border, video desaturated (`filter: grayscale(1)`), at `top −55`. Story column: hairline-separated values in League Gothic 88 px. Headline League Gothic (weight 400 ONLY) 150 px uppercase at `top 820`; accent word rendered as a 2 px outline. Mono labels at 15–18 px, tracked .2–.3em.

## Rules that apply to every template

- Callouts are content-sized cards or chips, never a panel stretched to the column height.
- Values 56–112 px / 900 (League Gothic 400), titles ≥ 30 px, chips ≥ 15 px mono, list items ≥ 20 px; mono is for eyebrows and chips only.
- Crop browser chrome as the footage scene does; verify on a snapshot.
- Beats land on the spoken words; nothing arrives at t=0 except the stage.
- Replace `assets/brand/logo.png` with the project's actual logo file if it has another name; drop the plate if the brief has no logo.
