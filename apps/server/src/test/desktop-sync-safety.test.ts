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

// must run first: it links this computer for the first time
describe('the first link keeps what was made before it (DSK-2)', () => {
  const brand = (name: string) => ({ name, colors: ['#112233'], fonts: { headline: 'Inter', body: 'Inter' } })

  it('moves voices and brand kits with their space; a cloud kit is kept and ours is set aside', async () => {
    const { ctx } = await import('../context')
    const { voiceProfiles } = await import('../db/schema')
    const me = (await desk.json('GET', '/api/auth/me')).body
    expect(me.workspaces).toHaveLength(1)
    const personal = me.workspaces[0].id
    const studio = (await desk.json('POST', '/api/workspaces', { name: 'Studio' })).body.id
    expect((await desk.json('PUT', `/api/workspaces/${personal}/brand`, brand('Made here'))).status).toBe(200)
    expect((await desk.json('PUT', `/api/workspaces/${studio}/brand`, brand('Studio brand'))).status).toBe(200)
    expect((await A.http.json('PUT', `/api/workspaces/${A.workspaceId}/brand`, brand('Cloud brand'))).status).toBe(200)
    // cloned voices (the rows a VoiceStudio clone leaves; the engine isn't running in this test)
    const now = Date.now()
    const consent = { statement: 'This is my own voice and I consent to cloning it.', attestedBy: me.user.id, attestedAt: now, speaker: 'me' }
    const voice = (id: string, workspaceId: string, vs: string) => ({ id, workspaceId, name: `Voice ${id}`, kind: 'clone', engine: 'omnivoice', consent, vsProfileId: vs, createdBy: me.user.id, createdAt: now, updatedAt: now })
    await ctx().db.insert(voiceProfiles).values([voice('vp_mine01', personal, 'p1'), voice('vp_studio1', studio, 'p2')])

    await linkA()
    const cloudStudio = (await A.http.json('GET', '/api/workspaces')).body.find((w: { name: string }) => w.name === 'Studio').id
    // the voices moved with their spaces, here and in the cloud, consent and all
    const deskVoices = async (ws: string) => (await desk.json('GET', `/api/voice/profiles?workspaceId=${ws}`)).body.map((v: { id: string }) => v.id)
    expect(await deskVoices(A.workspaceId)).toEqual(['vp_mine01'])
    expect(await deskVoices(cloudStudio)).toEqual(['vp_studio1'])
    const inCloud = (await A.http.json('GET', `/api/voice/profiles?workspaceId=${A.workspaceId}`)).body
    expect(inCloud.find((v: { id: string }) => v.id === 'vp_mine01')).toMatchObject({ consent: { statement: consent.statement, speaker: 'me' } })
    expect((await A.http.json('GET', `/api/voice/profiles?workspaceId=${cloudStudio}`)).body.map((v: { id: string }) => v.id)).toEqual(['vp_studio1'])
    // the new cloud space had no kit: ours moved there
    expect((await A.http.json('GET', `/api/workspaces/${cloudStudio}/brand`)).body.name).toBe('Studio brand')
    expect((await desk.json('GET', `/api/workspaces/${cloudStudio}/brand`)).body.name).toBe('Studio brand')
    // the cloud personal space had one: it stays, ours is set aside and can be brought back
    expect((await A.http.json('GET', `/api/workspaces/${A.workspaceId}/brand`)).body.name).toBe('Cloud brand')
    expect((await desk.json('GET', `/api/workspaces/${A.workspaceId}/brand`)).body.name).toBe('Cloud brand')
    const st = (await desk.json<SyncStatus>('GET', '/api/sync/status')).body
    const notice = st.notices?.find((n) => n.message.includes('Made here'))
    expect(notice).toMatchObject({ action: expect.any(String) })
    const applied = await desk.json<SyncStatus>('POST', `/api/sync/notices/${notice!.id}`, { action: 'apply' })
    expect(applied.status).toBe(200)
    expect(applied.body.notices?.some((n) => n.id === notice!.id)).toBe(false)
    expect((await desk.json('GET', `/api/workspaces/${A.workspaceId}/brand`)).body.name).toBe('Made here')
    await sync()
    expect((await A.http.json('GET', `/api/workspaces/${A.workspaceId}/brand`)).body.name).toBe('Made here')
  })
})

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

describe('a change that commits late is still delivered (DSK-9)', () => {
  beforeAll(linkA)

  it('resumes where the cloud says it is safe, not past a change still being written', async () => {
    const late = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Late' })).body.summary.id
    // more newer changes than the old 25-change lookback
    for (let i = 0; i < 30; i++) await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: `Filler ${i}` })
    // the first pull happens while "Late" is still uncommitted: the cloud can't return it yet and says to resume below it
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init)
      if (!String(input instanceof Request ? input.url : input).includes('/api/sync/changes')) return res
      const body = await res.json()
      const hit = body.projects.find((p: { project: { id: string } }) => p.project.id === late)
      if (hit) {
        body.projects = body.projects.filter((p: unknown) => p !== hit)
        body.safe = Math.min(body.safe ?? body.cursor, hit.changeSeq - 1)
      }
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      await sync()
    } finally {
      globalThis.fetch = real
    }
    expect((await desk.json('GET', `/api/projects/${late}`)).status).toBe(404)
    // committed now: the next pull delivers it
    await sync()
    expect((await desk.json('GET', `/api/projects/${late}`)).body.summary?.name).toBe('Late')
  })
})

