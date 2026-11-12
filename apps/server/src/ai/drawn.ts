// AI-drawn animation scenes: the space's AI writes the drawing code for one scene (canvas 2D + Rough.js, timed to the
// narration's words), media/drawing.ts runs it in a sandbox, and the model gets one round to fix an error and one look
// at frames of its own drawing to fix what it sees. The rules below are distilled from two open-source agent kits for
// code-made video (both MIT): explainroo (github.com/vincentsch/explainroo: drawings that appear on a word of the
// narration) and video-director (github.com/win4r/video-director: plan in numbers, draw from the clock alone, check
// what you can't watch). The media the drawings can use (pencil, ink, watercolour, chalk, riso, paper, marks that draw
// themselves) are anidoodle's (github.com/alexgreensh/anidoodle, Apache-2.0, vendored in vendor/anidoodle); the
// drawing styles' recipes are ours. The 3D styles draw with three.js (MIT, vendored in vendor/three) on a lit stage the
// sandbox builds (env.stage3d); THREE_GUIDE below is how the model is told to use it.
import * as z from 'zod/v4'
import { DRAWING_STYLES, type DrawingStyleId, is3dDrawingStyle } from '@producer/core'
import { HttpError } from '../http'
import { log } from '../log'
import type { BlenderRunner } from '../media/blender'
import { DrawingError, type DrawingEnv, testDrawing } from '../media/drawing'
import type { AiProvider, ScriptImage } from './provider'

/** The longest drawing code kept (the model is asked for far less). */
export const MAX_CODE_CHARS = 60_000

export const DrawingSchema = z.object({
  plan: z.string().describe('Two or three sentences: what is drawn and what happens when, in seconds and on which words'),
  code: z.string().describe('JavaScript that defines function draw(ctx, t, env) and nothing that runs on its own'),
})

export const ReviewSchema = z.object({
  problems: z.string().describe('What is wrong in the frames (empty, cluttered, cut off, unreadable, covering the headline band, nothing moving), or "none"'),
  changed: z.boolean().describe('true when the code below fixes something'),
  code: z.string().describe('The full code, fixed (or the same code when nothing needed fixing)'),
})

