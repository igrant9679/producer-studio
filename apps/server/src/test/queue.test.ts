// The queue as people see it (P-3, A-9, A-8's job history): the fair claim between spaces, places in line with an
// estimated wait and the reason, finished jobs with Retry. The claim is raw SQL with row locks: run this file with
// TEST_DATABASE_URL on a real Postgres too. Jobs here are inserted or claimed by id, never run by a worker.
import { inArray } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../config'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { claimNext } from '../jobs/queue'
import { QUICK_KINDS } from '../jobs/worker'
import { claimJob, type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
let limits: Config['limits']
beforeAll(async () => {
  t = await setup()
  limits = { ...ctx().config.limits }
})
afterEach(() => {
  Object.assign(ctx().config.limits, limits)
})

let n = 0
const uniq = (p: string) => `${p}_${Date.now().toString(36)}_${++n}`
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

/** Queued jobs inserted straight into the table (no worker runs them), oldest first. */
async function queued(workspaceId: string, userId: string, kinds: string[]) {
  const ids: string[] = []
  const base = Date.now() - 60_000
  for (const [i, kind] of kinds.entries()) {
    const id = uniq('j_fair')
    await ctx().db.insert(jobs).values({ id, kind, status: 'queued', input: {}, workspaceId, userId, createdAt: base + i * 1000, updatedAt: base + i * 1000 })
    ids.push(id)
  }
  return ids
}
const park = (ids: string[]) => ctx().db.update(jobs).set({ status: 'cancelled' }).where(inArray(jobs.id, ids))

describe('fair share between spaces (P-3)', () => {
  it('the space with the fewest running jobs goes first, then the oldest job', async () => {
    const A = await team()
    const B = await team()
    const a = await queued(A.wsId, A.A.userId, ['export.render', 'export.render', 'export.render'])
    const [b] = await queued(B.wsId, B.A.userId, ['export.render'])
    const only = { workspaces: [A.wsId, B.wsId] }
    try {
      const order: string[] = []
      for (let i = 0; i < 4; i++) order.push((await claimNext('w-fair', undefined, only))!.id)
      // A's first (oldest, nobody running), then B's though it is newer (A now has one running), then A's others
      expect(order).toEqual([a[0], b, a[1], a[2]])
      expect(await claimNext('w-fair', undefined, only)).toBeNull()
      const claimed = await ctx().db.select().from(jobs).where(inArray(jobs.id, order))
      expect(claimed.every((j) => j.status === 'running' && j.lockedBy === 'w-fair' && j.startedAt != null)).toBe(true)
    } finally {
      await park([...a, b])
    }
  })

  it('in the quick lane only quick jobs running count', async () => {
    const A = await team()
    const B = await team()
    // A has a long export running; B a quick job: for the quick lane B is the busier one
    const [aLong] = await queued(A.wsId, A.A.userId, ['export.render'])
    const [bQuick] = await queued(B.wsId, B.A.userId, ['ai.transcribe'])
    await claimJob(aLong)
    await claimJob(bQuick)
    const [bNext] = await queued(B.wsId, B.A.userId, ['ai.tts'])
    const [aNext] = await queued(A.wsId, A.A.userId, ['ai.tts'])
    try {
      expect((await claimNext('w-quick', QUICK_KINDS, { workspaces: [A.wsId, B.wsId] }))!.id).toBe(aNext)
      expect((await claimNext('w-quick', QUICK_KINDS, { workspaces: [A.wsId, B.wsId] }))!.id).toBe(bNext)
    } finally {
      await park([aLong, bQuick, bNext, aNext])
    }
  })

  it('claims at the same moment never take the same job', async () => {
    const A = await team()
    const B = await team()
    const ids = [...(await queued(A.wsId, A.A.userId, ['export.render', 'export.render', 'export.render'])), ...(await queued(B.wsId, B.A.userId, ['export.render', 'export.render']))]
    try {
      const got = await Promise.all(Array.from({ length: 9 }, (_, i) => claimNext(`w-race-${i}`, undefined, { workspaces: [A.wsId, B.wsId] })))
      const won = got.filter(Boolean).map((j) => j!.id)
      expect(won.sort()).toEqual([...ids].sort())
      expect(got.filter((j) => j === null)).toHaveLength(4)
      const rows = await ctx().db.select().from(jobs).where(inArray(jobs.id, ids))
      expect(rows.every((r) => r.attempts === 1)).toBe(true)
    } finally {
      await park(ids)
    }
  })
})
