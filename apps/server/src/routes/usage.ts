// The Usage page's data (A-18) and the per-space switch for the server's own AI key (P-1).
import { Hono } from 'hono'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { estimateCost, type ClipUsage, type UsageLimitView, type UsageSummary } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { audit } from '../services/audit'
import { falModelName } from '../ai/generate/fal'
import { builtinProvider } from '../ai/resolve'
import { ctx } from '../context'
import { jobs, memberships, rateWindows, users, workspaces } from '../db/schema'
import { HttpError, body, invalid, requireRole } from '../http'
import { QUEUED_KINDS } from '../limits'
import { DAY_MS, builtinAiEnabled, monthStart, setBuiltinAi, storageOf, sumUsage, usageRows, utcDay } from '../services/metering'

export const usageRoutes = new Hono<AppEnv>()

/** A rate window's count now (0 once it has ended). */
async function windowCount(key: string, now: number): Promise<number> {
  const [w] = await ctx().db.select({ n: rateWindows.n }).from(rateWindows).where(and(eq(rateWindows.key, key), gt(rateWindows.resetAt, now))).limit(1)
  return w?.n ?? 0
}

usageRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  const role = await requireRole(u.id, workspaceId, 'viewer')
  const days = Math.min(400, Math.max(1, Math.floor(Number(c.req.query('days') ?? 30)) || 30))
  const now = Date.now()
  const from = now - (days - 1) * DAY_MS
  const rows = await usageRows(workspaceId, utcDay(from), utcDay(now))

  // AI by provider and model
  const ai = new Map<string, { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number }>()
  const jobKinds = new Map<string, { kind: string; ms: number; runs: number }>()
  // AI video clips by provider and model: seconds and clips, never tokens or dollars
  const clipKinds = new Map<string, { provider: string; model: string; clips: number; seconds: number }>()
  const people = new Map<string, { aiRequests: number; tokens: number; jobMs: number; clipSeconds: number }>()
  for (const r of rows) {
    const n = Number(r.amount)
    const who = people.get(r.userId) ?? { aiRequests: 0, tokens: 0, jobMs: 0, clipSeconds: 0 }
    people.set(r.userId, who)
    if (r.metric === 'clip.seconds' || r.metric === 'clip.count') {
      const [provider, ...rest] = r.subject.split('|')
      const e = clipKinds.get(r.subject) ?? { provider, model: rest.join('|'), clips: 0, seconds: 0 }
      clipKinds.set(r.subject, e)
      if (r.metric === 'clip.seconds') (e.seconds += n), (who.clipSeconds += n)
      else e.clips += n
    } else if (r.metric.startsWith('ai.')) {
      const [provider, ...rest] = r.subject.split('|')
      const e = ai.get(r.subject) ?? { provider, model: rest.join('|'), requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }
      ai.set(r.subject, e)
      if (r.metric === 'ai.requests') (e.requests += n), (who.aiRequests += n)
      else if (r.metric === 'ai.input_tokens') (e.inputTokens += n), (who.tokens += n)
      else if (r.metric === 'ai.cost_microusd') e.costMicroUsd += n
      else (e.outputTokens += n), (who.tokens += n)
    } else {
      const e = jobKinds.get(r.subject) ?? { kind: r.subject, ms: 0, runs: 0 }
      jobKinds.set(r.subject, e)
      if (r.metric === 'job.ms') (e.ms += n), (who.jobMs += n)
      else e.runs += n
    }
  }
  // the dollars the provider reported (OpenRouter), else an estimate from list prices
  const providers = [...ai.values()]
    .map(({ costMicroUsd, ...p }) => ({ ...p, estCostUsd: costMicroUsd > 0 ? costMicroUsd / 1_000_000 : estimateCost(p.provider, p.model, p.inputTokens, p.outputTokens) }))
    .sort((a, b) => b.estCostUsd - a.estCostUsd || b.requests - a.requests)
  const sum = (k: 'requests' | 'inputTokens' | 'outputTokens' | 'estCostUsd') => providers.reduce((t, p) => t + p[k], 0)
  const tenth = (n: number) => Math.round(n * 10) / 10
  const clips: ClipUsage[] = [...clipKinds.values()]
    .map((c) => {
      const name = c.provider === 'fal' ? falModelName(c.model) : c.model
      return { provider: c.provider, model: c.model, ...(name !== c.model ? { modelName: name } : {}), clips: c.clips, seconds: tenth(c.seconds) }
    })
    .sort((a, b) => b.seconds - a.seconds || b.clips - a.clips)

  // storage: this space, and every space this person is in
  const mine = await ctx()
    .db.select({ id: workspaces.id, name: workspaces.name })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, u.id))
  const stored = await storageOf([...new Set([workspaceId, ...mine.map((w) => w.id)])])
  const here = stored.get(workspaceId)

  let members: UsageSummary['members']
  if (role === 'owner') {
    const ids = [...people.keys()].filter(Boolean)
    const names = new Map(ids.length ? (await ctx().db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((x) => [x.id, x.name]) : [])
    members = [...people.entries()]
      .map(([userId, p]) => ({ userId, name: userId ? (names.get(userId) ?? 'Former member') : 'Automatic', aiRequests: p.aiRequests, tokens: p.tokens, jobMinutes: Math.round((p.jobMs / 60_000) * 10) / 10, clipSeconds: tenth(p.clipSeconds) }))
      .sort((a, b) => b.tokens - a.tokens || b.jobMinutes - a.jobMinutes || b.clipSeconds - a.clipSeconds)
  }

  const cfg = ctx().config
  const cloud = cfg.mode === 'cloud'
  const l = cfg.limits
  const off = (n: number) => (cloud ? n : 0)
  const month = monthStart(now)
  const tokens = ['ai.input_tokens', 'ai.output_tokens'] as const
  const [waiting] = await ctx()
    .db.select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.status, ['queued', 'running']), inArray(jobs.kind, QUEUED_KINDS)))
  const everyLimit: UsageLimitView[] = [
    { label: 'Your AI requests today', used: await windowCount(`ai:day:${u.id}`, now), limit: off(l.aiPerDay), unit: 'requests' },
    { label: 'This space’s AI requests today', used: await windowCount(`ai:ws-day:${workspaceId}`, now), limit: off(l.aiPerDayPerWorkspace), unit: 'requests' },
    { label: 'This space’s AI tokens this month', used: await sumUsage({ workspaceId, metrics: [...tokens], fromDay: month }), limit: off(l.aiTokensPerMonthPerWorkspace), unit: 'tokens' },
    { label: 'Your AI tokens this month', used: await sumUsage({ userId: u.id, metrics: [...tokens], fromDay: month }), limit: off(l.aiTokensPerMonthPerUser), unit: 'tokens' },
    { label: 'Processing minutes this month', used: Math.round((await sumUsage({ workspaceId, metrics: ['job.ms'], fromDay: month })) / 6000) / 10, limit: off(l.jobMinutesPerMonthPerWorkspace), unit: 'minutes' },
    { label: 'Exports, voiceovers and AI runs waiting', used: Number(waiting?.n ?? 0), limit: off(l.queuedJobsPerWorkspace), unit: 'jobs' },
    { label: 'Storage', used: here?.bytes ?? 0, limit: off(l.storageBytesPerWorkspace), unit: 'bytes' },
    // a request window is only counted while it has a limit (limits.ts `hit`): without one there is no number to show,
    // and "0 · no limit" beside a counted "2 of 200" read as if the space had made no requests
  ]
  const limits = everyLimit.filter((x) => x.unit !== 'requests' || x.limit > 0)

  const b = await builtinProvider()
  const summary: UsageSummary = {
    workspaceId,
    from,
    to: now,
    days,
    ai: {
      providers,
      requests: sum('requests'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      estCostUsd: sum('estCostUsd'),
      estimate: true,
      clips,
      clipCount: clips.reduce((t, c) => t + c.clips, 0),
      clipSeconds: tenth([...clipKinds.values()].reduce((t, c) => t + c.seconds, 0)),
    },
    jobs: {
      minutes: Math.round(([...jobKinds.values()].reduce((t, k) => t + k.ms, 0) / 60_000) * 10) / 10,
      byKind: [...jobKinds.values()].map((k) => ({ kind: k.kind, minutes: Math.round((k.ms / 60_000) * 10) / 10, runs: k.runs })).sort((a, b) => b.minutes - a.minutes),
    },
    storage: { bytes: here?.bytes ?? 0, files: here?.files ?? 0, byKind: [...(here?.byKind ?? new Map()).entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.bytes - a.bytes) },
    spaces: mine.map((w) => ({ id: w.id, name: w.name, bytes: stored.get(w.id)?.bytes ?? 0 })).sort((a, b) => b.bytes - a.bytes),
    ...(members ? { members } : {}),
    limits,
    builtinAi: await builtinAiView(workspaceId, u, cloud, role, ((b.id === 'anthropic-api' || b.id === 'openrouter-api') && (await b.status()).available) || Boolean(ctx().config.openrouterKey)),
  }
  return c.json(summary)
})

