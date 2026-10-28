// Desktop sync, phase 4: what was made before linking, saves whose answer was lost, offline conflict choices and new
// spaces, half-written clips, deletes made while unlinked, Wi-Fi sign-in pages, synced file types, renames and
// transcripts, downloads checked before use, saves during a sync write, voice edits across clocks, the voice relay
// after a revoke. Same harness as desktop-sync.test.ts: a real cloud in a child process and this process as the desktop.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AssetRecord, Project, SyncStatus, Transcript } from '@producer/core'
import { type Cloud, type Desktop, type Http, PASSWORD, deskSession, startCloud, startDesktop } from './desktop-harness'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
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

async function link() {
  expect((await desk.json('POST', '/api/sync/link', { cloudUrl: cloud.url, email: A.email, password: PASSWORD })).status).toBe(200)
  await sync()
}

async function linkA() {
  if (!(await desk.json<SyncStatus>('GET', '/api/sync/status')).body.linked) await link()
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

async function deskUpload(workspaceId: string, bytes: Buffer, filename = 'clip.png'): Promise<string> {
  const t = await desk.json('POST', '/api/uploads', { workspaceId, filename, mime: 'image/png', size: bytes.length })
  expect(t.status).toBe(200)
  expect((await desk.json('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
  expect((await desk.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)
  return t.body.assetId
}

async function cloudUpload(bytes: Buffer): Promise<string> {
  const t = await A.http.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'cloud.png', mime: 'image/png', size: bytes.length })
  expect(t.status).toBe(200)
  expect((await A.http.req('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
  expect((await A.http.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)
  for (let i = 0; i < 100; i++) {
    if ((await A.http.json('GET', `/api/assets/${t.body.assetId}`)).body.status === 'ready') break
    await new Promise((r) => setTimeout(r, 100))
  }
  return t.body.assetId
}

/** While `fn` runs, the desktop's requests to the cloud matching `hit` get `answer` instead (default: a dropped connection). */
async function intercept<T>(hit: (method: string, url: string) => boolean, fn: () => Promise<T>, answer?: (real: typeof fetch, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(cloud.url) && hit(init?.method ?? 'GET', url)) {
      if (answer) return answer(real, input, init)
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

const offline = <T>(fn: () => Promise<T>) => intercept(() => true, fn)

beforeAll(async () => {
  cloud = await startCloud()
  A = await cloud.signup('Phase Four')
  d = await startDesktop()
  desk = d.desk
  await deskSession(desk)
}, 240_000)

afterAll(async () => {
  d?.stop()
  cloud?.proc.kill()
})

// must run first: it links this computer for the first time
describe('what was made before the first link', () => {
  it('keeps the appearance settings and voice consent records with the person (DSK-22)', async () => {
    const { ctx } = await import('../context')
    const { voiceProfiles } = await import('../db/schema')
    const me = (await desk.json('GET', '/api/auth/me')).body
    expect((await desk.json('PUT', '/api/me/preferences', { theme: 'light', accent: 'violet' })).status).toBe(200)
    const now = Date.now()
    await ctx()
      .db.insert(voiceProfiles)
      .values({ id: 'vp_before01', workspaceId: me.workspaces[0].id, name: 'Mine', kind: 'clone', engine: 'omnivoice', consent: { statement: 'My own voice.', attestedBy: me.user.id, attestedAt: now }, vsProfileId: 'p-before', createdBy: me.user.id, createdAt: now, updatedAt: now })

    // a clip made here before linking, deleted after (DSK-21)
    const clip = await deskUpload(me.workspaces[0].id, png())
    // processed (nothing still has its file open)
    for (let i = 0; i < 100 && (await desk.json('GET', `/api/assets/${clip}`)).body.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100))
    const { assets } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const before = (await ctx().db.select().from(assets).where(eq(assets.id, clip)))[0]
    const file = ctx().storage.localPath!(before.sourceKey)
    expect(fs.existsSync(file)).toBe(true)

    await link()
    expect((await desk.json('GET', '/api/auth/me')).body.user.id).toBe(A.userId)
    expect((await desk.json('GET', '/api/me/preferences')).body.preferences).toMatchObject({ theme: 'light', accent: 'violet' })
    const v = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, 'vp_before01')))[0]
    expect(v.consent.attestedBy).toBe(A.userId)

    // DSK-21: deleting it removes its files, which stayed under the first space's folder (a delete puts it in the
    // trash; emptying the trash removes it)
    expect((await desk.json('DELETE', `/api/assets/${clip}`)).status).toBe(200)
    expect(fs.existsSync(file)).toBe(true)
    const trashed = (await ctx().db.select().from(assets).where(eq(assets.id, clip)))[0]
    expect((await desk.json('POST', '/api/assets/trash/empty', { workspaceId: trashed.workspaceId, ids: [clip] })).status).toBe(200)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('a save whose answer was lost is not a conflict (DSK-18)', () => {
  beforeAll(linkA)

  it('finds the cloud already has the same content and carries on', async () => {
    const p = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'lost answer' })).body
    await sync()
    await editDoc(desk, p.summary.id, (doc) => (doc.name = 'lost answer, edited'))
    // the cloud takes the save, but its answer never arrives
    const st0 = await intercept(
      (m, u) => m === 'PUT' && u.includes(`/api/projects/${p.summary.id}`),
      sync,
      async (real, input, init) => {
        const res = await real(input, init)
        await res.arrayBuffer()
        throw new TypeError('fetch failed')
      },
    )
    expect(st0.state).toBe('offline')
    expect((await A.http.json('GET', `/api/projects/${p.summary.id}`)).body.project.name).toBe('lost answer, edited')
    const st = await sync()
    expect(st.state).toBe('idle')
    expect(st.conflicts).toEqual([])
    expect(st.pending).toBe(0)
  })
})

describe('offline, conflict choices and new spaces say so (DSK-19, DSK-29)', () => {
  beforeAll(linkA)

  it('"Keep both" offline answers 502 and changes nothing; online it makes exactly one copy', async () => {
    const p = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'both' })).body
    const id = p.summary.id
    await sync()
    await editDoc(A.http, id, (doc) => (doc.name = 'both (cloud)'))
    await editDoc(desk, id, (doc) => (doc.name = 'both (desk)'))
    const st = await sync()
    expect(st.conflicts.map((x) => x.projectId)).toContain(id)
    const count = async () => (await desk.json('GET', `/api/projects?workspaceId=${A.workspaceId}&limit=500`)).body.items.length as number
    const n = await count()
    for (let i = 0; i < 2; i++) {
      const r = await offline(() => desk.json('POST', `/api/projects/${id}/sync`, { mode: 'keep-both' }))
      expect(r.status).toBe(502)
      expect(r.body.error).toMatch(/unreachable/i)
    }
    expect(await count()).toBe(n)
    expect((await desk.json('POST', `/api/projects/${id}/sync`, { mode: 'keep-both' })).status).toBe(200)
    await sync()
    const copies = (await A.http.json('GET', `/api/projects?workspaceId=${A.workspaceId}&limit=500`)).body.items.filter((x: { name: string }) => x.name === 'both (desk) (conflicted copy)')
    expect(copies).toHaveLength(1)
    expect((await desk.json('GET', `/api/projects/${id}`)).body.project.name).toBe('both (cloud)')
  })

  it('creating a space offline answers 502 with a reason, not "Internal server error"', async () => {
    const r = await offline(() => desk.json('POST', '/api/workspaces', { name: 'Offline space' }))
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/unreachable/i)
  })
})

describe('a cloud clip whose sync record was never written is still fetched (DSK-20)', () => {
  beforeAll(linkA)

  it('treats a clip with no file here as the cloud’s', async () => {
    const id = await cloudUpload(png())
    await sync()
    const { rawQuery } = await import('../desktop/db')
    const { sql } = await import('drizzle-orm')
    // a crash between writing the clip and its sync record
    await rawQuery(sql`DELETE FROM desktop_sync WHERE kind = 'asset' AND id = ${id}`)
    expect((await A.http.json('PATCH', `/api/assets/${id}`, { name: 'cloud renamed.png' })).status).toBe(200)
    await sync()
    let res = await desk.req('GET', `/api/media/${id}/source`)
    for (let i = 0; i < 50 && res.status === 202; i++) {
      await new Promise((r) => setTimeout(r, 200))
      res = await desk.req('GET', `/api/media/${id}/source`)
    }
    expect(res.status).toBe(200)
  })
})

describe('deletes made while unlinked reach the cloud when the same account links again (DSK-23)', () => {
  beforeAll(linkA)

  it('pushes them on relinking', async () => {
    const p = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'gone while unlinked' })).body
    await sync()
    expect((await desk.json('POST', '/api/sync/unlink')).status).toBe(200)
    expect((await desk.json('PATCH', `/api/projects/${p.summary.id}`, { trashed: true })).status).toBe(200)
    expect((await desk.json('DELETE', `/api/projects/${p.summary.id}`)).status).toBe(200)
    await link()
    expect((await A.http.json('GET', `/api/projects/${p.summary.id}`)).status).toBe(404)
  })
})

