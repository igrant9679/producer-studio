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

  it('keeps version history like the server: viewers read, editors name and restore (P-15)', async () => {
    expect((await call('POST', '/api/projects/p_client1/versions', { name: 'x' })).status).toBe(403)
    expect((await call('GET', '/api/projects/p_client1/versions')).status).toBe(200)
    const p = (await call('POST', '/api/projects', { workspaceId: 'ws_team', name: 'History' })).body
    const id = p.summary.id as string
    const v1 = (await call('PUT', `/api/projects/${id}`, { project: { ...p.project, background: '#111111' }, baseVersion: p.version })).body.version
    await call('PUT', `/api/projects/${id}`, { project: { ...p.project, background: '#222222' }, baseVersion: v1 })
    const list = (await call('GET', `/api/projects/${id}/versions`)).body
    expect(list[0].current).toBe(true)
    const first = list.find((v: { version: number }) => v.version === v1)
    expect((await call('GET', `/api/projects/${id}/versions/${first.id}`)).body.project.background).toBe('#111111')
    expect((await call('GET', `/api/projects/${id}/versions/at/${v1}`)).status).toBe(200)
    const restored = await call('POST', `/api/projects/${id}/versions/${first.id}/restore`, { baseVersion: v1 + 1 })
    expect(restored.status).toBe(200)
    expect((await call('GET', `/api/projects/${id}`)).body.project.background).toBe('#111111')
    expect((await call('POST', `/api/projects/${id}/versions`, { name: 'Approved' })).body).toMatchObject({ label: 'named', name: 'Approved' })
  })

  it('lets only owners invite', async () => {
    expect((await call('POST', '/api/workspaces/ws_team/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_personal/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(200)
  })
})
