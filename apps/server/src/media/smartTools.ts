// Smart tools (E-21): what this server's ffmpeg (and configuration) can do, and the part every tool shares: read the
// clip's file, make a processed copy of the part asked for, save it as a new clip processed inside the same job, and
// answer where in the original it starts. The tools themselves are stabilise.ts, denoise.ts and bgremove.ts.
import fs from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { SmartJobRequest, SmartJobResult, SmartTool, SmartToolsInfo, Transcript } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { type AssetRow, createAssetFromFile, localSource, tmpDir } from '../services/assets'
import { runOk } from './proc'
import { processAsset } from './process'

let filters: Promise<Set<string>> | undefined

/** The filters this ffmpeg has (asked once). */
export function ffmpegFilters(): Promise<Set<string>> {
  filters ??= runOk(ctx().config.ffmpegPath, ['-hide_banner', '-filters'])
    .then((r) => new Set([...r.stdout.matchAll(/^\s*[A-Z.|]{2,3}\s+(\w+)\s/gm)].map((m) => m[1])))
    .catch((err) => {
      log.warn('could not list ffmpeg filters: smart tools are off', { err })
      return new Set<string>()
    })
  return filters
}

/** Tests: list the filters again (or pretend this ffmpeg has only `only`). */
export function resetFfmpegFilters(only?: string[]) {
  filters = only ? Promise.resolve(new Set(only)) : undefined
}

/** What the smart tools can do here, and why not where they can't. */
export async function smartToolsInfo(): Promise<SmartToolsInfo> {
  const f = await ffmpegFilters()
  const cfg = ctx().config
  const why: SmartToolsInfo['why'] = {}
  const stabilise = f.has('vidstabdetect') && f.has('vidstabtransform') ? { method: 'vidstab' as const } : f.has('deshake') ? { method: 'deshake' as const } : null
  if (!stabilise) why.stabilise = "This server's ffmpeg has no stabiliser (vid.stab or deshake)."
  const model = cfg.denoiseModel && fs.existsSync(cfg.denoiseModel)
  const audio = [...(f.has('afftdn') ? (['afftdn'] as const) : []), ...(f.has('arnndn') && model ? (['arnndn'] as const) : [])]
  const video = (['hqdn3d', 'nlmeans'] as const).filter((x) => f.has(x))
  if (!audio.length && !video.length) why.denoise = "This server's ffmpeg has no denoise filters."
  else if (!audio.length) why.denoise = "This server's ffmpeg can't denoise sound (no afftdn); pictures it can."
  else if (!video.length) why.denoise = "This server's ffmpeg can't denoise pictures (no hqdn3d or nlmeans); sound it can."
  const bg = !!cfg.bgRemovalCmd
  if (!bg) why.removeBackground = 'Background removal is not set up on this server: the owner sets BG_REMOVAL_CMD to a removal tool installed there.'
  return { stabilise, denoise: { audio: [...audio], video: [...video] }, removeBackground: { available: bg }, why }
}

export interface SmartInput extends SmartJobRequest {
  assetId: string
  workspaceId: string
}

/** Names the copies get in the media library. */
const SUFFIX: Record<SmartTool, string> = { stabilise: 'stabilised', denoise: 'denoised', removeBackground: 'background removed' }

export async function smartSource(input: SmartInput): Promise<AssetRow> {
  const row = (await ctx().db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId))).limit(1))[0]
  if (!row) throw new HttpError(404, 'not_found', 'This clip is not in the media library')
  if (row.status !== 'ready') throw new HttpError(409, 'conflict', 'This clip is still being processed')
  return row
}