export const DRAWN_SYSTEM = `You are the animator for Producer, a video editor. You write the JavaScript that draws one scene of a narrated explainer video as a moving illustration, frame by frame, on an HTML canvas. Your drawings are clear, warm and purposeful: one idea, a few big shapes, motion that explains.

THE CONTRACT
- Define exactly: function draw(ctx, t, env) { ... }. It is called once per frame. ctx is a CanvasRenderingContext2D of env.W x env.H pixels; t is seconds from the scene's start (0 to env.duration).
- Paint the whole frame from t alone. Keep no state between calls, start no timers, use no DOM, no images, no network, no async. Anything that changes over time is a pure function of t. The canvas is already filled with env.palette.canvas when draw is called.
- Math.random returns the same numbers every frame; for things that should vary use env.rand(seed) (returns a function giving 0..1).
- Keep each frame fast (well under 30 ms): no loops over millions of pixels, no getImageData, at most a few hundred shapes.

ENV
- env.W, env.H, env.duration, env.fps
- env.palette.canvas (background), env.palette.ink (lines, text), env.palette.accent (the one highlight colour). Derive tints with rgba/alpha; use no other hues except small, natural touches (skin, sky, leaves) when the subject needs them.
- env.fonts.headline, env.fonts.body: font family names, e.g. ctx.font = '700 64px "' + env.fonts.body + '"'.
- env.words: [{ w, start }] the narration's words with their start times in seconds. env.wordAt('word', after?) gives the time a word is first said (after an optional time), or undefined: time each entrance to the word that names it, with a fallback time when it is undefined.
- env.rough: Rough.js for a hand-drawn look: env.rough.line(x1,y1,x2,y2,opts), .rectangle(x,y,w,h,opts), .circle(cx,cy,d,opts), .ellipse(cx,cy,w,h,opts), .linearPath([[x,y],...],opts), .polygon([[x,y],...],opts), .arc(x,y,w,h,start,stop,closed,opts), .curve([[x,y],...],opts), .path(svgPathString,opts). opts: { stroke, strokeWidth, roughness (0.5-2), bowing, fill, fillStyle ('hachure'|'solid'|'zigzag'|'cross-hatch'|'dots'), fillWeight, hachureGap, seed }. ALWAYS pass a seed: the same seed draws the same wobble; seed: 1 + Math.floor(t * 6) % 3 makes lines gently "boil" like hand-drawn animation. Plain ctx paths are fine too (and faster) for a clean flat look.
- env.ease.{linear,in,out,inOut,back,elastic}(k), env.progress(t, start, dur = 0.6, ease = env.ease.out) gives 0..1, env.lerp(a,b,k), env.clamp(v,a,b).

DIRECTION
- Plan in numbers first: when each element enters (on the word that names it), how long it moves (0.3-0.8 s entrances, eased), what holds still long enough to be read.
- Something meaningful moves in every beat: draw on a line (stroke reveal with setLineDash or a partial path), grow, slide, fill a bar, move along a path, a character gesture, a camera push (ctx.translate/scale, gentle). Never a static picture with one fade.
- One clear composition, 2-5 elements. The top 22% of the frame is covered by the scene's headline and the bottom 16% by captions: put nothing important there (background is fine).
- Fill the frame: the main subject is 40-60% of the safe area's height, never a small drawing floating in empty space. Give it depth: a simple background (ground and horizon, a room, soft large shapes in canvas/ink tints), the subject in the middle, a few small foreground details.
- Use solid fills with outlines, not bare outlines: the accent for what matters, tints of ink and canvas (rgba) for the rest, natural colours where the subject needs them. Line widths scale with the frame (about H/250 to H/120).
- Add secondary motion so nothing is ever frozen: idle bob or breathing, sway, a blink, drifting particles, a soft parallax on the background.
- Text in the drawing is rare and short (labels of 1-3 words, at least H*0.04 tall, in env.palette.ink); the headline and captions are added by the editor, don't repeat them.
- No flashes, no strobing, nothing faster than the eye can follow, no jarring cuts; ease in and out; end on a settled, readable frame.
- Draw people and objects simply and charmingly (round heads, simple bodies, expressive poses), never photorealistic, never logos or brand marks.

MEDIA AND MARKS (anidoodle: for drawn looks such as pencil, ink, watercolour, chalk and print)
- const d = env.doodle(ctx, t, medium) is this frame's drawing surface; medium 'pencil' | 'ink' | 'riso' | 'chalk' | 'marker'. It owns ctx's transform: place things with d.push(x, y, scale, rotationRadians) ... d.pop() rather than ctx.translate, and call ctx.setTransform(1, 0, 0, 1, 0, 0) before plain ctx drawing after it.
  d.pen(points, { w, color, seed, closed, progress, opacity, wobble, boil, taper }): a hand-drawn line through [[x, y], ...] (smoothed, tapered, gently boiling by itself); progress 0..1 draws it on from its start. Give every line its own seed.
  d.hatch(x, y, width, { n, len, angle, color, seed, pw, opacity }): a row of n short hatch strokes.
  d.wash(points, color, { alpha, seed, shrink }): a watercolour wash with a wet edge that doesn't quite fill its outline.
  d.form(points, color, shadeColor, { seed, light: [dx, dy], hi: [x, y, rx, ry] }): a painted, softly lit solid shape (highlight optional).
  d.fill(points, color, alpha); d.glow(cx, cy, r, color, opacity).
  d.group('ink' | 'paint' | 'plain', () => { d.pen(...); d.wash(...) }, { blend, alpha, off: [dx, dy], textures }): draws on its own layer, adds the medium's tooth ('ink' pencil grain, 'paint' soft granulating wash; textures: 'risoSpeck', 'risoMottle', 'draftTooth'), then lays it on the frame (blend 'multiply' and off for inks printed off register). d.inkGroup(() => ...) is the same with a soft bloom under light ink on a dark ground.
  d.paper(kind, opacity): paper grain over the whole frame, kind 'paper' | 'coldpress' | 'pencilTooth' | 'blueMottle' | 'draftTooth' | 'risoMottle'. Call it last.
- env.shapes gives point lists for those: oval(cx, cy, rx, ry, n), softBox(cx, cy, w, h), arc(cx, cy, rx, ry, a0, a1, n), line([x, y], [x, y], bow), poly(corners, per), heart(cx, cy, size), tube(centrePoints, r0, r1) (a limb, stem or branch), turn(points, cx, cy, degrees), jitter(points, amount, seed), displace(points, amp, freq, octaves, seed); halftone({ x0, y0, x1, y1 }, pitch, angleDegrees, (x, y) => tone 0..1) returns dots [[x, y, r], ...]; fractal(seed, x, y, fx, fy, octaves) is smooth noise 0..1; rng(seed).
- env.marks are marks that draw themselves, made once and laid down in order: stroke(points, { w, col, a, taper }), contour(points, { w, col, a, seed, closed }) (a list), hatch(region, { ang, gap, len, w, col, a, seed, dens: (x, y) => 0..1 }) (a list), sketchEllipse(cx, cy, rx, ry, { w, col, a, seed }); regions polyR(points), ellR(cx, cy, rx, ry), union, minus, inter. env.marks.play(ctx, list, t, start, end) draws a list the way a hand would between two times.
- env.memo('name', () => value) builds something once and gives the same value to every frame (lists of marks, paths): it must depend on its key alone, never on t, and must not be changed after.

When a DRAWING STYLE is given below, it decides the look (paper, ink, fills, outlines, colours, which tools) in place of the look rules in DIRECTION; the contract, the safe areas and the timing still hold.`

