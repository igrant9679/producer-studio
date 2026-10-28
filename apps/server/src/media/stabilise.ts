// media.stabilise (E-21): a steadied copy of the part of a clip's file it shows. ffmpeg's vid.stab when this build has
// it (two passes: find the shake, then smooth it out and zoom in just enough to hide the moving edges), else deshake.
import path from 'node:path'
import type { SmartJobResult } from '@producer/core'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { ffmpegProgress } from './proc'
import { probe, sdrFilters } from './process'
import { type SmartInput, VIDEO_OUT, rangeInput, runSmartTool, smartToolsInfo, sourceRange } from './smartTools'

/** Frames vid.stab averages the camera's path over (5..60) for a 0..100 smoothing. */
export const vidstabSmoothing = (s = 50) => Math.round(5 + (Math.max(0, Math.min(100, s)) / 100) * 55)

/** Pass 1: where the camera moved, written to `trf` (a name in the working folder: a Windows path's colon breaks filter options). */
export function vidstabDetectArgs(input: string[], trf: string): string[] {
  return [...input, '-an', '-sn', '-vf', `vidstabdetect=shakiness=6:accuracy=15:result=${trf}`, '-f', 'null', '-']
}

/** Pass 2: the steadied picture, sound kept. */
export function vidstabTransformArgs(input: string[], trf: string, out: string, o: { smoothing?: number; after?: string[]; hasAudio: boolean }): string[] {
  const vf = [`vidstabtransform=input=${trf}:smoothing=${vidstabSmoothing(o.smoothing)}:optzoom=1:interpol=bicubic`, 'unsharp=5:5:0.6:3:3:0.3', ...(o.after ?? [])].join(',')
  return [...input, '-map', '0:v:0', ...(o.hasAudio ? ['-map', '0:a:0?'] : []), '-vf', vf, ...VIDEO_OUT, ...(o.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), out]
}

/** One pass with deshake (builds without libvidstab). */
export function deshakeArgs(input: string[], out: string, o: { smoothing?: number; after?: string[]; hasAudio: boolean }): string[] {
  // the search range: 16..64 px, in steps of 16 (deshake takes no other)
  const r = 16 * Math.round(1 + (Math.max(0, Math.min(100, o.smoothing ?? 50)) / 100) * 3)
  const vf = [`deshake=rx=${r}:ry=${r}:edge=mirror`, ...(o.after ?? [])].join(',')
  return [...input, '-map', '0:v:0', ...(o.hasAudio ? ['-map', '0:a:0?'] : []), '-vf', vf, ...VIDEO_OUT, ...(o.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), out]
}

export async function stabiliseClip(jc: JobContext): Promise<SmartJobResult> {
  const input = jc.job.input as unknown as SmartInput
  const tools = await smartToolsInfo()
  if (!tools.stabilise) throw new HttpError(501, 'server', tools.why.stabilise ?? 'Stabilisation is not available on this server')
  const method = tools.stabilise.method
  return runSmartTool(
    'stabilise',
    jc,
    async ({ row, src, work, progress }) => {
      if (row.kind !== 'video') throw new HttpError(400, 'invalid', 'Stabilisation works on video clips')
      const info = await probe(src, jc.signal)
      const range = sourceRange(input, info.duration ?? row.meta?.duration)
      const length = range.length ?? info.duration ?? 1
      const inArgs = rangeInput(src, range)
      const out = path.join(work, 'stabilised.mp4')
      const after = await sdrFilters(info)
      const hasAudio = info.hasAudio
      if (method === 'vidstab') {
        progress(0, 'Finding the shake')
        await ffmpegProgress(vidstabDetectArgs(inArgs, 'transforms.trf'), length, (f) => progress(f * 0.45, 'Finding the shake'), { signal: jc.signal, cwd: work })
        jc.check()
        await ffmpegProgress(vidstabTransformArgs(inArgs, 'transforms.trf', out, { smoothing: input.smoothing, after, hasAudio }), length, (f) => progress(0.45 + f * 0.55, 'Steadying the picture'), { signal: jc.signal, cwd: work })
      } else {
        await ffmpegProgress(deshakeArgs(inArgs, out, { smoothing: input.smoothing, after, hasAudio }), length, (f) => progress(f, 'Steadying the picture'), { signal: jc.signal, cwd: work })
      }
      return { file: out, mime: 'video/mp4', kind: 'video', offset: range.from, length: range.length }
    },
    { method, smoothing: input.smoothing ?? 50 },
  )
}
