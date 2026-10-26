// Phase 1 hardening (evaluation of 25 Oct 2026): members, share links, live-update access, device tokens, voice
// consent, upload size and fingerprint, duplicate requests, project ids across workspaces, retention.
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Client, setup, signup, type TestEnv } from './helpers'

process.env.MAX_UPLOAD_MB = '1'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const db = async () => (await import('../context')).ctx().db
const schema = () => import('../db/schema')

/** A team space owned by A with B (and optionally more people) joined. */
async function team(roles: Array<'owner' | 'editor' | 'viewer'> = ['editor']) {
  const A = await signup(t.app, 'Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  const others = []
  for (const role of roles) {
    const M = await signup(t.app, 'Member')
    const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
    await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const me = (await M.client.json('GET', '/api/auth/me')).body
    others.push({ ...M, userId: me.user.id as string })
  }
  const aId = (await A.client.json('GET', '/api/auth/me')).body.user.id as string
  return { A: { ...A, userId: aId }, wsId: ws.id, others }
}

describe('members', () => {
  it('owners change roles and remove people; a space keeps one owner; anyone can leave', async () => {
    const { A, wsId, others } = await team(['editor', 'viewer'])
    const [B, C] = others
    expect((await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${C.userId}`, { role: 'editor' })).status).toBe(200)
    expect((await B.client.json('PATCH', `/api/workspaces/${wsId}/members/${C.userId}`, { role: 'viewer' })).status).toBe(403)
    // the only owner can't demote themselves or leave
    expect((await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${A.userId}`, { role: 'editor' })).status).toBe(409)
    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${A.userId}`)).status).toBe(409)
    // a member leaves on their own
    expect((await C.client.json('DELETE', `/api/workspaces/${wsId}/members/${C.userId}`)).status).toBe(200)
    expect((await C.client.json('GET', `/api/workspaces/${wsId}/members`)).status).toBe(404)
    // an editor can't remove someone else
    expect((await B.client.json('DELETE', `/api/workspaces/${wsId}/members/${A.userId}`)).status).toBe(403)
    // promote B, then A can leave
    await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${B.userId}`, { role: 'owner' })
    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${A.userId}`)).status).toBe(200)
    const left = (await B.client.json('GET', `/api/workspaces/${wsId}/members`)).body as Array<{ userId: string; role: string }>
    expect(left.map((m) => [m.userId, m.role])).toEqual([[B.userId, 'owner']])
  })

  it('removing someone withdraws the invites still waiting for them', async () => {
    const { A, wsId, others } = await team(['editor'])
    const [B] = others
    const again = (await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: B.email, role: 'owner' })).body.inviteUrl.split('/invite/')[1]
    await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${B.userId}`)
    expect((await B.client.json('POST', `/api/invites/${again}/accept`)).status).toBe(410)
  })

  it("nobody can be removed from their own personal space", async () => {
    const A = await signup(t.app, 'Solo')
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    expect((await A.client.json('DELETE', `/api/workspaces/${A.workspaceId}/members/${me}`)).status).toBe(409)
  })
})

