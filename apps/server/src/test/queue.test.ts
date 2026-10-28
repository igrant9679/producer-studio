// The queue as people see it (P-3, A-9, A-8's job history): the fair claim between spaces, places in line with an
// estimated wait and the reason, finished jobs with Retry. The claim is raw SQL with row locks: run this file with
// TEST_DATABASE_URL on a real Postgres too. Jobs here are inserted or claimed by id, never run by a worker.
import { eq, inArray } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../config'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { claimNext, enqueue, failJob, finishJob } from '../jobs/queue'
import { replayQueue } from '../jobs/queue-info'
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

describe('queue visibility (A-9)', () => {
  const durations = new Map([
    ['export.render', 10 * 60_000],
    ['ai.transcribe', 60_000],
  ])

  it('places each job in line with a wait from recent durations', () => {
    const r = replayQueue({
      running: [{ kind: 'export.render', workspaceId: 'A', elapsedMs: 4 * 60_000 }],
      queued: [
        { id: 'a2', kind: 'export.render', workspaceId: 'A' },
        { id: 'a3', kind: 'export.render', workspaceId: 'A' },
      ],
      workers: 1,
      concurrency: 2,
      quick: 1,
      durations,
    })
    // a free shared slot takes a2 now; a3 waits for the running export (6 more minutes)
    expect(r.get('a2')).toEqual({ position: 1, startMs: 0, passedOver: false })
    expect(r.get('a3')).toEqual({ position: 2, startMs: 6 * 60_000, passedOver: false })
  })

  it('says a job waits for its fair share when a younger job of another space goes first', () => {
    const r = replayQueue({
      running: [{ kind: 'export.render', workspaceId: 'A', elapsedMs: 0 }],
      queued: [
        { id: 'a2', kind: 'export.render', workspaceId: 'A' },
        { id: 'b1', kind: 'export.render', workspaceId: 'B' },
      ],
      workers: 1,
      concurrency: 2,
      quick: 0,
      durations,
    })
    // the free slot goes to B (nothing running) though A's job is older; A's waits for its running export
    expect(r.get('b1')).toEqual({ position: 1, passedOver: false, startMs: 0 })
    expect(r.get('a2')).toEqual({ position: 2, passedOver: true, startMs: 10 * 60_000 })
  })

  it('once a space’s running job ends it is level again: no fair-share wait', () => {
    const r = replayQueue({
      running: [{ kind: 'export.render', workspaceId: 'A', elapsedMs: 0 }],
      queued: [
        { id: 'a2', kind: 'export.render', workspaceId: 'A' },
        { id: 'b1', kind: 'export.render', workspaceId: 'B' },
      ],
      workers: 1,
      concurrency: 1,
      quick: 0,
      durations,
    })
    expect(r.get('a2')).toEqual({ position: 1, passedOver: false, startMs: 10 * 60_000 })
    expect(r.get('b1')).toEqual({ position: 2, passedOver: false, startMs: 20 * 60_000 })
  })

  it('quick jobs use their own slot; a kind with no history makes the wait unknown', () => {
    const r = replayQueue({
      running: [{ kind: 'export.render', workspaceId: 'A', elapsedMs: 0 }],
      queued: [
        { id: 'x', kind: 'ai.produce.script', workspaceId: 'A' },
        { id: 'q', kind: 'ai.transcribe', workspaceId: 'A' },
        { id: 'y', kind: 'export.render', workspaceId: 'A' },
      ],
      workers: 1,
      concurrency: 1,
      quick: 1,
      durations,
    })
    expect(r.get('q')).toMatchObject({ startMs: 0 })
    expect(r.get('x')).toMatchObject({ startMs: 10 * 60_000 })
    // after the script, whose run time isn't known yet
    expect(r.get('y')).toMatchObject({ startMs: null })
  })

  it('the jobs list gets each queued job’s place, wait and reason', async () => {
    const { A, wsId } = await team()
    const ids = await queued(wsId, A.userId, ['export.render', 'export.render'])
    const relay = await enqueue('voice.relay', { text: 'hi' }, { workspaceId: wsId, userId: A.userId })
    try {
      const r = await A.client.json('GET', `/api/jobs/queue?workspaceId=${wsId}`)
      expect(r.status).toBe(200)
      const q = r.body.jobs
      expect(q[relay.id]).toMatchObject({ reason: 'desktop', waitMs: null })
      expect(q[ids[0]].position).toBeLessThan(q[ids[1]].position)
      for (const id of ids) expect(['next', 'behind', 'lane-full', 'fair-share']).toContain(q[id].reason)
      expect(typeof q[ids[1]].detail).toBe('string')
      const stranger = await signup(t.app, 'Stranger')
      expect((await stranger.client.json('GET', `/api/jobs/queue?workspaceId=${wsId}`)).status).toBe(404)
    } finally {
      await park([...ids, relay.id])
    }
  })
})

