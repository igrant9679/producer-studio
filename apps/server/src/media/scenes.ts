// media.scenes: where the picture changes in a clip's file (ffmpeg's scene score), so the editor can split there (E-10).
import fs from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { SceneCuts } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { localSource } from '../services/assets'
import { ffmpegProgress } from './proc'
import { renderMediaKey } from './process'

export interface SceneInput {
  assetId: string
  workspaceId: string
  /** Seconds into the file; the whole file when absent. */
  from?: number
  to?: number
  /** ffmpeg scene score (0..1) above which a frame starts a new shot: lower finds more cuts. */
  threshold?: number
}

export const DEFAULT_SCENE_THRESHOLD = 0.3
/** Cuts closer together than this are one change (a flash, a fast pan). */
const MIN_GAP = 0.5

/** ffmpeg arguments: decode the range small and print each frame whose scene score passes the threshold. */
export function sceneArgs(src: string, o: { from: number; length?: number; threshold: number }): string[] {
  const range = [...(o.from > 0 ? ['-ss', String(o.from)] : []), ...(o.length ? ['-t', String(o.length)] : [])]
  return [...range, '-i', src, '-an', '-sn', '-vf', `scale=320:-2,select='gt(scene,${o.threshold})',showinfo`, '-f', 'null', '-']
}

/** Cut times (seconds into the file) from showinfo's lines: `from` added back, near-duplicates merged. */
export function parseSceneCuts(stderr: string, from = 0): number[] {
  const out: number[] = []
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([\d.]+)/g)) {
    const t = Math.round((from + Number(m[1])) * 1000) / 1000
    if (!Number.isFinite(t)) continue
    if (out.length && t - out[out.length - 1] < MIN_GAP) continue
    out.push(t)
  }
  return out
}

export async function detectScenes(jc: JobContext): Promise<SceneCuts> {
  const input = jc.job.input as unknown as SceneInput
  const row = (await ctx().db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId))).limit(1))[0]
  if (!row) throw new HttpError(404, 'not_found', 'This clip is not in the media library')
  if (row.kind !== 'video') throw new HttpError(400, 'invalid', 'Scene detection works on video clips')
  const dur = row.meta?.duration
  const from = Math.max(0, input.from ?? 0)
  const to = Math.min(input.to ?? dur ?? Infinity, dur ?? Infinity)
  const length = Number.isFinite(to) ? Math.max(0.1, to - from) : undefined
  const tmp = path.join(ctx().config.dataDir, 'tmp', `scenes-${jc.job.id}`)
  fs.mkdirSync(tmp, { recursive: true })
  try {
    jc.progress(0.02, 'Reading the clip')
    // the small proxy has the same timing and decodes far faster
    const src = await localSource(row, tmp, renderMediaKey(row, true))
    // keep only showinfo's lines (whole lines: a chunk can end mid-line)
    let pending = ''
    let found = ''
    const take = (line: string) => line.includes('Parsed_showinfo') && (found += line + '\n')
    jc.progress(0.05, 'Looking for scene changes')
    await ffmpegProgress(sceneArgs(src, { from, length, threshold: input.threshold ?? DEFAULT_SCENE_THRESHOLD }), length ?? dur ?? 1, (f) => jc.progress(0.05 + f * 0.9, 'Looking for scene changes'), {
      signal: jc.signal,
      maxCapture: 4000,
      onStderr: (s) => {
        const lines = (pending + s).split('\n')
        pending = lines.pop() ?? ''
        lines.forEach(take)
      },
    })
    take(pending)
    const cuts = parseSceneCuts(found, from).filter((t) => t > from + 0.05 && (!Number.isFinite(to) || t < to - 0.05))
    return { assetId: row.id, cuts }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
