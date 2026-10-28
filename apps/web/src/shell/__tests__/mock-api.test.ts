// APP-40: the development mock refuses what the real API refuses, so viewer and invite problems show up in dev.
import { beforeAll, describe, expect, it } from 'vitest'
import { installMockApi } from '../dev/mockApi'

beforeAll(() => {
  localStorage.setItem('psMockUser', JSON.stringify({ id: 'u_demo', email: 'alex@example.com', name: 'Alex Rivera' }))
  installMockApi()
})

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { status: res.status, body: await res.json() }
}

describe('the dev mock API', () => {
  it('has a space where the demo user is a viewer', async () => {
    const me = await call('GET', '/api/auth/me')
    expect(me.body.workspaces.some((w: { role: string }) => w.role === 'viewer')).toBe(true)
  })

  it('refuses a viewer’s changes the way the server does', async () => {
    expect((await call('POST', '/api/projects', { workspaceId: 'ws_client', name: 'x' })).status).toBe(403)
    expect((await call('POST', '/api/uploads', { workspaceId: 'ws_client', filename: 'a.mp4', mime: 'video/mp4', size: 1 })).status).toBe(403)
    expect((await call('PATCH', '/api/projects/p_client1', { name: 'renamed' })).status).toBe(403)
    expect((await call('POST', '/api/projects/p_client1/share', {})).status).toBe(403)
    expect((await call('PUT', '/api/workspaces/ws_client/brand', { name: 'x', colors: [] })).status).toBe(403)
    const refused = await call('POST', '/api/projects/p_client1/duplicate')
    expect(refused).toEqual({ status: 403, body: expect.objectContaining({ error: 'Viewers cannot make changes in this workspace' }) })
  })

  it('lets an editor change things', async () => {
    expect((await call('POST', '/api/projects', { workspaceId: 'ws_team', name: 'x' })).status).toBe(200)
  })

  it('has the collaboration routes with the server’s rules (A-16, E-22, A-23)', async () => {
    // a viewer lists links and comments, but changes no link
    expect((await call('GET', '/api/workspaces/ws_client/shares')).status).toBe(200)
    const link = (await call('POST', '/api/projects/p_launch/share', {})).body
    expect(link).toMatchObject({ views: expect.any(Number), allowDownload: true, hasPassword: false })
    expect((await call('PATCH', `/api/share/${link.token}`, { password: 'abc' })).status).toBe(400)
    expect((await call('PATCH', `/api/share/${link.token}`, { password: 'sesame', allowComments: true })).body).toMatchObject({ hasPassword: true, allowComments: true })
    // the share page: locked until the key comes back
    const locked = await fetch(`/api/share/${link.token}`)
    expect(locked.status).toBe(401)
    const { key } = (await call('POST', `/api/share/${link.token}/unlock`, { password: 'sesame' })).body
    expect((await fetch(`/api/share/${link.token}`, { headers: { 'x-share-key': key } })).status).toBe(200)
    expect((await call('POST', '/api/projects/p_client1/comments', { body: 'From a viewer', at: 2 })).status).toBe(200)
    const own = await call('POST', '/api/projects/p_launch/comments', { body: 'Note', at: 1 })
    expect((await call('PATCH', `/api/comments/${own.body.id}`, { resolved: true })).body.resolved).toBeTruthy()
    expect((await call('GET', '/api/workspaces/ws_personal/activity')).body.items.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['share.changed', 'comment.added']))
    expect((await call('POST', '/api/projects/p_launch/presence', { client: 't', open: true })).body.people).toHaveLength(1)
  })

  it('lets only owners invite', async () => {
    expect((await call('POST', '/api/workspaces/ws_team/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_personal/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(200)
  })
})