/**
 * How each drawing style is drawn: its paper and ink (the accent stays the brand's) and the recipe the AI follows.
 * Our own recipes, written for anidoodle's media; 'clean' is the look the rules above describe.
 */
export const DRAWING_RECIPES: Record<DrawingStyleId, { canvas?: string; ink?: string; recipe: string }> = {
  clean: { recipe: '' },
  sketchbook: {
    canvas: '#f5f0e4',
    ink: '#3a3236',
    recipe:
      "Graphite on cream paper (the canvas is the paper). const d = env.doodle(ctx, t, 'pencil'). Outlines with d.pen in env.palette.ink, each drawn on (progress) as the thing enters on its word; shading as hatching in one diagonal (d.hatch, or env.marks.hatch in a region, denser in shadow); no solid fills, except the accent as a light wash on the one thing that matters (d.group('paint', () => d.wash(...))). Finish with d.paper('paper', 0.35).",
  },
  watercolour: {
    canvas: '#f7f3ea',
    ink: '#4a4046',
    recipe:
      "Pencil and pan watercolour on cold-press paper. For each object, first its washes (d.group('paint', () => d.wash(shape, colour, { alpha: 0.55, seed }))) in soft natural colours that don't quite fill the outline, then a pencil outline over the paint (d.pen, 'pencil' medium) that may be drawn on as it enters. The accent for the key object. Finish with d.paper('coldpress', 0.35).",
  },
  ink: {
    canvas: '#fbfaf6',
    ink: '#16141a',
    recipe:
      "Ink line and grey wash. A confident, tapered pen line (env.doodle(ctx, t, 'ink'), d.pen) in env.palette.ink, drawn on as things enter; washes in two or three greys made from the ink at low alpha (d.wash), and one accent wash. Finish with d.paper('paper', 0.2).",
  },
  storybook: {
    canvas: '#f6efe2',
    ink: '#3d3437',
    recipe:
      "A painted picture book. Rounded, softly lit forms (d.form(shape, colour, shadeColour, { light: [-8, -9], seed })) under one warm light, a soft pencil outline over them (d.pen at opacity 0.6), a gentle, warm palette with the accent for the hero. Characters have simple rounded bodies and expressive poses. Finish with d.paper('coldpress', 0.25).",
  },
  riso: {
    canvas: '#f4efe4',
    ink: '#1f3f8f',
    recipe:
      "A two-ink risograph print: env.palette.ink (deep blue) and env.palette.accent on off-white paper. Every colour area goes inside d.group('plain', () => ..., { blend: 'multiply', textures: ['risoMottle', 'risoSpeck'] }), the accent's group printed a little off register (off: [3, -2]); tones are halftone dots (env.shapes.halftone, pitch about 8 px, the blue at 75 degrees, the accent at 15), and where the inks overlap they make a third colour. Lines with the 'riso' medium. Finish with d.paper('paper', 0.25).",
  },
  halftone: {
    canvas: '#efe9da',
    ink: '#151515',
    recipe:
      "Newsprint: black and one spot colour (the accent) on unbleached newsprint. Shapes are filled with halftone dots (env.shapes.halftone, pitch 7 to 9 px, black at 45 degrees, the accent at 15), a heavy black contour (d.pen, 'ink' medium, w about H/150), inks multiplied (d.group('plain', ..., { blend: 'multiply' })). Finish with d.paper('paper', 0.3).",
  },
  blueprint: {
    canvas: '#1d4378',
    ink: '#f2f0e8',
    recipe:
      "A cyanotype blueprint: everything in white ink on Prussian blue with the 'ink' medium. Ruled lines (d.pen with wobble 0.2, boil 0.2), circles from env.shapes.oval, dimension lines with arrowheads and small measured labels, centre lines dashed; lines wrapped in d.inkGroup(() => ...) for the ink's bloom, drawn on as each part enters. The accent only for the one highlighted part. Finish with d.paper('blueMottle', 0.3).",
  },
  chalkboard: {
    canvas: '#27332f',
    ink: '#f1eee4',
    recipe:
      "Chalk on a slate board. The 'chalk' medium in env.palette.ink, the accent as coloured chalk; areas are scumbled with dense hatching (env.marks.hatch with back: true, or d.hatch rows) rather than solid fills; faint ghosts of old rubbed-out lessons at very low alpha; chalk work inside d.group('ink', ...) for the board's tooth. Things are drawn on as they are named.",
  },
  whiteboard: {
    canvas: '#fbfbf8',
    ink: '#1c1c1f',
    recipe:
      "A whiteboard explainer: everything drawn on stroke by stroke as it is named (env.marks.contour / d.pen with progress, the 'marker' medium), a black marker for everything and the accent marker for the key thing, short hand-lettered labels, simple stick-and-shape figures. No textures, no fills but quick marker scribbles.",
  },
  clay3d: {
    canvas: '#efe6d8',
    ink: '#3b3330',
    recipe:
      "3D clay animation, like a stop-motion short. Use the 3D stage (env.stage3d) and env.material3d(colour, 'clay') for everything: soft, chunky, rounded forms (RoundedBoxGeometry with a generous radius, spheres, capsules, lathed shapes), a warm palette of three to five muted colours plus the accent for the hero. Paint a soft backdrop first (a vertical gradient from a lighter tint of the canvas colour to the canvas colour), then the stage. Characters are chunky toy figures with big heads that act with weight (squash on landing, anticipation, a happy bounce). A slow camera push or a gentle orbit.",
  },
  studio3d: {
    canvas: '#e7eaef',
    ink: '#1f2329',
    recipe:
      "A polished 3D product film. Use the 3D stage (env.stage3d) with env.material3d 'glossy', 'metal' and 'glass' materials, the accent glossy on the hero object and calm neutrals elsewhere. Paint a seamless studio backdrop first (a radial gradient, light in the middle, the canvas colour at the edges), keep the ground shadow soft (shadow 0.15). Few objects and generous space; they float, turn and assemble with elegant easing, and the camera moves slowly like a cinema dolly or orbit. A cool, clean, premium feel.",
  },
  isometric3d: {
    canvas: '#eef3f6',
    ink: '#1d2a33',
    recipe:
      "A tidy 3D isometric explainer world. Use the 3D stage (env.stage3d, { fov: 14 }) with the camera far up and to one side (about (14, 13, 14), looking at the middle of the scene) for an almost isometric view, and a low platform (a RoundedBoxGeometry slab) the scene sits on. Little buildings, devices, roads, arrows as tubes, people as simple capsule figures; 'matte' and 'plastic' materials in a fresh palette with the accent for what matters. Things pop up onto the platform on the words that name them (scale up from 0 with env.ease.back) and flows travel along paths. Paint a soft gradient backdrop first; 2D labels pinned to things with s.project.",
  },
  // Blender scenes follow BLENDER_SYSTEM, not a canvas recipe; this sets their backdrop and ink
  blender: { canvas: '#e8e3da', ink: '#26252c', recipe: 'A cinematic 3D scene built, lit and animated in Blender.' },
}

