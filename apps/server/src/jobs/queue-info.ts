// Queue visibility (A-9): for a space's queued jobs, their place in line, an estimated wait and why they wait. The
// claim order is replayed: the worker slots (WORKER_CONCURRENCY shared + QUICK_JOB_CONCURRENCY quick-only, per worker
// seen running jobs), the jobs running now, and the fair-share rule of claimNext (fewest running in the lane, then the
// oldest). Durations are each kind's average run time over the last week (job.ms / job.runs in usage_daily); a wait
// that depends on a kind with no history is "unknown".
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import type { JobKind, QueueInfo, QueueReason } from '@producer/core'
import { ctx } from '../context'
import { jobs, usageDaily } from '../db/schema'
import { DAY_MS, utcDay } from '../services/metering'
import { QUICK_KINDS } from './worker'

/** At most this many queued jobs are replayed (past it, places in line are still counted; waits are unknown). */
const MAX_SIM = 2000
/** Orders the replay when a kind has no history (any wait that depends on it is then unknown). */
const GUESS_MS = 5 * 60_000

/** Average run time per job kind over the last 7 days, from metering. */
export async function recentDurations(now = Date.now()): Promise<Map<string, number>> {
  const rows = await ctx()
    .db.select({ kind: usageDaily.subject, metric: usageDaily.metric, n: sql<number>`sum(${usageDaily.amount})` })
    .from(usageDaily)
    .where(and(inArray(usageDaily.metric, ['job.ms', 'job.runs']), gte(usageDaily.day, utcDay(now - 7 * DAY_MS))))
    .groupBy(usageDaily.subject, usageDaily.metric)
  const ms = new Map<string, number>()
  const runs = new Map<string, number>()
  for (const r of rows) (r.metric === 'job.ms' ? ms : runs).set(r.kind, Number(r.n))
  const out = new Map<string, number>()
  for (const [k, total] of ms) if ((runs.get(k) ?? 0) > 0) out.set(k, total / runs.get(k)!)
  return out
}

const isQuick = (kind: string) => QUICK_KINDS.includes(kind as JobKind)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export interface Replayed {
  /** 1 = the next job any worker claims. */
  position: number
  /** ms from now until it starts; null = depends on a kind with no history. */
  startMs: number | null
  /** A younger job of another space was claimed before it (fair share). */
  passedOver: boolean
}

/**
 * Replay the claim order (pure, for tests). `running`: what runs now and for how long; `queued`: oldest first; the
 * slots per worker; the average durations by kind.
 */
export function replayQueue(input: {
  running: Array<{ kind: string; workspaceId: string; elapsedMs: number }>
  queued: Array<{ id: string; kind: string; workspaceId: string }>
  workers: number
  concurrency: number
  quick: number
  durations: Map<string, number>
}): Map<string, Replayed> {
  const dur = (kind: string) => input.durations.get(kind)
  const slots: Array<{ quickOnly: boolean; freeAt: number; known: boolean; used: boolean }> = []
  for (let w = 0; w < Math.max(1, input.workers); w++) {
    for (let i = 0; i < input.concurrency; i++) slots.push({ quickOnly: false, freeAt: 0, known: true, used: false })
    for (let i = 0; i < input.quick; i++) slots.push({ quickOnly: true, freeAt: 0, known: true, used: false })
  }
  // running jobs per space, as claimNext counts them: all of them for a shared slot, quick ones for a quick slot
  const busy = { any: new Map<string, number>(), quick: new Map<string, number>() }
  const ends: Array<{ at: number; ws: string; quick: boolean }> = []
  const start = (ws: string, quick: boolean, at: number) => {
    busy.any.set(ws, (busy.any.get(ws) ?? 0) + 1)
    if (quick) busy.quick.set(ws, (busy.quick.get(ws) ?? 0) + 1)
    ends.push({ at, ws, quick })
  }
  for (const r of input.running) {
    const q = isQuick(r.kind)
    // quick jobs fill quick slots first, like the worker's claimable()
    const slot = slots.find((s) => !s.used && (q ? s.quickOnly : !s.quickOnly)) ?? slots.find((s) => !s.used && !s.quickOnly)
    const d = dur(r.kind)
    // an overdue job is expected to need a little longer, not to be done already
    const left = Math.max((d ?? GUESS_MS) - r.elapsedMs, (d ?? GUESS_MS) * 0.1)
    start(r.workspaceId, q, left)
    if (slot) Object.assign(slot, { used: true, freeAt: left, known: d !== undefined })
  }
  const out = new Map<string, Replayed>()
  const passed = new Set<string>()
  const pending = input.queued.slice(0, MAX_SIM)
  let position = 0
  while (pending.length) {
    let slot = slots[0]
    for (const s of slots) if (s.freeAt < slot.freeAt) slot = s
    if (!slot || slot.freeAt === Infinity) break
    const now = slot.freeAt
    for (let i = ends.length - 1; i >= 0; i--)
      if (ends[i].at <= now) {
        const e = ends.splice(i, 1)[0]
        busy.any.set(e.ws, (busy.any.get(e.ws) ?? 1) - 1)
        if (e.quick) busy.quick.set(e.ws, (busy.quick.get(e.ws) ?? 1) - 1)
      }
    const counts = slot.quickOnly ? busy.quick : busy.any
    let pick = -1
    for (let i = 0; i < pending.length; i++) {
      if (slot.quickOnly && !isQuick(pending[i].kind)) continue
      if (pick < 0 || (counts.get(pending[i].workspaceId) ?? 0) < (counts.get(pending[pick].workspaceId) ?? 0)) pick = i
    }
    if (pick < 0) {
      // a quick-only slot with nothing quick waiting stays idle
      slot.freeAt = Infinity
      continue
    }
    const j = pending.splice(pick, 1)[0]
    for (let i = 0; i < pick; i++) if (pending[i].workspaceId !== j.workspaceId) passed.add(pending[i].id)
    out.set(j.id, { position: ++position, startMs: slot.known ? now : null, passedOver: false })
    const d = dur(j.kind)
    slot.freeAt = now + (d ?? GUESS_MS)
    slot.known = slot.known && d !== undefined
    start(j.workspaceId, isQuick(j.kind), slot.freeAt)
  }
  for (const id of passed) {
    const r = out.get(id)
    if (r) r.passedOver = true
  }
  // past the replay cap, or nothing left that can run them: their place in line, wait unknown
  for (const j of input.queued) if (!out.has(j.id)) out.set(j.id, { position: ++position, startMs: null, passedOver: passed.has(j.id) })
  return out
}

