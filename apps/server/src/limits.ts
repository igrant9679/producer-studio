// Abuse brakes and quotas (cloud only): request rates per user, client IP or workspace; how much slow work one
// workspace can queue; monthly AI tokens and job minutes; storage. Counted in Postgres (rate_windows, usage_daily),
// so several API replicas share one count. Every limit is an env value where 0 turns it off.
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { ctx } from './context'
import { jobs, rateWindows } from './db/schema'
import { HttpError } from './http'
import { monthStart, storageOf, sumUsage } from './services/metering'

function inWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 90) return `${s} seconds`
  const m = Math.ceil(s / 60)
  if (m < 90) return `${m} minutes`
  return `${Math.ceil(m / 60)} hours`
}

interface Rule {
  key: string
  /** 0 = no limit */
  limit: number
  windowMs: number
  /** First sentence of the 429 message. */
  message: string
}

class Full extends Error {
  constructor(
    readonly rule: Rule,
    readonly resetAt: number,
  ) {
    super(rule.message)
  }
}

/**
 * Count one request against every rule, or throw 429 (counting nothing) when any of them is already full. Each rule
 * is one atomic upsert that only counts while the window has room, inside one transaction: two replicas (or two
 * requests at once) can never both take the last place.
 */
export async function hit(rules: Rule[]) {
  if (ctx().config.mode !== 'cloud') return
  const live = rules.filter((r) => r.limit > 0)
  if (!live.length) return
  const now = Date.now()
  try {
    await ctx().db.transaction(async (tx) => {
      for (const r of live) {
        const fresh = sql`${rateWindows.resetAt} <= ${now}`
        const rows = await tx
          .insert(rateWindows)
          .values({ key: r.key, n: 1, resetAt: now + r.windowMs })
          .onConflictDoUpdate({
            target: rateWindows.key,
            set: { n: sql`CASE WHEN ${fresh} THEN 1 ELSE ${rateWindows.n} + 1 END`, resetAt: sql`CASE WHEN ${fresh} THEN ${now + r.windowMs} ELSE ${rateWindows.resetAt} END` },
            setWhere: sql`${fresh} OR ${rateWindows.n} < ${r.limit}`,
          })
          .returning({ n: rateWindows.n })
        if (!rows.length) {
          const [w] = await tx.select({ resetAt: rateWindows.resetAt }).from(rateWindows).where(eq(rateWindows.key, r.key)).limit(1)
          throw new Full(r, Number(w?.resetAt ?? now + r.windowMs))
        }
      }
    })
  } catch (err) {
    if (err instanceof Full) throw new HttpError(429, 'quota', `${err.rule.message} Try again in ${inWords(err.resetAt - now)}.`)
    throw err
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const nf = (n: number) => n.toLocaleString('en-US')
/** Time until the next calendar month (UTC), when the monthly quotas start again. */
function untilNextMonth(now = Date.now()) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - now
}

/** AI tokens this month for the space and (when known) the person, against their monthly quotas. */
export async function assertAiTokens(workspaceId: string | undefined, userId: string | undefined) {
  const l = ctx().config.limits
  if (ctx().config.mode !== 'cloud') return
  const from = monthStart()
  const metrics = ['ai.input_tokens', 'ai.output_tokens'] as const
  if (workspaceId && l.aiTokensPerMonthPerWorkspace) {
    const used = await sumUsage({ workspaceId, metrics: [...metrics], fromDay: from })
    if (used >= l.aiTokensPerMonthPerWorkspace)
      throw new HttpError(429, 'quota', `This space has used this month’s ${nf(l.aiTokensPerMonthPerWorkspace)} AI tokens. It starts again in ${inWords(untilNextMonth())}, or use your own key in Settings → AI.`)
  }
  if (userId && l.aiTokensPerMonthPerUser) {
    const used = await sumUsage({ userId, metrics: [...metrics], fromDay: from })
    if (used >= l.aiTokensPerMonthPerUser) throw new HttpError(429, 'quota', `You’ve used this month’s ${nf(l.aiTokensPerMonthPerUser)} AI tokens. It starts again in ${inWords(untilNextMonth())}.`)
  }
}

/** AI writing on the server's or the workspace's key: the writer, the assistant, Producer AI's script. */
export async function limitAi(userId: string, workspaceId?: string) {
  const l = ctx().config.limits
  await assertAiTokens(workspaceId, userId)
  await hit([
    { key: `ai:day:${userId}`, limit: l.aiPerDay, windowMs: DAY, message: `You've used today's ${l.aiPerDay} AI requests.` },
    { key: `ai:min:${userId}`, limit: l.aiPerMinute, windowMs: MINUTE, message: 'Too many AI requests in a row.' },
    ...(workspaceId ? [{ key: `ai:ws-day:${workspaceId}`, limit: l.aiPerDayPerWorkspace, windowMs: DAY, message: `This space has used today's ${l.aiPerDayPerWorkspace} AI requests.` }] : []),
  ])
}

export async function limitSignup(ip: string) {
  const l = ctx().config.limits
  await hit([
    { key: `signup:ip:${ip}`, limit: l.signupsPerHourPerIp, windowMs: HOUR, message: 'Too many accounts were created from this network.' },
    { key: 'signup:all', limit: l.signupsPerHour, windowMs: HOUR, message: 'Sign-ups are paused for a moment.' },
  ])
}

export async function limitDevices(userId: string) {
  const l = ctx().config.limits
  await hit([{ key: `devices:${userId}`, limit: l.devicesPerHour, windowMs: HOUR, message: 'Too many apps were linked to this account.' }])
}

/** Slow work a person starts by hand. Upload processing isn't counted: a folder of clips must always go through. */
export const QUEUED_KINDS: JobKind[] = ['export.render', 'ai.tts', 'ai.transcribe', 'ai.produce.script', 'ai.produce.assemble', 'voice.relay']

/**
 * Refuse a new export / voiceover / transcription / Producer AI run when the workspace already has its share waiting,
 * or has used this month's job minutes.
 */
export async function assertQueueRoom(workspaceId: string) {
  if (ctx().config.mode !== 'cloud') return
  const { queuedJobsPerWorkspace: limit, jobMinutesPerMonthPerWorkspace: minutes } = ctx().config.limits
  if (minutes) {
    const used = (await sumUsage({ workspaceId, metrics: ['job.ms'], fromDay: monthStart() })) / MINUTE
    if (used >= minutes) throw new HttpError(429, 'quota', `This space has used this month’s ${nf(minutes)} minutes of processing. It starts again in ${inWords(untilNextMonth())}.`)
  }
  if (!limit) return
  const [row] = await ctx()
    .db.select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.status, ['queued', 'running']), inArray(jobs.kind, QUEUED_KINDS)))
  if (Number(row?.n ?? 0) >= limit)
    throw new HttpError(429, 'quota', `This space already has ${limit} exports, voiceovers or AI runs waiting. Let one finish, or cancel one from the jobs list.`)
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`

/** Refuse an upload that would take the space past its storage limit. */
export async function assertStorageRoom(workspaceId: string, addBytes: number) {
  const limit = ctx().config.limits.storageBytesPerWorkspace
  if (ctx().config.mode !== 'cloud' || !limit) return
  const used = (await storageOf([workspaceId])).get(workspaceId)?.bytes ?? 0
  if (used + Math.max(0, addBytes) > limit)
    throw new HttpError(413, 'quota', `This space is using ${gb(used)} of its ${gb(limit)} storage, so this file doesn’t fit. Delete clips or exports you no longer need.`)
}

/** Tests: start from empty counters. */
export async function resetLimits() {
  await ctx().db.delete(rateWindows)
}
