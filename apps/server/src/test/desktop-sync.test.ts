// Desktop ⇄ cloud sync, end to end: a real cloud server (MODE=cloud, child process on a free port, its own data dir)
// and this process running MODE=desktop (in-memory PGlite, its own data dir) with the real sync engine over HTTP.
import { type ChildProcess, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, SyncStatus } from '@producer/core'
import type { AppEnv } from '../auth'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** Minimal cookie-jar HTTP client for the cloud (real network) and the desktop (in-process app.request). */
class Http {
  cookie = ''
  constructor(private send: (url: string, init: RequestInit) => Promise<Response>) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    let payload: BodyInit | undefined
    if (Buffer.isBuffer(body)) payload = body as unknown as BodyInit
    else if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res = await this.send(url, { method, headers: h, body: payload })
    const m = res.headers.get('set-cookie')?.match(/ps_session=([^;]+)/)
    if (m) this.cookie = `ps_session=${m[1]}`
    return res
  }
  async json<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.req(method, url, body, headers)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
}

let cloudProc: ChildProcess
let cloudUrl: string
let cloudHttp: Http
let desk: Http
let app: Hono<AppEnv>
let email: string
const password = 'correct-horse-1'
let cloudUserId: string
let cloudWs: string
let engine: typeof import('../desktop/sync').syncEngine
let stopWorker: () => void

async function sync(): Promise<SyncStatus> {
  const r = await desk.json<SyncStatus>('POST', '/api/sync/now')
  expect(r.status).toBe(200)
  return r.body
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

beforeAll(async () => {
  // ---- cloud: separate process, separate data dir ----
  const port = await freePort()
  cloudUrl = `http://127.0.0.1:${port}`
  const cloudData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cloud-'))
  cloudProc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, MODE: 'cloud', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: cloudData, PGLITE_DIR: 'memory://', LOG_SILENT: '1', AI_PROVIDER: 'none', DESKTOP_SECRET: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  cloudProc.stderr!.on('data', (b) => (err += String(b)))
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${cloudUrl}/api/health`)).ok) break
    } catch {
      /* booting */
    }
    if (i > 200) throw new Error(`cloud did not start: ${err}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  cloudHttp = new Http((u, init) => fetch(`${cloudUrl}${u}`, init))
  email = `desk${Date.now()}@example.com`
  const su = await cloudHttp.json('POST', '/api/auth/signup', { email, password, name: 'Dana Desk' })
  expect(su.status).toBe(200)
  cloudUserId = su.body.user.id
  cloudWs = su.body.workspaces[0].id

  // ---- desktop: this process ----
  const deskData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-desk-'))
  Object.assign(process.env, {
    MODE: 'desktop',
    DATA_DIR: deskData,
    PGLITE_DIR: 'memory://',
    LOG_SILENT: '1',
    DESKTOP_SECRET: 'test-secret-0123456789',
    DESKTOP_SETTINGS_FILE: path.join(deskData, 'settings.json'),
  })
  delete process.env.DATABASE_URL
  delete process.env.S3_BUCKET
  const { loadConfig } = await import('../config')
  const { initCtx } = await import('../context')
  const { createApp } = await import('../app')
  const { registerHandlers } = await import('../jobs/handlers')
  const worker = await import('../jobs/worker')
  const { initDesktop } = await import('../desktop')
  const { saveSettings } = await import('../desktop/settings')
  await initCtx(loadConfig())
  registerHandlers()
  await initDesktop()
  saveSettings({ autoSync: false })
  app = createApp()
  worker.startWorker({ concurrency: 1 })
  stopWorker = worker.stopWorker
  engine = (await import('../desktop/sync')).syncEngine
  await engine.start()
  desk = new Http(async (u, init) => app.request(u, init))
}, 120_000)

afterAll(async () => {
  engine?.stop()
  stopWorker?.()
  cloudProc?.kill()
})

describe('desktop identity & hardening', () => {
  it('issues a local session only with the per-launch secret; no sign-up; foreign Host headers are refused', async () => {
    expect((await desk.json('GET', '/api/auth/me')).status).toBe(401)
    expect((await desk.json('POST', '/api/desktop/session', {}, { 'x-desktop-secret': 'wrong' })).status).toBe(403)
    expect((await desk.json('POST', '/api/desktop/session')).status).toBe(403)
    const s = await desk.json('POST', '/api/desktop/session', {}, { 'x-desktop-secret': 'test-secret-0123456789' })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ cookie: 'ps_session', token: expect.any(String) })
    desk.cookie = `ps_session=${s.body.token}`
    const me = await desk.json('GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.workspaces).toHaveLength(1)
    expect(me.body.workspaces[0].personal).toBe(true)
    expect((await desk.json('POST', '/api/auth/signup', { email: 'x@y.z', password: 'longenough1', name: 'X' })).status).toBe(403)
    expect((await desk.json('GET', '/api/health', undefined, { host: 'evil.example.com' })).status).toBe(403)
    const sys = await desk.req('GET', '/api/system')
    expect(sys.headers.get('content-security-policy')).toMatch(/default-src 'self'/)
    const info = await sys.json()
    expect(info).toMatchObject({ mode: 'desktop', ai: { provider: 'claude-cli' }, sync: { linked: false, state: 'unlinked' } })
    // settings round-trip
    const set = await desk.json('PUT', '/api/settings', { mediaSync: 'on-demand', claudeModel: '' })
    expect(set.body).toMatchObject({ mediaSync: 'on-demand', autoSync: false })
    expect((await desk.json('PUT', '/api/settings', { bogus: 1 })).status).toBe(400)
  })
})