describe('a Wi-Fi sign-in page counts as offline (DSK-32)', () => {
  beforeAll(linkA)

  it('backs off instead of failing', async () => {
    const st = await intercept(
      () => true,
      sync,
      async () => new Response('<html><body>Hotel Wi-Fi: sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    expect(st.state).toBe('offline')
    expect((await sync()).state).toBe('idle')
  })
})

describe('a synced file that isn’t media is never served as a page (DSK-33)', () => {
  beforeAll(linkA)

  it('stores it as a download and keeps its sandbox policy', async () => {
    const { ctx } = await import('../context')
    const rec = { asset: { id: 'as_script01', kind: 'video', name: 'evil.js', src: '/api/media/as_script01/source', mime: 'text/javascript', createdAt: Date.now() }, workspaceId: A.workspaceId, status: 'ready', origin: 'upload', createdAt: Date.now(), changeSeq: 1 }
    await (d.engine as unknown as { applyAsset: (r: unknown) => Promise<void> }).applyAsset(rec)
    const { assets } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, 'as_script01')))[0]
    expect(row.mime).toBe('application/octet-stream')
    await ctx().storage.put(row.sourceKey, Buffer.from('alert(1)'))
    const res = await desk.req('GET', '/api/media/as_script01/source')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(res.headers.get('content-security-policy')).toMatch(/(^|, )sandbox/)
  })
})

