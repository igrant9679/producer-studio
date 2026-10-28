// Pitch that follows the speed, in the export (E-17). HyperFrames plays a clip's sound at its speed keeping the pitch
// (atempo); a clip set to let its pitch shift gets a copy of its sound resampled to its speed instead, the way the
// preview's player does it with preservesPitch off. Made before the render; the composition plays it at 1x.
import fs from 'node:fs'
import path from 'node:path'
import { shiftsPitch, soundSpans, varispeedSlices, type Project } from '@producer/core'
import { log } from '../log'
import { ffmpeg } from '../media/proc'

/** Sample rate of the copies (HyperFrames mixes at 48 kHz). */
export const PITCH_RATE = 48000

const n6 = (v: number) => String(Math.round(v * 1e6) / 1e6)

/**
 * ffmpeg arguments for one copy: source `slices[0].from`..`slices[n-1].to` of `src`, each slice resampled (pitch and
 * tempo together) to last its `len` seconds, joined. A constant speed is one slice; a ramp steps its speed per slice.
 */
export function pitchShiftArgs(src: string, out: string, slices: Array<{ from: number; to: number; len: number }>): string[] {
  const start = slices[0].from
  const end = slices[slices.length - 1].to
  const n = slices.length
  const chains = slices.map((s, i) => {
    const rate = Math.max(1, Math.round((PITCH_RATE * (s.to - s.from)) / Math.max(1e-6, s.len)))
    return `[s${i}]atrim=start=${n6(s.from - start)}:end=${n6(s.to - start)},asetpts=PTS-STARTPTS,asetrate=${rate},aresample=${PITCH_RATE},apad,atrim=0:${n6(s.len)},asetpts=PTS-STARTPTS[t${i}]`
  })
  const split = n > 1 ? `asplit=${n}${slices.map((_, i) => `[s${i}]`).join('')}` : 'anull[s0]'
  const graph = [`[0:a]aresample=${PITCH_RATE},${split}`, ...chains, `${slices.map((_, i) => `[t${i}]`).join('')}concat=n=${n}:v=0:a=1[out]`].join(';')
  return ['-ss', n6(start), '-t', n6(end - start + 0.05), '-i', src, '-vn', '-filter_complex', graph, '-map', '[out]', '-ac', '2', '-ar', String(PITCH_RATE), '-c:a', 'pcm_s16le', out]
}

/**
 * Make the pitch-shifted copies a project's export needs (relative paths by item id). A clip whose copy can't be
 * made (no sound stream, say) is left out: it plays at its speed with its pitch kept.
 */
export async function makePitchShiftCopies(project: Project, localFiles: Map<string, string>, dir: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const span of soundSpans(project)) {
    const it = span.item
    const src = localFiles.get(it.assetId)
    if (!src || !shiftsPitch(it) || out.has(it.id)) continue
    const rel = `pitch/${it.id}.wav`
    fs.mkdirSync(path.join(dir, 'pitch'), { recursive: true })
    try {
      await ffmpeg(pitchShiftArgs(src, path.join(dir, rel), varispeedSlices(it, span.start, span.end)), { signal })
      out.set(it.id, rel)
    } catch (err) {
      if (signal?.aborted) throw err
      log.warn('pitch-shifted copy failed, the clip keeps its pitch', { itemId: it.id, err })
    }
  }
  return out
}
