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
 * as measured on real runs: about 5 minutes for motion graphics, 9 for a 2D drawing, 17 for a 3D scene. Two are drawn
 * at a time.
 */
export function drawnSeconds(style: string | undefined): number {
  if (is3dDrawingStyle(style) || isBlenderStyle(style)) return 1000
  return isLottieStyle(style) ? 280 : 560
}

/** Drawings the next assembly has to make: scenes drawn before (code and clip) are reused. */
export const freshDrawings = (scenes: ScriptScene[]): number => scenes.filter((sc) => sc.visual?.kind === 'drawn' && !(sc.visual.code && sc.visual.assetId)).length

/**
 * Tokens one drawing takes (writing the code, then up to three looks at its own frames, each answer with the model's
 * thinking). Measured on a 3D scene on a strongest-tier model: about 80,000 in and 90,000 out; 2D and motion-graphics
 * code is shorter.
 */
export function drawnTokens(style: string | undefined): { input: number; output: number } {
  const k = is3dDrawingStyle(style) || isBlenderStyle(style) ? 1 : isLottieStyle(style) ? 0.35 : 0.55
  return { input: Math.round(80_000 * k), output: Math.round(90_000 * k) }
}

/** Roughly what the scenes still to draw cost on this model (0: nothing to draw, or a provider with no price, like the Claude app's own plan). */
export function estimateDrawnCost(scenes: ScriptScene[], o: { drawingStyle?: string; provider: string; model: string }): { scenes: number; each: number; total: number } {
  const n = freshDrawings(scenes)
  const t = drawnTokens(o.drawingStyle)
  const each = estimateCost(o.provider, o.model, t.input, t.output)
  return { scenes: n, each, total: each * n }
}

/** Seconds to narrate, time captions, make visuals and build the timeline. */
export function estimateAssemble(scenes: ScriptScene[], opts: { renarrate?: string[]; whisper?: boolean; music?: boolean; narration?: boolean; drawingStyle?: string } = {}): number {
  let t = 8
  let length = 6.5
  // drawings not made yet: one takes its full time, more are drawn two at a time (one already drawn is only re-rendered if its timing changed)
  const drawn = scenes.filter((sc) => sc.visual?.kind === 'drawn')
  const fresh = freshDrawings(scenes)
  t += (drawn.length - fresh) * 20 + (fresh <= 1 ? fresh : Math.ceil(fresh / 2)) * drawnSeconds(opts.drawingStyle)
  for (const sc of scenes) {
    const spoken = narrationSeconds(sc.narration) / (sc.narrator?.speed ?? 1)
    length += spoken + 2
    // a voice made before for the same words is reused
    const reuse = !!sc.voice && !opts.renarrate?.includes(sc.id)
    if (opts.narration !== false) {
      t += reuse ? 1 : 4 + spoken * 0.35
      t += opts.whisper === false ? 0.2 : 2 + spoken * 0.2
    }
    t += VISUAL_SECONDS[sc.visual?.kind ?? ''] ?? 0
  }
  // the music takes about as long to compose as the video takes to play
  if (opts.music) t += length * 0.9
  return Math.round(t)
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
