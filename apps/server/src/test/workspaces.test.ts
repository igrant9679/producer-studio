import { beforeAll, describe, expect, it } from 'vitest'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

/** A team space owned by A with B joined as `role`. */
async function teamWith(role: 'editor' | 'viewer' | 'owner') {
  const A = await signup(t.app, 'Owner')
  const B = await signup(t.app, 'Member')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Marketing' })).body
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: B.email, role })
  await B.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  return { A, B, wsId: ws.id as string }
}

describe('rename workspace', () => {
  it('owners rename; editors get 403, outsiders 404; blank names are rejected', async () => {
    const { A, B, wsId } = await teamWith('editor')
    const r = await A.client.json('PATCH', `/api/workspaces/${wsId}`, { name: '  Brand team ' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: wsId, name: 'Brand team', role: 'owner', personal: false, memberCount: 2 })
    expect((await B.client.json('GET', '/api/workspaces')).body.find((w: { id: string }) => w.id === wsId).name).toBe('Brand team')
    expect((await B.client.json('PATCH', `/api/workspaces/${wsId}`, { name: 'Mine now' })).status).toBe(403)
    const C = await signup(t.app)
    expect((await C.client.json('PATCH', `/api/workspaces/${wsId}`, { name: 'Nope' })).status).toBe(404)
    expect((await A.client.json('PATCH', `/api/workspaces/${wsId}`, { name: '   ' })).status).toBe(400)
  })

  it('personal spaces can be renamed', async () => {
    const A = await signup(t.app)
    const r = await A.client.json('PATCH', `/api/workspaces/${A.workspaceId}`, { name: 'Solo studio' })
    expect(r.body).toMatchObject({ name: 'Solo studio', personal: true })
  })

  it('a rename shows up in the sync change feed', async () => {
    const { A, wsId } = await teamWith('editor')
    const c0 = (await A.client.json('GET', '/api/sync/changes?since=0&limit=500')).body.cursor
    await A.client.json('PATCH', `/api/workspaces/${wsId}`, { name: 'Renamed' })
    const ch = await A.client.json('GET', `/api/sync/changes?since=${c0}`)
    expect(ch.body.workspaces).toEqual([expect.objectContaining({ id: wsId, name: 'Renamed' })])
  })
})

describe('delete workspace', () => {
  it('only owners delete, and never a personal space', async () => {
    const { A, B, wsId } = await teamWith('editor')
    expect((await B.client.json('DELETE', `/api/workspaces/${wsId}`)).status).toBe(403)
    const C = await signup(t.app)
    expect((await C.client.json('DELETE', `/api/workspaces/${wsId}`)).status).toBe(404)
    const p = await A.client.json('DELETE', `/api/workspaces/${A.workspaceId}`)
    expect(p.status).toBe(409)
    expect(p.body.code).toBe('conflict')
  })

  it('removes the space, its projects, brand kit and stored files for every member', async () => {
    const { A, B, wsId } = await teamWith('editor')
    const proj = (await A.client.json('POST', '/api/projects', { workspaceId: wsId, name: 'Doomed' })).body.project
    await A.client.json('PUT', `/api/workspaces/${wsId}/brand`, { name: 'Acme', colors: ['#000000'], fonts: { headline: 'Inter', body: 'Inter' } })
    const { ctx } = await import('../context')
    await ctx().storage.put(`ws/${wsId}/assets/x/source.txt`, Buffer.from('hi'))
    const keep = `ws/${A.workspaceId}/assets/y/source.txt`
    await ctx().storage.put(keep, Buffer.from('keep'))
    const bCursor = (await B.client.json('GET', '/api/sync/changes?since=0&limit=500')).body.cursor

    const r = await A.client.json('DELETE', `/api/workspaces/${wsId}`)
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect((await A.client.json('GET', '/api/workspaces')).body.map((w: { id: string }) => w.id)).not.toContain(wsId)
    expect((await B.client.json('GET', '/api/workspaces')).body.map((w: { id: string }) => w.id)).not.toContain(wsId)
    expect((await A.client.json('GET', `/api/projects/${proj.id}`)).status).toBe(404)
    expect((await A.client.json('GET', `/api/workspaces/${wsId}/brand`)).status).toBe(404)
    expect(await ctx().storage.stat(`ws/${wsId}/assets/x/source.txt`)).toBeNull()
    expect(await ctx().storage.stat(keep)).not.toBeNull()
    // the member's desktop replicas learn the space is gone
    const ch = await B.client.json('GET', `/api/sync/changes?since=${bCursor}`)
    expect(ch.body.deleted.workspaces).toEqual([wsId])
    expect(ch.body.cursor).toBeGreaterThan(bCursor)
    // and not again on the next pull
    expect((await B.client.json('GET', `/api/sync/changes?since=${ch.body.cursor}`)).body.deleted.workspaces).toEqual([])
  })

  it('a full resync (since=0) after leaving reports the left space but keeps current ones', async () => {
    const { A, B, wsId } = await teamWith('viewer')
    await A.client.json('DELETE', `/api/workspaces/${wsId}`)
    const all = await B.client.json('GET', '/api/sync/changes?since=0&limit=500')
    expect(all.body.deleted.workspaces).toContain(wsId)
    expect(all.body.workspaces.map((w: { id: string }) => w.id)).toEqual([B.workspaceId])
  })
})