describe('clip renames and transcripts sync after the first upload (DSK-35)', () => {
  beforeAll(linkA)

  it('both ways', async () => {
    const id = await deskUpload(A.workspaceId, png(), 'named.png')
    await sync()
    expect((await A.http.json('GET', `/api/assets/${id}`)).body.asset.name).toBe('named.png')
    // renamed here
    expect((await desk.json('PATCH', `/api/assets/${id}`, { name: 'renamed here' })).status).toBe(200)
    await sync()
    expect((await A.http.json('GET', `/api/assets/${id}`)).body.asset.name).toBe('renamed here')
    // renamed in the cloud
    expect((await A.http.json('PATCH', `/api/assets/${id}`, { name: 'renamed in the cloud' })).status).toBe(200)
    await sync()
    expect((await desk.json('GET', `/api/assets/${id}`)).body.asset.name).toBe('renamed in the cloud')
    // transcribed here
    const transcript: Transcript = { language: 'en', engine: 'whisper', segments: [{ start: 0, end: 1, text: 'hello there', words: [{ w: 'hello', start: 0, end: 0.4 }, { w: 'there', start: 0.5, end: 1 }] }] }
    const { mergeAssetMeta } = await import('../services/assets')
    await mergeAssetMeta(id, { transcript })
    await sync()
    expect((await A.http.json<AssetRecord>('GET', `/api/assets/${id}`)).body.asset.transcript).toEqual(transcript)
    expect((await sync()).pending).toBe(0)
  })
})

describe('a downloaded original is never usable before its hash is checked (DSK-36)', () => {
  beforeAll(linkA)

  it('lands under its own name only once verified', async () => {
    const { ctx } = await import('../context')
    const { assets } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const id = await cloudUpload(png())
    await sync()
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, id)))[0]
    // the bytes that arrive don't match the hash this computer was told
    await ctx().db.update(assets).set({ sha256: 'f'.repeat(64) }).where(eq(assets.id, id))
    const storage = ctx().storage
    const put = storage.put.bind(storage)
    const seen: string[] = []
    storage.put = async (key, body, opts) => {
      const r = await put(key, body, opts)
      if (key === row.sourceKey) seen.push(key)
      return r
    }
    try {
      let res = await desk.req('GET', `/api/media/${id}/source`)
      for (let i = 0; i < 50 && res.status === 202; i++) {
        await new Promise((r) => setTimeout(r, 200))
        res = await desk.req('GET', `/api/media/${id}/source`)
      }
      expect(res.status).toBe(404)
      expect(seen).toEqual([])
      expect(await storage.stat(row.sourceKey)).toBeNull()
      // the right hash: it arrives and is served
      await ctx().db.update(assets).set({ sha256: row.sha256 }).where(eq(assets.id, id))
      res = await desk.req('GET', `/api/media/${id}/source`)
      for (let i = 0; i < 50 && res.status === 202; i++) {
        await new Promise((r) => setTimeout(r, 200))
        res = await desk.req('GET', `/api/media/${id}/source`)
      }
      expect(res.status).toBe(200)
    } finally {
      storage.put = put
    }
  })
})

