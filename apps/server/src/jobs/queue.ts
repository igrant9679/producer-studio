// Postgres-backed job queue: enqueue, claim (FOR UPDATE SKIP LOCKED), progress, finish, cancel, stale recovery.
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import type { Job, JobKind } from '@producer/core'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { jobDto } from '../dto'
import { newId } from '../ids'
import { ASSET_ERRORS, failAssetOfJob } from '../services/asset-recovery'
import { scrubPaths } from './errors'
import { jobEnded } from '../services/notify'

export type JobRow = typeof jobs.$inferSelect

export function emitJob(j: JobRow) {
  const dto = jobDto(j)
  // results (transcripts, scripts) can be large; other processes reload by id
  ctx().bus.publish(j.workspaceId, 'job', dto, { id: j.id, inline: j.result == null ? dto : undefined })
  // A-8: the person who started it hears about the end by email, if they chose to
  if (j.status === 'done' || j.status === 'error') void jobEnded(j)
}

export async function enqueue(kind: JobKind, input: Record<string, unknown>, meta: { workspaceId: string; userId: string; projectId?: string | null; message?: string }): Promise<JobRow> {
  const now = Date.now()
  const [row] = await ctx()
    .db.insert(jobs)
    .values({
      id: newId('j'),
      kind,
      status: 'queued',
      progress: 0,
      message: meta.message ?? 'Queued',
      input,
      workspaceId: meta.workspaceId,
      userId: meta.userId,
      projectId: meta.projectId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  emitJob(row)
  wakeWorkers()
  return row
}

let wake: (() => void) | undefined
export function onWake(fn: () => void) {
  wake = fn
}
function wakeWorkers() {
  wake?.()
}

/** Atomically claim the oldest queued job (of `kinds`, when given). */
export async function claimNext(workerId: string, kinds?: readonly JobKind[]): Promise<JobRow | null> {
  const now = Date.now()
  const only = kinds ? sql`AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``
  const rows = await ctx()
    .db.update(jobs)
    .set({ status: 'running', lockedBy: workerId, lockedAt: now, updatedAt: now, attempts: sql`${jobs.attempts} + 1`, message: 'Starting' })
    // voice.relay jobs are claimed by the owning desktop over /api/voice/relay/claim, never by a local worker
    .where(eq(jobs.id, sql`(SELECT id FROM jobs WHERE status = 'queued' AND kind <> 'voice.relay' ${only} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`))
    .returning()
  return rows[0] ?? null
}

export async function getJob(id: string): Promise<JobRow | null> {
  return (await ctx().db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0] ?? null
}

/** Running, and (when given) still held by `lockedBy`: a worker that lost its lock writes nothing more. */
const runningBy = (id: string, lockedBy?: string) => and(eq(jobs.id, id), eq(jobs.status, 'running'), lockedBy ? eq(jobs.lockedBy, lockedBy) : undefined)

export async function updateProgress(id: string, progress: number, message?: string, lockedBy?: string): Promise<JobRow | null> {
  const rows = await ctx()
    .db.update(jobs)
    .set({ progress, ...(message !== undefined ? { message } : {}), updatedAt: Date.now(), lockedAt: Date.now() })
    .where(runningBy(id, lockedBy))
    .returning()
  if (rows[0]) emitJob(rows[0])
  return rows[0] ?? null
}

export async function finishJob(id: string, result: unknown, lockedBy?: string): Promise<JobRow | null> {
  const rows = await ctx()
    .db.update(jobs)
    .set({ status: 'done', progress: 1, message: 'Done', result: result as never, updatedAt: Date.now(), lockedBy: null })
    .where(runningBy(id, lockedBy))
    .returning()
  if (rows[0]) emitJob(rows[0])
  return rows[0] ?? null
}

/** End a running job. The error is shown to people, so any file path in it is dropped (callers log the raw text). */
export async function failJob(id: string, error: string, status: 'error' | 'cancelled' = 'error', lockedBy?: string): Promise<JobRow | null> {
  const rows = await ctx()
    .db.update(jobs)
    .set({ status, error: scrubPaths(error).slice(0, 4000), message: status === 'cancelled' ? 'Cancelled' : 'Failed', updatedAt: Date.now(), lockedBy: null })
    .where(runningBy(id, lockedBy))
    .returning()
  if (rows[0]) emitJob(rows[0])
  return rows[0] ?? null
}

/** Cancel: queued jobs end immediately; running ones are flagged and the worker aborts them. */
export async function cancelJob(id: string, error = 'Cancelled by user'): Promise<JobRow | null> {
  const now = Date.now()
  const rows = await ctx()
    .db.update(jobs)
    .set({ status: 'cancelled', cancelRequested: true, message: 'Cancelled', error, updatedAt: now, lockedBy: null })
    .where(and(eq(jobs.id, id), sql`${jobs.status} IN ('queued', 'running')`))
    .returning()
  const row = rows[0] ?? (await getJob(id))
  if (rows[0]) {
    emitJob(rows[0])
    cancelHooks.forEach((h) => h(id, 'cancelled'))
    // a queued asset.process job never runs its own error path: its clip would stay "processing" for good
    await failAssetOfJob(rows[0], ASSET_ERRORS.cancelled)
  }
  return row
}

/** Clip deleted: its processing and transcription jobs (queued or running) stop; nothing is left to work on. */
export async function cancelJobsOfAsset(assetId: string): Promise<void> {
  const open = await ctx()
    .db.select({ id: jobs.id })
    .from(jobs)
    .where(and(sql`${jobs.input}->>'assetId' = ${assetId}`, sql`${jobs.status} IN ('queued', 'running')`, sql`${jobs.kind} IN ('asset.process', 'ai.transcribe')`))
  for (const j of open) await cancelJob(j.id, 'The clip was deleted')
}

/** Job rows were deleted with their workspace: a worker in this process stops them now (others at their next heartbeat). */
export function jobsDeleted(ids: string[]) {
  for (const id of ids) cancelHooks.forEach((h) => h(id, 'gone'))
}

const cancelHooks = new Set<(id: string, why: 'cancelled' | 'gone') => void>()
export function onCancel(fn: (id: string, why: 'cancelled' | 'gone') => void) {
  cancelHooks.add(fn)
  return () => cancelHooks.delete(fn)
}

export const WORKER_GAVE_UP = 'The server running this job stopped responding three times, so it was stopped. Try again.'

/**
 * Requeue one stale running job (or error it after 3 attempts), only if it's still exactly as it was seen: a
 * worker that heartbeat meanwhile keeps its job, and two recoveries never both requeue it.
 */
export async function recoverJob(j: JobRow): Promise<boolean> {
  const giveUp = j.attempts >= 3
  const rows = await ctx()
    .db.update(jobs)
    .set(giveUp ? { status: 'error', error: WORKER_GAVE_UP, message: 'Failed', lockedBy: null, updatedAt: Date.now() } : { status: 'queued', lockedBy: null, lockedAt: null, message: 'Requeued', updatedAt: Date.now() })
    .where(and(eq(jobs.id, j.id), eq(jobs.status, 'running'), sql`${jobs.lockedBy} IS NOT DISTINCT FROM ${j.lockedBy}`, sql`${jobs.lockedAt} IS NOT DISTINCT FROM ${j.lockedAt}`))
    .returning()
  if (!rows[0]) return false
  emitJob(rows[0])
  // giving up on the job must not leave its clip "processing" forever
  if (giveUp) await failAssetOfJob(rows[0], ASSET_ERRORS.workerGaveUp)
  return true
}

/** This worker is shutting down (a deploy): its running jobs go back in the queue, and the run doesn't count as an attempt. */
export async function requeueForShutdown(ids: string[], workerId: string): Promise<number> {
  if (!ids.length) return 0
  const rows = await ctx()
    .db.update(jobs)
    .set({ status: 'queued', lockedBy: null, lockedAt: null, progress: 0, attempts: sql`greatest(${jobs.attempts} - 1, 0)`, message: 'Requeued: the server is restarting', updatedAt: Date.now() })
    .where(and(inArray(jobs.id, ids), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
    .returning()
  rows.forEach(emitJob)
  return rows.length
}

/**
 * Requeue running jobs whose worker stopped heartbeating (or error them after 3 attempts). Not relayed voices: a
 * desktop holds those on its own lease (recoverRelays in routes/voice.ts).
 */
export async function recoverStale(staleMs: number, exceptWorker?: string): Promise<number> {
  const cutoff = Date.now() - staleMs
  const stale = await ctx()
    .db.select()
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), ne(jobs.kind, 'voice.relay'), lt(jobs.lockedAt, cutoff)))
  let n = 0
  for (const j of stale) {
    if (exceptWorker && j.lockedBy === exceptWorker) continue
    if (await recoverJob(j)) n++
  }
  return n
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const j = await getJob(id)
  return !j || j.cancelRequested || j.status === 'cancelled'
}

export type { Job }
