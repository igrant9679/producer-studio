// Clips that can no longer finish are told so instead of "processing" forever. (Added 23 Oct 2026.)
//
// "Processing" in the media panel was hiding three different dead ends, none of which ever reached the asset row:
//  1. The browser's PUT to the bucket was refused (or the tab closed): the row stays `uploading` for good.
//  2. The asset.process job kept dying (an out-of-memory proxy encode restarts the worker) and stale recovery
//     gave up on the JOB after three attempts without touching the asset.
//  3. The job was cancelled while still queued, so processAsset never ran its own error path.
// Each is now an asset `error` with a sentence a person can act on; the editor offers Retry and Remove.
//
// Only hard evidence fails a clip. Voiceovers and renders are created `processing` inside other jobs and a long
// proxy encode is legitimately quiet, so there is no "quiet for N minutes" rule: an upload whose one-hour ticket
// has long expired, a processing clip whose latest asset.process job has ended after the clip last changed, or a
// clip made inside another job (its `meta.jobId`: Producer AI voices and visuals, voiceovers) once that job ended.
// A job that hangs instead of ending is the worker's to stop (a time limit per kind and a no-progress watchdog,
// jobs/worker.ts); it then fails its clips with the reason.
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { ctx } from '../context'
import { assets, jobs } from '../db/schema'
import { log } from '../log'
import { friendlyProcessingError } from '../media/process'
import { emitAsset } from './assets'

/** The PUT ticket is valid for an hour; give the browser another hour before calling it abandoned. */
export const UPLOAD_ABANDONED_MS = 2 * 3600_000

export const ASSET_ERRORS = {
  uploadAbandoned: "The upload didn't finish — the file never reached storage. Upload it again.",
  workerGaveUp:
    "Processing kept stopping before it finished — the file may be too large, or in a format the server can't convert. Retry, or convert it to MP4 and upload it again.",
  cancelled: 'Processing was cancelled before it finished. Retry to process it again.',
  endedWithoutResult: 'Processing ended without finishing this clip. Retry to process it again.',
  neverStarted: 'Processing never started. Retry to process it again.',
}

/** Set an asset to error only if it is still in one of `from` (never overwrite a clip that finished). */
export async function failAsset(id: string, from: Array<'uploading' | 'processing' | 'error'>, error: string): Promise<boolean> {
  const [row] = await ctx()
    .db.update(assets)
    .set({ status: 'error', error: error.slice(0, 500), updatedAt: Date.now() })
    .where(and(eq(assets.id, id), inArray(assets.status, from)))
    .returning()
  if (row) emitAsset(row)
  return Boolean(row)
}

/** A clip whose processing was interrupted by a restart (its job is queued again) is processing, not failed. */
export async function reopenAsset(id: string): Promise<boolean> {
  const [row] = await ctx()
    .db.update(assets)
    .set({ status: 'processing', error: null, updatedAt: Date.now() })
    .where(and(eq(assets.id, id), eq(assets.status, 'error')))
    .returning()
  if (row) emitAsset(row)
  return Boolean(row)
}

const parentJobOf = sql<string | null>`${assets.meta}->>'jobId'`

/** A job that will never run again: if it was processing a clip (or still making some, as a parent job), they failed too. */
export async function failAssetOfJob(job: { id: string; kind: string; input: unknown }, error: string): Promise<void> {
  if (job.kind !== 'asset.process') {
    const made = await ctx()
      .db.select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.status, 'processing'), eq(parentJobOf, job.id)))
      .catch((err) => (log.warn('could not find the clips of a job', { jobId: job.id, err }), []))
    for (const a of made) await failAsset(a.id, ['processing'], error).catch((err) => log.warn('could not mark asset failed', { assetId: a.id, err }))
    return
  }
  const assetId = (job.input as { assetId?: unknown } | null)?.assetId
  if (typeof assetId !== 'string') return
  await failAsset(assetId, ['processing'], error).catch((err) => log.warn('could not mark asset failed', { assetId, err }))
}

/** The browser says its upload to storage failed. */
export async function abortUpload(id: string, reason: string): Promise<boolean> {
  const why = reason.trim().replace(/\s+/g, ' ').slice(0, 300)
  return failAsset(id, ['uploading'], `Upload failed${why ? `: ${why}` : ''}. Upload the file again.`)
}

/** One sweep over clips that can no longer finish. Returns how many were marked failed. */
export async function reconcileAssets(now = Date.now()): Promise<number> {
  const db = ctx().db
  let n = 0

  const abandoned = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.status, 'uploading'), lt(assets.updatedAt, now - UPLOAD_ABANDONED_MS)))
    .limit(200)
  for (const a of abandoned) if (await failAsset(a.id, ['uploading'], ASSET_ERRORS.uploadAbandoned)) n++

  // a minute of grace covers the gap between the complete route marking a clip processing and enqueueing its job
  const processing = await db
    .select({ id: assets.id, origin: assets.origin, updatedAt: assets.updatedAt, parentJob: parentJobOf })
    .from(assets)
    .where(and(eq(assets.status, 'processing'), lt(assets.updatedAt, now - 60_000)))
    .limit(500)
  if (!processing.length) return n
  const assetIdOf = sql<string>`${jobs.input}->>'assetId'`
  const rows = await db
    .select({ assetId: assetIdOf, status: jobs.status, error: jobs.error, createdAt: jobs.createdAt, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(and(eq(jobs.kind, 'asset.process'), inArray(assetIdOf, processing.map((a) => a.id))))
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const cur = latest.get(r.assetId)
    if (!cur || r.createdAt > cur.createdAt) latest.set(r.assetId, r)
  }
  // voiceovers and Producer AI visuals are processed inside the job that made them (recorded on the clip)
  const parentIds = [...new Set(processing.filter((a) => a.parentJob && !latest.has(a.id)).map((a) => a.parentJob!))]
  const parents = new Map(
    (parentIds.length ? await db.select({ id: jobs.id, status: jobs.status, updatedAt: jobs.updatedAt }).from(jobs).where(inArray(jobs.id, parentIds)) : []).map((j) => [j.id, j]),
  )
  for (const a of processing) {
    const job = latest.get(a.id)
    if (!job && a.parentJob) {
      const parent = parents.get(a.parentJob)
      if (parent && (parent.status === 'queued' || parent.status === 'running')) continue
      // the clip changed after its job ended: a retry is on its way
      if (parent && a.updatedAt > parent.updatedAt) continue
      // the job ended (or is long gone) without finishing this clip: a crash mid-voice, say
      if (await failAsset(a.id, ['processing'], parent?.status === 'cancelled' ? ASSET_ERRORS.cancelled : ASSET_ERRORS.endedWithoutResult)) n++
      continue
    }
    if (!job) {
      // uploads always get an asset.process job; voiceovers and renders are processed inside their own job
      if (a.origin === 'upload' && a.updatedAt < now - 30 * 60_000 && (await failAsset(a.id, ['processing'], ASSET_ERRORS.neverStarted))) n++
      continue
    }
    if (job.status === 'queued' || job.status === 'running') continue
    // the clip changed after this job ended: a retry is on its way
    if (a.updatedAt > job.updatedAt) continue
    const error = job.status === 'cancelled' ? ASSET_ERRORS.cancelled : job.status === 'error' && job.error ? friendlyProcessingError(new Error(job.error)) : ASSET_ERRORS.endedWithoutResult
    if (await failAsset(a.id, ['processing'], error)) n++
  }
  if (n) log.info('reconciled stuck assets', { failed: n })
  return n
}