describe('link, pull, push', () => {
  let localOnly: string
  let cloudA: string

  it('links with cloud credentials, adopts the cloud identity and syncs both directions', async () => {
    const me0 = await desk.json('GET', '/api/auth/me')
    const localWs = me0.body.workspaces[0].id
    localOnly = (await desk.json('POST', '/api/projects', { workspaceId: localWs, name: 'Made offline' })).body.summary.id
    cloudA = (await cloudHttp.json('POST', '/api/projects', { workspaceId: cloudWs, name: 'Cloud A' })).body.summary.id

    expect((await desk.json('POST', '/api/sync/link', { cloudUrl, email, password: 'wrong-password' })).status).toBe(401)
    const linked = await desk.json<SyncStatus>('POST', '/api/sync/link', { cloudUrl: `${cloudUrl}/`, email, password })
    expect(linked.status).toBe(200)
    expect(linked.body).toMatchObject({ linked: true, cloudUrl, account: email })
    const st = await sync()
    expect(st).toMatchObject({ state: 'idle', pending: 0, conflicts: [] })

    // identity + workspace mirroring (local personal space merged into the cloud one)
    const me = await desk.json('GET', '/api/auth/me')
    expect(me.body.user).toMatchObject({ id: cloudUserId, email, name: 'Dana Desk' })
    expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([cloudWs])
    const deskList = (await desk.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.map((p: { id: string }) => p.id)
    expect(deskList).toEqual(expect.arrayContaining([localOnly, cloudA]))
    const cloudList = (await cloudHttp.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.map((p: { id: string }) => p.id)
    expect(cloudList).toEqual(expect.arrayContaining([localOnly, cloudA]))
    // the device token is stored encrypted, never in plain text
    const { kvGet } = await import('../desktop/db')
    const stored = JSON.stringify(await kvGet('link'))
    expect(stored).not.toMatch(/psd_/)
    // /api/devices on the cloud lists this computer
    expect((await cloudHttp.json('GET', '/api/devices')).body[0].name).toMatch(/Producer Studio desktop/)
  })

  it('edits on each side propagate; a project created on desktop keeps its id in the cloud', async () => {
    await editDoc(desk, localOnly, (p) => (p.name = 'Made offline v2'))
    await editDoc(cloudHttp, cloudA, (p) => (p.name = 'Cloud A v2'))
    const st = await sync()
    expect(st.conflicts).toEqual([])
    expect((await cloudHttp.json('GET', `/api/projects/${localOnly}`)).body.summary.name).toBe('Made offline v2')
    expect((await desk.json('GET', `/api/projects/${cloudA}`)).body.summary.name).toBe('Cloud A v2')
    // trash on desktop → trashed in the cloud
    await desk.json('PATCH', `/api/projects/${localOnly}`, { trashed: true })
    await sync()
    expect((await cloudHttp.json('GET', `/api/projects/${localOnly}`)).body.summary.trashed).toBe(true)
    await desk.json('PATCH', `/api/projects/${localOnly}`, { trashed: false })
    await sync()
    expect((await cloudHttp.json('GET', `/api/projects/${localOnly}`)).body.summary.trashed).toBe(false)
  })

  it('edits on both sides → conflict → keep-local, keep-cloud, keep-both', async () => {
    const conflict = async (tag: string) => {
      await editDoc(desk, cloudA, (p) => (p.name = `desk ${tag}`))
      await editDoc(cloudHttp, cloudA, (p) => (p.name = `cloud ${tag}`))
      const st = await sync()
      expect(st.conflicts).toHaveLength(1)
      expect(st.conflicts[0]).toMatchObject({ projectId: cloudA, name: `desk ${tag}` })
      expect(st.conflicts[0].cloudVersion).toBeGreaterThan(1)
      // conflicted projects are never overwritten by pull
      expect((await desk.json('GET', `/api/projects/${cloudA}`)).body.summary.name).toBe(`desk ${tag}`)
    }

    await conflict('1')
    let r = await desk.json<SyncStatus>('POST', `/api/projects/${cloudA}/sync`, { mode: 'keep-local' })
    expect(r.body.conflicts).toEqual([])
    expect((await cloudHttp.json('GET', `/api/projects/${cloudA}`)).body.summary.name).toBe('desk 1')

    await conflict('2')
    r = await desk.json<SyncStatus>('POST', `/api/projects/${cloudA}/sync`, { mode: 'keep-cloud' })
    expect(r.body.conflicts).toEqual([])
    expect((await desk.json('GET', `/api/projects/${cloudA}`)).body.summary.name).toBe('cloud 2')

    await conflict('3')
    r = await desk.json<SyncStatus>('POST', `/api/projects/${cloudA}/sync`, { mode: 'keep-both' })
    expect(r.body.conflicts).toEqual([])
    expect((await desk.json('GET', `/api/projects/${cloudA}`)).body.summary.name).toBe('cloud 3')
    const copies = (await cloudHttp.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.filter((p: { name: string }) => p.name === 'desk 3 (conflicted copy)')
    expect(copies).toHaveLength(1)
    const deskCopies = (await desk.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.filter((p: { name: string }) => p.name === 'desk 3 (conflicted copy)')
    expect(deskCopies.map((p: { id: string }) => p.id)).toEqual([copies[0].id])
    expect((await sync()).pending).toBe(0)
  })

  it('a push rejected with 409 (cloud changed after our pull) becomes a conflict', async () => {
    const { kvGet, kvSet } = await import('../desktop/db')
    await editDoc(desk, cloudA, (p) => (p.name = 'desk late'))
    await editDoc(cloudHttp, cloudA, (p) => (p.name = 'cloud late'))
    const cursor = (await kvGet<number>('cursor'))!
    await kvSet('cursor', 1e12) // hide the cloud change from the pull so the PUT meets it
    const st = await sync()
    await kvSet('cursor', cursor)
    expect(st.conflicts.map((c) => c.projectId)).toEqual([cloudA])
    const r = await desk.json<SyncStatus>('POST', `/api/projects/${cloudA}/sync`, { mode: 'keep-cloud' })
    expect(r.body.conflicts).toEqual([])
  })
})

describe('assets', () => {
  it('an asset uploaded on desktop exists in the cloud with the same id and sha256', async () => {
    const t = await desk.json('POST', '/api/uploads', { workspaceId: cloudWs, filename: 'dot.png', mime: 'image/png', size: PNG.length })
    expect(t.status).toBe(200)
    expect((await desk.json('PUT', t.body.url, PNG, { 'content-type': 'image/png' })).status).toBe(200)
    const done = await desk.json('POST', `/api/assets/${t.body.assetId}/complete`)
    expect(done.status).toBe(200)
    await sync()
    const inCloud = await cloudHttp.json('GET', `/api/assets/${t.body.assetId}`)
    expect(inCloud.status).toBe(200)
    expect(inCloud.body.asset.id).toBe(t.body.assetId)
    const bytes = Buffer.from(await (await cloudHttp.req('GET', `/api/media/${t.body.assetId}/source`)).arrayBuffer())
    expect(sha(bytes)).toBe(sha(PNG))
    // the change feed echo doesn't turn it into a "remote" asset or re-upload it
    expect((await sync()).pending).toBe(0)
  })

  it('a cloud asset appears on desktop and its bytes are fetched on demand (202 while downloading), sha256-verified', async () => {
    const img = Buffer.concat([PNG, crypto.randomBytes(64)])
    const t = await cloudHttp.json('POST', '/api/uploads', { workspaceId: cloudWs, filename: 'cloud.png', mime: 'image/png', size: img.length })
    await cloudHttp.req('PUT', t.body.url, img, { 'content-type': 'image/png' })
    await cloudHttp.json('POST', `/api/assets/${t.body.assetId}/complete`)
    await sync()
    const rec = await desk.json('GET', `/api/assets/${t.body.assetId}`)
    expect(rec.status).toBe(200)
    const { ctx } = await import('../context')
    const { assets } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, t.body.assetId)))[0]
    expect(await ctx().storage.stat(row.sourceKey)).toBeNull() // nothing downloaded yet
    let res: Response | undefined
    for (let i = 0; i < 20; i++) {
      res = await desk.req('GET', `/api/media/${t.body.assetId}/source`)
      if (res.status !== 202) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(res!.status).toBe(200)
    expect(sha(Buffer.from(await res!.arrayBuffer()))).toBe(sha(img))
    // cached: Range requests are served locally
    const part = await desk.req('GET', `/api/media/${t.body.assetId}/source`, undefined, { range: 'bytes=0-7' })
    expect(part.status).toBe(206)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(img.subarray(0, 8))
  })
})

describe('deletes & unlink', () => {
  it('a project deleted in the cloud disappears locally; unlink keeps local data', async () => {
    const id = (await cloudHttp.json('POST', '/api/projects', { workspaceId: cloudWs, name: 'Doomed' })).body.summary.id
    await sync()
    expect((await desk.json('GET', `/api/projects/${id}`)).status).toBe(200)
    await cloudHttp.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await cloudHttp.json('DELETE', `/api/projects/${id}`)
    await sync()
    expect((await desk.json('GET', `/api/projects/${id}`)).status).toBe(404)

    const before = (await desk.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.length
    const un = await desk.json<SyncStatus>('POST', '/api/sync/unlink')
    expect(un.body).toMatchObject({ linked: false, state: 'unlinked' })
    expect((await desk.json('GET', `/api/projects?workspaceId=${cloudWs}`)).body.length).toBe(before)
    // the device token was revoked in the cloud
    expect((await cloudHttp.json('GET', '/api/devices')).body).toEqual([])
  })
})
