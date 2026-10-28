// Usage and limits (P-1, A-18): limits counted in Postgres, AI requests and tokens, job minutes and storage metered
// and capped, the Usage page's data, and the server's own AI key opt-in per space. The rate-window upsert is raw SQL:
// run this file with TEST_DATABASE_URL on a real Postgres too.
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { estimateCost } from '@producer/core'
import { setProvider, type AiProvider } from '../ai/provider'
import { BUILTIN_OFF } from '../ai/resolve'
import type { Config } from '../config'
import { ctx } from '../context'
import { rateWindows, usageDaily, workspaceUsageSettings } from '../db/schema'
import { hit, limitAi } from '../limits'
import { noteTokens, recordJobRun, utcDay } from '../services/metering'
import { type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
/** The limits as this file's server started (helpers turn them all off), put back after each test. */
let limits: Config['limits']
beforeAll(async () => {
  t = await setup()
  limits = { ...ctx().config.limits }
})
afterEach(() => {
  Object.assign(ctx().config.limits, limits)
  setProvider(undefined)
})

let n = 0
const uniq = (p: string) => `${p}:${Date.now().toString(36)}:${++n}`
const me = async (c: Client) => (await c.json('GET', '/api/auth/me')).body.user.id as string

/** A team space owned by A with members in the given roles. */
async function team(roles: Array<'editor' | 'viewer'> = []) {
  const A = await signup(t.app, 'Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  const others = []
  for (const role of roles) {
    const M = await signup(t.app, `Member ${role}`)
    const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
    await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    others.push({ ...M, userId: await me(M.client) })
  }
  return { A: { ...A, userId: await me(A.client) }, wsId: ws.id, others }
}

/** A fake model that reports tokens, as the real providers do after each response. */
function fakeProvider(tokens = { input: 100, output: 50 }): AiProvider {
  return {
    id: 'anthropic-key',
    model: 'claude-opus-5-5',
    status: async () => ({ available: true, detail: 'fake', model: 'claude-opus-5-5' }),
    write: async (_req, onDelta) => {
      noteTokens(tokens.input, tokens.output)
      onDelta('Hello')
      return 'Hello'
    },
    structured: async () => {
      throw new Error('unused')
    },
    runAgent: async () => ({ text: '' }),
  } as AiProvider
}

/** The writer, read to its end (the stream's last event is sent once the call is counted). */
const write = async (c: Client, workspaceId: string) => {
  const res = await c.req('POST', '/api/ai/write', { kind: 'headline', prompt: 'A title', workspaceId })
  const text = await res.text()
  return { status: res.status, text }
}

describe('limits counted in Postgres (P-1)', () => {
  it('counts a window across calls and refuses past it, saying when it frees up', async () => {
    const key = uniq('t')
    const rule = { key, limit: 3, windowMs: 60_000, message: 'Too many.' }
    for (let i = 0; i < 3; i++) await hit([rule])
    await expect(hit([rule])).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/^Too many\. Try again in \d+ seconds\.$/) })
    const [w] = await ctx().db.select().from(rateWindows).where(eq(rateWindows.key, key))
    expect(w.n).toBe(3)
  })

  it('never lets two requests at once both take the last place', async () => {
    const rule = { key: uniq('race'), limit: 4, windowMs: 60_000, message: 'Full.' }
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => hit([rule])))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(8)
  })

  it('counts nothing when any rule is already full', async () => {
    const full = { key: uniq('full'), limit: 1, windowMs: 60_000, message: 'Full.' }
    const roomy = { key: uniq('roomy'), limit: 10, windowMs: 60_000, message: 'Roomy.' }
    await hit([full])
    await expect(hit([roomy, full])).rejects.toMatchObject({ status: 429 })
    expect(await ctx().db.select().from(rateWindows).where(eq(rateWindows.key, roomy.key))).toHaveLength(0)
  })

  it('starts a window again once it has ended', async () => {
    const key = uniq('reset')
    await ctx().db.insert(rateWindows).values({ key, n: 5, resetAt: Date.now() - 1 })
    await hit([{ key, limit: 5, windowMs: 60_000, message: 'Full.' }])
    expect((await ctx().db.select().from(rateWindows).where(eq(rateWindows.key, key)))[0].n).toBe(1)
  })

  it('keeps the env names and the "0 = off" rule: AI_CALLS_PER_DAY counts per person, the new per-space limit per space', async () => {
    const { A, wsId, others } = await team(['editor'])
    ctx().config.limits.aiPerDay = 2
    await limitAi(A.userId, wsId)
    await limitAi(A.userId, wsId)
    await expect(limitAi(A.userId, wsId)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/today's 2 AI requests/) })
    ctx().config.limits.aiPerDay = 0
    ctx().config.limits.aiPerDayPerWorkspace = 3
    for (let i = 0; i < 3; i++) await limitAi(others[0].userId, wsId)
    await expect(limitAi(A.userId, wsId)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/This space has used today's 3/) })
  })
})

