// Version history (P-15): every save is kept and thinned with age, versions are listed, read, named and restored.
import { beforeAll, describe, expect, it } from 'vitest'
import { setup, signup, type TestEnv } from './helpers'
import { versionsToKeep } from '../services/versions'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

async function team(role: 'editor' | 'viewer') {
  const A = await signup(t.app, 'Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  const M = await signup(t.app, 'Member')
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
  await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  return { A, M, wsId: ws.id }
}

describe('version history', () => {
  it('keeps each save with its author, time and size, newest first, and marks the current one', async () => {
    const { client, workspaceId } = await signup(t.app, 'Dana')
    const { project, version } = (await client.json('POST', '/api/projects', { workspaceId, name: 'Cut' })).body
    let v = version
    for (const bg of ['#111111', '#222222', '#333333']) v = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: bg }, baseVersion: v })).body.version
    const list = (await client.json('GET', `/api/projects/${project.id}/versions`)).body
    expect(list.map((x: { version: number }) => x.version)).toEqual([v, v - 1, v - 2])
    expect(list[0]).toMatchObject({ label: 'autosave', authorName: 'Dana', current: true })
    expect(list[1].current).toBeUndefined()
    expect(list[0].sizeBytes).toBeGreaterThan(100)
    const one = (await client.json('GET', `/api/projects/${project.id}/versions/${list[2].id}`)).body
    expect(one.project.background).toBe('#111111')
    expect((await client.json('GET', `/api/projects/${project.id}/versions/at/${v - 1}`)).body.project.background).toBe('#222222')
  })

  it('restores a version as a new save, keeping what it replaced as "before restore"', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { project, version } = (await client.json('POST', '/api/projects', { workspaceId, name: 'Cut' })).body
    const v1 = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#aa0000' }, baseVersion: version })).body.version
    const v2 = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#00bb00' }, baseVersion: v1 })).body.version
    const list = (await client.json('GET', `/api/projects/${project.id}/versions`)).body
    const red = list.find((x: { version: number }) => x.version === v1)
    // a stale base is refused
    expect((await client.json('POST', `/api/projects/${project.id}/versions/${red.id}/restore`, { baseVersion: v1 })).status).toBe(409)
    const r = await client.json('POST', `/api/projects/${project.id}/versions/${red.id}/restore`, { baseVersion: v2 })
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(v2 + 1)
    expect((await client.json('GET', `/api/projects/${project.id}`)).body.project.background).toBe('#aa0000')
    const after = (await client.json('GET', `/api/projects/${project.id}/versions`)).body
    expect(after[0]).toMatchObject({ version: v2 + 1, current: true, note: `Restored from version ${v1}` })
    expect(after.find((x: { version: number }) => x.version === v2).label).toBe('before-restore')
  })

  it('names the current version and keeps a named one however old', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { project } = (await client.json('POST', '/api/projects', { workspaceId, name: 'Cut' })).body
    // made before any save: there is no version yet, so naming keeps one
    const named = await client.json('POST', `/api/projects/${project.id}/versions`, { name: 'Sent to client' })
    expect(named.body).toMatchObject({ label: 'named', name: 'Sent to client', current: true })
    const renamed = await client.json('PATCH', `/api/projects/${project.id}/versions/${named.body.id}`, { name: 'Approved' })
    expect(renamed.body.name).toBe('Approved')
    const unnamed = await client.json('PATCH', `/api/projects/${project.id}/versions/${named.body.id}`, { name: null })
    expect(unnamed.body).toMatchObject({ label: 'autosave' })
    expect(unnamed.body.name).toBeUndefined()
  })

  it('lets viewers read the history but only editors name or restore', async () => {
    const { A, M, wsId } = await team('viewer')
    const { project, version } = (await A.client.json('POST', '/api/projects', { workspaceId: wsId, name: 'Team cut' })).body
    await A.client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#010101' }, baseVersion: version })
    const list = await M.client.json('GET', `/api/projects/${project.id}/versions`)
    expect(list.status).toBe(200)
    expect((await M.client.json('POST', `/api/projects/${project.id}/versions/${list.body[0].id}/restore`, {})).status).toBe(403)
    expect((await M.client.json('POST', `/api/projects/${project.id}/versions`, { name: 'x' })).status).toBe(403)
    const stranger = await signup(t.app)
    expect((await stranger.client.json('GET', `/api/projects/${project.id}/versions`)).status).toBe(404)
  })

  it('keeps the last PROJECT_VERSIONS_KEEP saves', async () => {
    process.env.PROJECT_VERSIONS_KEEP = '3'
    try {
      const { client, workspaceId } = await signup(t.app)
      const { project, version } = (await client.json('POST', '/api/projects', { workspaceId, name: 'Busy' })).body
      let v = version
      for (let i = 0; i < 6; i++) v = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: `#00000${i}` }, baseVersion: v })).body.version
      const list = (await client.json('GET', `/api/projects/${project.id}/versions`)).body
      // the newest three, and nothing older: they are all in the same hour, whose newest is among them
      expect(list.map((x: { version: number }) => x.version)).toEqual([v, v - 1, v - 2])
    } finally {
      delete process.env.PROJECT_VERSIONS_KEEP
    }
  })
})

describe('thinning with age', () => {
  const H = 3600_000
  const now = Date.UTC(2026, 9, 28, 12, 0, 0)
  it('keeps the newest N, one an hour for a week, one a day after that, and every named one', () => {
    const rows = [
      // the newest two
      { id: 'a', label: 'autosave', createdAt: now - 1000 },
      { id: 'b', label: 'autosave', createdAt: now - 2000 },
      // two in the same hour (09:30, 09:29): the newer stays
      { id: 'c', label: 'autosave', createdAt: now - 2.5 * H },
      { id: 'd', label: 'autosave', createdAt: now - 2.5 * H - 60_000 },
      // a safety copy in that hour stays too
      { id: 'e', label: 'before-ai', createdAt: now - 2.5 * H - 120_000 },
      // ten days ago, the same day: one
      { id: 'f', label: 'autosave', createdAt: now - 240 * H },
      { id: 'g', label: 'autosave', createdAt: now - 240 * H - 2 * H },
      // too old, unless named
      { id: 'h', label: 'autosave', createdAt: now - 60 * 24 * H },
      { id: 'i', label: 'named', createdAt: now - 90 * 24 * H },
    ]
    expect([...versionsToKeep(rows, now, 2)].sort()).toEqual(['a', 'b', 'c', 'e', 'f', 'i'])
  })
})
