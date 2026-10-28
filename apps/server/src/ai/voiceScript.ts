// Speaking a script (A-20): the space's pronunciation dictionary first, then the markup. A plain script is one TTS
// call as before; one with pauses or emphasis is voiced a part at a time (emphasis a little slower and louder) and
// joined with ffmpeg, silences made to measure.
import fs from 'node:fs'
import path from 'node:path'
import { applyPronunciations, hasMarkup, parseScript, plainScript, type Pronunciation } from '@producer/core'
import { ffmpeg } from '../media/proc'
import { getSpaceSettings } from '../services/settings'
import { tts } from './tts'

/** Emphasis: this much slower, and this much louder (dB). */
export const EMPHASIS_SPEED = 0.88
export const EMPHASIS_GAIN_DB = 2.5

export async function pronunciationsFor(workspaceId: string | undefined): Promise<Pronunciation[]> {
  if (!workspaceId) return []
  const list = (await getSpaceSettings(workspaceId)).pronunciations
  return Array.isArray(list) ? (list as Pronunciation[]) : []
}

/** The words a voice that can't pause or stress is given: the dictionary applied, the markup taken out. */
export async function spokenPlain(text: string, workspaceId: string | undefined): Promise<string> {
  return plainScript(applyPronunciations(text, await pronunciationsFor(workspaceId)))
}

type Progress = (f: number, m: string) => void

export async function speakScript(text: string, out: string, opts: { voice: string; speed: number; workspaceId?: string; signal?: AbortSignal; progress?: Progress }): Promise<{ duration: number; sampleRate: number }> {
  const dict = await pronunciationsFor(opts.workspaceId)
  if (!hasMarkup(text)) return tts.synthesize(applyPronunciations(text, dict), out, opts)
  const parts = parseScript(text)
  const says = parts.filter((p) => p.kind === 'say').length
  if (!says) throw new Error('The script has nothing to say, only pauses')
  const dir = path.join(path.dirname(out), `parts-${path.basename(out, path.extname(out))}`)
  fs.mkdirSync(dir, { recursive: true })
  const inputs: string[] = []
  const filters: string[] = []
  let duration = 0
  let sampleRate = 24000
  let done = 0
  for (const p of parts) {
    // one ffmpeg input per part, in order
    const i = filters.length
    if (p.kind === 'pause') {
      inputs.push('-f', 'lavfi', '-t', String(p.seconds), '-i', 'anullsrc=r=24000:cl=mono')
      filters.push(`[${i}:a]aresample=${sampleRate},aformat=sample_rates=${sampleRate}:channel_layouts=mono[a${i}]`)
      duration += p.seconds
      continue
    }
    const file = path.join(dir, `${i}.wav`)
    const sub: Progress | undefined = opts.progress && ((f, m) => opts.progress!((done + f) / says, m))
    const r = await tts.synthesize(applyPronunciations(p.text, dict), file, { voice: opts.voice, speed: p.emphasis ? opts.speed * EMPHASIS_SPEED : opts.speed, signal: opts.signal, progress: sub })
    done++
    sampleRate = r.sampleRate || sampleRate
    duration += r.duration
    inputs.push('-i', file)
    filters.push(`[${i}:a]aresample=${sampleRate},aformat=sample_rates=${sampleRate}:channel_layouts=mono${p.emphasis ? `,volume=${EMPHASIS_GAIN_DB}dB` : ''}[a${i}]`)
  }
  const n = filters.length
  const graph = `${filters.join(';')};${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[out]`
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[out]', '-ar', String(sampleRate), '-ac', '1', out], { signal: opts.signal })
  fs.rm(dir, { recursive: true, force: true }, () => undefined)
  return { duration: Math.round(duration * 1000) / 1000, sampleRate }
}
