// Worker loop: claims jobs up to WORKER_CONCURRENCY, runs handlers with an AbortSignal (cancellation kills
// child processes), heartbeats, recovers stale locks, pushes throttled progress over the event bus.
import { and, eq, inArray } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { log } from '../log'
import { type JobRow, claimNext, failJob, finishJob, onCancel, onWake, recoverStale, updateProgress } from './queue'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export interface JobContext {
  job: Pick<JobRow, 'id' | 'kind' | 'workspaceId' | 'userId' | 'projectId' | 'input'>
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

const running = new Map<string, AbortController>()
let stopped = false
let started = false
let wakeNow: () => void = () => undefined

export function runningJobIds() {
  return [...running.keys()]
}

function makeContext(job: JobRow, ac: AbortController): JobContext {
  let last = 0
  let pending: { p: number; m?: string } | undefined
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    timer = undefined
    if (!pending) return
    const { p, m } = pending
    pending = undefined
    last = Date.now()
    void updateProgress(job.id, p, m).catch((err) => log.warn('progress update failed', { err, jobId: job.id }))
  }
  return {
    job,
    signal: ac.signal,
    progress(p, m) {
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

async function runJob(job: JobRow) {
  const ac = new AbortController()
  running.set(job.id, ac)
  const started = Date.now()
  log.info('job start', { jobId: job.id, kind: job.kind })
  const h = handlers.get(job.kind as JobKind)
  try {
    if (!h) throw new Error(`No handler for job kind ${job.kind}`)
    const jc = makeContext(job, ac)
    const result = await h(jc)
    jc.check()
    await finishJob(job.id, result ?? null)
    log.info('job done', { jobId: job.id, kind: job.kind, ms: Date.now() - started })
  } catch (err) {
    const cancelled = ac.signal.aborted || err instanceof CancelledError
    const message = err instanceof Error ? err.message : String(err)
    if (!cancelled) log.error('job failed', { jobId: job.id, kind: job.kind, err })
    await failJob(job.id, cancelled ? 'Cancelled' : message, cancelled ? 'cancelled' : 'error').catch(() => undefined)
  } finally {
    running.delete(job.id)
    wakeNow()
  }
}

export function startWorker(opts: { concurrency: number }) {
  if (started) return
  started = true
  stopped = false
  const workerId = ctx().instanceId
  let wakeResolve: (() => void) | undefined
  wakeNow = () => wakeResolve?.()
  onWake(() => wakeResolve?.())
  onCancel((id) => running.get(id)?.abort())

  const loop = async () => {
    if (ctx().database.driver === 'pglite') await recoverStale(0).catch(() => 0) // single process: anything "running" is from a previous run
    while (!stopped) {
      try {
        while (running.size < opts.concurrency && !stopped) {
          const job = await claimNext(workerId)
          if (!job) break
          void runJob(job)
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

  // heartbeat + cross-process cancellation
  const hb = setInterval(async () => {
    const ids = runningJobIds()
    if (!ids.length) return
    try {
      await ctx().db.update(jobs).set({ lockedAt: Date.now() }).where(and(inArray(jobs.id, ids), eq(jobs.status, 'running')))
      const rows = await ctx().db.select({ id: jobs.id, status: jobs.status, cancel: jobs.cancelRequested }).from(jobs).where(inArray(jobs.id, ids))
      for (const r of rows) if (r.cancel || r.status === 'cancelled') running.get(r.id)?.abort()
    } catch (err) {
      log.warn('heartbeat failed', { err })
    }
  }, 5000)
  const rec = setInterval(() => void recoverStale(90_000, workerId).catch(() => 0), 30_000)
  hb.unref()
  rec.unref()
  stopWorkerFn = () => {
    stopped = true
    clearInterval(hb)
    clearInterval(rec)
    for (const ac of running.values()) ac.abort()
  }
  log.info('worker started', { workerId, concurrency: opts.concurrency })
}

let stopWorkerFn: (() => void) | undefined
export function stopWorker() {
  stopWorkerFn?.()
  started = false
}
