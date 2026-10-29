// The janitor (P-11): expired sessions and tokens, finished jobs, old tombstones (with the sync feed's horizon, so a
// desktop behind it syncs again instead of missing deletes), the audit log, rate windows, and temp and render folders.
// The tombstone horizon and the deletes are SQL: run this file with TEST_DATABASE_URL too.
import fs from 'node:fs'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../config'
import { ctx } from '../context'
import { auditLog, authTokens, jobs, opsState, rateWindows, tombstones } from '../db/schema'
import { pruneUsage } from '../services/metering'
import { TOMBSTONE_HORIZON_KEY, pruneOldRows, tombstoneHorizon } from '../services/retention'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
let retention: Config['retention']
beforeAll(async () => {
  t = await setup()
  retention = { ...ctx().config.retention }
})
afterEach(async () => {
  Object.assign(ctx().config.retention, retention)
  await ctx().db.delete(opsState).where(eq(opsState.key, TOMBSTONE_HORIZON_KEY))
})

const DAY = 24 * 3600_000
const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => {
  const r = (await ctx().db.execute(q)) as unknown
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[]
}
const nextSeq = async () => Number((await rows<{ v: string }>(sql`SELECT nextval('change_seq')::text AS v`))[0].v)

describe('the janitor (P-11)', () => {
  it('deletes finished jobs after JOB_RETENTION_DAYS, spent tokens and old audit entries; 0 keeps them forever', async () => {
    const A = await signup(t.app, 'Janitor')
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    const now = Date.now()
    const id = (p: string) => `${p}_${now}_${Math.random().toString(36).slice(2, 6)}`
    const oldJob = id('j_old')
    const freshJob = id('j_fresh')
    await ctx().db.insert(jobs).values([
      { id: oldJob, kind: 'ai.tts', status: 'error', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: now - 12 * DAY, updatedAt: now - 12 * DAY },
      { id: freshJob, kind: 'ai.tts', status: 'done', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY },
    ])
    const spent = id('tok_spent')
    const live = id('tok_live')
    await ctx().db.insert(authTokens).values([
      { id: spent, userId: me, purpose: 'reset', email: A.email, createdAt: now - 3 * DAY, expiresAt: now - 2 * DAY },
      { id: live, userId: me, purpose: 'reset', email: A.email, createdAt: now, expiresAt: now + 3600_000 },
    ])
    const oldAudit = id('au_old')
    await ctx().db.insert(auditLog).values({ id: oldAudit, at: now - 400 * DAY, kind: 'signin.ok', data: {} })

    Object.assign(ctx().config.retention, { jobDays: 0, auditDays: 0 })
    await pruneOldRows(now)
    expect(await ctx().db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, oldJob))).toHaveLength(1)
    expect(await ctx().db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, oldAudit))).toHaveLength(1)

    Object.assign(ctx().config.retention, { jobDays: 10, auditDays: 365 })
    const r = await pruneOldRows(now)
    expect(r.jobs).toBeGreaterThanOrEqual(1)
    expect(await ctx().db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, oldJob))).toHaveLength(0)
    expect(await ctx().db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, freshJob))).toHaveLength(1)
    expect(await ctx().db.select({ id: authTokens.id }).from(authTokens).where(eq(authTokens.id, spent))).toHaveLength(0)
    expect(await ctx().db.select({ id: authTokens.id }).from(authTokens).where(eq(authTokens.id, live))).toHaveLength(1)
    expect(await ctx().db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, oldAudit))).toHaveLength(0)
  })

  it('compacts old tombstones behind a horizon: a desktop behind it must sync from the start, one past it carries on', async () => {
    const A = await signup(t.app, 'Desk')
    const now = Date.now()
    const oldSeq = await nextSeq()
    const freshSeq = await nextSeq()
    await ctx().db.insert(tombstones).values([
      { kind: 'project', id: `p_gone_${now}`, workspaceId: A.workspaceId, changeSeq: oldSeq, deletedAt: now - 100 * DAY },
      { kind: 'project', id: `p_recent_${now}`, workspaceId: A.workspaceId, changeSeq: freshSeq, deletedAt: now - DAY },
    ])
    // the desktop's cursor from before the old delete
    const behind = oldSeq - 1
    expect((await A.client.json('GET', `/api/sync/changes?since=${behind}`)).status).toBe(200)

    Object.assign(ctx().config.retention, { tombstoneDays: 0 })
    expect((await pruneOldRows(now)).tombstones).toBe(0)
    expect(await tombstoneHorizon()).toBe(0)

    Object.assign(ctx().config.retention, { tombstoneDays: 90 })
    expect((await pruneOldRows(now)).tombstones).toBeGreaterThanOrEqual(1)
    expect(await tombstoneHorizon()).toBeGreaterThanOrEqual(oldSeq)
    const left = await ctx().db.select({ id: tombstones.id }).from(tombstones).where(eq(tombstones.workspaceId, A.workspaceId))
    expect(left.map((x) => x.id)).toEqual([`p_recent_${now}`])

    const refused = await A.client.json('GET', `/api/sync/changes?since=${behind}`)
    expect(refused.status).toBe(409)
    expect(refused.body.details).toMatchObject({ reason: 'resync', horizon: await tombstoneHorizon() })
    // from the start, or from past the horizon, the feed answers (and still has the recent delete)
    expect((await A.client.json('GET', '/api/sync/changes?since=0')).status).toBe(200)
    const after = await A.client.json('GET', `/api/sync/changes?since=${await tombstoneHorizon()}`)
    expect(after.status).toBe(200)
    expect(after.body.deleted.projects).toContain(`p_recent_${now}`)
  })

  it('never compacts tombstones on a desktop (they are what it still has to push)', async () => {
    const now = Date.now()
    const seq = await nextSeq()
    await ctx().db.insert(tombstones).values({ kind: 'asset', id: `as_desk_${now}`, workspaceId: 'ws_desk', changeSeq: seq, deletedAt: now - 365 * DAY })
    const mode = ctx().config.mode
    ctx().config.mode = 'desktop'
    try {
      expect((await pruneOldRows(now)).tombstones).toBe(0)
    } finally {
      ctx().config.mode = mode
    }
    expect(await ctx().db.select({ id: tombstones.id }).from(tombstones).where(eq(tombstones.id, `as_desk_${now}`))).toHaveLength(1)
    await ctx().db.delete(tombstones).where(eq(tombstones.id, `as_desk_${now}`))
  })

  it('drops rate windows past their reset (already done by pruneUsage)', async () => {
    const k = `test:janitor:${Date.now()}`
    await ctx().db.insert(rateWindows).values([
      { key: `${k}:old`, n: 3, resetAt: Date.now() - 1000 },
      { key: `${k}:live`, n: 3, resetAt: Date.now() + 60_000 },
    ])
    await pruneUsage()
    const left = (await ctx().db.select({ key: rateWindows.key }).from(rateWindows)).map((r) => r.key).filter((x) => x.startsWith(k))
    expect(left).toEqual([`${k}:live`])
  })

  it('clears temp and render folders a crash left behind (already done at worker start by sweepTempDirs)', async () => {
    const { sweepTempDirs } = await import('../services/assets')
    const { dataDir } = ctx().config
    const deadTmp = path.join(dataDir, 'tmp', 'w_dead_process', 'proc-x')
    const mineTmp = path.join(dataDir, 'tmp', ctx().instanceId, 'proc-y')
    const deadRender = path.join(dataDir, 'renders', 'j_not_running')
    for (const d of [deadTmp, mineTmp, deadRender]) fs.mkdirSync(d, { recursive: true })
    const old = (Date.now() - 2 * 3600_000) / 1000
    for (const d of [deadTmp, path.dirname(deadTmp)]) fs.utimesSync(d, old, old)
    expect(await sweepTempDirs()).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(path.dirname(deadTmp))).toBe(false)
    expect(fs.existsSync(deadRender)).toBe(false)
    expect(fs.existsSync(mineTmp)).toBe(true)
  })
})
