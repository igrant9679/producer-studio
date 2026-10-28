// The dev mock has the usage, queue and job-history routes with the server's role checks (A-18, A-9, A-8).
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

describe('the dev mock: usage, queue and history', () => {
  it('reads usage for members only; owners alone turn the server’s AI key on or off and see per-person rows', async () => {
    const own = await call('GET', '/api/usage?workspaceId=ws_personal&days=7')
    expect(own.status).toBe(200)
    expect(own.body).toMatchObject({ workspaceId: 'ws_personal', days: 7, ai: { estimate: true }, builtinAi: { canChange: true } })
    expect(own.body.members).toBeDefined()
    expect((await call('GET', '/api/usage?workspaceId=ws_team')).body.members).toBeUndefined()
    expect((await call('GET', '/api/usage?workspaceId=ws_nope')).status).toBe(404)
    expect((await call('PUT', '/api/usage/builtin-ai', { workspaceId: 'ws_team', enabled: false })).status).toBe(403)
    expect((await call('PUT', '/api/usage/builtin-ai', { workspaceId: 'ws_client', enabled: true })).status).toBe(403)
    expect(await call('PUT', '/api/usage/builtin-ai', { workspaceId: 'ws_personal', enabled: false })).toEqual({ status: 200, body: { enabled: false } })
  })

  it('answers the queue and history routes (not the single-job route) the way the server does', async () => {
    expect(await call('GET', '/api/jobs/queue?workspaceId=ws_team')).toEqual({ status: 200, body: { jobs: {} } })
    expect((await call('GET', '/api/jobs/history?workspaceId=ws_team')).body).toEqual({ items: [] })
    expect((await call('GET', '/api/jobs/history?workspaceId=ws_team&status=queued')).status).toBe(400)
    expect((await call('POST', '/api/jobs/nope/retry')).status).toBe(404)
  })
})
