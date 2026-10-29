// The change feed desktops pull (R4-C D-6 and the carried items): a cursor that never skips a change committed late,
// tombstone compaction that sends a reader below it back to a full resync, a space's other brand kits and font files,
// and a desktop's project delete taking its review comments with it.
import { beforeAll, describe, expect, it } from 'vitest'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const feed = async (c: Client, since: number) => (await c.json('GET', `/api/sync/changes?since=${since}&limit=500`)).body
const ids = (page: { projects: Array<{ project: { id: string } }> }) => page.projects.map((p) => p.project.id)

describe('a change committed late is never skipped (real Postgres)', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)('holds `safe` below a transaction still open on another connection, then delivers it', async () => {
    const { default: postgres } = await import('postgres')
    const A = await signup(t.app)
    const slow = (await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Slow' })).body.summary.id
    const c0 = (await feed(A.client, 0)).cursor
    // a real transaction on its own connection: it takes its change number now and commits only when told to
    const other = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: (seq: number) => void
    const took = new Promise<number>((r) => (started = r))
    const tx = other.begin(async (q) => {
      const [row] = await q`UPDATE projects SET name = 'Slow, committed late' WHERE id = ${slow} RETURNING change_seq::text AS s`
      started(Number(row.s))
      await gate
    })
    const slowSeq = await took
    // newer changes commit meanwhile
    for (let i = 0; i < 20; i++) await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: `Newer ${i}` })
    const page = await feed(A.client, c0)
    expect(page.cursor).toBeGreaterThan(slowSeq)
    expect(ids(page)).not.toContain(slow)
    // the cursor is past the slow change, but the resume point isn't
    expect(page.safe).toBeLessThan(slowSeq)
    release()
    await tx
    await other.end()
    const resumed = await feed(A.client, page.safe)
    expect(resumed.projects.find((p: { project: { id: string } }) => p.project.id === slow)?.summary.name).toBe('Slow, committed late')
    // resuming from the cursor instead (what a naive reader does) would have skipped it for good
    expect(ids(await feed(A.client, page.cursor))).not.toContain(slow)
  })
})

describe('tombstone compaction', () => {
  it('a reader below the compaction horizon is told to resync; one above it, or starting from 0, is not', async () => {
    const { compactTombstones, syncHorizon } = await import('../services/tombstones')
    const A = await signup(t.app)
    const { body: p } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Gone soon' })
    const before = (await feed(A.client, 0)).cursor
    await A.client.json('PATCH', `/api/projects/${p.project.id}`, { trashed: true })
    expect((await A.client.json('DELETE', `/api/projects/${p.project.id}`)).status).toBe(200)
    const withDelete = await feed(A.client, before)
    expect(withDelete.deleted.projects).toContain(p.project.id)
    expect(withDelete.resync).toBeUndefined()

    // nothing is old enough yet; 0 keeps them forever
    expect(await compactTombstones(30)).toBe(0)
    expect(await compactTombstones(0, Date.now() + 365 * 86_400_000)).toBe(0)
    // a year on, 30 days' retention lets them go and raises the horizon
    expect(await compactTombstones(30, Date.now() + 365 * 86_400_000)).toBeGreaterThan(0)
    expect(await syncHorizon()).toBeGreaterThanOrEqual(withDelete.cursor)

    const stale = await feed(A.client, before)
    expect(stale.resync).toBe(true)
    // the page still comes (older desktops carry on as before), just without the delete that's gone
    expect(stale.deleted.projects).not.toContain(p.project.id)
    expect((await feed(A.client, 0)).resync).toBeUndefined()
    expect((await feed(A.client, await syncHorizon())).resync).toBeUndefined()
  })
})

const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, ...new Array(60).fill(7)]) // 'wOF2' and some bytes