/** Whether the space uses the server's AI, whether this person may switch it, and why it can't be turned on (when it can't). */
async function builtinAiView(workspaceId: string, u: Parameters<typeof import('../services/membership').builtinAiRefusal>[1], cloud: boolean, role: string, available: boolean): Promise<UsageSummary['builtinAi']> {
  const enabled = cloud ? await builtinAiEnabled(workspaceId) : true
  const canChange = cloud && role === 'owner'
  if (enabled || !canChange || !available) return { enabled, available, canChange }
  const { builtinAiRefusal } = await import('../services/membership')
  const whyNot = await builtinAiRefusal(workspaceId, u)
  return { enabled, available, canChange, ...(whyNot ? { whyNot } : {}) }
}

/** Owners: let this space use the server's own AI key, or stop it (its own keys keep working either way). */
usageRoutes.put('/builtin-ai', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ workspaceId: z.string().min(1), enabled: z.boolean() }))
  await requireRole(u.id, b.workspaceId, 'owner')
  if (ctx().config.mode !== 'cloud') throw invalid('The desktop app uses your own Claude sign-in; there is no server key to turn on.')
  // it comes with a membership (operators: anywhere); a space whose membership ended gets it back by renewing
  if (b.enabled) {
    const { builtinAiRefusal } = await import('../services/membership')
    const why = await builtinAiRefusal(b.workspaceId, u)
    if (why) throw new HttpError(409, 'conflict', why)
  }
  await setBuiltinAi(b.workspaceId, b.enabled, u.id)
  await audit(c, { kind: 'ai.builtin', workspaceId: b.workspaceId, data: { enabled: b.enabled } })
  return c.json({ enabled: b.enabled })
})
