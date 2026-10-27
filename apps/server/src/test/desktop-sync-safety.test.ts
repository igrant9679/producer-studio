// Desktop sync never loses work: interrupted uploads, deletes against newer cloud edits, items that keep failing,
// switching accounts, losing a space, slow transactions and slow links. Same harness as desktop-sync.test.ts: a real
// cloud in a child process and this process running the desktop edition.
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, SyncStatus } from '@producer/core'
import { type Cloud, type Desktop, type Http, PASSWORD, deskSession, startCloud, startDesktop } from './desktop-harness'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const png = () => Buffer.concat([PNG, crypto.randomBytes(32)])

let cloud: Cloud
let d: Desktop
let desk: Http
let A: Awaited<ReturnType<Cloud['signup']>>

async function sync(): Promise<SyncStatus> {
  const r = await desk.json<SyncStatus>('POST', '/api/sync/now')
  expect(r.status).toBe(200)
  return r.body
}

async function linkA() {
  const st = await desk.json<SyncStatus>('GET', '/api/sync/status')
  if (st.body.linked) return
  expect((await desk.json('POST', '/api/sync/link', { cloudUrl: cloud.url, email: A.email, password: PASSWORD })).status).toBe(200)
  await sync()
}

async function editDoc(h: Http, id: string, mutate: (p: Project) => void) {
  const cur = await h.json('GET', `/api/projects/${id}`)
  expect(cur.status).toBe(200)
  const p = cur.body.project as Project
  mutate(p)
  const r = await h.json('PUT', `/api/projects/${id}`, { project: p, baseVersion: cur.body.version })
  expect(r.status).toBe(200)
  return r.body.version as number
}

