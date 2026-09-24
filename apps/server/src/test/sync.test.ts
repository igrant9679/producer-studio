import crypto from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

function bearer(token: string) {
  const c = new Client(t.app)
  return {
    json: async <T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await c.req(method, url, body, { authorization: `Bearer ${token}` })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : undefined }
    },
  }
}

describe('system', () => {
  it('GET /api/system is public and reports mode, ai provider and capabilities', async () => {
    const r = await new Client(t.app).json('GET', '/api/system')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ mode: 'cloud', ai: { provider: 'anthropic-api', available: false, model: 'claude-opus-5' } })
    expect(typeof r.body.version).toBe('string')
    expect(r.body.capabilities).toEqual({ transcribe: expect.any(Boolean), tts: expect.any(Boolean), render: expect.any(Boolean) })
  })
})

describe('device tokens', () => {
  it('create (cookie or email+password), authenticate with Bearer, list, revoke', async () => {
    const A = await signup(t.app)
    const created = await A.client.json('POST', '/api/devices', { name: 'Studio laptop' })
    expect(created.status).toBe(200)
    expect(created.body.token).toMatch(/^psd_/)
    const dev = bearer(created.body.token)
    const me = await dev.json('GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(A.email)
    // bearer works on workspace-scoped routes too
    expect((await dev.json('GET', `/api/projects?workspaceId=${A.workspaceId}`)).status).toBe(200)

    // link without a cookie using credentials
    const anon = new Client(t.app)
    const linked = await anon.json('POST', '/api/devices', { name: 'Desktop', email: A.email, password: 'correct-horse-1' })
    expect(linked.status).toBe(200)
    expect((await anon.json('POST', '/api/devices', { name: 'Desktop', email: A.email, password: 'wrong-password' })).status).toBe(401)
    expect((await anon.json('POST', '/api/devices', { name: 'No auth' })).status).toBe(401)

    const list = await dev.json('GET', '/api/devices')
    expect(list.body.map((d: { name: string }) => d.name).sort()).toEqual(['Desktop', 'Studio laptop'])
    expect(list.body.find((d: { id: string }) => d.id === created.body.deviceId).lastSeenAt).toBeGreaterThan(0)
    expect(list.body[0]).not.toHaveProperty('token')

    expect((await A.client.json('DELETE', `/api/devices/${created.body.deviceId}`)).body).toEqual({ ok: true })
    const revoked = await dev.json('GET', '/api/auth/me')
    expect(revoked.status).toBe(401)
    expect(revoked.body.code).toBe('unauthorized')
    // another user can't revoke A's device
    const B = await signup(t.app)
    expect((await B.client.json('DELETE', `/api/devices/${linked.body.deviceId}`)).status).toBe(404)
  })
})

describe('global ids', () => {
  it('accepts a client-supplied project id; idempotent in the same workspace, 409 across workspaces', async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    const id = crypto.randomUUID()
    const r = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, id, name: 'From desktop' })
    expect(r.status).toBe(200)
    expect(r.body.project.id).toBe(id)
    expect(r.body.summary.id).toBe(id)
    const again = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, id, name: 'Retry' })
    expect(again.status).toBe(200)
    expect(again.body.summary.name).toBe('From desktop')
    const clash = await B.client.json('POST', '/api/projects', { workspaceId: B.workspaceId, id })
    expect(clash.status).toBe(409)
    expect(clash.body).toMatchObject({ code: 'conflict', details: { exists: true } })
    expect((await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, id: 'bad id!' })).status).toBe(400)
  })

  it('push conflicts carry the current cloud project', async () => {
    const A = await signup(t.app)
    const { body } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Doc' })
    await A.client.json('PUT', `/api/projects/${body.project.id}`, { project: { ...body.project, name: 'Cloud edit' }, baseVersion: 1 })
    const r = await A.client.json('PUT', `/api/projects/${body.project.id}`, { project: { ...body.project, name: 'Desktop edit' }, baseVersion: 1 })
    expect(r.status).toBe(409)
    expect(r.body.details.version).toBe(2)
    expect(r.body.details.project).toMatchObject({ id: body.project.id, name: 'Cloud edit' })
  })

  it('uploads with a known assetId return 409 exists; sha256 is stored and verified', async () => {
    const A = await signup(t.app)
    const bytes = crypto.randomBytes(4096)
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const assetId = crypto.randomUUID()
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'a.png', mime: 'image/png', size: bytes.length, assetId, sha256: hash })
    expect(ticket.status).toBe(200)
    expect(ticket.body.assetId).toBe(assetId)
    await A.client.req('PUT', ticket.body.url, new Uint8Array(bytes), ticket.body.headers)
    const done = await A.client.json('POST', `/api/assets/${assetId}/complete`)
    expect(done.status).toBe(200)
    const again = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'a.png', mime: 'image/png', size: bytes.length, assetId, sha256: hash })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ code: 'conflict', details: { exists: true, sha256: hash } })

    // declared hash that doesn't match the bytes
    const other = crypto.randomUUID()
    const t2 = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'b.png', mime: 'image/png', size: 10, assetId: other, sha256: 'a'.repeat(64) })
    await A.client.req('PUT', t2.body.url, new Uint8Array(crypto.randomBytes(10)), t2.body.headers)
    expect((await A.client.json('POST', `/api/assets/${other}/complete`)).status).toBe(400)
  })
})