/** How to draw in 3D: given with the 3D styles' recipes only (the stage and three.js load for code that uses them). */
export const THREE_GUIDE = `3D (THREE.JS ON A LIT STAGE)
- const s = env.stage3d('main', (THREE, st) => { /* build once: meshes, groups */ return { /* the parts you pose */ } }, { fov, background, ground, shadow, groundY, environment, key, fill, rim, shadows }). It is built once (like env.memo) with a studio light: a soft key light with shadows, a fill, a rim light and soft reflections, a perspective camera at (0, 2.2, 9) looking at (0, 0.8, 0) (fov 35), and a ground at y = 0 that shows only shadows. Options are optional.
- The 2D canvas is behind the 3D picture (its background is transparent): paint the background with ctx first (a gradient, a backdrop, the paper), then pose and s.render(ctx), then any 2D labels or marks on top.
- Every frame, pose everything from t: positions, rotations, scales, the camera (s.camera.position.set(...); s.camera.lookAt(...)), any colour you change. Set each changing property every frame and never accumulate (no += from frame to frame): frames are drawn out of order.
- st.add(obj, ...) adds things that cast and catch shadows; s.parts is what the build returned; s.project(objectOrPoint) gives { x, y } in frame pixels, for 2D labels pinned to 3D things; s.camera, s.scene, s.lights.{key, fill, rim} and s.ground are there too.
- env.material3d(colour, kind) gives shared, good-looking materials: 'clay', 'plastic', 'glossy', 'metal', 'glass', 'matte', 'glow'. Use few colours: the accent for the hero, tints and calm natural colours for the rest.
- Shapes (env.THREE = THREE): RoundedBoxGeometry(w, h, d, 4, radius), SphereGeometry(r, 32, 24), CapsuleGeometry(r, length, 8, 16), CylinderGeometry, ConeGeometry, TorusGeometry, LatheGeometry (a profile spun round: bottles, vases, bodies, trees), ExtrudeGeometry of a THREE.Shape with a bevel (icons, arrows, signs, a map's regions), TubeGeometry along a CatmullRomCurve3 (cables, paths, flows). Build objects and characters from THREE.Group, with each moving part on its own group whose origin is the pivot.
- Characters: appealing toy-like figures: a capsule body, a big sphere head, small dot eyes, capsule arms and legs hung from shoulder and hip groups (rotate those groups to walk, wave, point, shrug), consistent proportions; animate with weight: anticipation before a move, overshoot and settle after, a little bob while idle.
- Space: units are metres; at the default camera the frame is about 10 wide. Keep the subject within x -4..4 and y 0..4.5 (landscape; narrower for vertical) and out of the top 22% and bottom 16% of the frame.
- Motion: ease everything (env.progress, env.ease.out / back / inOut); things enter on their words (scale up from 0 with env.ease.back, drop in and squash, slide in); the camera moves slowly and smoothly (a dolly in, a gentle orbit), never jerks.
- Keep it light: under about 60 meshes and modest segments; no textures, images, loaders or 3D text (text is 2D, on top).`