/** Upload a file on the desktop (local storage; nothing reaches the cloud until a sync). */
async function deskUpload(workspaceId: string, bytes: Buffer, extra: Record<string, unknown> = {}): Promise<string> {
  const t = await desk.json('POST', '/api/uploads', { workspaceId, filename: 'clip.png', mime: 'image/png', size: bytes.length, ...extra })
  expect(t.status).toBe(200)
  expect((await desk.json('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
  expect((await desk.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)
  return t.body.assetId
}

beforeAll(async () => {
  cloud = await startCloud()
  A = await cloud.signup('Ada Desk')
  d = await startDesktop()
  desk = d.desk
  await deskSession(desk)
}, 240_000)

afterAll(async () => {
  d?.stop()
  cloud?.proc.kill()
})

/** While `fn` runs, the desktop's requests matching `hit` fail like a dropped connection. */
async function withDroppedRequests<T>(hit: (method: string, url: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(cloud.url) && hit(init?.method ?? 'GET', url)) {
      await (init?.body as ReadableStream | undefined)?.cancel?.().catch(() => undefined)
      throw new TypeError('fetch failed')
    }
    return real(input, init)
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

describe('an interrupted upload is sent again (DSK-1)', () => {
  beforeAll(linkA)

  it('re-uploads a clip whose bytes never reached the cloud', async () => {
    const bytes = png()
    const id = await deskUpload(A.workspaceId, bytes)
    // the ticket is issued, then the connection drops while the file is on its way
    const st0 = await withDroppedRequests((m, u) => m === 'PUT' && u.includes(`/api/uploads/${id}/data`), sync)
    expect(st0.state).toBe('offline')
    expect((await A.http.json('GET', `/api/assets/${id}`)).body.status).toBe('uploading')

    const st = await sync()
    expect(st.state).toBe('idle')
    const rec = await A.http.json('GET', `/api/assets/${id}`)
    expect(rec.body.status).not.toBe('uploading')
    const res = await A.http.req('GET', `/api/media/${id}/source`)
    expect(res.status).toBe(200)
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(bytes))
    expect(st.pending).toBe(0)
  })

  it('re-uploads a clip whose upload reached the cloud but was never completed', async () => {
    const bytes = png()
    const id = await deskUpload(A.workspaceId, bytes)
    expect((await withDroppedRequests((m, u) => m === 'POST' && u.endsWith(`/api/assets/${id}/complete`), sync)).state).toBe('offline')
    expect((await A.http.json('GET', `/api/assets/${id}`)).body.status).toBe('uploading')
    await sync()
    expect((await A.http.json('GET', `/api/assets/${id}`)).body.status).not.toBe('uploading')
    expect(sha(Buffer.from(await (await A.http.req('GET', `/api/media/${id}/source`)).arrayBuffer()))).toBe(sha(bytes))
  })
})

describe('trash, restore and template changes made on the web reach the desktop (DSK-3)', () => {
  beforeAll(linkA)
  const local = async (id: string) => (await desk.json('GET', `/api/projects/${id}`)).body.summary

  it('applies the cloud’s flag changes even though the version is unchanged', async () => {
    const id = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Flags' })).body.summary.id
    await sync()
    await A.http.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await sync()
    expect((await local(id)).trashed).toBe(true)
    await A.http.json('PATCH', `/api/projects/${id}`, { trashed: false })
    await A.http.json('PATCH', `/api/projects/${id}`, { isTemplate: true })
    const st = await sync()
    expect(await local(id)).toMatchObject({ trashed: false, isTemplate: true })
    expect(st.pending).toBe(0)
    // a toggle made here since the last sync stays ours and is pushed
    await desk.json('PATCH', `/api/projects/${id}`, { isTemplate: false })
    await A.http.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await sync()
    expect(await local(id)).toMatchObject({ trashed: true, isTemplate: false })
    expect((await A.http.json('GET', `/api/projects/${id}`)).body.summary).toMatchObject({ trashed: true, isTemplate: false })
  })

  it('emptying the trash here never deletes a project someone restored in the cloud', async () => {
    const id = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Rescued' })).body.summary.id
    await sync()
    await desk.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await sync()
    expect((await A.http.json('GET', `/api/projects/${id}`)).body.summary.trashed).toBe(true)
    // restored on the web; this computer empties its trash before it hears about it
    await A.http.json('PATCH', `/api/projects/${id}`, { trashed: false })
    expect((await desk.json('DELETE', `/api/projects/${id}`)).status).toBe(200)
    const st = await sync()
    const cloudCopy = await A.http.json('GET', `/api/projects/${id}`)
    expect(cloudCopy.status).toBe(200)
    expect(cloudCopy.body.summary.trashed).toBe(false)
    // and it's back here, out of the trash, with a notice that says why
    expect(await local(id)).toMatchObject({ name: 'Rescued', trashed: false })
    expect(st.notices?.find((n) => n.message.includes('Rescued'))?.message).toMatch(/taken out of the trash in the cloud/)
  })
})

describe('a delete made offline never destroys a newer cloud edit (DSK-4)', () => {
  beforeAll(linkA)

  it('keeps the cloud edit, brings it back here and says so', async () => {
    const id = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Shared cut' })).body.summary.id
    await sync()
    // offline: trashed and deleted here, while a colleague edits it in the cloud
    await desk.json('PATCH', `/api/projects/${id}`, { trashed: true })
    expect((await desk.json('DELETE', `/api/projects/${id}`)).status).toBe(200)
    await editDoc(A.http, id, (p) => (p.name = 'Shared cut, colleague’s edit'))
    const st = await sync()
    const cloudCopy = await A.http.json('GET', `/api/projects/${id}`)
    expect(cloudCopy.status).toBe(200)
    expect(cloudCopy.body.summary).toMatchObject({ name: 'Shared cut, colleague’s edit', trashed: false })
    expect((await desk.json('GET', `/api/projects/${id}`)).body.summary.name).toBe('Shared cut, colleague’s edit')
    const notice = st.notices?.find((n) => n.message.includes('Shared cut, colleague’s edit'))
    expect(notice?.message).toMatch(/deleted here, but edited in the cloud/)
    expect(st.pending).toBe(0)

    const r = await desk.json<SyncStatus>('POST', `/api/sync/notices/${notice!.id}`, { action: 'dismiss' })
    expect(r.status).toBe(200)
    expect(r.body.notices?.some((n) => n.id === notice!.id)).toBe(false)
    // deleting it again, now that this computer has seen the edit, goes through
    await desk.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await desk.json('DELETE', `/api/projects/${id}`)
    await sync()
    expect((await A.http.json('GET', `/api/projects/${id}`)).status).toBe(404)
  })

  it('the cloud refuses a stale delete in one step', async () => {
    const id = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Guarded' })).body.summary.id
    await editDoc(A.http, id, (p) => (p.name = 'Guarded v2'))
    const stale = await A.http.json('POST', `/api/sync/projects/${id}/delete`, { baseVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.details).toMatchObject({ reason: 'edited', version: 2, trashed: false })
    expect((await A.http.json('POST', `/api/sync/projects/${id}/delete`, { baseVersion: 2, trashed: true })).body.details).toMatchObject({ reason: 'restored' })
    expect((await A.http.json('POST', `/api/sync/projects/${id}/delete`, { baseVersion: 2 })).body).toEqual({ ok: true })
    expect((await A.http.json('POST', `/api/sync/projects/${id}/delete`, { baseVersion: 2 })).status).toBe(404)
  })
})

describe('one item that keeps failing never blocks the rest (DSK-5)', () => {
  beforeAll(linkA)

  it('records the failure, syncs everything else, and offers Retry and Skip', async () => {
    const B = await cloud.signup('Bea Other')
    // ids someone else already holds in the cloud: these can never sync from here
    const takenProject = `p_taken_${Date.now()}`
    const takenAsset = `as_taken_${Date.now()}`
    expect((await B.http.json('POST', '/api/projects', { workspaceId: B.workspaceId, id: takenProject, name: 'Bea’s' })).status).toBe(200)
    expect((await B.http.json('POST', '/api/uploads', { workspaceId: B.workspaceId, filename: 'b.png', mime: 'image/png', size: 10, assetId: takenAsset })).status).toBe(200)

    expect((await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, id: takenProject, name: 'Clashing project' })).status).toBe(200)
    await deskUpload(A.workspaceId, png(), { assetId: takenAsset })
    const fine = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Fine project' })).body.summary.id
    const fineAsset = await deskUpload(A.workspaceId, png())

    const st = await sync()
    expect(st.state).toBe('idle')
    expect(st.error).toBeUndefined()
    // everything else made it
    expect((await A.http.json('GET', `/api/projects/${fine}`)).status).toBe(200)
    expect((await A.http.json('GET', `/api/assets/${fineAsset}`)).status).toBe(200)
    // the two that can't are listed, with a reason a person can act on
    const failures = st.failures ?? []
    expect(failures.map((f) => `${f.kind}:${f.id}`).sort()).toEqual([`asset:${takenAsset}`, `project:${takenProject}`].sort())
    expect(failures.find((f) => f.kind === 'project')).toMatchObject({ name: 'Clashing project', attempts: 1, skipped: false, error: expect.stringMatching(/another cloud workspace/) })
    expect(failures.find((f) => f.kind === 'asset')).toMatchObject({ name: 'clip.png', error: expect.stringMatching(/taken/) })
    expect(st.pending).toBe(2)

    // the list survives a restart
    const { SyncEngine } = await import('../desktop/sync')
    expect(((await new SyncEngine().status()).failures ?? []).length).toBe(2)

    // a cycle soon after doesn't hammer the same item again (it waits for its retry time)
    expect((await sync()).failures?.find((f) => f.kind === 'asset')?.attempts).toBe(1)
    // Retry: tries again straight away
    const retried = await desk.json<SyncStatus>('POST', `/api/sync/failures/asset/${takenAsset}`, { action: 'retry' })
    expect(retried.status).toBe(200)
    expect(retried.body.failures?.find((f) => f.kind === 'asset')).toMatchObject({ attempts: 2, skipped: false })
    // Skip: stays on this computer, no longer pending, never tried again until Retry
    const skipped = await desk.json<SyncStatus>('POST', `/api/sync/failures/asset/${takenAsset}`, { action: 'skip' })
    expect(skipped.body.failures?.find((f) => f.kind === 'asset')).toMatchObject({ skipped: true })
    expect(skipped.body.pending).toBe(1)
    const after = await sync()
    expect(after.failures?.find((f) => f.kind === 'asset')).toMatchObject({ skipped: true, attempts: 2 })
    expect((await desk.json('GET', `/api/assets/${takenAsset}`)).status).toBe(200) // nothing was removed here
    expect((await desk.json('POST', `/api/sync/failures/asset/nope`, { action: 'retry' })).status).toBe(404)

    // once the cause is gone, the item syncs and leaves the list
    await desk.json('PATCH', `/api/projects/${takenProject}`, { trashed: true })
    await desk.json('DELETE', `/api/projects/${takenProject}`)
    await desk.json('DELETE', `/api/assets/${takenAsset}`)
    expect((await sync()).failures).toEqual([])
  })
})