describe('change feed', () => {
  it('writes bump change_seq, deletes leave tombstones, and results page with `more`', async () => {
    const A = await signup(t.app)
    const base = await A.client.json('GET', '/api/sync/changes?since=0')
    expect(base.status).toBe(200)
    expect(base.body.workspaces.map((w: { id: string }) => w.id)).toContain(A.workspaceId)
    const c0 = base.body.cursor

    const p1 = (await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'One' })).body
    const p2 = (await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Two' })).body
    const ch1 = await A.client.json('GET', `/api/sync/changes?since=${c0}`)
    const ids1 = ch1.body.projects.map((p: { project: { id: string } }) => p.project.id)
    expect(ids1).toEqual([p1.project.id, p2.project.id])
    expect(ch1.body.projects[0].changeSeq).toBeGreaterThan(c0)
    expect(ch1.body.projects[1].changeSeq).toBeGreaterThan(ch1.body.projects[0].changeSeq)
    expect(ch1.body.cursor).toBe(ch1.body.projects[1].changeSeq)
    expect(ch1.body.more).toBe(false)

    // an update moves the project to a newer seq
    await A.client.json('PUT', `/api/projects/${p1.project.id}`, { project: { ...p1.project, name: 'One v2' }, baseVersion: 1 })
    const ch2 = await A.client.json('GET', `/api/sync/changes?since=${ch1.body.cursor}`)
    expect(ch2.body.projects).toHaveLength(1)
    expect(ch2.body.projects[0]).toMatchObject({ version: 2, summary: { name: 'One v2' } })

    // brand kit writes are in the feed too
    await A.client.json('PUT', `/api/workspaces/${A.workspaceId}/brand`, { name: 'Acme', colors: ['#000000'], fonts: { headline: 'Inter', body: 'Inter' } })
    // soft delete (trash) then hard delete → tombstone
    await A.client.json('PATCH', `/api/projects/${p2.project.id}`, { trashed: true })
    await A.client.json('DELETE', `/api/projects/${p2.project.id}`)
    const ch3 = await A.client.json('GET', `/api/sync/changes?since=${ch2.body.cursor}`)
    expect(ch3.body.brandKits).toHaveLength(1)
    expect(ch3.body.brandKits[0].doc.name).toBe('Acme')
    expect(ch3.body.deleted.projects).toEqual([p2.project.id])
    expect(ch3.body.projects).toEqual([]) // the row is gone; only the tombstone remains

    // paging
    const page1 = await A.client.json('GET', `/api/sync/changes?since=${c0}&limit=2`)
    expect(page1.body.more).toBe(true)
    const seen = [...page1.body.projects.map((p: { changeSeq: number }) => p.changeSeq)]
    let cursor = page1.body.cursor
    let more = page1.body.more
    let guard = 0
    while (more && guard++ < 20) {
      const pg = await A.client.json('GET', `/api/sync/changes?since=${cursor}&limit=2`)
      for (const p of pg.body.projects) seen.push(p.changeSeq)
      expect(pg.body.cursor).toBeGreaterThanOrEqual(cursor)
      cursor = pg.body.cursor
      more = pg.body.more
    }
    expect(more).toBe(false)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))

    // other users never see A's changes
    const B = await signup(t.app)
    const bc = await B.client.json('GET', '/api/sync/changes?since=0')
    expect(bc.body.projects.some((p: { project: { id: string } }) => p.project.id === p1.project.id)).toBe(false)
  })

  it('assets appear with sha256; joining a workspace republishes its content', async () => {
    const A = await signup(t.app)
    const V = await signup(t.app)
    const { body } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Shared later' })
    const bytes = crypto.randomBytes(1000)
    const tk = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'x.bin.png', mime: 'image/png', size: bytes.length })
    await A.client.req('PUT', tk.body.url, new Uint8Array(bytes), tk.body.headers)
    await A.client.json('POST', `/api/assets/${tk.body.assetId}/complete`)
    const feedA = await A.client.json('GET', '/api/sync/changes?since=0&limit=500')
    const asset = feedA.body.assets.find((a: { asset: { id: string } }) => a.asset.id === tk.body.assetId)
    expect(asset.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))

    const vCursor = (await V.client.json('GET', '/api/sync/changes?since=0')).body.cursor
    const inv = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites`, { email: V.email, role: 'editor' })
    await V.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const vc = await V.client.json('GET', `/api/sync/changes?since=${vCursor}&limit=500`)
    expect(vc.body.workspaces.map((w: { id: string }) => w.id)).toContain(A.workspaceId)
    expect(vc.body.projects.map((p: { project: { id: string } }) => p.project.id)).toContain(body.project.id)
    expect(vc.body.assets.map((a: { asset: { id: string } }) => a.asset.id)).toContain(tk.body.assetId)
  })
})
