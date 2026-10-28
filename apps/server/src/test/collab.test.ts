// Collaboration (Phase 5, release 2): share-link management (A-16), timecoded review comments (E-22), presence and
// the per-space activity feed (A-23).
import { beforeAll, describe, expect, it } from 'vitest'
import { PRESENCE_TTL_MS } from '@producer/core'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const db = async () => (await import('../context')).ctx().db
const schema = () => import('../db/schema')

/** A team space owned by A, with one member per role asked for. */
async function team(roles: Array<'owner' | 'editor' | 'viewer'> = ['editor']) {
  const A = await signup(t.app, 'Ada Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  const others = []
  for (const role of roles) {
    const M = await signup(t.app, `Member ${role}`)
    const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
    await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const me = (await M.client.json('GET', '/api/auth/me')).body
    others.push({ ...M, userId: me.user.id as string })
  }
  const aId = (await A.client.json('GET', '/api/auth/me')).body.user.id as string
  return { A: { ...A, userId: aId }, wsId: ws.id, others }
}

/** A project with a finished export whose file is a few real bytes (served like any export). */
async function exportedProject(client: Client, workspaceId: string, opts: { range?: { from: number; to: number } } = {}) {
  const p = (await client.json('POST', '/api/projects', { workspaceId, name: 'Launch' })).body.summary
  const ticket = (await client.json('POST', '/api/uploads', { workspaceId, filename: 'cut.mp4', mime: 'video/mp4', size: 4 })).body
  await client.req('PUT', ticket.url, new Uint8Array([1, 2, 3, 4]), ticket.headers)
  const { exportsTable, jobs } = await schema()
  const exportId = `ex_collab_${p.id}`
  const jobId = `job_collab_${p.id}`
  if (opts.range) {
    const now = Date.now()
    await (await db()).insert(jobs).values({ id: jobId, kind: 'export.render', status: 'done', input: { projectId: p.id, range: opts.range }, workspaceId, userId: 'u', projectId: p.id, createdAt: now, updatedAt: now })
  }
  await (await db()).insert(exportsTable).values({ id: exportId, projectId: p.id, workspaceId, assetId: ticket.assetId, jobId: opts.range ? jobId : null, name: 'Cut', resolution: '1080p', fps: 30, format: 'mp4', sizeBytes: 4, duration: 5, createdBy: 'u', createdAt: Date.now() })
  return { projectId: p.id as string, exportId }
}

async function events(workspaceId: string) {
  const { ctx } = await import('../context')
  const got: Array<{ event: string; data: any }> = []
  const stop = ctx().bus.subscribe(workspaceId, (e) => got.push({ event: e.event, data: e.data }))
  return { got, stop }
}

describe('share-link management (A-16)', () => {
  it('lists a project’s and a space’s links with who made them, views and last viewed; viewers look, editors manage', async () => {
    const { A, wsId, others } = await team(['viewer'])
    const [V] = others
    const one = await exportedProject(A.client, wsId)
    const two = await exportedProject(A.client, wsId)
    const l1 = (await A.client.json('POST', `/api/projects/${one.projectId}/share`, {})).body
    const l2 = (await A.client.json('POST', `/api/projects/${two.projectId}/share`, { allowComments: true })).body
    expect(l1).toMatchObject({ projectId: one.projectId, projectName: 'Launch', exportName: 'Cut', createdBy: { id: A.userId, name: 'Ada Owner' }, views: 0, expiresAt: null, expired: false, hasPassword: false, allowDownload: true, allowComments: false })
    expect(l2.allowComments).toBe(true)
    // a second link for the same export, on purpose
    const again = (await A.client.json('POST', `/api/projects/${one.projectId}/share`, {})).body
    expect(again.token).toBe(l1.token)
    const extra = (await A.client.json('POST', `/api/projects/${one.projectId}/share`, { new: true, allowDownload: false })).body
    expect(extra.token).not.toBe(l1.token)
    expect(extra.allowDownload).toBe(false)
    // views count page loads
    const anon = new Client(t.app)
    await anon.json('GET', `/api/share/${l1.token}`)
    await anon.json('GET', `/api/share/${l1.token}`)
    const list = (await V.client.json('GET', `/api/projects/${one.projectId}/shares`)).body as any[]
    const seen = list.find((l) => l.token === l1.token)
    expect(seen.views).toBe(2)
    expect(seen.lastViewedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|scrypt/)
    // the space's page lists every project's links
    const space = (await V.client.json('GET', `/api/workspaces/${wsId}/shares`)).body as any[]
    expect(space.map((l) => l.token).sort()).toEqual([l1.token, l2.token, extra.token].sort())
    // a viewer can't change or stop a link
    expect((await V.client.json('PATCH', `/api/share/${l1.token}`, { allowComments: true })).status).toBe(403)
    expect((await V.client.json('DELETE', `/api/share/${l1.token}`)).status).toBe(403)
    const O = await signup(t.app)
    expect((await O.client.json('GET', `/api/workspaces/${wsId}/shares`)).status).toBe(404)
  })

  it('an expiry stops the page, the video and the poster; clearing it brings them back', async () => {
    const { A, wsId } = await team([])
    const p = await exportedProject(A.client, wsId)
    const link = (await A.client.json('POST', `/api/projects/${p.projectId}/share`, {})).body
    const anon = new Client(t.app)
    expect((await anon.req('GET', `/api/share/${link.token}/video`)).status).toBe(200)
    const past = (await A.client.json('PATCH', `/api/share/${link.token}`, { expiresAt: Date.now() - 1000 })).body
    expect(past.expired).toBe(true)
    const r = await anon.json('GET', `/api/share/${link.token}`)
    expect(r.status).toBe(410)
    expect(r.body.error).toMatch(/expired/)
    expect((await anon.req('GET', `/api/share/${link.token}/video`)).status).toBe(410)
    await A.client.json('PATCH', `/api/share/${link.token}`, { expiresAt: Date.now() + 3600_000 })
    expect((await anon.json('GET', `/api/share/${link.token}`)).status).toBe(200)
    await A.client.json('PATCH', `/api/share/${link.token}`, { expiresAt: null })
    expect((await anon.json('GET', `/api/share/${link.token}`)).status).toBe(200)
  })

  it('a password locks the page and the video until unlocked; a new password locks old keys out', async () => {
    const { A, wsId } = await team([])
    const p = await exportedProject(A.client, wsId)
    const link = (await A.client.json('POST', `/api/projects/${p.projectId}/share`, {})).body
    expect((await A.client.json('PATCH', `/api/share/${link.token}`, { password: 'abc' })).status).toBe(400)
    const locked = (await A.client.json('PATCH', `/api/share/${link.token}`, { password: 'open sesame' })).body
    expect(locked.hasPassword).toBe(true)
    const anon = new Client(t.app)
    const r = await anon.json('GET', `/api/share/${link.token}`)
    expect(r.status).toBe(401)
    expect(r.body.details).toEqual({ password: true })
    expect(JSON.stringify(r.body)).not.toMatch(/Launch/)
    expect((await anon.req('GET', `/api/share/${link.token}/video`)).status).toBe(401)
    expect((await anon.json('POST', `/api/share/${link.token}/unlock`, { password: 'wrong' })).status).toBe(403)
    const { key } = (await anon.json('POST', `/api/share/${link.token}/unlock`, { password: 'open sesame' })).body
    expect(key).toMatch(/\./)
    const page = await anon.json('GET', `/api/share/${link.token}?k=${encodeURIComponent(key)}`)
    expect(page.status).toBe(200)
    expect(page.body.project.name).toBe('Launch')
    expect(page.body.videoUrl).toBe(`/api/share/${link.token}/video?k=${encodeURIComponent(key)}`)
    expect((await anon.req('GET', page.body.videoUrl)).status).toBe(200)
    expect((await anon.req('GET', `/api/share/${link.token}`, undefined, { 'x-share-key': key })).status).toBe(200)
    // a forged key or a changed password
    expect((await anon.json('GET', `/api/share/${link.token}?k=${encodeURIComponent(key.replace(/.$/, 'x'))}`)).status).toBe(401)
    await A.client.json('PATCH', `/api/share/${link.token}`, { password: 'another one' })
    expect((await anon.json('GET', `/api/share/${link.token}?k=${encodeURIComponent(key)}`)).status).toBe(401)
    await A.client.json('PATCH', `/api/share/${link.token}`, { password: null })
    expect((await anon.json('GET', `/api/share/${link.token}`)).status).toBe(200)
  })

  it('downloads: offered only when allowed; the video still plays when they are off', async () => {
    const { A, wsId } = await team([])
    const p = await exportedProject(A.client, wsId)
    const link = (await A.client.json('POST', `/api/projects/${p.projectId}/share`, {})).body
    const anon = new Client(t.app)
    const on = (await anon.json('GET', `/api/share/${link.token}`)).body
    expect(on.allowDownload).toBe(true)
    expect(on.downloadUrl).toBe(`/api/share/${link.token}/video?download=1`)
    const file = await anon.req('GET', on.downloadUrl)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-disposition')).toMatch(/attachment/)
    await A.client.json('PATCH', `/api/share/${link.token}`, { allowDownload: false })
    const off = (await anon.json('GET', `/api/share/${link.token}`)).body
    expect(off.allowDownload).toBe(false)
    expect(off.downloadUrl).toBeUndefined()
    expect((await anon.req('GET', `/api/share/${link.token}/video?download=1`)).status).toBe(403)
    expect((await anon.req('GET', `/api/share/${link.token}/video`)).status).toBe(200)
  })
})

describe('review comments (E-22)', () => {
  it('members comment at a time and a point, reply in threads, resolve and reopen; viewers comment too', async () => {
    const { A, wsId, others } = await team(['editor', 'viewer'])
    const [E, V] = others
    const p = (await A.client.json('POST', '/api/projects', { workspaceId: wsId, name: 'Cut' })).body.summary
    const live = await events(wsId)
    const root = (await V.client.json('POST', `/api/projects/${p.id}/comments`, { body: 'Logo is too small here', at: 12.5, x: 0.25, y: 0.75 })).body
    expect(root).toMatchObject({ body: 'Logo is too small here', at: 12.5, x: 0.25, y: 0.75, author: { id: V.userId, guest: false }, canEdit: true, canDelete: true })
    const reply = (await E.client.json('POST', `/api/projects/${p.id}/comments`, { body: 'Fixed', parentId: root.id, at: 99 })).body
    expect(reply.parentId).toBe(root.id)
    expect(reply.at).toBeUndefined()
    // a reply to a reply joins the thread
    const deep = (await A.client.json('POST', `/api/projects/${p.id}/comments`, { body: 'Thanks', parentId: reply.id })).body
    expect(deep.parentId).toBe(root.id)
    expect((await A.client.json('POST', `/api/projects/${p.id}/comments`, { body: '   ' })).status).toBe(400)
    const list = (await A.client.json('GET', `/api/projects/${p.id}/comments`)).body as any[]
    expect(list.map((c) => c.body)).toEqual(['Logo is too small here', 'Fixed', 'Thanks'])
    // the owner moderates; the viewer can't touch the editor's reply
    expect(list.find((c) => c.id === reply.id)).toMatchObject({ canEdit: false, canDelete: true })
    expect((await V.client.json('PATCH', `/api/comments/${reply.id}`, { body: 'nope' })).status).toBe(403)
    expect((await V.client.json('DELETE', `/api/comments/${reply.id}`)).status).toBe(403)
    // resolve: an editor, or the author of the thread
    const resolved = (await E.client.json('PATCH', `/api/comments/${root.id}`, { resolved: true })).body
    expect(resolved.resolved.by).toBe('Member editor')
    expect((await V.client.json('PATCH', `/api/comments/${root.id}`, { resolved: false })).body.resolved).toBeUndefined()
    expect((await E.client.json('PATCH', `/api/comments/${reply.id}`, { resolved: true })).status).toBe(400)
    // the author changes their words
    expect((await V.client.json('PATCH', `/api/comments/${root.id}`, { body: 'Logo too small' })).body.body).toBe('Logo too small')
    // removing the first comment removes its thread
    const gone = (await V.client.json('DELETE', `/api/comments/${root.id}`)).body
    expect(gone.removed.sort()).toEqual([root.id, reply.id, deep.id].sort())
    expect((await A.client.json('GET', `/api/projects/${p.id}/comments`)).body).toEqual([])
    // open editors heard every change
    expect(live.got.filter((e) => e.event === 'comment').length).toBeGreaterThanOrEqual(6)
    expect(live.got.find((e) => e.event === 'comment' && e.data.removed)?.data.removed).toHaveLength(3)
    live.stop()
    // outsiders see nothing
    const O = await signup(t.app)
    expect((await O.client.json('GET', `/api/projects/${p.id}/comments`)).status).toBe(404)
    expect((await O.client.json('POST', `/api/projects/${p.id}/comments`, { body: 'hi' })).status).toBe(404)
  })

  it('share-page visitors comment with a name when the link allows it, at times in the shared video', async () => {
    const { A, wsId } = await team([])
    // the export is of the range 5–15 s: 2 s into the video is 7 s into the project
    const p = await exportedProject(A.client, wsId, { range: { from: 5, to: 15 } })
    const link = (await A.client.json('POST', `/api/projects/${p.projectId}/share`, {})).body
    const anon = new Client(t.app)
    expect((await anon.json('GET', `/api/share/${link.token}/comments`)).status).toBe(403)
    expect((await anon.json('POST', `/api/share/${link.token}/comments`, { body: 'hi', name: 'Guest' })).status).toBe(403)
    await A.client.json('PATCH', `/api/share/${link.token}`, { allowComments: true })
    expect((await anon.json('GET', `/api/share/${link.token}`)).body.allowComments).toBe(true)
    expect((await anon.json('POST', `/api/share/${link.token}/comments`, { body: 'hi' })).status).toBe(400)
    const posted = (await anon.json('POST', `/api/share/${link.token}/comments`, { body: 'Love this cut', name: 'Client Carla', at: 2, x: 0.5, y: 0.5 })).body
    expect(posted).toMatchObject({ at: 2, author: { name: 'Client Carla', guest: true }, canEdit: false, canDelete: false })
    expect(posted.author.id).toBeUndefined()
    const team_ = (await A.client.json('GET', `/api/projects/${p.projectId}/comments`)).body as any[]
    expect(team_[0]).toMatchObject({ at: 7, author: { name: 'Client Carla', guest: true } })
    // a reply from the team shows on the share page
    await A.client.json('POST', `/api/projects/${p.projectId}/comments`, { body: 'Thank you!', parentId: posted.id })
    const onPage = (await anon.json('GET', `/api/share/${link.token}/comments`)).body as any[]
    expect(onPage.map((c) => [c.body, c.at])).toEqual([
      ['Love this cut', 2],
      ['Thank you!', undefined],
    ])
    expect(JSON.stringify(onPage)).not.toMatch(/workspaceId|email/)
    // a password-protected link wants its key for comments too
    await A.client.json('PATCH', `/api/share/${link.token}`, { password: 'letmein' })
    expect((await anon.json('GET', `/api/share/${link.token}/comments`)).status).toBe(401)
  })
})

describe('presence and activity (A-23)', () => {
  it('who has a project open: live, one entry per person, gone on close or when the beats stop', async () => {
    const { A, wsId, others } = await team(['editor', 'viewer'])
    const [E, V] = others
    const { resetPresence, sweepPresence } = await import('../services/presence')
    resetPresence()
    const p = (await A.client.json('POST', '/api/projects', { workspaceId: wsId, name: 'Live' })).body.summary
    const live = await events(wsId)
    expect((await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab1' })).body.people.map((x: any) => x.name)).toEqual(['Ada Owner'])
    await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab2' })
    await E.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'e1' })
    const now = (await V.client.json('GET', `/api/projects/${p.id}/presence`)).body
    expect(now.people.map((x: any) => [x.name, x.role])).toEqual([
      ['Ada Owner', 'owner'],
      ['Member editor', 'editor'],
    ])
    // A closes one tab: still there; then the other
    await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab1', open: false })
    expect((await V.client.json('GET', `/api/projects/${p.id}/presence`)).body.people).toHaveLength(2)
    await A.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'tab2', open: false })
    expect((await V.client.json('GET', `/api/projects/${p.id}/presence`)).body.people.map((x: any) => x.name)).toEqual(['Member editor'])
    // someone else's goodbye with the same tab id closes nothing
    await V.client.json('POST', `/api/projects/${p.id}/presence`, { client: 'e1', open: false })
    expect((await V.client.json('GET', `/api/projects/${p.id}/presence`)).body.people).toHaveLength(1)
    // the editor's tab stops beating
    sweepPresence(Date.now() + PRESENCE_TTL_MS + 1000)
    expect((await V.client.json('GET', `/api/projects/${p.id}/presence`)).body.people).toEqual([])
    const changes = live.got.filter((e) => e.event === 'presence').map((e) => e.data.people.length)
    expect(changes).toEqual([1, 2, 1, 0])
    live.stop()
    expect((await (await signup(t.app)).client.json('POST', `/api/projects/${p.id}/presence`, { client: 'x' })).status).toBe(404)
  })

  it('the space’s activity: created, renamed, shared, commented and member changes, newest first, in pages', async () => {
    const { A, wsId, others } = await team(['viewer'])
    const [V] = others
    const p = await exportedProject(A.client, wsId)
    await A.client.json('PATCH', `/api/projects/${p.projectId}`, { name: 'Launch v2' })
    const link = (await A.client.json('POST', `/api/projects/${p.projectId}/share`, {})).body
    await A.client.json('PATCH', `/api/share/${link.token}`, { allowComments: true, password: 'secret!' })
    await V.client.json('POST', `/api/projects/${p.projectId}/comments`, { body: 'Nice', at: 1 })
    await new Client(t.app).json('POST', `/api/share/${link.token}/comments`, { body: 'Guest note', name: 'Gus' }) // locked: refused, nothing recorded
    await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${V.userId}`, { role: 'editor' })
    await A.client.json('DELETE', `/api/share/${link.token}`)
    await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${V.userId}`)
    const page = (await A.client.json('GET', `/api/workspaces/${wsId}/activity`)).body
    const kinds = page.items.map((e: any) => e.kind)
    expect(kinds).toEqual(['member.removed', 'share.revoked', 'member.role', 'comment.added', 'share.changed', 'share.created', 'project.renamed', 'project.created', 'member.joined'])
    const byKind = Object.fromEntries(page.items.map((e: any) => [e.kind, e]))
    expect(byKind['project.renamed'].data).toEqual({ from: 'Launch', to: 'Launch v2' })
    expect(byKind['share.changed'].data.changes).toEqual(['password set', 'comments on'])
    expect(byKind['member.role']).toMatchObject({ actor: { name: 'Ada Owner' }, data: { member: 'Member viewer', role: 'editor' } })
    expect(byKind['comment.added'].actor.name).toBe('Member viewer')
    expect(byKind['member.joined'].actor.name).toBe('Member viewer')
    // pages
    const first = (await A.client.json('GET', `/api/workspaces/${wsId}/activity?limit=4`)).body
    expect(first.items).toHaveLength(4)
    const second = (await A.client.json('GET', `/api/workspaces/${wsId}/activity?limit=4&cursor=${first.nextCursor}`)).body
    expect(second.items[0].id).toBe(page.items[4].id)
    // the removed member, and outsiders, see none of it
    expect((await V.client.json('GET', `/api/workspaces/${wsId}/activity`)).status).toBe(404)
  })
})
