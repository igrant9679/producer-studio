// How long Producer's steps take, roughly (A-7): told before a step starts and while it runs. Rules of thumb from what
// each step does on the server (transcription about 4× faster than real time, a voice a third of its length, AI
// clips minutes), shown as an estimate, never a promise.
import type { ScriptScene } from '@producer/core'
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

const VISUAL_SECONDS: Record<string, number> = { image: 20, stock: 10, aiVideo: 120 }

/** Seconds to narrate, time captions, make visuals and build the timeline. */
export function estimateAssemble(scenes: ScriptScene[], opts: { renarrate?: string[]; whisper?: boolean } = {}): number {
  let t = 8
  for (const sc of scenes) {
    const spoken = narrationSeconds(sc.narration) / (sc.narrator?.speed ?? 1)
    // a voice made before for the same words is reused
    const reuse = !!sc.voice && !opts.renarrate?.includes(sc.id)
    t += reuse ? 1 : 4 + spoken * 0.35
    t += opts.whisper === false ? 0.2 : 2 + spoken * 0.2
    t += VISUAL_SECONDS[sc.visual?.kind ?? ''] ?? 0
  }
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