describe('a space’s other brand kits and font files sync', () => {
  it('come in the feed, go up with a desktop’s own ids, and their deletes follow', async () => {
    const A = await signup(t.app)
    const ws = A.workspaceId
    const c0 = (await feed(A.client, 0)).cursor
    const kit = (await A.client.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items[0].doc

    // a font file made on a desktop, under its own id
    const put = await A.client.req('PUT', `/api/sync/brand-fonts/bf_desk1?workspaceId=${ws}&family=Desk%20Sans&weight=700`, FONT, { 'content-type': 'application/octet-stream' })
    expect(put.status).toBe(200)
    expect((await put.json()).family).toBe('Desk Sans')
    // sending it again is harmless
    expect((await A.client.req('PUT', `/api/sync/brand-fonts/bf_desk1?workspaceId=${ws}&family=Desk%20Sans&weight=700`, FONT, { 'content-type': 'application/octet-stream' })).status).toBe(200)
    const file = await A.client.req('GET', '/api/sync/brand-fonts/bf_desk1/file')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(FONT)

    // a kit using it, under the desktop's id
    const doc = { ...kit, name: 'Desk kit', fonts: { headline: 'Desk Sans', body: kit.fonts.body } }
    expect((await A.client.json('PUT', '/api/sync/brand-kits/bk_desk1', { workspaceId: ws, doc })).status).toBe(200)
    const kits = (await A.client.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items
    expect(kits.find((k: { id: string }) => k.id === 'bk_desk1')?.doc.customFonts).toEqual(['Desk Sans'])

    const page = await feed(A.client, c0)
    expect(page.brandFonts.map((f: { id: string }) => f.id)).toEqual(['bf_desk1'])
    expect(page.extraBrandKits.map((k: { id: string; doc: { name: string } }) => [k.id, k.doc.name])).toEqual([['bk_desk1', 'Desk kit']])
    // a font still used by a kit can't go; the kit first
    expect((await A.client.json('POST', '/api/sync/brand-fonts/bf_desk1/delete')).status).toBe(409)
    expect((await A.client.json('POST', '/api/sync/brand-kits/bk_desk1/delete')).status).toBe(200)
    expect((await A.client.json('POST', '/api/sync/brand-fonts/bf_desk1/delete')).status).toBe(200)
    const after = await feed(A.client, page.cursor)
    expect(after.deleted.brandKits).toEqual(['bk_desk1'])
    expect(after.deleted.brandFonts).toEqual(['bf_desk1'])
    expect((await A.client.json('POST', '/api/sync/brand-kits/bk_desk1/delete')).status).toBe(404)
  })

  it('only members of that space (editors) push them', async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    const kit = (await A.client.json('GET', `/api/workspaces/${A.workspaceId}/brand-kits`)).body.items[0].doc
    expect((await B.client.json('PUT', '/api/sync/brand-kits/bk_other', { workspaceId: A.workspaceId, doc: kit })).status).toBe(404)
    expect((await B.client.req('PUT', `/api/sync/brand-fonts/bf_other?workspaceId=${A.workspaceId}&family=X`, FONT)).status).toBe(404)
    // an id already used in another space is refused
    expect((await A.client.json('PUT', '/api/sync/brand-kits/bk_mine', { workspaceId: A.workspaceId, doc: kit })).status).toBe(200)
    expect((await B.client.json('PUT', '/api/sync/brand-kits/bk_mine', { workspaceId: B.workspaceId, doc: kit })).status).toBe(409)
  })
})

describe('a project deleted through desktop sync', () => {
  it('takes its review comments with it, as a delete on the web does', async () => {
    const { ctx } = await import('../context')
    const { comments } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const A = await signup(t.app)
    const { body: p } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Reviewed' })
    expect((await A.client.json('POST', `/api/projects/${p.project.id}/comments`, { body: 'Tighten the intro', at: 1 })).status).toBe(200)
    const count = async () => (await ctx().db.select().from(comments).where(eq(comments.projectId, p.project.id))).length
    expect(await count()).toBe(1)
    expect((await A.client.json('POST', `/api/sync/projects/${p.project.id}/delete`, { baseVersion: p.version })).status).toBe(200)
    expect(await count()).toBe(0)
  })
})