describe('AI metering and quotas (P-1, A-18)', () => {
  it('counts each AI request and its tokens under the provider and model, for the space and the person', async () => {
    const { A, wsId } = await team()
    setProvider(fakeProvider())
    expect((await write(A.client, wsId)).status).toBe(200)
    expect((await write(A.client, wsId)).status).toBe(200)
    const u = await A.client.json('GET', `/api/usage?workspaceId=${wsId}`)
    expect(u.status).toBe(200)
    expect(u.body.ai).toMatchObject({ requests: 2, inputTokens: 200, outputTokens: 100, estimate: true })
    expect(u.body.ai.providers).toEqual([{ provider: 'anthropic-key', model: 'claude-opus-5-5', requests: 2, inputTokens: 200, outputTokens: 100, estCostUsd: estimateCost('anthropic-key', 'claude-opus-5-5', 200, 100) }])
    expect(u.body.ai.estCostUsd).toBeCloseTo((200 * 4 + 100 * 20) / 1e6)
    // the owner sees who used it
    expect(u.body.members).toEqual([expect.objectContaining({ userId: A.userId, name: 'Owner', aiRequests: 2, tokens: 300 })])
    const rows = await ctx().db.select().from(usageDaily).where(and(eq(usageDaily.workspaceId, wsId), eq(usageDaily.metric, 'ai.requests')))
    expect(rows).toEqual([expect.objectContaining({ userId: A.userId, day: utcDay(), subject: 'anthropic-key|claude-opus-5-5', amount: 2 })])
  })

  it('refuses AI once the space has used its monthly tokens, before calling the model', async () => {
    const { A, wsId } = await team()
    setProvider(fakeProvider({ input: 600, output: 500 }))
    ctx().config.limits.aiTokensPerMonthPerWorkspace = 1000
    expect((await write(A.client, wsId)).status).toBe(200)
    const r = await A.client.json('POST', '/api/ai/write', { kind: 'headline', prompt: 'Again', workspaceId: wsId })
    expect(r.status).toBe(429)
    expect(r.body.error).toMatch(/This space has used this month’s 1,000 AI tokens/)
  })

  it('a job past the space’s monthly processing minutes is refused; minutes come from job runs', async () => {
    const { A, wsId } = await team()
    ctx().config.limits.jobMinutesPerMonthPerWorkspace = 60
    await recordJobRun({ workspaceId: wsId, userId: A.userId, kind: 'export.render' }, 61 * 60_000)
    const r = await A.client.json('POST', '/api/ai/tts', { workspaceId: wsId, text: 'Hello', voice: 'af_heart' })
    expect(r.status).toBe(429)
    expect(r.body.error).toMatch(/used this month’s 60 minutes of processing/)
    const u = (await A.client.json('GET', `/api/usage?workspaceId=${wsId}`)).body
    expect(u.jobs.byKind).toEqual([{ kind: 'export.render', minutes: 61, runs: 1 }])
    expect(u.limits).toContainEqual({ label: 'Processing minutes this month', used: 61, limit: 60, unit: 'minutes' })
  })

  it('an upload that would take the space past its storage is refused, and the Usage page shows storage per space', async () => {
    const { A, wsId } = await team()
    ctx().config.limits.storageBytesPerWorkspace = 1000
    const ok = await A.client.json('POST', '/api/uploads', { workspaceId: wsId, filename: 'a.wav', mime: 'audio/wav', size: 600 })
    expect(ok.status).toBe(200)
    const no = await A.client.json('POST', '/api/uploads', { workspaceId: wsId, filename: 'b.wav', mime: 'audio/wav', size: 600 })
    expect(no.status).toBe(413)
    expect(no.body.error).toMatch(/doesn’t fit/)
    const u = (await A.client.json('GET', `/api/usage?workspaceId=${wsId}`)).body
    expect(u.storage).toMatchObject({ bytes: 600, files: 1, byKind: [{ kind: 'audio', bytes: 600, files: 1 }] })
    expect(u.spaces).toContainEqual({ id: wsId, name: 'Team', bytes: 600 })
    expect(u.limits).toContainEqual({ label: 'Storage', used: 600, limit: 1000, unit: 'bytes' })
  })

  it('members can read their space’s usage; only owners see per-person rows; outsiders get 404', async () => {
    const { wsId, others } = await team(['viewer'])
    const v = await others[0].client.json('GET', `/api/usage?workspaceId=${wsId}`)
    expect(v.status).toBe(200)
    expect(v.body.members).toBeUndefined()
    expect(v.body.builtinAi.canChange).toBe(false)
    const stranger = await signup(t.app, 'Stranger')
    expect((await stranger.client.json('GET', `/api/usage?workspaceId=${wsId}`)).status).toBe(404)
  })
})

