// Worker loop: claims jobs up to WORKER_CONCURRENCY (plus QUICK_JOB_CONCURRENCY slots for quick jobs), runs handlers with an AbortSignal (cancellation kills
// child processes), heartbeats, recovers stale locks, pushes throttled progress over the event bus. Every job
// ends: one that runs past its kind's time limit or goes quiet for too long is stopped with a reason, and one that
// another worker took over, or whose rows were deleted, is dropped here.
import { and, eq, inArray } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { ctx } from '../context'
import { assets, jobs, workspaces } from '../db/schema'
import { log } from '../log'
import { failAssetOfJob, reconcileAssets } from '../services/asset-recovery'
import { recoverRelays } from '../routes/voice'
import { assetPrefix, sweepTempDirs } from '../services/assets'
import { pruneOldRows } from '../services/retention'
import { publicJobError } from './errors'
import { type JobRow, cancelJob, claimNext, failJob, finishJob, onCancel, onWake, recoverStale, requeueForShutdown, updateProgress } from './queue'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export interface JobContext {
  /** `lockedBy`: the worker holding a claimed job (absent inline): a handler finishing the job itself must still hold it. */
  job: Pick<JobRow, 'id' | 'kind' | 'workspaceId' | 'userId' | 'projectId' | 'input'> & { lockedBy?: string | null }
  signal: AbortSignal
  /** Report progress 0..1 (or -1 indeterminate) with an optional message; throttled. */
  progress(p: number, message?: string): void
  /** Throw CancelledError if the job was cancelled. Call between steps. */
  check(): void
}

export type Handler = (jc: JobContext) => Promise<unknown>
const handlers = new Map<JobKind, Handler>()

export function registerHandler(kind: JobKind, h: Handler) {
  handlers.set(kind, h)
}

/** Map a child step's 0..1 progress into [from, to] of the parent. */
export function subContext(jc: JobContext, from: number, to: number, prefix?: string): JobContext {
  return {
    ...jc,
    progress: (p, m) => jc.progress(p < 0 ? -1 : from + (to - from) * Math.max(0, Math.min(1, p)), m !== undefined && prefix ? `${prefix}: ${m}` : m),
  }
}

/** A context for running handler logic inline (e.g. from a route or test) without a queued job. */
export function inlineContext(job: JobContext['job'], signal: AbortSignal = new AbortController().signal): JobContext {
  return {
    job,
    signal,
    progress: () => undefined,
    check: () => {
      if (signal.aborted) throw new CancelledError()
    },
  }
}

/** Why the worker stopped a job from outside its handler (the abort reason on its signal). */
export type StopReason =
  | { kind: 'cancelled' }
  /** Ran past its time limit, or reported no progress for too long: ends as an error with `message`. */
  | { kind: 'limit'; message: string }
  /** Stale recovery gave it to another worker: that worker finishes it, this one writes nothing. */
  | { kind: 'lost' }
  /** Its job row is gone (the workspace was deleted): nothing left to report to. */
  | { kind: 'gone' }
  /** This server is shutting down (a deploy): the job is back in the queue and runs again after the restart. */
  | { kind: 'shutdown' }

export function stopReason(signal: AbortSignal): StopReason | undefined {
  const r = signal.aborted ? (signal.reason as StopReason | undefined) : undefined
  return r && typeof r === 'object' && 'kind' in r ? r : signal.aborted ? { kind: 'cancelled' } : undefined
}

/** The worker's reason for stopping this job when it ran too long (shown on the job and its clip), if that's why. */
export function limitMessage(signal: AbortSignal): string | undefined {
  const r = stopReason(signal)
  return r?.kind === 'limit' ? r.message : undefined
}

const WHAT: Partial<Record<JobKind, string>> = {
  'export.render': 'The export',
  'asset.process': 'Processing this clip',
  'ai.transcribe': 'The transcription',
  'ai.tts': 'The voiceover',
  'ai.produce.script': 'Producer AI',
  'ai.produce.assemble': 'Producer AI',
  'voicestudio.install': 'Installing VoiceStudio',
  'media.scenes': 'Finding scene changes',
  'media.stabilise': 'Stabilising',
  'media.denoise': 'Denoising',
  'media.bgremove': 'Removing the background',
}

/** Short jobs people wait on in the editor: they get slots long exports can't take (QUICK_JOB_CONCURRENCY). */
export const QUICK_KINDS: readonly JobKind[] = ['asset.process', 'ai.transcribe', 'ai.tts', 'media.scenes']