/** The 'blender' drawing style: the model writes a Blender script instead of canvas code (media/blender.ts runs it). */
export const BlenderSchema = z.object({
  plan: z.string().describe('Two or three sentences: what is built and what happens when, in seconds and on which words'),
  code: z.string().describe('Python that defines def build(scene, env) for Blender 5.2, and nothing that runs on its own'),
})

export const BLENDER_SYSTEM = `You are the 3D animator for Producer, a video editor. You write the Python script that builds one scene of a narrated video in Blender 5.2: you model it, light it and animate it with keyframes. Your scenes look like a polished animated film: appealing shapes, soft light, depth, and deliberate motion that explains.

THE CONTRACT
- Define exactly: def build(scene, env): ... It runs once in an empty Blender scene (background mode, no window) and builds everything: objects, materials, lights, camera, and keyframes on frames 1 to env.frames. It doesn't render or save anything: that happens afterwards.
- Imports: only bpy, bmesh, mathutils, math, random, colorsys. Prefer bpy.data and bmesh; bpy.ops only for modelling (bpy.ops.mesh.primitive_*_add, bpy.ops.object.*, bpy.ops.curve.*, bpy.ops.transform.*). No files, paths, images or textures from disk, add-ons, drivers' expressions, handlers or timers. getattr, setattr, exec, eval, open, str.format, names starting with _ and strings containing __ are refused before the code runs (use f-strings).
- Units are metres and Z is up. The camera from env.stage() sits at (0, -9, 2.4) looking at (0, 0, 1); the frame is about 8 m wide there (landscape; narrower when env.vertical). Keep the subject within x -3.5..3.5 and z 0..4.5, in front of y = 4 (the backdrop curves up behind it), and out of the top 22% and bottom 16% of the frame (the headline and captions go there).
- Time: frame = env.frame(seconds); things happen on the narration's words: env.frame(env.word_at('word', default_seconds)).
- Deterministic: call random.seed(1) before any random.

ENV
- env.W, env.H, env.fps, env.frames, env.duration, env.vertical; env.palette (canvas, ink, accent as linear RGBA), env.hex (the same as '#rrggbb').
- env.stage(backdrop=True, camera=(0, -9, 2.4), target=(0, 0, 1), lens=50) returns st with st.camera, st.key, st.fill, st.rim, st.floor: a seamless backdrop in the canvas colour, a soft key light, fill and rim, and the camera. Call it first, then add your things; move or animate st.camera for camera moves (env.look_at(st.camera, point)).
- env.material(color, kind) returns a Principled material. color: '#rrggbb', 'accent', 'ink', 'canvas' or (r, g, b); kind: clay, plastic, glossy, metal, glass, matte, glow (emits light), toon. Assign it with obj.data.materials.append(m).
- env.key(obj, 'location', frame, (x, y, z)) sets a property and keyframes it ('rotation_euler', 'scale', 'data.energy' and so on). Keys are Bezier, so they ease in and out. env.interpolate(obj, 'BACK', 'EASE_OUT') gives all of obj's keys an overshoot (or 'ELASTIC', 'BOUNCE', 'SINE', 'LINEAR', 'CONSTANT').
- env.look_at(obj, target) points a camera, light or object at a point or an object.

MAKE IT LOOK PROFESSIONAL
- Shapes: primitives refined with modifiers: a Bevel modifier (width 0.03 to 0.08, 3 segments) on hard objects; a Subdivision Surface modifier (levels 2) and smooth shading on soft ones. Curves with bevel_depth for pipes, paths and cables. 3D text (bpy.data.curves.new(name, 'FONT'), Blender's own font, with extrude and bevel) only when a word is the point and words are allowed.
- Characters: appealing, toy-like figures: a rounded body, a big head, simple eyes (dark spheres with a small white highlight), arms and legs as rounded cylinders parented to empties at the shoulders and hips (rotate the empties to walk, wave, point). Keep proportions consistent. Animate with weight: anticipation before a move, overshoot and settle after, a gentle bob or breath while idle, secondary motion that lags behind.
- Colour: the canvas colour for the world, ink for dark details, accent for the hero; two to four colours in all.
- Camera: one slow, purposeful move (a dolly in, a gentle orbit around an empty, a rise), eased, never jerky; a 35 to 85 mm lens.
- Light work: under about 80 objects, subdivision levels 2 at most, no particles, simulations or volumetrics.`