describe('live updates', () => {
  it('a removed member stream receives the change and then closes', async () => {
    const { A, wsId, others } = await team(['editor'])
    const [B] = others
    const res = await B.client.req('GET', `/api/events?workspaceId=${wsId}`)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const ended = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return true
        text += dec.decode(value)
      }
    })()
    await new Promise((r) => setTimeout(r, 200))
    await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${B.userId}`)
    const closed = await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 8000))])
    expect(closed).toBe(true)
    expect(text).toContain('event: workspace')
  })
})

describe('share links', () => {
  async function exported(client: Client, workspaceId: string) {
    const p = (await client.json('POST', '/api/projects', { workspaceId, name: 'Launch' })).body.summary
    const { exportsTable } = await schema()
    const mk = async (n: number) => {
      const id = `ex_test_${p.id}_${n}`
      await (await db()).insert(exportsTable).values({ id, projectId: p.id, workspaceId, assetId: `as_none_${n}`, name: `Cut ${n}`, resolution: '1080p', fps: 30, format: 'mp4', sizeBytes: 10, duration: 5, createdBy: 'u', createdAt: Date.now() + n })
      return id
    }
    return { projectId: p.id as string, mk }
  }

  it('needs an export, reuses its link, lists, and stops sharing', async () => {
    const A = await signup(t.app)
    const { projectId, mk } = await exported(A.client, A.workspaceId)
    const none = await A.client.json('POST', `/api/projects/${projectId}/share`, {})
    expect(none.status).toBe(409)
    expect(none.body.error).toMatch(/Export the video first/)
    const e1 = await mk(1)
    const s1 = (await A.client.json('POST', `/api/projects/${projectId}/share`, {})).body
    expect(s1.exportId).toBe(e1)
    expect((await A.client.json('POST', `/api/projects/${projectId}/share`, { exportId: e1 })).body.token).toBe(s1.token)
    // a newer export doesn't change what the existing link shows
    await mk(2)
    const pub = await new Client(t.app).json('GET', `/api/share/${s1.token}`)
    expect(pub.status).toBe(200)
    expect(Object.keys(pub.body.project).sort()).toEqual(['duration', 'height', 'name', 'updatedAt', 'width'])
    expect(JSON.stringify(pub.body)).not.toMatch(/workspaceId|createdBy|ws_|"id"/)
    expect((await A.client.json('GET', `/api/projects/${projectId}/shares`)).body.map((l: { token: string }) => l.token)).toEqual([s1.token])
    // only an editor of the space stops sharing; then the link is gone for everyone
    expect((await new Client(t.app).json('DELETE', `/api/share/${s1.token}`)).status).toBe(401)
    const outsider = await signup(t.app)
    expect((await outsider.client.json('DELETE', `/api/share/${s1.token}`)).status).toBe(404)
    expect((await A.client.json('DELETE', `/api/share/${s1.token}`)).status).toBe(200)
    expect((await new Client(t.app).json('GET', `/api/share/${s1.token}`)).status).toBe(404)
  })

  it('a link from before pinning is pinned to what it shows now', async () => {
    const A = await signup(t.app)
    const { projectId, mk } = await exported(A.client, A.workspaceId)
    const first = await mk(1)
    const { shareLinks } = await schema()
    await (await db()).insert(shareLinks).values({ token: `legacy_${projectId}`, projectId, exportId: null, createdBy: 'u', createdAt: Date.now() })
    await new Client(t.app).json('GET', `/api/share/legacy_${projectId}`)
    await mk(2)
    const row = (await (await db()).select().from(shareLinks).where(eq(shareLinks.token, `legacy_${projectId}`)))[0]
    expect(row.exportId).toBe(first)
  })
})

describe('device tokens', () => {
  it("a device token can't create more device tokens, and an unused one expires", async () => {
    const A = await signup(t.app)
    const dev = (await A.client.json('POST', '/api/devices', { name: 'Laptop' })).body
    const viaToken = await t.app.request('/api/devices', { method: 'POST', headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Copy' }) })
    expect(viaToken.status).toBe(403)
    const withPassword = await new Client(t.app).json('POST', '/api/devices', { name: 'Desktop', email: A.email, password: 'correct-horse-1' })
    expect(withPassword.status).toBe(200)
    const { devices } = await schema()
    await (await db()).update(devices).set({ lastSeenAt: Date.now() - 91 * 24 * 3600 * 1000 }).where(eq(devices.id, dev.deviceId))
    const stale = await t.app.request('/api/auth/me', { headers: { authorization: `Bearer ${dev.token}` } })
    expect(stale.status).toBe(401)
  })
})

describe('voice profiles pushed by desktops', () => {
  it('keeps the first consent record, refuses other computers, and clamps future timestamps', async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    const inv = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites`, { email: B.email, role: 'editor' })
    await B.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const tokA = (await A.client.json('POST', '/api/devices', { name: 'A desktop' })).body.token
    const tokB = (await B.client.json('POST', '/api/devices', { name: 'B desktop' })).body.token
    const push = (tok: string, over: Record<string, unknown>) =>
      t.app.request('/api/voice/profiles/vp_testvoice1', {
        method: 'PUT',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: A.workspaceId, name: 'Narrator', kind: 'clone', engine: 'omni', consent: { statement: 'I am the speaker', attestedBy: 'A', attestedAt: 1000 }, createdAt: 1000, updatedAt: 2000, ...over }),
      })
    expect((await push(tokA, {})).status).toBe(200)
    // another member's computer can't rewrite it
    expect((await push(tokB, { name: 'Hijacked', updatedAt: 3000 })).status).toBe(403)
    // the owner's own update can't replace consent, and a far-future time is clamped to now
    const far = Date.now() + 365 * 24 * 3600 * 1000
    const upd = await push(tokA, { name: 'Narrator 2', consent: { statement: 'changed', attestedBy: 'X', attestedAt: 5 }, updatedAt: far })
    expect(upd.status).toBe(200)
    const { voiceProfiles } = await schema()
    const row = (await (await db()).select().from(voiceProfiles).where(eq(voiceProfiles.id, 'vp_testvoice1')))[0]
    expect(row.name).toBe('Narrator 2')
    expect(row.consent).toMatchObject({ statement: 'I am the speaker', attestedBy: 'A' })
    expect(row.updatedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('uploads', () => {
  it('a file larger than the limit that reached storage anyway is refused on complete', async () => {
    const A = await signup(t.app)
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'big.mp4', mime: 'video/mp4', size: 10 })
    const { assets } = await schema()
    const row = (await (await db()).select().from(assets).where(eq(assets.id, ticket.body.assetId)))[0]
    const { ctx } = await import('../context')
    await ctx().storage.put(row.sourceKey, Buffer.alloc(1024 * 1024 + 10))
    const done = await A.client.json('POST', `/api/assets/${ticket.body.assetId}/complete`)
    expect(done.status).toBe(413)
    const after = (await A.client.json('GET', `/api/assets/${ticket.body.assetId}`)).body
    expect(after.status).toBe('error')
    expect(await ctx().storage.stat(row.sourceKey)).toBeNull()
  })

  it('two completes at once queue processing once', async () => {
    const A = await signup(t.app)
    const bytes = new Uint8Array(64)
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'twice.mp4', mime: 'video/mp4', size: bytes.length })
    await A.client.req('PUT', ticket.body.url, bytes, { 'content-type': 'video/mp4' })
    const [r1, r2] = await Promise.all([A.client.json('POST', `/api/assets/${ticket.body.assetId}/complete`), A.client.json('POST', `/api/assets/${ticket.body.assetId}/complete`)])
    expect([r1.status, r2.status]).toEqual([200, 200])
    const { jobs } = await schema()
    const queued = await (await db()).select().from(jobs).where(and(eq(jobs.workspaceId, A.workspaceId), eq(jobs.kind, 'asset.process')))
    expect(queued).toHaveLength(1)
  })

  it("won't attach work to another workspace's project", async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    const p = (await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Mine' })).body.summary
    const up = await B.client.json('POST', '/api/uploads', { workspaceId: B.workspaceId, filename: 'x.mp4', mime: 'video/mp4', size: 10, projectId: p.id })
    expect(up.status).toBe(404)
    // a project id the cloud hasn't seen yet is fine (desktops push media before projects)
    expect((await B.client.json('POST', '/api/uploads', { workspaceId: B.workspaceId, filename: 'y.mp4', mime: 'video/mp4', size: 10, projectId: 'p_not_synced_yet' })).status).toBe(200)
  })
})