/** Queue info for a space's queued jobs. */
export async function describeQueue(workspaceId: string, now = Date.now()): Promise<Record<string, QueueInfo>> {
  const db = ctx().db
  const mine = await db.select({ id: jobs.id, kind: jobs.kind }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, 'queued')))
  const out: Record<string, QueueInfo> = {}
  for (const j of mine) if (j.kind === 'voice.relay') out[j.id] = { position: 1, waitMs: null, reason: 'desktop', detail: 'Waiting for the desktop that holds this voice to pick it up' }
  if (mine.every((j) => j.kind === 'voice.relay')) return out
  const queued = await db
    .select({ id: jobs.id, kind: jobs.kind, workspaceId: jobs.workspaceId })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), ne(jobs.kind, 'voice.relay')))
    .orderBy(jobs.createdAt, jobs.id)
  const running = await db
    .select({ kind: jobs.kind, workspaceId: jobs.workspaceId, lockedBy: jobs.lockedBy, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), ne(jobs.kind, 'voice.relay')))
  const cfg = ctx().config
  const workers = Math.max(1, new Set(running.map((r) => r.lockedBy).filter(Boolean)).size)
  const sim = replayQueue({
    running: running.map((r) => ({ kind: r.kind, workspaceId: r.workspaceId, elapsedMs: Math.max(0, now - (r.startedAt ?? r.createdAt)) })),
    queued,
    workers,
    concurrency: cfg.workerConcurrency,
    quick: cfg.quickJobConcurrency,
    durations: await recentDurations(now),
  })
  const myRunning = running.filter((r) => r.workspaceId === workspaceId).length
  const slots = workers * cfg.workerConcurrency
  for (const j of mine) {
    const s = sim.get(j.id)
    if (j.kind === 'voice.relay' || !s) continue
    const ahead = s.position - 1
    let reason: QueueReason
    let detail: string
    if (s.startMs === 0) {
      reason = 'next'
      detail = 'Starting in a moment'
    } else if (s.passedOver && myRunning > 0) {
      reason = 'fair-share'
      detail = `Other spaces go first while this space has ${plural(myRunning, 'job')} running (fair share)`
    } else if (ahead > 0) {
      reason = 'behind'
      detail = `${plural(ahead, 'job')} ahead of it`
    } else {
      reason = 'lane-full'
      detail = isQuick(j.kind) ? 'Next in line: every slot is busy' : `Next in line: waiting for one of the ${plural(slots, 'slot')} to free up`
    }
    out[j.id] = { position: s.position, waitMs: s.startMs === null ? null : Math.round(s.startMs), reason, detail }
  }
  return out
}