export function buildBlenderPrompt(o: { description: string; narration: string; headline: string; env: DrawingEnv; silent?: boolean; noWords?: boolean }): string {
  const words = o.env.words.map((w) => `${w.w}@${w.start.toFixed(2)}`).join(' ')
  const frames = Math.max(1, Math.round(o.env.duration * o.env.fps))
  return `Build this scene in Blender.

WHAT TO SHOW (the director's note)
${o.description.trim()}

${o.silent ? `WHAT HAPPENS IN THIS SCENE (nobody speaks: the scene has to tell it alone)` : `THE NARRATION OF THIS SCENE (what the voice says while it plays)`}
${o.narration.trim()}

${o.noWords ? 'NO WORDS: this video shows no text at all, so build no text, labels or numbers. The whole frame is yours.' : `HEADLINE SHOWN ABOVE IT: ${o.headline || '(none)'}`}

FRAME: ${o.env.width} x ${o.env.height} px (${o.env.height > o.env.width ? 'vertical' : 'landscape'}), ${o.env.duration.toFixed(1)} s = frames 1 to ${frames} at ${o.env.fps} fps
PALETTE: canvas ${o.env.palette.canvas}, ink ${o.env.palette.ink}, accent ${o.env.palette.accent}
WORD TIMES (word@seconds from the scene's start): ${words || '(no timings: spread the beats over the scene)'}

Return the plan and the code.`
}

