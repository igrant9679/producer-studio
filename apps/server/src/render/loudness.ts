// Loudness normalisation of a finished export (E-14): ffmpeg's loudnorm in two passes, measured first, then applied
// as one linear gain with a true-peak ceiling, so the mix keeps its dynamics and lands on the platform's target.
// The picture is copied untouched.
import fs from 'node:fs'
import type { ExportRequest } from '@producer/core'
import { ffmpeg } from '../media/proc'

/** Ceiling for true peaks (dBTP) and the loudness range loudnorm aims for. */
const TRUE_PEAK = -1.5
const RANGE = 11

export interface Loudness {
  /** Integrated loudness (LUFS), true peak (dBTP), loudness range (LU) and the gating threshold, as loudnorm reports. */
  i: number
  tp: number
  lra: number
  thresh: number
  offset: number
}

/** The last JSON block loudnorm prints on stderr. */
export function parseLoudnorm(stderr: string): Loudness | undefined {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>
    const n = (k: string) => Number(j[k])
    const out = { i: n('input_i'), tp: n('input_tp'), lra: n('input_lra'), thresh: n('input_thresh'), offset: n('target_offset') }
    return Object.values(out).every(Number.isFinite) ? out : undefined
  } catch {
    return undefined
  }
}

/** Measure a file's sound; undefined when it has none, or only silence. */
export async function measureLoudness(file: string, signal?: AbortSignal): Promise<Loudness | undefined> {
  // a file without a sound stream makes ffmpeg fail ("no streams"): nothing to measure
  const r = await ffmpeg(['-i', file, '-map', '0:a:0?', '-vn', '-af', `loudnorm=I=-16:TP=${TRUE_PEAK}:LRA=${RANGE}:print_format=json`, '-f', 'null', '-'], { signal }).catch((err) => {
    if (signal?.aborted) throw err
    return undefined
  })
  return r ? parseLoudnorm(r.stderr) : undefined
}

const AUDIO_CODEC: Record<Exclude<ExportRequest['format'], 'gif'>, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:a', 'libopus', '-b:a', '160k'],
}

/**
 * Write `src` to `out` with its sound at `lufs` integrated loudness; returns the file to keep (`src` itself when it
 * has no sound to normalise).
 */
export async function normalizeLoudness(src: string, out: string, lufs: number, opts: { format: ExportRequest['format']; signal?: AbortSignal }): Promise<string> {
  if (opts.format === 'gif') return src
  const m = await measureLoudness(src, opts.signal)
  if (!m || m.i < -70) return src
  const filter =
    `loudnorm=I=${lufs}:TP=${TRUE_PEAK}:LRA=${RANGE}:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}` +
    `:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary`
  await ffmpeg(['-i', src, '-map', '0:v?', '-map', '0:a:0', '-c:v', 'copy', '-af', filter, '-ar', '48000', ...AUDIO_CODEC[opts.format], ...(opts.format === 'mp4' ? ['-movflags', '+faststart'] : []), out], { signal: opts.signal })
  if (!fs.existsSync(out)) throw new Error('Loudness normalisation wrote no file')
  return out
}
