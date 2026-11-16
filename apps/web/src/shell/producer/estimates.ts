// How long Producer's steps take, roughly (A-7): told before a step starts and while it runs. Rules of thumb from what
// each step does on the server (transcription about 4× faster than real time, a voice a third of its length, AI
// clips minutes), shown as an estimate, never a promise.
import { estimateCost, is3dDrawingStyle, isBlenderStyle, isLottieStyle, type ScriptScene } from '@producer/core'
import { isIdea, narrationSeconds, readyAssetIds, type WizardState } from './wizardLogic'

/** Seconds to transcribe what still needs it and write the script. */
export function estimateWrite(s: WizardState): number {
  if (isIdea(s)) return 30
  let t = 0
  let footage = 0
  for (const id of readyAssetIds(s)) {
    const a = s.assets.find((x) => x.assetId === id)
    const d = a?.duration ?? 60
    footage += d
    if (!s.transcribed.includes(id) && a?.hasAudio !== false) t += 8 + d * 0.25
  }
  // the writer reads the transcript (and looks at frames): longer footage, longer read
  return Math.round(t + 20 + Math.min(90, (footage / 60) * 4))
}

const VISUAL_SECONDS: Record<string, number> = { image: 20, stock: 10, photo: 5, animation: 6, aiVideo: 120 }

/**
 * Seconds the AI takes to draw one scene (write the code, try it, look at its frames up to three times, render it),
 * from real runs: about 5 minutes for motion graphics and 9 for a 2D drawing (one on 14 Nov 2026 took 11). Two are
 * drawn at a time.
 *
 * 3D (three.js): 12 minutes. A 3D scene took about 17 minutes while the model thought at its own default; since
 * drawings think at medium effort (14 Nov 2026) there is one measurement, on the live site on 15 Nov: three studio3d
 * scenes on claude-fable-5-2, the whole assembly in 14.9 minutes, which is about 9.5 minutes a scene as assembleParts
 * counts them (the first leads, the other two side by side). One run isn't a rule, so this sits about a quarter above
 * it rather than on it; bring it down when more runs agree. Blender has no measurement (its time is the render's) and
 * keeps the old 17.
 */
export function drawnSeconds(style: string | undefined): number {
  if (isBlenderStyle(style)) return 1000
  if (is3dDrawingStyle(style)) return 720
  return isLottieStyle(style) ? 280 : 560
}

/** Drawings the next assembly has to make: scenes drawn before (code and clip) are reused. */
export const freshDrawings = (scenes: ScriptScene[]): number => scenes.filter((sc) => sc.visual?.kind === 'drawn' && !(sc.visual.code && sc.visual.assetId)).length

/** A 3D scene's tokens while the model thought at its own default (before 14 Nov 2026): what the other styles are scaled from. */
const DEFAULT_EFFORT_3D = { input: 80_000, output: 90_000 }

/**
 * Tokens one drawing takes (writing the code, then up to three looks at its own frames, each answer with the model's
 * thinking).
 *
 * 3D (three.js): 80,000 in and 55,000 out. Measured at medium effort on the live site on 15 Nov 2026: three studio3d
 * scenes on claude-fable-5-2 took 10 requests, 221,054 tokens in and 123,016 out ($6.69 at list price), so about
 * 74,000 in and 41,000 out a scene. That is one run, and a scene that needs a fix or a third look takes more: the
 * output stays about a third above the measurement (three such scenes then read as roughly $8.50, not the $13 the
 * default-effort figures gave).
 *
 * 2D and motion-graphics code is shorter; neither they nor Blender have a measurement at medium effort, so they keep
 * the figures scaled from the default-effort 3D scene.
 */
export function drawnTokens(style: string | undefined): { input: number; output: number } {
  if (is3dDrawingStyle(style)) return { input: 80_000, output: 55_000 }
  const k = isBlenderStyle(style) ? 1 : isLottieStyle(style) ? 0.35 : 0.55
  return { input: Math.round(DEFAULT_EFFORT_3D.input * k), output: Math.round(DEFAULT_EFFORT_3D.output * k) }
}