/** The palette a style is drawn in: its own paper and ink, the brand's accent ('clean' keeps the brand's). */
export function drawingPalette(style: DrawingStyleId, brand: DrawingEnv['palette']): DrawingEnv['palette'] {
  const r = DRAWING_RECIPES[style]
  return { canvas: r.canvas ?? brand.canvas, ink: r.ink ?? brand.ink, accent: brand.accent }
}

export function buildDrawingPrompt(o: { description: string; narration: string; headline: string; env: DrawingEnv; silent?: boolean; noWords?: boolean; style?: DrawingStyleId }): string {
  const words = o.env.words.map((w) => `${w.w}@${w.start.toFixed(2)}`).join(' ')
  const style = o.style && o.style !== 'clean' ? DRAWING_STYLES.find((s) => s.id === o.style) : undefined
  return `Draw this scene.

WHAT TO DRAW (the director's note)
${o.description.trim()}
${style ? `\nDRAWING STYLE: ${style.label}. ${DRAWING_RECIPES[style.id].recipe}\n` : ''}${style && is3dDrawingStyle(style.id) ? `\n${THREE_GUIDE}\n` : ''}
${o.silent ? `WHAT HAPPENS IN THIS SCENE (nobody speaks: the drawing has to tell it alone, so leave nothing to a voice)` : `THE NARRATION OF THIS SCENE (what the voice says while it plays)`}
${o.narration.trim()}

${o.noWords ? 'NO WORDS: this video shows no text at all, so draw no text, labels or numbers. The whole frame is yours, and nothing is added over it.' : `HEADLINE SHOWN ABOVE IT: ${o.headline || '(none)'}`}

FRAME: ${o.env.width} x ${o.env.height} px (${o.env.height > o.env.width ? 'vertical' : 'landscape'}), ${o.env.duration.toFixed(1)} s, ${o.env.fps} fps
PALETTE: canvas ${o.env.palette.canvas}, ink ${o.env.palette.ink}, accent ${o.env.palette.accent}
FONTS: headline "${o.env.fonts.headline}", body "${o.env.fonts.body}"
WORD TIMES (word@seconds from the scene's start): ${words || '(no timings: spread the beats over the scene)'}

Return the plan and the code.`
}

