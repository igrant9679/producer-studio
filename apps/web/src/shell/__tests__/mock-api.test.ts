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

  it('makes smooth slow motion of a video, refusing a bad range (E-17)', async () => {
    const job = await call('POST', '/api/assets/as_rec1/smooth', { from: 0, to: 2, fps: 60 })
    expect(job).toMatchObject({ status: 200, body: { kind: 'media.smooth' } })
    expect((await call('POST', '/api/assets/as_rec1/smooth', { from: 2, to: 1, fps: 60 })).status).toBe(400)
    expect([403, 404]).toContain((await call('POST', '/api/assets/as_nope/smooth', { from: 0, to: 1, fps: 60 })).status)
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

  it('has the Library’s routes with the server’s rules: trash, copies, tags, exports, search (A-11 – A-19)', async () => {
    const team = (await call('GET', '/api/assets?workspaceId=ws_team')).body as Array<{ asset: { id: string } }>
    // a delete only trashes; viewers can't
    const client = (await call('GET', '/api/assets?workspaceId=ws_client')).body as Array<{ asset: { id: string } }>
    if (client[0]) expect((await call('DELETE', `/api/assets/${client[0].asset.id}`)).status).toBe(403)
    const id = (await call('POST', '/api/assets/as_rec2/copy', { workspaceId: 'ws_team' })).body.asset.id as string
    expect((await call('GET', '/api/assets?workspaceId=ws_team')).body).toHaveLength(team.length + 1)
    expect((await call('DELETE', `/api/assets/${id}`)).body).toMatchObject({ ok: true, usedIn: 0 })
    expect((await call('GET', '/api/assets?workspaceId=ws_team&trashed=1')).body.map((a: { asset: { id: string } }) => a.asset.id)).toEqual([id])
    expect((await call('POST', '/api/assets/trash/empty', { workspaceId: 'ws_team', ids: ['as_rec1'] })).status).toBe(409)
    expect((await call('POST', '/api/assets/trash/empty', { workspaceId: 'ws_team' })).body).toEqual({ removed: 1, exports: 0 })
    expect((await call('POST', '/api/assets/as_rec1/replace', { filename: 'a.mp3', mime: 'audio/mpeg', size: 1 })).status).toBe(400)
    // projects: copy to a space the user only views is refused; tags are tidied
    expect((await call('POST', '/api/projects/p_launch/copy', { workspaceId: 'ws_client' })).status).toBe(403)
    expect((await call('POST', '/api/projects/p_launch/copy', { workspaceId: 'ws_team' })).body).toMatchObject({ workspaceId: 'ws_team', missingMedia: 0 })
    expect((await call('PATCH', '/api/projects/p_reel', { tags: [' Launch ', 'launch'] })).body.tags).toEqual(['Launch'])
    // every export of a space, paged like the server
    expect((await call('GET', '/api/exports?workspaceId=ws_personal')).body).toMatchObject({ items: expect.any(Array) })
    expect((await call('GET', '/api/search?workspaceId=ws_personal&q=launch')).body.hits.map((h: { title: string }) => h.title)).toEqual(expect.arrayContaining(['Spring launch — product tour']))
  })

  it('keeps several brand kits with the server’s rules (A-21)', async () => {
    expect((await call('POST', '/api/workspaces/ws_client/brand-kits', {})).status).toBe(403)
    expect((await call('GET', '/api/workspaces/ws_client/brand-kits')).status).toBe(200)
    const made = await call('POST', '/api/workspaces/ws_team/brand-kits', {})
    expect(made.body).toMatchObject({ default: false, doc: { name: 'Northwind copy' } })
    expect((await call('DELETE', '/api/workspaces/ws_team/brand-kits/default')).status).toBe(409)
    const list = (await call('POST', `/api/workspaces/ws_team/brand-kits/${made.body.id}/default`)).body.items
    expect(list[0]).toMatchObject({ default: true, doc: { name: 'Northwind copy' } })
    expect((await call('POST', '/api/workspaces/ws_team/brand/palette', { assetId: 'as_logo' })).body.colors.length).toBeGreaterThan(1)
    expect((await fetch('/api/workspaces/ws_client/brand/fonts?family=Acme', { method: 'POST', body: 'x' })).status).toBe(403)
  })

  it('has the onboarding checklist and templates from a kit (A-6, A-22)', async () => {
    const w = (await call('POST', '/api/workspaces', { name: 'Fresh' })).body
    const s = (await call('GET', `/api/workspaces/${w.id}/onboarding`)).body
    expect(s).toMatchObject({ dismissed: false, sampleProjectId: expect.any(String), steps: { upload: false, invite: false } })
    expect((await call('PUT', `/api/workspaces/${w.id}/onboarding`, { dismissed: true })).body.dismissed).toBe(true)
    expect((await call('GET', '/api/templates/tpl:studio/doc?aspect=9:16')).body).toMatchObject({ width: 1080, height: 1920 })
    expect((await call('POST', '/api/templates/from-brand', { workspaceId: 'ws_client', lookId: 'studio' })).status).toBe(403)
    const made = await call('POST', '/api/templates/from-brand', { workspaceId: 'ws_team', lookId: 'studio', aspect: '1:1' })
    expect(made.body).toMatchObject({ builtIn: false, aspect: '1:1' })
  })

  it('has the Voice Studio settings and the script versions (A-20, A-7)', async () => {
    expect((await call('PUT', '/api/workspaces/ws_client/voice-settings', { pronunciations: [] })).status).toBe(403)
    expect((await call('PUT', '/api/workspaces/ws_team/voice-settings', { pronunciations: [{ word: 'SQL', say: 'sequel' }] })).body.pronunciations).toHaveLength(1)
    expect((await call('PUT', '/api/workspaces/ws_client/voice-studio', { favourites: ['af_heart'] })).body.favourites).toEqual(['af_heart'])
    const wav = await fetch('/api/workspaces/ws_team/voice-preview', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'af_heart' }), headers: { 'content-type': 'application/json' } })
    expect(wav.headers.get('content-type')).toBe('audio/wav')
    expect((await call('POST', '/api/workspaces/ws_client/voice-preview', { text: 'Hi', voice: 'af_heart' })).status).toBe(403)
    expect((await call('GET', '/api/ai/produce/p_nope/script-versions')).status).toBe(404)
  })

  it('lets only owners invite', async () => {
    expect((await call('POST', '/api/workspaces/ws_team/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(403)
    expect((await call('POST', '/api/workspaces/ws_personal/invites', { email: 'kim@example.com', role: 'editor' })).status).toBe(200)
  })
})
