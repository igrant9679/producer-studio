// The dev mock has the account routes with the server's rules (R3-A), so a missing route or check shows up in dev.
import { beforeAll, describe, expect, it } from 'vitest'
import { installMockApi } from '../dev/mockApi'

beforeAll(() => {
  localStorage.setItem('psMockUser', JSON.stringify({ id: 'u_demo', email: 'alex@example.com', name: 'Alex Rivera', avatarColor: '#35e0ff', createdAt: 1 }))
  installMockApi()
})

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { status: res.status, body: await res.json() }
}

describe('the dev mock’s account routes', () => {
  it('serves the account, refuses a wrong password and keeps notification choices', async () => {
    expect((await call('GET', '/api/account')).body).toMatchObject({ user: { id: 'u_demo' }, mail: false, notifications: { browser: true, emailJobs: false } })
    expect((await call('POST', '/api/account/password', { current: 'nope', password: 'new-pass-123' })).status).toBe(403)
    expect((await call('POST', '/api/account/password', { current: 'password123', password: 'new-pass-123' })).status).toBe(200)
    expect((await call('PUT', '/api/account/notifications', { emailJobs: true })).body).toEqual({ browser: true, emailJobs: true })
    expect((await call('POST', '/api/auth/forgot', { email: 'alex@example.com' })).body).toEqual({ ok: true, mail: false })
    expect((await call('GET', '/api/account/sessions')).body[0].current).toBe(true)
  })

  it('resends invites and hands a space over only for owners', async () => {
    const ws = (await call('POST', '/api/workspaces', { name: 'Mine' })).body
    const inv = (await call('POST', `/api/workspaces/${ws.id}/invites`, { email: 'kim@example.com', role: 'editor' })).body
    const token = inv.inviteUrl.split('/invite/')[1]
    expect((await call('POST', `/api/workspaces/${ws.id}/invites/${token}/resend`)).body).toMatchObject({ status: 'pending', emailed: false })
    expect((await call('POST', `/api/workspaces/ws_team/invites/${token}/resend`)).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_team/members/u_3/transfer')).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_personal/members/u_demo/transfer')).status).toBe(409)
  })
})
