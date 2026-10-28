// Concurrency safety (P-14): base versions (If-Match) on updates that could lose an edit, idempotency keys on POSTs.
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ctx } from '../context'
import { assets, idempotencyKeys, jobs } from '../db/schema'
import { type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

async function withHeaders(client: Client, method: string, url: string, body: unknown, headers: Record<string, string>) {
  const res = await client.req(method, url, body, headers)
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined }
}

async function anAsset(workspaceId: string, name = 'clip.mp4') {
  const id = `as_cc_${Math.random().toString(36).slice(2, 10)}`
  await ctx().db.insert(assets).values({ id, workspaceId, kind: 'audio', name, mime: 'audio/mpeg', status: 'ready', sourceKey: `ws/${workspaceId}/a/${id}`, createdBy: 'u', createdAt: Date.now(), updatedAt: Date.now() })
  return id
}

describe('If-Match on updates', () => {
  it('an asset rename from a stale screen gets 412; the current base goes through', async () => {
    const { client, workspaceId } = await signup(t.app)
    const id = await anAsset(workspaceId)
    const got = await withHeaders(client, 'GET', `/api/assets/${id}`, undefined, {})
    const tag = got.headers.get('etag')!
    expect(tag).toBeTruthy()
    expect(got.body.etag).toBe(tag)
    const listed = (await client.json('GET', `/api/assets?workspaceId=${workspaceId}`)).body.items.find((r: { asset: { id: string } }) => r.asset.id === id)
    expect(listed.etag).toBe(tag)
    // someone else renames it
    const first = await withHeaders(client, 'PATCH', `/api/assets/${id}`, { name: 'Interview' }, { 'If-Match': tag })
    expect(first.status).toBe(200)
    expect(first.headers.get('etag')).not.toBe(tag)
    // a second screen still holding the old base
    const stale = await withHeaders(client, 'PATCH', `/api/assets/${id}`, { name: 'Old screen' }, { 'If-Match': tag })
    expect(stale.status).toBe(412)
    expect(stale.body.error).toMatch(/changed by someone else/)
    expect((await client.json('GET', `/api/assets/${id}`)).body.asset.name).toBe('Interview')
    // processing finishing (a status change) doesn't count as a change to what a rename edits
    await ctx().db.update(assets).set({ status: 'ready', updatedAt: Date.now() + 5 }).where(eq(assets.id, id))
    expect((await withHeaders(client, 'PATCH', `/api/assets/${id}`, { name: 'B-roll' }, { 'If-Match': first.headers.get('etag')! })).status).toBe(200)
    // no If-Match: as before
    expect((await client.json('PATCH', `/api/assets/${id}`, { name: 'Anything' })).status).toBe(200)
  })

  it('the brand kit and a space’s name', async () => {
    const { client, workspaceId } = await signup(t.app)
    const got = await withHeaders(client, 'GET', `/api/workspaces/${workspaceId}/brand`, undefined, {})
    const tag = got.headers.get('etag')!
    const saved = await withHeaders(client, 'PUT', `/api/workspaces/${workspaceId}/brand`, { ...got.body, name: 'Acme' }, { 'If-Match': tag })
    expect(saved.status).toBe(200)
    const stale = await withHeaders(client, 'PUT', `/api/workspaces/${workspaceId}/brand`, { ...got.body, name: 'Lost edit' }, { 'If-Match': tag })
    expect(stale.status).toBe(412)
    // the ETag a save answers with is the one a fresh read gives (jsonb reorders keys)
    const again = await withHeaders(client, 'GET', `/api/workspaces/${workspaceId}/brand`, undefined, {})
    expect(again.headers.get('etag')).toBe(saved.headers.get('etag'))
    expect(again.body.name).toBe('Acme')

    const ws = (await client.json('POST', '/api/workspaces', { name: 'Team' })).body
    expect(ws.etag).toBeTruthy()
    const renamed = await withHeaders(client, 'PATCH', `/api/workspaces/${ws.id}`, { name: 'Team A' }, { 'If-Match': ws.etag })
    expect(renamed.status).toBe(200)
    expect((await withHeaders(client, 'PATCH', `/api/workspaces/${ws.id}`, { name: 'Team B' }, { 'If-Match': ws.etag })).status).toBe(412)
    expect((await withHeaders(client, 'PATCH', `/api/workspaces/${ws.id}`, { name: 'Team B' }, { 'If-Match': renamed.body.etag })).status).toBe(200)
  })
})