describe('job history and Retry (A-8)', () => {
  it('lists finished and failed jobs, newest first, filtered by outcome, linked to their project', async () => {
    const { A, wsId } = await team()
    const project = (await A.client.json('POST', '/api/projects', { workspaceId: wsId, name: 'History' })).body.summary
    const ok = await enqueue('ai.tts', { workspaceId: wsId, text: 'one', voice: 'af_heart' }, { workspaceId: wsId, userId: A.userId, projectId: project.id })
    await claimJob(ok.id)
    await finishJob(ok.id, { big: 'x'.repeat(1000) })
    const bad = await enqueue('ai.tts', { workspaceId: wsId, text: 'two', voice: 'af_heart' }, { workspaceId: wsId, userId: A.userId, projectId: project.id })
    await claimJob(bad.id)
    await failJob(bad.id, 'The voice engine stopped')
    const waiting = await enqueue('ai.tts', { workspaceId: wsId, text: 'three', voice: 'af_heart' }, { workspaceId: wsId, userId: A.userId })
    try {
      const all = (await A.client.json('GET', `/api/jobs/history?workspaceId=${wsId}`)).body
      expect(all.items.map((j: { id: string }) => j.id)).toEqual([bad.id, ok.id])
      expect(all.items[1]).toMatchObject({ status: 'done', projectId: project.id, startedAt: expect.any(Number) })
      expect(all.items[1].result).toBeUndefined()
      const failed = (await A.client.json('GET', `/api/jobs/history?workspaceId=${wsId}&status=error`)).body
      expect(failed.items).toEqual([expect.objectContaining({ id: bad.id, error: 'The voice engine stopped' })])
      expect((await A.client.json('GET', `/api/jobs/history?workspaceId=${wsId}&status=queued`)).status).toBe(400)
    } finally {
      await park([waiting.id])
    }
  })

  it('Retry queues the same work again for editors; viewers can’t; finished and clip jobs point elsewhere', async () => {
    const { A, wsId, others } = await team(['editor', 'viewer'])
    const [editor, viewer] = others
    const input = { workspaceId: wsId, text: 'again', voice: 'af_heart' }
    const bad = await enqueue('ai.tts', input, { workspaceId: wsId, userId: A.userId })
    await claimJob(bad.id)
    await failJob(bad.id, 'Failed once')
    expect((await viewer.client.json('POST', `/api/jobs/${bad.id}/retry`)).status).toBe(403)
    const r = await editor.client.json('POST', `/api/jobs/${bad.id}/retry`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ kind: 'ai.tts', status: 'queued', workspaceId: wsId, message: 'Queued again' })
    expect(r.body.id).not.toBe(bad.id)
    const [row] = await ctx().db.select().from(jobs).where(eq(jobs.id, r.body.id))
    expect(row).toMatchObject({ input, userId: editor.userId })
    await park([r.body.id])
    const done = await enqueue('ai.tts', input, { workspaceId: wsId, userId: A.userId })
    await claimJob(done.id)
    await finishJob(done.id, {})
    expect((await A.client.json('POST', `/api/jobs/${done.id}/retry`)).status).toBe(409)
    const proc = await enqueue('asset.process', { assetId: 'as_gone' }, { workspaceId: wsId, userId: A.userId })
    await claimJob(proc.id)
    await failJob(proc.id, 'Broken file')
    const clip = await A.client.json('POST', `/api/jobs/${proc.id}/retry`)
    expect(clip.status).toBe(409)
    expect(clip.body.details).toEqual({ assetId: 'as_gone' })
  })

  it('Retry follows the same limits as starting the work by hand', async () => {
    const { A, wsId } = await team()
    ctx().config.limits.queuedJobsPerWorkspace = 1
    const bad = await enqueue('ai.tts', { workspaceId: wsId, text: 'x', voice: 'af_heart' }, { workspaceId: wsId, userId: A.userId })
    await claimJob(bad.id)
    await failJob(bad.id, 'Failed')
    const busy = await enqueue('ai.tts', { workspaceId: wsId, text: 'y', voice: 'af_heart' }, { workspaceId: wsId, userId: A.userId })
    try {
      expect((await A.client.json('POST', `/api/jobs/${bad.id}/retry`)).status).toBe(429)
    } finally {
      await park([busy.id])
    }
  })
})
