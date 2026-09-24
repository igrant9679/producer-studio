import { beforeAll, describe, expect, it } from 'vitest'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

describe('auth', () => {
  it('signs up, reads me, logs out and back in', async () => {
    const c = new Client(t.app)
    const email = `alice${Date.now()}@example.com`
    const s = await c.json('POST', '/api/auth/signup', { email, password: 'password-123', name: 'Alice Doe' })
    expect(s.status).toBe(200)
    expect(s.body.user.email).toBe(email)
    expect(s.body.workspaces).toHaveLength(1)
    expect(s.body.workspaces[0]).toMatchObject({ name: "Alice's space", role: 'owner', personal: true, memberCount: 1 })
    expect(c.cookie).toMatch(/^ps_session=/)

    const me = await c.json('GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.user.name).toBe('Alice Doe')

    const out = await c.json('POST', '/api/auth/logout')
    expect(out.body).toEqual({ ok: true })
    expect(c.cookie).toBe('')
    expect((await c.json('GET', '/api/auth/me')).status).toBe(401)

    const login = await c.json('POST', '/api/auth/login', { email: email.toUpperCase(), password: 'password-123' })
    expect(login.status).toBe(200)
    expect((await c.json('GET', '/api/auth/me')).status).toBe(200)
  })

  it('rejects a wrong password with 401 and rate-limits repeated failures', async () => {
    const { email } = await signup(t.app)
    const c = new Client(t.app)
    const bad = await c.json('POST', '/api/auth/login', { email, password: 'nope-nope-nope' })
    expect(bad.status).toBe(401)
    expect(bad.body).toMatchObject({ code: 'unauthorized' })
    let last = 0
    for (let i = 0; i < 9; i++) last = (await c.json('POST', '/api/auth/login', { email, password: 'still-wrong' })).status
    expect(last).toBe(429)
  })

  it('rejects duplicate signups and invalid bodies', async () => {
    const { email } = await signup(t.app)
    const c = new Client(t.app)
    expect((await c.json('POST', '/api/auth/signup', { email, password: 'password-123', name: 'X' })).status).toBe(409)
    const inv = await c.json('POST', '/api/auth/signup', { email: 'not-an-email', password: 'short', name: '' })
    expect(inv.status).toBe(400)
    expect(inv.body.code).toBe('invalid')
  })
})

describe('projects', () => {
  it('saves with optimistic concurrency (409 on a stale baseVersion)', async () => {
    const { client, workspaceId } = await signup(t.app)
    const created = await client.json('POST', '/api/projects', { workspaceId, name: 'Concurrency', width: 1280, height: 720 })
    expect(created.status).toBe(200)
    const { project, version } = created.body
    expect(version).toBe(1)
    expect(project.width).toBe(1280)

    const ok = await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, name: 'Renamed' }, baseVersion: 1 })
    expect(ok.status).toBe(200)
    expect(ok.body.version).toBe(2)

    const stale = await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, name: 'Other tab' }, baseVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'conflict', details: { version: 2 } })

    const got = await client.json('GET', `/api/projects/${project.id}`)
    expect(got.body.version).toBe(2)
    expect(got.body.summary.name).toBe('Renamed')

    const bad = await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, tracks: 'nope' }, baseVersion: 2 })
    expect(bad.status).toBe(400)
  })

  it('lists, patches, duplicates, trashes and deletes', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { body } = await client.json('POST', '/api/projects', { workspaceId, name: 'Lifecycle' })
    const id = body.project.id
    expect((await client.json('GET', `/api/projects?workspaceId=${workspaceId}&trashed=0`)).body.map((p: { id: string }) => p.id)).toContain(id)
    const dup = await client.json('POST', `/api/projects/${id}/duplicate`)
    expect(dup.body.name).toBe('Lifecycle copy')
    expect((await client.json('DELETE', `/api/projects/${id}`)).status).toBe(409)
    const trashed = await client.json('PATCH', `/api/projects/${id}`, { trashed: true, isTemplate: true })
    expect(trashed.body).toMatchObject({ trashed: true, isTemplate: true })
    expect((await client.json('GET', `/api/projects?workspaceId=${workspaceId}&trashed=1`)).body).toHaveLength(1)
    expect((await client.json('DELETE', `/api/projects/${id}`)).body).toEqual({ ok: true })
    expect((await client.json('GET', `/api/projects/${id}`)).status).toBe(404)
  })

  it('creates projects from built-in and workspace templates', async () => {
    const { client, workspaceId } = await signup(t.app)
    const tpls = await client.json('GET', `/api/templates?workspaceId=${workspaceId}`)
    expect(tpls.status).toBe(200)
    const ids = tpls.body.map((x: { id: string }) => x.id)
    expect(ids).toContain('tpl:studio-dark')
    expect(ids).toContain('tpl:social-vertical')
    const vertical = await client.json('POST', '/api/projects', { workspaceId, templateId: 'tpl:social-vertical' })
    expect(vertical.status).toBe(200)
    expect(vertical.body.project).toMatchObject({ width: 1080, height: 1920 })
    const texts = vertical.body.project.tracks.flatMap((tr: { items: Array<{ type: string }> }) => tr.items).filter((i: { type: string }) => i.type === 'text')
    expect(texts.length).toBeGreaterThanOrEqual(4)
    // save as template, then instantiate with fresh ids
    await client.json('PATCH', `/api/projects/${vertical.body.project.id}`, { isTemplate: true })
    const fromWs = await client.json('POST', '/api/projects', { workspaceId, templateId: vertical.body.project.id, name: 'From my template' })
    expect(fromWs.status).toBe(200)
    const a = vertical.body.project.tracks.flatMap((tr: { items: Array<{ id: string }> }) => tr.items.map((i) => i.id))
    const b = fromWs.body.project.tracks.flatMap((tr: { items: Array<{ id: string }> }) => tr.items.map((i) => i.id))
    expect(b).toHaveLength(a.length)
    expect(b.some((id: string) => a.includes(id))).toBe(false)
  })
})