/** Roughly what the scenes still to draw cost on this model (0: nothing to draw, or a provider with no price, like the Claude app's own plan). */
export function estimateDrawnCost(scenes: ScriptScene[], o: { drawingStyle?: string; provider: string; model: string }): { scenes: number; each: number; total: number } {
  const n = freshDrawings(scenes)
  const t = drawnTokens(o.drawingStyle)
  const each = estimateCost(o.provider, o.model, t.input, t.output)
  return { scenes: n, each, total: each * n }
}

export interface AssembleOptions {
  renarrate?: string[]
  whisper?: boolean
  music?: boolean
  narration?: boolean
  drawingStyle?: string
}

/** Seconds to narrate, time captions, make visuals and build the timeline. */
export function estimateAssemble(scenes: ScriptScene[], opts: AssembleOptions = {}): number {
  const p = assembleParts(scenes, opts)
  return Math.round(p.voice + p.visuals + p.rest)
}

/**
 * What is left of an assembly at the job's progress. The job reports voices as 0 to 0.6, visuals as 0.6 to 0.9 and the
 * music and timeline after that, but the time is nowhere near shared that way: three drawings are a quarter of an hour
 * or more inside the 0.6 to 0.9 band. So each band's share of the progress is turned into that part's own seconds.
 */
export function assembleRemaining(scenes: ScriptScene[], opts: AssembleOptions, progress: number | undefined): number {
  const p = assembleParts(scenes, opts)
  const total = p.voice + p.visuals + p.rest
  if (progress === undefined || progress <= 0) return Math.round(total)
  const f = Math.min(1, progress)
  const done = f < 0.6 ? (f / 0.6) * p.voice : f < 0.9 ? p.voice + ((f - 0.6) / 0.3) * p.visuals : p.voice + p.visuals + ((f - 0.9) / 0.1) * p.rest
  return Math.max(5, Math.round(total - done))
}

/** An assembly's seconds by part: the voices (and their timing), the visuals, and the music and timeline. */
export function assembleParts(scenes: ScriptScene[], opts: AssembleOptions = {}): { voice: number; visuals: number; rest: number } {
  let voice = 0
  let visuals = 0
  let t = 8
  let length = 6.5
  // drawings not made yet: one takes its full time (one already drawn is only re-rendered if its timing changed)
  const drawn = scenes.filter((sc) => sc.visual?.kind === 'drawn')
  const fresh = freshDrawings(scenes)
  // the first leads (the others copy its characters and start once its code runs, about half way), then two at a time
  visuals += (drawn.length - fresh) * 20 + (fresh <= 1 ? fresh : 0.5 + Math.ceil((fresh - 1) / 2)) * drawnSeconds(opts.drawingStyle)
  for (const sc of scenes) {
    const spoken = narrationSeconds(sc.narration) / (sc.narrator?.speed ?? 1)
    length += spoken + 2
    // a voice made before for the same words is reused
    const reuse = !!sc.voice && !opts.renarrate?.includes(sc.id)
    if (opts.narration !== false) {
      voice += reuse ? 1 : 4 + spoken * 0.35
      voice += opts.whisper === false ? 0.2 : 2 + spoken * 0.2
    }
    visuals += VISUAL_SECONDS[sc.visual?.kind ?? ''] ?? 0
  }
  // the music takes about as long to compose as the video takes to play
  if (opts.music) t += length * 0.9
  return { voice, visuals, rest: t }
}

/** "less than a minute", "about 3 minutes". */
export function formatEstimate(seconds: number): string {
  if (seconds < 50) return 'less than a minute'
  const m = Math.max(1, Math.round(seconds / 60))
  return m === 1 ? 'about a minute' : `about ${m} minutes`
}

/** What's left of an estimate at a progress 0..1 (unknown progress: the whole of it). */
export function remainingSeconds(total: number, progress: number | undefined): number {
  if (progress === undefined || progress <= 0) return total
  return Math.max(5, Math.round(total * (1 - Math.min(1, progress))))
}
