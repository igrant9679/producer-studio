// media.smooth: smooth slow motion (E-17). A slowed clip shows each frame of its file for longer than one frame of
// the video, so it stutters; this makes a copy of the clip's stretch of the file with frames made in between
// (ffmpeg minterpolate, motion-compensated), which the clip's picture then plays from in the preview and the export.
import fs from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { SMOOTH_MAX_FPS, type SmoothCopyResult } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetDoc } from '../dto'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { createAssetFromFile, localSource } from '../services/assets'
import { ffmpegProgress } from './proc'
import { processAsset, probe, sdrFilters } from './process'

export interface SmoothInput {
  assetId: string
  workspaceId: string
  projectId?: string
  /** Source seconds the copy covers. */
  from: number
  to: number
  /** Frame rate of the copy. */
  fps: number
}

export type SmoothResult = SmoothCopyResult

/** The copy is made no larger than this on its short side: in-between frames cost a lot per pixel. */
export const SMOOTH_SHORT = 1080

/**
 * ffmpeg arguments: source `from` for `length` seconds, scaled down to `short` at most (never up), with frames made
 * in between up to `fps` (motion-compensated interpolation), H.264, no sound (the clip keeps its source's sound).
 */
export function smoothArgs(src: string, out: string, o: { from: number; length: number; fps: number; short?: number; sdr?: string[] }): string[] {
  const short = o.short ?? SMOOTH_SHORT
  const fps = Math.max(1, Math.min(SMOOTH_MAX_FPS, Math.round(o.fps)))
  const vf = [
    `scale='if(gt(iw,ih),-2,min(iw,${short}))':'if(gt(iw,ih),min(ih,${short}),-2)'`,
    ...(o.sdr ?? []),
    `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    'format=yuv420p',
  ].join(',')
  const r = (n: number) => String(Math.round(n * 1000) / 1000)
  return ['-ss', r(o.from), '-t', r(o.length), '-i', src, '-an', '-sn', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(fps), '-movflags', '+faststart', out]
}

export async function makeSmoothCopy(jc: JobContext): Promise<SmoothResult> {
  const input = jc.job.input as unknown as SmoothInput
  const row = (await ctx().db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId))).limit(1))[0]
  if (!row) throw new HttpError(404, 'not_found', 'This clip is not in the media library')
  if (row.kind !== 'video') throw new HttpError(400, 'invalid', 'Smooth slow motion works on video clips')
  const dur = row.meta?.duration
  const from = Math.max(0, input.from)
  const to = Math.min(input.to, dur ?? Infinity)
  if (!(to > from)) throw new HttpError(400, 'invalid', 'There is nothing of the clip in that range')
  const tmp = path.join(ctx().config.dataDir, 'tmp', `smooth-${jc.job.id}`)
  fs.mkdirSync(tmp, { recursive: true })
  try {
    jc.progress(0.02, 'Reading the clip')
    const src = await localSource(row, tmp)
    const info = await probe(src, jc.signal).catch(() => undefined)
    const sdr = info ? await sdrFilters(info) : []
    const out = path.join(tmp, 'smooth.mp4')
    const length = to - from
    await ffmpegProgress(smoothArgs(src, out, { from, length, fps: input.fps, sdr }), length, (f) => jc.progress(0.05 + f * 0.8, 'Making the in-between frames'), { signal: jc.signal })
    jc.check()
    jc.progress(0.87, 'Saving the smooth copy')
    const created = await createAssetFromFile({
      workspaceId: row.workspaceId,
      userId: jc.job.userId,
      projectId: input.projectId ?? row.projectId,
      filePath: out,
      name: `${row.name.replace(/\.[^.]+$/, '')} · smooth ${Math.round(input.fps)} fps`.slice(0, 200),
      mime: 'video/mp4',
      kind: 'video',
      origin: 'smooth',
      meta: { jobId: jc.job.id },
    })
    jc.progress(0.9, 'Preparing it for the editor')
    const ready = await processAsset(created.id, { signal: jc.signal, check: jc.check, progress: (f) => jc.progress(0.9 + f * 0.1, 'Preparing it for the editor') })
    const doc = assetDoc(ready)
    // in-between frames stop at the last frame of the file: the copy can end a frame early, and says so
    const end = doc.duration ? Math.min(to, from + doc.duration) : to
    return { asset: doc, from, to: Math.round(end * 1000) / 1000, fps: Math.round(input.fps) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