/** The part of the file to process (seconds), inside the file; the whole file when none was asked for. */
export function sourceRange(input: Pick<SmartJobRequest, 'from' | 'to'>, duration: number | undefined): { from: number; length?: number } {
  const from = Math.max(0, Math.min(input.from ?? 0, duration ?? Infinity))
  const to = Math.min(input.to ?? duration ?? Infinity, duration ?? Infinity)
  if (!Number.isFinite(to)) return { from }
  if (to - from < 0.05) throw new HttpError(400, 'invalid', 'The part of the clip to process is too short')
  return { from: Math.round(from * 1000) / 1000, length: Math.round((to - from) * 1000) / 1000 }
}

/** ffmpeg input arguments for that part (an accurate seek: the copy's 0 is `from`). */
export function rangeInput(src: string, r: { from: number; length?: number }, decoder?: string[]): string[] {
  return [...(r.from > 0 ? ['-ss', String(r.from)] : []), ...(r.length ? ['-t', String(r.length)] : []), ...(decoder ?? []), '-i', src]
}

/** The source's transcript moved onto the copy: words inside it, `from` seconds earlier. */
export function shiftTranscript(t: Transcript | undefined, from: number, length?: number): Transcript | undefined {
  if (!t) return undefined
  const end = length === undefined ? Infinity : from + length
  const r = (v: number) => Math.round((v - from) * 1000) / 1000
  const segments = t.segments
    .filter((s) => s.end > from && s.start < end)
    .map((s) => ({ ...s, start: r(Math.max(s.start, from)), end: r(Math.min(s.end, end)), words: s.words.filter((w) => w.start >= from && w.end <= end).map((w) => ({ ...w, start: r(w.start), end: r(w.end) })) }))
  return { ...t, segments }
}

export interface MadeCopy {
  file: string
  mime: string
  kind: 'video' | 'audio'
  /** Seconds into the original at the copy's 0. */
  offset: number
  /** The copy covers this much of the original (for the transcript). */
  length?: number
  ext?: string
}

/**
 * Run a tool: `make` writes the copy in a scratch folder (reporting 0..1), then it is saved as a clip next to the
 * original, processed here (proxy, thumbnails, waveform) and handed back with where it starts in the original.
 */
export async function runSmartTool(
  tool: SmartTool,
  jc: JobContext,
  make: (o: { row: AssetRow; src: string; work: string; progress: (f: number, message: string) => void }) => Promise<MadeCopy>,
  settings?: Record<string, unknown>,
): Promise<SmartJobResult> {
  const input = jc.job.input as unknown as SmartInput
  const row = await smartSource(input)
  const work = tmpDir(`smart-${jc.job.id}`)
  try {
    jc.progress(0.02, 'Reading the clip')
    const src = await localSource(row, work)
    jc.check()
    const made = await make({ row, src, work, progress: (f, m) => jc.progress(0.05 + Math.max(0, Math.min(1, f)) * 0.75, m) })
    jc.check()
    jc.progress(0.82, 'Saving the copy')
    const base = row.name.replace(/\.[a-z0-9]{2,5}$/i, '')
    const created = await createAssetFromFile({
      workspaceId: row.workspaceId,
      userId: jc.job.userId,
      projectId: row.projectId,
      filePath: made.file,
      name: `${base} (${SUFFIX[tool]})${path.extname(made.file)}`,
      mime: made.mime,
      kind: made.kind,
      origin: 'smart',
      meta: {
        jobId: jc.job.id,
        derivedFrom: { assetId: row.id, tool, offset: made.offset, ...(settings ? { settings } : {}) },
        ...(row.meta?.transcript ? { transcript: shiftTranscript(row.meta.transcript, made.offset, made.length) } : {}),
      },
    })
    jc.progress(0.85, 'Preparing the copy for editing')
    const ready = await processAsset(created.id, { signal: jc.signal, check: jc.check, progress: (f, m) => jc.progress(0.85 + Math.max(0, f) * 0.14, m) })
    jc.progress(1, 'Ready')
    return { tool, asset: assetRecord(ready), offset: made.offset, sourceAssetId: row.id }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

/** H.264 at a high quality for picture copies (they replace the original in the export). */
export const VIDEO_OUT = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
