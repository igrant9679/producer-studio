// Usage metering (P-1): AI requests and tokens per provider and model, job run time per kind, per space and person
// per UTC day, in Postgres (usage_daily) so every replica adds to the same totals. Storage is read live from the
// clips themselves. Whether a space may use the server's own AI key lives here too (workspace_usage_settings).
// Cloud only: the desktop is one person's own machine and plan.
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm'
import type { AiFeature } from '@producer/core'
import { ctx } from '../context'
import { assets, rateWindows, usageDaily, workspaceUsageSettings } from '../db/schema'
import { log } from '../log'
import type { AiProvider, AiScope } from '../ai/provider'

export const DAY_MS = 24 * 3600_000

/** The UTC day of a time, as stored ("2026-10-28"). */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
/** The UTC month of a time ("2026-10"). */
export const utcMonth = (t = Date.now()) => new Date(t).toISOString().slice(0, 7)

const metering = () => ctx().config.mode === 'cloud'

// ---- who is doing the work ----

interface Actor {
  userId?: string
}
const actors = new AsyncLocalStorage<Actor>()

/** Run `fn` with `userId` as the person usage inside it is charged to (a request's signed-in user, a job's starter). */
export function withActor<T>(userId: string | undefined, fn: () => T): T {
  return actors.run({ userId }, fn)
}
export const currentUserId = () => actors.getStore()?.userId

// ---- tokens reported by the providers ----

const bags = new AsyncLocalStorage<{ input: number; output: number }>()

/** Called by a provider after each model response with the tokens it used (no-op outside a metered call). */
export function noteTokens(input: number | null | undefined, output: number | null | undefined) {
  const b = bags.getStore()
  if (!b) return
  b.input += Math.max(0, Number(input) || 0)
  b.output += Math.max(0, Number(output) || 0)
}

// ---- recording ----

export interface UsageRow {
  workspaceId: string
  userId?: string
  metric: 'ai.requests' | 'ai.input_tokens' | 'ai.output_tokens' | 'job.ms' | 'job.runs'
  subject?: string
  amount: number
}

/** Add to today's totals (one row per space, person, metric and subject). Never throws: metering mustn't break work. */
export async function recordUsage(rows: UsageRow[], at = Date.now()): Promise<void> {
  const live = rows.filter((r) => r.amount > 0 && r.workspaceId)
  if (!live.length || !metering()) return
  const day = utcDay(at)
  try {
    for (const r of live)
      await ctx()
        .db.insert(usageDaily)
        .values({ workspaceId: r.workspaceId, userId: r.userId ?? '', day, metric: r.metric, subject: r.subject ?? '', amount: r.amount, updatedAt: at })
        .onConflictDoUpdate({
          target: [usageDaily.workspaceId, usageDaily.day, usageDaily.metric, usageDaily.subject, usageDaily.userId],
          set: { amount: sql`${usageDaily.amount} + ${r.amount}`, updatedAt: at },
        })
  } catch (err) {
    log.warn('recording usage failed', { err })
  }
}

/** A job ran for `ms` (whatever its outcome: the machine time was spent). */
export function recordJobRun(job: { workspaceId: string; userId: string; kind: string }, ms: number) {
  return recordUsage([
    { workspaceId: job.workspaceId, userId: job.userId, metric: 'job.ms', subject: job.kind, amount: Math.round(ms) },
    { workspaceId: job.workspaceId, userId: job.userId, metric: 'job.runs', subject: job.kind, amount: 1 },
  ])
}

// ---- totals ----

/** Sum of a metric for a space (or a person across spaces) from `fromDay` (inclusive). */
export async function sumUsage(opts: { workspaceId?: string; userId?: string; metrics: UsageRow['metric'][]; fromDay: string; toDay?: string }): Promise<number> {
  const conds = [inArray(usageDaily.metric, opts.metrics), gte(usageDaily.day, opts.fromDay)]
  if (opts.toDay) conds.push(lte(usageDaily.day, opts.toDay))
  if (opts.workspaceId) conds.push(eq(usageDaily.workspaceId, opts.workspaceId))
  if (opts.userId) conds.push(eq(usageDaily.userId, opts.userId))
  const [row] = await ctx()
    .db.select({ n: sql<number>`coalesce(sum(${usageDaily.amount}), 0)` })
    .from(usageDaily)
    .where(and(...conds))
  return Number(row?.n ?? 0)
}

export const monthStart = (t = Date.now()) => `${utcMonth(t)}-01`

