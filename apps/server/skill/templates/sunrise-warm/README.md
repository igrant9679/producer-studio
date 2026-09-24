# Sunrise Warm — template

Deep plum canvas with warm glows; headline on top, footage centred, chips beneath.

**Aspect:** 16:9 · **Canvas:** dark · **Brand defaults:** canvas `#1a0f24`, accent `#ff8a3d`, ink `#fff4ea`, headline `Montserrat`, labels `IBM Plex Mono`.

## Reference scenes (copy these, change only content, footage windows and beat times)

- `compositions/hook.html` — cold-open title scene
- `compositions/footage.html` — footage scene with chapter tag, three KPI count-up cards, chips and a punch-in
- `compositions/close.html` — flow diagram + closing line + logo plate

## Geometry

Two large warm glows (orange top-left, pink bottom-right) drifting once. Headline at the TOP: 76 px at `left 220 / top 112`, chapter tag at `top 78`. Footage card centred `left 220 / top 226 / 1480×736`, radius 22, glow ring; video 1480×833 at `top −62`. One row of pill KPIs (40 px values) and chips under the card at `top 988`.

## Rules that apply to every template

- Callouts are content-sized cards or chips, never a panel stretched to the column height.
- Values 56–112 px / 900 (League Gothic 400), titles ≥ 30 px, chips ≥ 15 px mono, list items ≥ 20 px; mono is for eyebrows and chips only.
- Crop browser chrome as the footage scene does; verify on a snapshot.
- Beats land on the spoken words; nothing arrives at t=0 except the stage.
- Replace `assets/brand/logo.png` with the project's actual logo file if it has another name; drop the plate if the brief has no logo.