const fence = (code: string) =>
  code
    .trim()
    .replace(/^```(?:javascript|js|python|py)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim()

/** Where frames are looked at: early, the middle, late, and the settled end. */
export const LOOK_AT = [0.18, 0.45, 0.72, 0.97]

/** Fixes asked for when the code fails to run, and looks at its frames (each look may fix what it sees). */
export const MAX_FIXES = 2
export const MAX_LOOKS = 3

/**
 * The drawing code for one scene: written, run in the sandbox (up to MAX_FIXES fixes when it fails), then looked at
 * up to MAX_LOOKS times, each look fixing what it sees until the model finds nothing to change. Throws HttpError when
 * no working code came back.
 */
export async function writeDrawing(
  provider: AiProvider,
  o: { description: string; narration: string; headline: string; env: DrawingEnv; silent?: boolean; noWords?: boolean; style?: DrawingStyleId; signal?: AbortSignal; progress?: (f: number, msg: string) => void; blender?: BlenderRunner },
): Promise<{ code: string; plan: string; frames: Buffer[] }> {
  const times = LOOK_AT.map((k) => k * o.env.duration)
  // canvas code tried in the drawing sandbox, or (the 'blender' style) a Blender script tried in Blender
  const blender = o.blender
  const system = blender ? BLENDER_SYSTEM : DRAWN_SYSTEM
  const schema = blender ? BlenderSchema : DrawingSchema
  const brief = () => (blender ? buildBlenderPrompt(o) : buildDrawingPrompt(o))
  const tryIt = (c: string) => (blender ? blender.test(c, o.env, times, o.signal) : testDrawing(c, o.env, times, o.signal))
  o.progress?.(0.05, blender ? 'Writing the Blender scene' : 'Writing the animation')
  const first = await provider.structured({ system, prompt: brief(), images: [], schema, signal: o.signal })
  let code = fence(first.code).slice(0, MAX_CODE_CHARS)
  const plan = first.plan
  let frames: Buffer[]
  o.progress?.(0.3, 'Trying the animation')
  for (let fix = 0; ; fix++) {
    try {
      frames = await tryIt(code)
      break
    } catch (err) {
      if (!(err instanceof DrawingError)) throw err
      if (fix >= MAX_FIXES) throw new HttpError(502, 'server', `the AI’s animation didn’t run (${err.message.slice(0, 120)})`)
      log.info('drawing failed; asking for a fix', { error: err.message, at: err.at, fix: fix + 1 })
      o.progress?.(0.35 + fix * 0.08, 'Fixing the animation')
      const fixed = await provider.structured({
        system,
        prompt: `${brief()}

YOUR CODE FAILED${err.at !== undefined ? ` at t = ${err.at.toFixed(2)} s` : ''}: ${err.message}

THE CODE
${code}

Fix it and return the plan and the full code.`,
        images: [],
        schema,
        signal: o.signal,
      })
      code = fence(fixed.code).slice(0, MAX_CODE_CHARS)
    }
  }
  // looks at its own frames, as a viewer would see them; each fix that runs is kept, and the next look sees it
  for (let look = 0; look < MAX_LOOKS; look++) {
    o.progress?.(0.55 + look * 0.13, look ? 'Checking the animation again' : 'Checking the animation')
    const images: ScriptImage[] = frames.map((data, i) => ({ label: `Frame at ${times[i].toFixed(1)} s:`, mediaType: 'image/jpeg', data: data.toString('base64') }))
    try {
      const review = await provider.structured({
        system,
        prompt: `${brief()}

THE CODE YOU WROTE${look ? ` (after ${look} round${look > 1 ? 's' : ''} of your own fixes)` : ''}
${code}

The images that follow are frames of it at ${times.map((t) => `${t.toFixed(1)} s`).join(', ')}. Look at them as a viewer and as a demanding art director: is the scene clear, does it show the director's note, does something meaningful move between them, does it look finished and polished (composition, depth, colour, line and shape quality, nothing crude or placeholder-like), is anything cut off, cluttered, unreadable or inside the top 22% headline band or the bottom 16% caption band? If anything can be clearly better, fix it in the code; otherwise return the code unchanged with changed = false.`,
        images,
        schema: ReviewSchema,
        signal: o.signal,
      })
      const next = fence(review.code).slice(0, MAX_CODE_CHARS)
      if (!review.changed || !next || next === code) break
      try {
        frames = await tryIt(next)
        code = next
      } catch (err) {
        // the fix broke it: the working version stays
        if (!(err instanceof DrawingError)) throw err
        log.info('the reviewed drawing failed; keeping the last working one', { error: err.message, look: look + 1 })
        break
      }
    } catch (err) {
      if (o.signal?.aborted) throw err
      // a review that fails costs nothing: the code already runs
      log.warn('drawing review failed', { error: err instanceof Error ? err.message : String(err) })
      break
    }
  }
  return { code, plan, frames }
}
