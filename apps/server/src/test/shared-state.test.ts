// State several API processes and workers share (R4-A carried items): presence kept in Postgres, If-Match writes that
// are one conditional UPDATE, and the fair claim taking turns. These are SQL races: run this file with
// TEST_DATABASE_URL on a real Postgres too.
import { eq, inArray } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PRESENCE_TTL_MS } from '@producer/core'
import { ctx } from '../context'
import { assets, jobs, presenceRows } from '../db/schema'
import { claimNext } from '../jobs/queue'
import { updateAsset } from '../services/assets'
import { presenceOf, sweepPresence } from '../services/presence'
import { type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const me = async (c: Client) => (await c.json('GET', '/api/auth/me')).body.user.id as string
let n = 0
const uniq = (p: string) => `${p}_${Date.now().toString(36)}_${++n}`

describe('presence across API processes (carried)', () => {
  it('a tab another process heard from is here too; whichever process sweeps it tells the space, to other processes too', async () => {
    const A = await signup(t.app, 'Here Owner')
    const p = (await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Shared' })).body.summary
    const published: Array<{ event: string; opts?: { id?: string; inline?: unknown } }> = []
    const real = ctx().bus.publish.bind(ctx().bus)
    vi.spyOn(ctx().bus, 'publish').mockImplementation((ws, event, data, opts) => {
      published.push({ event, opts })
      return real(ws, event, data, opts)
    })
    // this process hears A's tab
    await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab-here' })
    // another API process heard B's tab (its row, written there)
    const now = Date.now()
    await ctx().db.insert(presenceRows).values({ projectId: p.id, userId: 'u_elsewhere', client: 'tab-there', workspaceId: A.workspaceId, name: 'Bea Elsewhere', color: '#123456', role: 'editor', since: now, seen: now })
    const both = (await A.client.json('GET', `/api/projects/${p.id}/presence`)).body
    expect(both.people.map((x: { name: string }) => x.name).sort()).toEqual(['Bea Elsewhere', 'Here Owner'])
    // the news goes to other processes as well (by reference, with the small payload inline)
    const sent = published.filter((e) => e.event === 'presence')
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent[0].opts).toMatchObject({ id: p.id, inline: expect.objectContaining({ projectId: p.id }) })
    // B's process went away: their tab stops beating, and this process's sweep says so
    await ctx().db.update(presenceRows).set({ seen: now - PRESENCE_TTL_MS - 1 }).where(eq(presenceRows.client, 'tab-there'))
    published.length = 0
    await sweepPresence()
    expect((await presenceOf(p.id)).people.map((x) => x.name)).toEqual(['Here Owner'])
    const after = published.find((e) => e.event === 'presence')
    expect((after?.opts?.inline as { people: unknown[] }).people).toHaveLength(1)
    await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab-here', open: false })
  })
})

describe('If-Match writes are one conditional UPDATE (carried)', () => {
  it('two saves of a clip with the same base at once: one wins, the other gets 412', async () => {
    const A = await signup(t.app, 'Racer')
    const id = uniq('as_race')
    await ctx().db.insert(assets).values({ id, workspaceId: A.workspaceId, kind: 'video', name: 'v0.mp4', mime: 'video/mp4', size: 1, status: 'ready', sourceKey: 'x', createdBy: await me(A.client), createdAt: Date.now(), updatedAt: Date.now() })
    const etag = (await A.client.json('GET', `/api/assets/${id}`)).body.etag as string
    const save = (name: string) => A.client.req('PATCH', `/api/assets/${id}`, JSON.stringify({ name }), { 'content-type': 'application/json', 'if-match': etag })
    const results = await Promise.all([save('first.mp4'), save('second.mp4')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 412])
    const winner = (await results.find((r) => r.status === 200)!.json()).asset.name
    expect((await ctx().db.select({ name: assets.name }).from(assets).where(eq(assets.id, id)))[0].name).toBe(winner)
  })

  it('a write whose base changed between the check and the write is refused, for clips, spaces and brand kits', async () => {
    const A = await signup(t.app, 'Checker')
    const id = uniq('as_base')
    await ctx().db.insert(assets).values({ id, workspaceId: A.workspaceId, kind: 'video', name: 'base.mp4', mime: 'video/mp4', size: 1, status: 'ready', sourceKey: 'x', createdBy: await me(A.client), createdAt: Date.now(), updatedAt: Date.now() })
    const { changedMeanwhile } = await import('../etag')
    // the condition the PATCH route uses, against a name someone else just changed
    await expect(updateAsset(id, { name: 'mine.mp4' }, { only: eq(assets.name, 'what-I-read.mp4'), otherwise: () => changedMeanwhile('This clip') })).rejects.toMatchObject({ status: 412 })
    expect((await ctx().db.select({ name: assets.name }).from(assets).where(eq(assets.id, id)))[0].name).toBe('base.mp4')

    const { renameWorkspace, saveDefaultKit, storedDefaultKit } = await import('../routes/workspaces')
    const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team one' })).body.id as string
    const uid = await me(A.client)
    await expect(renameWorkspace(uid, ws, 'Mine', 'Team zero')).rejects.toMatchObject({ status: 412 })
    expect((await renameWorkspace(uid, ws, 'Mine', 'Team one')).name).toBe('Mine')

    const kit = { name: 'Kit', colors: ['#111111'], fonts: { headline: 'Inter', body: 'Inter' } }
    expect(await storedDefaultKit(ws)).toBeNull()
    // base "none saved yet", but someone saved one meanwhile
    await saveDefaultKit(ws, { ...kit, name: 'Theirs' })
    await expect(saveDefaultKit(ws, kit, { doc: null })).rejects.toMatchObject({ status: 412 })
    const theirs = await storedDefaultKit(ws)
    await expect(saveDefaultKit(ws, kit, { doc: { ...theirs!, name: 'Stale' } })).rejects.toMatchObject({ status: 412 })
    expect((await saveDefaultKit(ws, kit, { doc: theirs })).name).toBe('Kit')
  })

  it('two brand kit saves with the same base at once: one wins', async () => {
    const A = await signup(t.app, 'Kit racer')
    const url = `/api/workspaces/${A.workspaceId}/brand`
    const first = await A.client.req('GET', url)
    const etag = first.headers.get('etag')!
    const doc = await first.json()
    const save = (name: string) => A.client.req('PUT', url, JSON.stringify({ ...doc, name }), { 'content-type': 'application/json', 'if-match': etag })
    const results = await Promise.all([save('One'), save('Two')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 412])
  })
})

describe('the fair claim takes turns (carried)', () => {
  it('two workers claiming at the same moment give two spaces one slot each, not one space two', async () => {
    const A = await signup(t.app, 'Space A')
    const B = await signup(t.app, 'Space B')
    const [ua, ub] = [await me(A.client), await me(B.client)]
    for (let round = 0; round < 5; round++) {
      const base = Date.now() - 60_000
      const ids = [uniq('j_a1'), uniq('j_a2'), uniq('j_b1')]
      await ctx().db.insert(jobs).values([
        { id: ids[0], kind: 'export.render', status: 'queued', input: {}, workspaceId: A.workspaceId, userId: ua, createdAt: base, updatedAt: base },
        { id: ids[1], kind: 'export.render', status: 'queued', input: {}, workspaceId: A.workspaceId, userId: ua, createdAt: base + 1, updatedAt: base + 1 },
        { id: ids[2], kind: 'export.render', status: 'queued', input: {}, workspaceId: B.workspaceId, userId: ub, createdAt: base + 2, updatedAt: base + 2 },
      ])
      const only = { workspaces: [A.workspaceId, B.workspaceId] }
      const [x, y] = await Promise.all([claimNext('w_one', undefined, only), claimNext('w_two', undefined, only)])
      expect([x?.workspaceId, y?.workspaceId].sort()).toEqual([A.workspaceId, B.workspaceId].sort())
      await ctx().db.update(jobs).set({ status: 'cancelled' }).where(inArray(jobs.id, ids))
    }
  })
})
