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

  it('makes smooth slow motion of a video, refusing a bad range (E-17)', async () => {
    const job = await call('POST', '/api/assets/as_rec1/smooth', { from: 0, to: 2, fps: 60 })
    expect(job).toMatchObject({ status: 200, body: { kind: 'media.smooth' } })
    expect((await call('POST', '/api/assets/as_rec1/smooth', { from: 2, to: 1, fps: 60 })).status).toBe(400)
    expect([403, 404]).toContain((await call('POST', '/api/assets/as_nope/smooth', { from: 0, to: 1, fps: 60 })).status)
  })

  it('lets only owners invite', async () => {
    expect((await call('POST', '/api/workspaces/ws_team/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_personal/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(200)
  })
})