describe('duplicate requests', () => {
  it('two sign-ups with one email give one account and a clean conflict', async () => {
    const email = `twice${Date.now()}@example.com`
    const go = () => new Client(t.app).json('POST', '/api/auth/signup', { email, password: 'correct-horse-1', name: 'Twice' })
    const [r1, r2] = await Promise.all([go(), go()])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
  })

  it("another workspace's project id gets a plain conflict that says nothing about it", async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    const id = `p_${Date.now()}shared`
    await A.client.json('POST', '/api/projects', { workspaceId: A.workspaceId, id, name: 'A' })
    const clash = await B.client.json('POST', '/api/projects', { workspaceId: B.workspaceId, id, name: 'B' })
    expect(clash.status).toBe(409)
    expect(clash.body.details).toBeUndefined()
  })
})

describe('retention', () => {
  it('prunes expired sessions, old finished jobs and spent invites, and keeps the rest', async () => {
    const A = await signup(t.app)
    const { jobs, sessions, invites } = await schema()
    const d = await db()
    const old = Date.now() - 40 * 24 * 3600 * 1000
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    await d.insert(sessions).values({ id: `s_expired_${Date.now()}`, userId: me, createdAt: old, expiresAt: old })
    await d.insert(jobs).values([
      { id: `j_old_${Date.now()}`, kind: 'ai.tts', status: 'done', progress: 1, message: 'Done', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: old, updatedAt: old },
      { id: `j_new_${Date.now()}`, kind: 'ai.tts', status: 'done', progress: 1, message: 'Done', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: Date.now(), updatedAt: Date.now() },
      { id: `j_run_${Date.now()}`, kind: 'ai.tts', status: 'queued', progress: 0, message: 'Queued', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: old, updatedAt: old },
    ])
    await d.insert(invites).values([
      { token: `inv_old_${Date.now()}`, workspaceId: A.workspaceId, email: 'x@example.com', role: 'viewer', createdBy: me, createdAt: old },
      { token: `inv_new_${Date.now()}`, workspaceId: A.workspaceId, email: 'y@example.com', role: 'viewer', createdBy: me, createdAt: Date.now(), expiresAt: Date.now() + 1000 },
    ])
    const { pruneOldRows } = await import('../services/retention')
    const r = await pruneOldRows()
    expect(r.sessions).toBeGreaterThanOrEqual(1)
    expect(r.jobs).toBeGreaterThanOrEqual(1)
    expect(r.invites).toBeGreaterThanOrEqual(1)
    const left = await d.select({ id: jobs.id, status: jobs.status }).from(jobs).where(eq(jobs.workspaceId, A.workspaceId))
    expect(left.map((j) => j.status).sort()).toEqual(['done', 'queued'])
    expect((await d.select().from(invites).where(eq(invites.workspaceId, A.workspaceId))).map((i) => i.email)).toEqual(['y@example.com'])
  })
})