describe('a save made during a long sync write is pushed 3 s later, not at the next minute (DSK-37)', () => {
  beforeAll(linkA)

  it('sees the save while the engine is still writing', async () => {
    const { ctx } = await import('../context')
    const { saveSettings } = await import('../desktop/settings')
    const p = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'during a write' })).body
    await sync()
    const storage = ctx().storage
    const deletePrefix = storage.deletePrefix.bind(storage)
    let release!: () => void
    const blocked = new Promise<void>((r) => (release = r))
    storage.deletePrefix = async (prefix) => {
      await blocked
      return deletePrefix(prefix)
    }
    const schedule = vi.spyOn(d.engine, 'schedule').mockImplementation(() => undefined)
    saveSettings({ autoSync: true })
    try {
      const id = await cloudUpload(png())
      await sync()
      // the engine removes a clip deleted in the cloud, and takes its time over the files
      expect((await A.http.json('DELETE', `/api/assets/${id}`)).status).toBe(200)
      const running = (d.engine as unknown as { applyAssetDelete: (id: string) => Promise<void> }).applyAssetDelete(id)
      await new Promise((r) => setTimeout(r, 50))
      schedule.mockClear()
      await editDoc(desk, p.summary.id, (doc) => (doc.name = 'saved meanwhile'))
      expect(schedule).toHaveBeenCalledWith(3000)
      release()
      await running
    } finally {
      release()
      storage.deletePrefix = deletePrefix
      saveSettings({ autoSync: false })
      schedule.mockRestore()
    }
  })
})

describe('voice edits are ordered by the cloud, not by clocks (DSK-34)', () => {
  beforeAll(linkA)

  it('keeps an edit made on a computer whose clock is behind, and the cloud’s edit to another field', async () => {
    const { ctx } = await import('../context')
    const { voiceProfiles } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const now = Date.now()
    await ctx()
      .db.insert(voiceProfiles)
      .values({ id: 'vp_clock01', workspaceId: A.workspaceId, name: 'Clock', kind: 'clone', engine: 'omnivoice', consent: { statement: 'My own voice.', attestedBy: A.userId, attestedAt: now }, vsProfileId: 'p-clock', createdBy: A.userId, createdAt: now, updatedAt: now })
    await sync()
    expect((await A.http.json('GET', `/api/voice/profiles?workspaceId=${A.workspaceId}`)).body.find((v: { id: string }) => v.id === 'vp_clock01')).toMatchObject({ name: 'Clock' })
    // the web changes the description; this computer, whose clock is an hour behind, renames it
    expect((await A.http.json('PATCH', '/api/voice/profiles/vp_clock01', { description: 'Warm and slow' })).status).toBe(200)
    await ctx().db.update(voiceProfiles).set({ name: 'Clock renamed', updatedAt: Date.now() - 3600_000 }).where(eq(voiceProfiles.id, 'vp_clock01'))
    await sync()
    const inCloud = (await A.http.json('GET', `/api/voice/profiles?workspaceId=${A.workspaceId}`)).body.find((v: { id: string }) => v.id === 'vp_clock01')
    expect(inCloud).toMatchObject({ name: 'Clock renamed', description: 'Warm and slow' })
    const here = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, 'vp_clock01')))[0]
    expect(here).toMatchObject({ name: 'Clock renamed', description: 'Warm and slow' })
    expect((await sync()).pending).toBe(0)
  })
})

describe('the voice relay backs off when the cloud refuses it (DSK-31)', () => {
  beforeAll(linkA)

  it('asks once, then waits, and says so once', async () => {
    const { voiceStudio } = await import('../desktop/voicestudio/runtime')
    const { log } = await import('../log')
    const status = vi.spyOn(voiceStudio, 'status').mockReturnValue({ ...voiceStudio.status(), state: 'running' })
    const warn = vi.spyOn(log, 'warn')
    const engine = d.engine as unknown as { relayTick: () => Promise<void>; relayHasVoices: boolean; relayCheckAt: number }
    engine.relayHasVoices = true
    engine.relayCheckAt = Date.now()
    let claims = 0
    try {
      await intercept(
        (_m, u) => u.includes('/api/voice/relay/claim'),
        async () => {
          for (let i = 0; i < 5; i++) await engine.relayTick()
        },
        async () => {
          claims++
          return new Response(JSON.stringify({ error: 'Device token revoked', code: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
        },
      )
      expect(claims).toBe(1)
      expect(warn.mock.calls.filter((c) => c[0] === 'desktop: voice relay failed')).toHaveLength(1)
    } finally {
      status.mockRestore()
      warn.mockRestore()
      Object.assign(engine, { relayRetryAt: 0, relayBackoffMs: 0 })
    }
  })
})