/** The longest a job of this kind may run: renders long, processing medium, voice short. */
export function maxRunMs(kind: string): number {
  const l = ctx().config.jobLimits
  if (kind === 'export.render' || kind === 'ai.produce.assemble' || kind === 'voicestudio.install') return l.renderMs
  if (kind === 'ai.tts') return l.voiceMs
  return l.processingMs
}

const span = (ms: number) => (ms >= 120 * 60_000 && ms % 3600_000 === 0 ? `${ms / 3600_000} hours` : ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`)

/** After a stop, how long the handler gets to wind down (its processes get SIGTERM, then SIGKILL at 3 s) before its slot is freed anyway. */
const STOP_GRACE_MS = 10_000

interface Running {
  ac: AbortController
  job: JobRow
  startedAt: number
  /** Last progress report: the no-progress watchdog's clock. */
  lastProgress: number
}

const running = new Map<string, Running>()
const inflight = new Set<Promise<void>>()
let started = false
let wakeNow: () => void = () => undefined
let graceMs = STOP_GRACE_MS

export function runningJobIds() {
  return [...running.keys()]
}

function stop(id: string, reason: StopReason) {
  const r = running.get(id)
  if (r && !r.ac.signal.aborted) r.ac.abort(reason)
}

function makeContext(entry: Running, workerId: string): JobContext {
  const { job, ac } = entry
  let last = 0
  let pending: { p: number; m?: string } | undefined
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    timer = undefined
    if (!pending) return
    const { p, m } = pending
    pending = undefined
    last = Date.now()
    void updateProgress(job.id, p, m, workerId).catch((err) => log.warn('progress update failed', { err, jobId: job.id }))
  }
  return {
    job,
    signal: ac.signal,
    progress(p, m) {
      entry.lastProgress = Date.now()
      pending = { p: Math.round(p * 1000) / 1000, m: m ?? pending?.m }
      const wait = 300 - (Date.now() - last)
      if (wait <= 0) flush()
      else if (!timer) timer = setTimeout(flush, wait)
    },
    check() {
      if (ac.signal.aborted) throw new CancelledError()
    },
  }
}

/** The handler's outcome; or, once the job is stopped, CancelledError after the grace period if the handler hangs on. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let t: NodeJS.Timeout | undefined
    const onAbort = () => {
      t = setTimeout(() => reject(new CancelledError()), graceMs)
      t.unref()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function runJob(job: JobRow, workerId: string) {
  const entry: Running = { ac: new AbortController(), job, startedAt: Date.now(), lastProgress: Date.now() }
  const { ac } = entry
  running.set(job.id, entry)
  log.info('job start', { jobId: job.id, kind: job.kind })
  const limit = maxRunMs(job.kind)
  const what = WHAT[job.kind as JobKind] ?? 'This job'
  const limitTimer = setTimeout(() => stop(job.id, { kind: 'limit', message: `${what} ran longer than its ${span(limit)} limit and was stopped. Try again.` }), limit)
  limitTimer.unref()
  const h = handlers.get(job.kind as JobKind)
  let work: Promise<unknown> = Promise.resolve()
  let settled = false
  let outcome: StopReason['kind'] | 'done' | 'error' = 'error'
  try {
    if (!h) throw new Error(`No handler for job kind ${job.kind}`)
    const jc = makeContext(entry, workerId)
    work = Promise.resolve().then(() => h(jc))
    void work.then(
      () => (settled = true),
      () => (settled = true),
    )
    const result = await untilStopped(work, ac.signal)
    jc.check()
    await finishJob(job.id, result ?? null, workerId)
    outcome = 'done'
    log.info('job done', { jobId: job.id, kind: job.kind, ms: Date.now() - entry.startedAt })
  } catch (err) {
    const why = ac.signal.aborted ? stopReason(ac.signal) : err instanceof CancelledError ? ({ kind: 'cancelled' } as const) : undefined
    outcome = why?.kind ?? 'error'
    if (why?.kind === 'shutdown') log.info('job requeued for after the restart', { jobId: job.id, kind: job.kind })
    else if (why?.kind === 'lost') log.warn('job taken over by another worker; dropped here', { jobId: job.id, kind: job.kind })
    else if (why?.kind === 'gone') log.info('job dropped: its rows were deleted', { jobId: job.id, kind: job.kind })
    else if (why?.kind === 'limit') {
      log.warn('job stopped', { jobId: job.id, kind: job.kind, reason: why.message })
      await failJob(job.id, why.message, 'error', workerId).catch(() => undefined)
      // the clips it was making will never finish either
      await failAssetOfJob(job, why.message)
    } else if (why?.kind === 'cancelled') await failJob(job.id, 'Cancelled', 'cancelled', workerId).catch(() => undefined)
    else {
      // the raw error (paths, ffprobe output) stays in the log; people get a sentence without them
      log.error('job failed', { jobId: job.id, kind: job.kind, err })
      await failJob(job.id, publicJobError(job.kind, err), 'error', workerId).catch(() => undefined)
    }
  } finally {
    clearTimeout(limitTimer)
    running.delete(job.id)
    wakeNow()
    // a job stopped because its clip or space was deleted may have written files since: sweep now, and again when
    // a handler that outlived the grace period finally ends
    if (outcome !== 'done' && outcome !== 'shutdown' && outcome !== 'lost') {
      const sweep = () => void sweepOrphans(job).catch((err) => log.warn('sweeping storage of a deleted clip or space failed', { err, jobId: job.id }))
      if (settled) sweep()
      else {
        sweep()
        void work.then(sweep, sweep)
      }
    }
  }
}

/** Delete what a job left in storage for a workspace or clip that no longer exists. */
export async function sweepOrphans(job: Pick<JobRow, 'id' | 'workspaceId' | 'input'>) {
  const db = ctx().db
  const s = ctx().storage
  const jobRow = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id)).limit(1)
  const ws = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, job.workspaceId)).limit(1)
  // the space was deleted (its jobs go with it)
  if (!ws.length && !jobRow.length) return s.deletePrefix(`ws/${job.workspaceId}/`)
  const assetId = (job.input as { assetId?: unknown } | null)?.assetId
  if (typeof assetId === 'string' && /^[\w-]+$/.test(assetId) && !(await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).limit(1)).length)
    await s.deletePrefix(`${assetPrefix(job.workspaceId, assetId)}/`)
}

/** Heartbeat our jobs, and drop the ones that were cancelled, taken over by another worker, or deleted. */
async function heartbeat(workerId: string) {
  const now = Date.now()
  const stallMs = ctx().config.jobLimits.stallMs
  for (const [id, r] of running) {
    if (now - r.lastProgress > stallMs) {
      const what = WHAT[r.job.kind as JobKind] ?? 'This job'
      stop(id, { kind: 'limit', message: `${what} made no progress for ${span(stallMs)} and was stopped. Try again.` })
    }
  }
  const ids = runningJobIds()
  if (!ids.length) return
  await ctx().db.update(jobs).set({ lockedAt: now }).where(and(inArray(jobs.id, ids), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
  const rows = await ctx().db.select({ id: jobs.id, status: jobs.status, cancel: jobs.cancelRequested, lockedBy: jobs.lockedBy }).from(jobs).where(inArray(jobs.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) stop(id, { kind: 'gone' })
    else if (r.cancel || r.status === 'cancelled') stop(id, { kind: 'cancelled' })
    else if (r.status !== 'running' || r.lockedBy !== workerId) stop(id, { kind: 'lost' })
  }
  // a clip deleted some other way (a desktop applying a delete from the cloud) stops its processing too
  const clipOf = new Map<string, string>()
  for (const [id, r] of running) {
    const assetId = (r.job.input as { assetId?: unknown } | null)?.assetId
    if ((r.job.kind === 'asset.process' || r.job.kind === 'ai.transcribe') && typeof assetId === 'string' && !r.ac.signal.aborted) clipOf.set(id, assetId)
  }
  if (!clipOf.size) return
  const present = new Set((await ctx().db.select({ id: assets.id }).from(assets).where(inArray(assets.id, [...new Set(clipOf.values())]))).map((a) => a.id))
  for (const [id, assetId] of clipOf) if (!present.has(assetId)) await cancelJob(id, 'The clip was deleted')
}

/**
 * Which jobs this worker may claim now. `concurrency` slots take any job; `quick` more take only quick ones, which
 * also use a free shared slot first. Two long exports can't hold up processing for every new upload.
 */
export function claimable(jobsNow: Iterable<{ kind: string }>, concurrency: number, quick: number): 'any' | 'quick' | 'none' {
  let nQuick = 0
  let nLong = 0
  for (const j of jobsNow) QUICK_KINDS.includes(j.kind as JobKind) ? nQuick++ : nLong++
  if (nLong + Math.max(0, nQuick - quick) < concurrency) return 'any'
  return nLong + nQuick < concurrency + quick ? 'quick' : 'none'
}

export function startWorker(opts: { concurrency: number; quickConcurrency?: number; heartbeatMs?: number; graceMs?: number }) {
  if (started) return
  started = true
  // this start's own flag: a loop from an earlier start still sleeping must not carry on after a restart
  const life = { stopped: false }
  graceMs = opts.graceMs ?? STOP_GRACE_MS
  const quick = opts.quickConcurrency ?? ctx().config.quickJobConcurrency
  const workerId = ctx().instanceId
  let wakeResolve: (() => void) | undefined
  wakeNow = () => wakeResolve?.()
  onWake(() => wakeResolve?.())
  const offCancel = onCancel((id, why) => stop(id, { kind: why }))

  const loop = async () => {
    if (ctx().database.driver === 'pglite') await recoverStale(0).catch(() => 0) // single process: anything "running" is from a previous run
    while (!life.stopped) {
      try {
        while (!life.stopped) {
          const room = claimable([...running.values()].map((r) => r.job), opts.concurrency, quick)
          if (room === 'none') break
          const job = await claimNext(workerId, room === 'quick' ? QUICK_KINDS : undefined)
          if (!job) break
          const p = runJob(job, workerId)
          inflight.add(p)
          void p.finally(() => inflight.delete(p))
        }
      } catch (err) {
        log.error('claim failed', { err })
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000)
        wakeResolve = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wakeResolve = undefined
    }
  }
  void loop()

  // heartbeat, the no-progress watchdog and cross-process cancellation
  const hb = setInterval(() => void heartbeat(workerId).catch((err) => log.warn('heartbeat failed', { err })), opts.heartbeatMs ?? 5000)
  const rec = setInterval(() => {
    void recoverStale(90_000, workerId).catch(() => 0)
    // relayed voices: a desktop gone mid-voice, or one that never picked the request up
    void recoverRelays().catch((err) => log.warn('relay recovery failed', { err }))
  }, 30_000)
  // clips that can no longer finish (abandoned uploads, dead or cancelled processing) are marked failed
  const sweep = () => void reconcileAssets().catch((err) => log.warn('asset reconcile failed', { err }))
  const first = setTimeout(sweep, 30_000)
  const recon = setInterval(sweep, 5 * 60_000)
  // temp and render folders a crash left behind (now, and hourly)
  const sweepTmp = () =>
    void sweepTempDirs()
      .then((n) => n && log.info('removed leftover temp folders', { n }))
      .catch((err) => log.warn('temp folder sweep failed', { err }))
  sweepTmp()
  const tmpSweeps = setInterval(sweepTmp, 3600_000)
  tmpSweeps.unref()
  // expired sessions, old finished jobs and spent invites
  const prune = () => void pruneOldRows().catch((err) => log.warn('pruning old rows failed', { err }))
  const firstPrune = setTimeout(prune, 3 * 60_000)
  const pruning = setInterval(prune, 6 * 3600_000)
  hb.unref()
  rec.unref()
  first.unref()
  recon.unref()
  firstPrune.unref()
  pruning.unref()
  stopWorkerFn = async () => {
    life.stopped = true
    wakeResolve?.()
    offCancel()
    clearInterval(hb)
    clearInterval(rec)
    clearTimeout(first)
    clearInterval(recon)
    clearInterval(tmpSweeps)
    clearTimeout(firstPrune)
    clearInterval(pruning)
    // a deploy is not a failed attempt: the jobs go back in the queue first, then their processes are stopped
    const ids = runningJobIds()
    await requeueForShutdown(ids, workerId).catch((err) => log.warn('requeue on shutdown failed', { err }))
    for (const id of ids) stop(id, { kind: 'shutdown' })
    // a moment for handlers to wind down (a clip put back to processing) before the database closes
    await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 2000).unref())])
  }
  log.info('worker started', { workerId, concurrency: opts.concurrency, quick })
}

let stopWorkerFn: (() => Promise<void>) | undefined
/** Stop claiming, requeue this worker's running jobs without counting an attempt, and stop them. */
export async function stopWorker() {
  const fn = stopWorkerFn
  stopWorkerFn = undefined
  started = false
  await fn?.()
}