describe('workspace access control', () => {
  it("user B can't read or change user A's projects, assets or workspace", async () => {
    const A = await signup(t.app, 'Alpha')
    const B = await signup(t.app, 'Bravo')
    const { body } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Secret' })
    const id = body.project.id
    expect((await B.client.json('GET', `/api/projects/${id}`)).status).toBe(404)
    expect((await B.client.json('PUT', `/api/projects/${id}`, { project: body.project, baseVersion: 1 })).status).toBe(404)
    expect((await B.client.json('GET', `/api/projects?workspaceId=${A.workspaceId}`)).status).toBe(404)
    expect((await B.client.json('GET', `/api/workspaces/${A.workspaceId}/members`)).status).toBe(404)
    expect((await B.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'x.mp4', mime: 'video/mp4', size: 10 })).status).toBe(404)
    expect((await new Client(t.app).json('GET', `/api/projects/${id}`)).status).toBe(401)
  })

  it('invites add members with a role; viewers are read-only', async () => {
    const A = await signup(t.app, 'Owner')
    const V = await signup(t.app, 'Viewer')
    const inv = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites`, { email: V.email, role: 'viewer' })
    expect(inv.body.inviteUrl).toMatch(/\/invite\//)
    const token = inv.body.inviteUrl.split('/invite/')[1]
    const acc = await V.client.json('POST', `/api/invites/${token}/accept`)
    expect(acc.body).toMatchObject({ id: A.workspaceId, role: 'viewer' })
    const members = await V.client.json('GET', `/api/workspaces/${A.workspaceId}/members`)
    expect(members.body).toHaveLength(2)
    const { body } = await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Shared' })
    expect((await V.client.json('GET', `/api/projects/${body.project.id}`)).status).toBe(200)
    const w = await V.client.json('PUT', `/api/projects/${body.project.id}`, { project: body.project, baseVersion: 1 })
    expect(w.status).toBe(403)
    expect(w.body.code).toBe('forbidden')
  })

  it('brand kit get/put', async () => {
    const A = await signup(t.app)
    const g = await A.client.json('GET', `/api/workspaces/${A.workspaceId}/brand`)
    expect(g.body.fonts.headline).toBe('Montserrat')
    const doc = { name: 'Acme', colors: ['#101820', '#f2aa4c', '#ffffff'], fonts: { headline: 'Poppins', body: 'Inter' }, voice: 'am_michael' }
    expect((await A.client.json('PUT', `/api/workspaces/${A.workspaceId}/brand`, doc)).body).toEqual(doc)
    expect((await A.client.json('GET', `/api/workspaces/${A.workspaceId}/brand`)).body).toEqual(doc)
    expect((await A.client.json('PUT', `/api/workspaces/${A.workspaceId}/brand`, { ...doc, fonts: { headline: 'Comic Sans', body: 'Inter' } })).status).toBe(400)
  })
})

describe('AI without credentials', () => {
  it('returns 503 {code:server} instead of crashing', async () => {
    const A = await signup(t.app)
    const w = await A.client.json('POST', '/api/ai/write', { kind: 'headline', prompt: 'A video about spreadsheets' })
    expect(w.status).toBe(503)
    expect(w.body).toEqual({ code: 'server', error: 'AI is not configured on this server' })
    const voices = await A.client.json('GET', '/api/ai/voices')
    expect(voices.body.length).toBe(24)
  })
})
