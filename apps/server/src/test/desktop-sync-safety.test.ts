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
}, 120_000)

afterAll(async () => {
  d?.stop()
  cloud?.proc.kill()
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
