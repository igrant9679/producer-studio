// AI-drawn animation scenes: the space's AI writes the drawing code for one scene (canvas 2D + Rough.js, timed to the
// narration's words), media/drawing.ts runs it in a sandbox, and the model gets one round to fix an error and one look
// at frames of its own drawing to fix what it sees. The rules below are distilled from two open-source agent kits for
// code-made video (both MIT): explainroo (github.com/vincentsch/explainroo: drawings that appear on a word of the
// narration) and video-director (github.com/win4r/video-director: plan in numbers, draw from the clock alone, check
// what you can't watch).
import * as z from 'zod/v4'
import { HttpError } from '../http'
import { log } from '../log'
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
- Draw people and objects simply and charmingly (round heads, simple bodies, expressive poses), never photorealistic, never logos or brand marks.`

export function buildDrawingPrompt(o: { description: string; narration: string; headline: string; env: DrawingEnv; silent?: boolean; noWords?: boolean }): string {
  const words = o.env.words.map((w) => `${w.w}@${w.start.toFixed(2)}`).join(' ')
  return `Draw this scene.

WHAT TO DRAW (the director's note)
${o.description.trim()}

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
    .replace(/^```(?:javascript|js)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim()

/** Where frames are looked at: early, the middle, late, and the settled end. */
export const LOOK_AT = [0.18, 0.45, 0.72, 0.97]

/**
 * The drawing code for one scene: written, run in the sandbox (one fix when it fails), then looked at once. Throws
 * HttpError when no working code came back.
 */
export async function writeDrawing(
  provider: AiProvider,
  o: { description: string; narration: string; headline: string; env: DrawingEnv; silent?: boolean; noWords?: boolean; signal?: AbortSignal; progress?: (f: number, msg: string) => void },
): Promise<{ code: string; plan: string; frames: Buffer[] }> {
  const times = LOOK_AT.map((k) => k * o.env.duration)
  o.progress?.(0.05, 'Writing the animation')
  const first = await provider.structured({ system: DRAWN_SYSTEM, prompt: buildDrawingPrompt(o), images: [], schema: DrawingSchema, signal: o.signal })
  let code = fence(first.code).slice(0, MAX_CODE_CHARS)
  const plan = first.plan
  let frames: Buffer[]
  o.progress?.(0.4, 'Trying the animation')
  try {
    frames = await testDrawing(code, o.env, times, o.signal)
  } catch (err) {
    if (!(err instanceof DrawingError)) throw err
    log.info('drawing failed; asking for a fix', { error: err.message, at: err.at })
    o.progress?.(0.5, 'Fixing the animation')
    const fixed = await provider.structured({
      system: DRAWN_SYSTEM,
      prompt: `${buildDrawingPrompt(o)}

YOUR CODE FAILED${err.at !== undefined ? ` at t = ${err.at.toFixed(2)} s` : ''}: ${err.message}

THE CODE
${code}

Fix it and return the plan and the full code.`,
      images: [],
      schema: DrawingSchema,
      signal: o.signal,
    })
    code = fence(fixed.code).slice(0, MAX_CODE_CHARS)
    try {
      frames = await testDrawing(code, o.env, times, o.signal)
    } catch (again) {
      if (!(again instanceof DrawingError)) throw again
      throw new HttpError(502, 'server', `the AI’s animation didn’t run (${again.message.slice(0, 120)})`)
    }
  }
  // one look at its own frames, as a viewer would see them
  o.progress?.(0.65, 'Checking the animation')
  const images: ScriptImage[] = frames.map((data, i) => ({ label: `Frame at ${times[i].toFixed(1)} s:`, mediaType: 'image/jpeg', data: data.toString('base64') }))
  try {
    const review = await provider.structured({
      system: DRAWN_SYSTEM,
      prompt: `${buildDrawingPrompt(o)}

THE CODE YOU WROTE
${code}

The images that follow are frames of it at ${times.map((t) => `${t.toFixed(1)} s`).join(', ')}. Look at them as a viewer: is the scene clear, does it show the director's note, does something move between them, is anything cut off, cluttered, unreadable or inside the top 22% headline band or the bottom 16% caption band? If anything is wrong, fix it in the code; otherwise return the code unchanged with changed = false.`,
      images,
      schema: ReviewSchema,
      signal: o.signal,
    })
    const next = fence(review.code).slice(0, MAX_CODE_CHARS)
    if (review.changed && next && next !== code) {
      try {
        frames = await testDrawing(next, o.env, times, o.signal)
        code = next
      } catch (err) {
        // the fix broke it: the working version stays
        if (!(err instanceof DrawingError)) throw err
        log.info('the reviewed drawing failed; keeping the first', { error: err.message })
      }
    }
  } catch (err) {
    if (o.signal?.aborted) throw err
    // a review that fails costs nothing: the code already runs
    log.warn('drawing review failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return { code, plan, frames }
}