describe('a delete that arrives again never removes a project that came back (DSK-10)', () => {
  beforeAll(linkA)

  it('keeps a project kept here after a cloud delete, when the same changes are delivered again', async () => {
    const { kvGet, kvSet } = await import('../desktop/db')
    const id = (await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Comeback' })).body.summary.id
    await sync()
    const before = (await kvGet<number>('cursor'))!
    // edited here while it's deleted in the cloud: kept here, and created in the cloud again
    await editDoc(desk, id, (p) => (p.name = 'Comeback, edited here'))
    await A.http.json('PATCH', `/api/projects/${id}`, { trashed: true })
    expect((await A.http.json('DELETE', `/api/projects/${id}`)).status).toBe(200)
    await sync()
    expect((await A.http.json('GET', `/api/projects/${id}`)).body.summary.name).toBe('Comeback, edited here')
    // the same changes arrive again (the cursor held back): the old delete must not apply
    await kvSet('cursor', before)
    await sync()
    await sync()
    expect((await desk.json('GET', `/api/projects/${id}`)).body.summary?.name).toBe('Comeback, edited here')
    expect((await A.http.json('GET', `/api/projects/${id}`)).status).toBe(200)
  })
})

describe('losing a space keeps the work that exists only here (DSK-11)', () => {
  beforeAll(linkA)

  it('moves unsynced edits and never-uploaded clips to a Recovered space, and says so', async () => {
    const C = await cloud.signup('Cy Owner')
    const crew = (await C.http.json('POST', '/api/workspaces', { name: 'Crew' })).body.id
    const pid = (await C.http.json('POST', '/api/projects', { workspaceId: crew, name: 'Crew cut' })).body.summary.id
    const theirs = (await C.http.json('POST', '/api/projects', { workspaceId: crew, name: 'Not mine' })).body.summary.id
    const inv = await C.http.json('POST', `/api/workspaces/${crew}/invites`, { email: A.email, role: 'editor' })
    expect((await A.http.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)).status).toBe(200)
    await sync()
    expect((await desk.json('GET', `/api/projects/${pid}`)).status).toBe(200)
    // work that exists only on this computer
    await editDoc(desk, pid, (p) => (p.name = 'Crew cut, my unsynced edit'))
    const bytes = png()
    const clip = await deskUpload(crew, bytes)
    // the owner removes this person from the space
    expect((await C.http.json('DELETE', `/api/workspaces/${crew}/members/${A.userId}`)).status).toBe(200)

    const st = await sync()
    expect(st.state).toBe('idle')
    const spaces = (await desk.json('GET', '/api/workspaces')).body as Array<{ id: string; name: string }>
    expect(spaces.some((w) => w.id === crew)).toBe(false)
    const recovered = spaces.find((w) => w.name === 'Recovered from Crew')!
    expect(recovered).toBeTruthy()
    expect((await desk.json('GET', `/api/projects/${pid}`)).body.summary).toMatchObject({ name: 'Crew cut, my unsynced edit', workspaceId: recovered.id })
    const res = await desk.req('GET', `/api/media/${clip}/source`)
    expect(res.status).toBe(200)
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(bytes))
    // what was only theirs goes, as before
    expect((await desk.json('GET', `/api/projects/${theirs}`)).status).toBe(404)
    expect(st.notices?.find((n) => n.message.includes('“Crew”'))?.message).toMatch(/Recovered from Crew/)
    // the recovered space stays on this computer: not pending, never pushed
    expect(st.pending).toBe(0)
    expect((await sync()).failures).toEqual([])
    expect((await C.http.json('GET', `/api/projects/${pid}`)).body.summary.name).toBe('Crew cut')
  })
})

// must run last: it switches the linked account
describe('linking a different account never uploads the previous account’s spaces (DSK-6)', () => {
  beforeAll(linkA)

  it('sets them aside on this computer, and they sync again when that account is linked back', async () => {
    const team = (await A.http.json('POST', '/api/workspaces', { name: 'Team A' })).body.id
    const pid = (await A.http.json('POST', '/api/projects', { workspaceId: team, name: 'Colleague cut' })).body.summary.id
    await sync()
    await editDoc(desk, pid, (p) => (p.name = 'Colleague cut, my edit'))
    expect((await desk.json('POST', '/api/sync/unlink')).status).toBe(200)

    const B = await cloud.signup('Bo Second')
    expect((await desk.json('POST', '/api/sync/link', { cloudUrl: cloud.url, email: B.email, password: PASSWORD })).status).toBe(200)
    const st = await sync()
    expect(st.state).toBe('idle')
    // nothing of the first account reached the second
    expect((await B.http.json('GET', '/api/workspaces')).body.map((w: { id: string }) => w.id)).toEqual([B.workspaceId])
    expect((await B.http.json('GET', `/api/projects?workspaceId=${B.workspaceId}`)).body.items).toEqual([])
    // still here, untouched, and the person is told
    expect((await desk.json('GET', `/api/projects/${pid}`)).body.summary.name).toBe('Colleague cut, my edit')
    expect(st.notices?.find((n) => n.message.includes('Team A'))?.message).toContain(A.email)
    expect(st.pending).toBe(0)

    // the first account again: its spaces sync again (the edit made here goes up), the second's are set aside
    expect((await desk.json('POST', '/api/sync/unlink')).status).toBe(200)
    await linkA()
    const back = await sync()
    expect(back.conflicts).toEqual([])
    expect((await A.http.json('GET', `/api/projects/${pid}`)).body.summary.name).toBe('Colleague cut, my edit')
    const bName = (await B.http.json('GET', '/api/workspaces')).body[0].name
    expect((await A.http.json('GET', '/api/workspaces')).body.some((w: { name: string }) => w.name === bName)).toBe(false)
  })
})