describe('Idempotency-Key', () => {
  const tts = (workspaceId: string) => ({ workspaceId, text: 'Hello there, this is a test.', voice: 'af_heart', speed: 1, name: 'Hello' })

  it('a retried voiceover request answers with the first job instead of queueing a second', async () => {
    const { client, workspaceId } = await signup(t.app)
    const key = `k_${Date.now()}`
    const a = await withHeaders(client, 'POST', '/api/ai/tts', tts(workspaceId), { 'Idempotency-Key': key })
    expect(a.status).toBe(200)
    const b = await withHeaders(client, 'POST', '/api/ai/tts', tts(workspaceId), { 'Idempotency-Key': key })
    expect(b.status).toBe(200)
    expect(b.body.id).toBe(a.body.id)
    expect(b.headers.get('idempotent-replayed')).toBe('true')
    const queued = await ctx().db.select({ id: jobs.id }).from(jobs).where(eq(jobs.workspaceId, workspaceId))
    expect(queued.filter((j) => j.id === a.body.id)).toHaveLength(1)
    expect(queued).toHaveLength(1)
    // a new key is a new request
    const c = await withHeaders(client, 'POST', '/api/ai/tts', tts(workspaceId), { 'Idempotency-Key': `${key}_2` })
    expect(c.body.id).not.toBe(a.body.id)
  })

  it('refuses the same key on a different request, and keys belong to their person', async () => {
    const { client, workspaceId } = await signup(t.app)
    const key = `k_other_${Date.now()}`
    await withHeaders(client, 'POST', '/api/ai/tts', tts(workspaceId), { 'Idempotency-Key': key })
    const diff = await withHeaders(client, 'POST', '/api/ai/tts', { ...tts(workspaceId), text: 'Something else entirely.' }, { 'Idempotency-Key': key })
    expect(diff.status).toBe(422)
    const other = await signup(t.app)
    const theirs = await withHeaders(other.client, 'POST', '/api/ai/tts', tts(other.workspaceId), { 'Idempotency-Key': key })
    expect(theirs.status).toBe(200)
  })

  it('a refused request keeps no answer, so the retry runs', async () => {
    const { client, workspaceId } = await signup(t.app)
    const key = `k_refused_${Date.now()}`
    const bad = await withHeaders(client, 'POST', '/api/ai/tts', { ...tts(workspaceId), text: '' }, { 'Idempotency-Key': key })
    expect(bad.status).toBe(400)
    const rows = await ctx().db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))
    expect(rows).toHaveLength(0)
  })

  it('a request still running answers 409 to its retry', async () => {
    const { client, workspaceId } = await signup(t.app)
    const me = (await client.json('GET', '/api/auth/me')).body.user.id
    const key = `k_running_${Date.now()}`
    const crypto = await import('node:crypto')
    const raw = JSON.stringify(tts(workspaceId))
    await ctx().db.insert(idempotencyKeys).values({ userId: me, key, method: 'POST', path: '/api/ai/tts', bodyHash: crypto.createHash('sha256').update(raw).digest('hex'), createdAt: Date.now() })
    const r = await withHeaders(client, 'POST', '/api/ai/tts', tts(workspaceId), { 'Idempotency-Key': key })
    expect(r.status).toBe(409)
  })
})

describe('a project rename', () => {
  it('with a stale base version is refused, and a current one goes through', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { project, version } = (await client.json('POST', '/api/projects', { workspaceId, name: 'Old' })).body
    const saved = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#123123' }, baseVersion: version })).body.version
    const stale = await client.json('PATCH', `/api/projects/${project.id}`, { name: 'From a stale list', baseVersion: version })
    expect(stale.status).toBe(409)
    expect(stale.body.details).toMatchObject({ version: saved })
    expect((await client.json('GET', `/api/projects/${project.id}`)).body.project.name).toBe('Old')
    const ok = await client.json('PATCH', `/api/projects/${project.id}`, { name: 'New', baseVersion: saved })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ name: 'New', version: saved + 1 })
    // without a base version (older clients, desktops) it still works
    expect((await client.json('PATCH', `/api/projects/${project.id}`, { name: 'Newer' })).status).toBe(200)
  })
})