describe('the server’s own AI key is opt-in per space (P-1)', () => {
  it('a new space can’t use it until an owner turns it on; editors can’t', async () => {
    const { A, wsId, others } = await team(['editor'])
    const { requireProvider } = await import('../ai/provider')
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key'
    try {
      await expect(requireProvider(wsId, 'writer')).rejects.toMatchObject({ status: 503, message: BUILTIN_OFF })
      const s = (await A.client.json('GET', `/api/ai/settings?workspaceId=${wsId}`)).body
      expect(s.builtin).toMatchObject({ id: 'anthropic-api', available: false, detail: BUILTIN_OFF })
      expect((await A.client.json('GET', `/api/usage?workspaceId=${wsId}`)).body.builtinAi).toEqual({ enabled: false, available: true, canChange: true })
      expect((await others[0].client.json('PUT', '/api/usage/builtin-ai', { workspaceId: wsId, enabled: true })).status).toBe(403)
      expect((await A.client.json('PUT', '/api/usage/builtin-ai', { workspaceId: wsId, enabled: true })).body).toEqual({ enabled: true })
      expect((await requireProvider(wsId, 'writer')).id).toBe('anthropic-api')
      expect((await A.client.json('GET', `/api/ai/settings?workspaceId=${wsId}`)).body.builtin).toMatchObject({ available: true })
      await A.client.json('PUT', '/api/usage/builtin-ai', { workspaceId: wsId, enabled: false })
      await expect(requireProvider(wsId, 'writer')).rejects.toMatchObject({ status: 503, message: BUILTIN_OFF })
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('without a server key, a space is told AI isn’t configured (not that it is off)', async () => {
    const { wsId } = await team()
    const { requireProvider } = await import('../ai/provider')
    await expect(requireProvider(wsId, 'writer')).rejects.toMatchObject({ status: 503, message: 'AI is not configured — add a key in Settings' })
  })

  it('spaces that existed before v15 keep using it (the migration turns it on for them)', async () => {
    const { wsId } = await team()
    await ctx().db.delete(workspaceUsageSettings).where(eq(workspaceUsageSettings.workspaceId, wsId))
    const { DDL_V15 } = await import('../db/migrate')
    // idempotent: running it again is safe
    await ctx().database.exec(DDL_V15)
    const [row] = await ctx().db.select().from(workspaceUsageSettings).where(eq(workspaceUsageSettings.workspaceId, wsId))
    expect(row.builtinAi).toBe(true)
  })
})