/** Usage rows of a space in a day range, for the Usage page. */
export async function usageRows(workspaceId: string, fromDay: string, toDay: string) {
  return ctx()
    .db.select({ userId: usageDaily.userId, metric: usageDaily.metric, subject: usageDaily.subject, amount: sql<number>`sum(${usageDaily.amount})` })
    .from(usageDaily)
    .where(and(eq(usageDaily.workspaceId, workspaceId), gte(usageDaily.day, fromDay), lte(usageDaily.day, toDay)))
    .groupBy(usageDaily.userId, usageDaily.metric, usageDaily.subject)
}

/** Bytes and files a space stores (the clips and exports in its library, trashed ones included until deleted). */
export async function storageOf(workspaceIds: string[]): Promise<Map<string, { bytes: number; files: number; byKind: Map<string, { bytes: number; files: number }> }>> {
  const out = new Map<string, { bytes: number; files: number; byKind: Map<string, { bytes: number; files: number }> }>()
  if (!workspaceIds.length) return out
  const rows = await ctx()
    .db.select({ ws: assets.workspaceId, kind: assets.kind, bytes: sql<number>`coalesce(sum(${assets.size}), 0)`, files: sql<number>`count(*)::int` })
    .from(assets)
    .where(inArray(assets.workspaceId, workspaceIds))
    .groupBy(assets.workspaceId, assets.kind)
  for (const r of rows) {
    const e = out.get(r.ws) ?? { bytes: 0, files: 0, byKind: new Map() }
    e.bytes += Number(r.bytes)
    e.files += Number(r.files)
    e.byKind.set(r.kind, { bytes: Number(r.bytes), files: Number(r.files) })
    out.set(r.ws, e)
  }
  return out
}

// ---- the server's own AI key, per space ----

/** May this space use the server's own AI key? Spaces from before v15 may; new ones once an owner turns it on. */
export async function builtinAiEnabled(workspaceId: string | undefined): Promise<boolean> {
  if (!workspaceId) return false
  const [row] = await ctx().db.select({ on: workspaceUsageSettings.builtinAi }).from(workspaceUsageSettings).where(eq(workspaceUsageSettings.workspaceId, workspaceId)).limit(1)
  return Boolean(row?.on)
}

export async function setBuiltinAi(workspaceId: string, enabled: boolean, by: string): Promise<void> {
  const now = Date.now()
  await ctx()
    .db.insert(workspaceUsageSettings)
    .values({ workspaceId, builtinAi: enabled, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: workspaceUsageSettings.workspaceId, set: { builtinAi: enabled, updatedBy: by, updatedAt: now } })
}

// ---- metered AI providers ----

/**
 * The provider for a space, counting every call: one request and the tokens it reported, under the provider and
 * model, for the space and the person (the request's user, or the job's). A space or person over its monthly token
 * quota is refused before the call (429).
 */
export function meterAi(p: AiProvider, scope: AiScope, feature?: AiFeature): AiProvider {
  if (!metering() || !scope || scope === 'local') return p
  const workspaceId = scope
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    const userId = currentUserId()
    const { assertAiTokens } = await import('../limits')
    await assertAiTokens(workspaceId, userId)
    const bag = { input: 0, output: 0 }
    try {
      return await bags.run(bag, call)
    } finally {
      const model = (p as { model?: string }).model ?? ''
      const subject = `${p.id}|${model}`
      // awaited: the next request's quota check sees this one
      await recordUsage([
        { workspaceId, userId, metric: 'ai.requests', subject, amount: 1 },
        { workspaceId, userId, metric: 'ai.input_tokens', subject, amount: bag.input },
        { workspaceId, userId, metric: 'ai.output_tokens', subject, amount: bag.output },
      ])
      log.info('ai usage', { workspaceId, feature, provider: p.id, input: bag.input, output: bag.output })
    }
  }
  return {
    get id() {
      return p.id
    },
    status: () => p.status(),
    write: (req, onDelta, signal) => run(() => p.write(req, onDelta, signal)),
    structured: (req) => run(() => p.structured(req)),
    runAgent: (req) => run(() => p.runAgent(req)),
  }
}

// ---- housekeeping ----

/** Expired rate windows go; daily usage is kept 400 days (a year of history on the Usage page and then some). */
export async function pruneUsage(now = Date.now()): Promise<void> {
  const db = ctx().db
  await db.delete(rateWindows).where(lt(rateWindows.resetAt, now))
  await db.delete(usageDaily).where(lt(usageDaily.day, utcDay(now - 400 * DAY_MS)))
}

