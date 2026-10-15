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

describe('desktop AI keys', () => {
  it('seals keys in the local settings file, ignores workspaceId and never returns them', async () => {
    const { setKeyClients } = await import('../ai/keys')
    const KEY = 'AIzaDESKTOPKEY0123456789wxyz'
    setKeyClients({
      gemini: () => ({
        models: {
          generateContentStream: async () => (async function* () {})(),
          list: async () =>
            (async function* () {
              yield { name: 'models/gemini-3-pro', supportedActions: ['generateContent'] }
            })(),
        },
      }),
    })
    try {
      const put = await desk.json('PUT', '/api/ai/keys/gemini', { workspaceId: 'ignored-on-desktop', key: KEY })
      expect(put.status).toBe(200)
      expect(put.body).toMatchObject({ ok: true, models: ['gemini-3-pro'], settings: { canEdit: true, builtin: { id: 'claude-cli' }, providers: { gemini: { hasKey: true, keyLast4: 'wxyz', model: 'gemini-3-pro' } } } })
      const file = fs.readFileSync(process.env.DESKTOP_SETTINGS_FILE!, 'utf8')
      expect(file).not.toContain(KEY)
      expect(JSON.parse(file).ai.keys.gemini).toMatchObject({ v: 1, last4: 'wxyz', data: expect.any(String) })
      const settings = await desk.json('GET', '/api/settings')
      expect(settings.body.ai).toBeUndefined()
      expect((await desk.json('PUT', '/api/settings', { ai: {} })).status).toBe(400)
      await desk.json('PUT', '/api/ai/settings', { defaultProvider: 'gemini' })
      const sys = await desk.json('GET', '/api/system')
      expect(sys.body.ai).toMatchObject({ provider: 'gemini', available: true, model: 'gemini-3-pro' })
      for (const r of [put, settings, sys, await desk.json('GET', '/api/ai/settings')]) expect(JSON.stringify(r.body)).not.toContain(KEY)
      const del = await desk.json('DELETE', '/api/ai/keys/gemini')
      expect(del.body).toMatchObject({ defaultProvider: null, providers: { gemini: { hasKey: false } } })
      expect((await desk.json('GET', '/api/system')).body.ai.provider).toBe('claude-cli')
      // a settings save afterwards keeps the (now key-less) AI document intact
      await desk.json('PUT', '/api/settings', { mediaSync: 'on-demand' })
      expect(JSON.parse(fs.readFileSync(process.env.DESKTOP_SETTINGS_FILE!, 'utf8')).ai.doc.providers.gemini.model).toBe('gemini-3-pro')
    } finally {
      setKeyClients(undefined)
    }
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

describe('VoiceStudio voices (fake VoiceStudio backend)', () => {
  let fake: Awaited<ReturnType<typeof import('./fake-voicestudio').startFakeVoiceStudio>>
  let voiceId: string
  let makeWav: (s?: number) => Buffer
  let batchMp4: string

  async function waitJob(h: Http, id: string, ms = 30_000) {
    const end = Date.now() + ms
    for (;;) {
      const j = (await h.json('GET', `/api/jobs/${id}`)).body
      if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') return j
      if (Date.now() > end) throw new Error(`job ${id} still ${j.status}: ${j.message}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  async function postForm(url: string, form: FormData) {
    const res = await app.request(url, { method: 'POST', headers: { cookie: desk.cookie }, body: form })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }

  beforeAll(async () => {
    const m = await import('./fake-voicestudio')
    makeWav = m.makeWav
    // a real (tiny) MP4 for batch outputs
    const ffmpeg = (await import('ffmpeg-static')).default as unknown as string
    batchMp4 = path.join(os.tmpdir(), `ps-batch-${Date.now()}.mp4`)
    const { spawnSync } = await import('node:child_process')
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', batchMp4])
    fake = await m.startFakeVoiceStudio({ batchMp4 })
    process.env.PS_VOICESTUDIO_URL = fake.url
    // the earlier "deletes & unlink" suite may not have run yet; make sure we're linked
    const st = await desk.json<SyncStatus>('GET', '/api/sync/status').catch(() => null)
    if (!st?.body?.linked) await desk.json('POST', '/api/sync/link', { cloudUrl, email, password })
  })

  afterAll(async () => {
    delete process.env.PS_VOICESTUDIO_URL
    await fake?.close()
  })

  it('starts the engine and proxies only allow-listed VoiceStudio routes (without an Origin header)', async () => {
    expect((await desk.json('POST', '/api/voicestudio/start')).body).toMatchObject({ state: 'running', supported: true, version: '0.5.6' })
    const eng = await desk.json('GET', '/api/voicestudio/x/engines/tts')
    expect(eng.status).toBe(200)
    expect(eng.body.backends[0].id).toBe('omnivoice')
    expect((await desk.json('GET', '/api/voicestudio/x/system/info')).status).toBe(403)
    // routes the Gallery / Stories tabs rely on are allowed through (the fake answers 404, not the proxy's 403)
    for (const [m, p] of [['POST', '/longform/render'], ['GET', '/longform/jobs'], ['GET', '/community/items'], ['POST', '/personas/inspect'], ['POST', '/gallery/upload'], ['GET', '/dictation/models']] as const) {
      expect((await desk.json(m, `/api/voicestudio/x${p}`, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).not.toBe(403)
    }
    expect((await desk.json('POST', '/api/voicestudio/x/api/settings/hf-token', { token: 'x' })).status).toBe(403)
    expect((await desk.json('GET', '/api/voicestudio/x/profiles/../system/info')).status).not.toBe(200)
    expect(fake.requests.every((r) => r.origin === undefined)).toBe(true)
  })

  it('creates a cloned voice only with a recording and a consent record', async () => {
    const base = () => {
      const f = new FormData()
      f.set('workspaceId', cloudWs)
      f.set('name', 'Dana (clone)')
      f.set('kind', 'clone')
      f.set('engine', 'omnivoice')
      f.set('language', 'English')
      return f
    }
    const noConsent = base()
    noConsent.set('audio', new File([new Uint8Array(makeWav(3))], 'me.wav', { type: 'audio/wav' }))
    expect((await postForm('/api/voicestudio/voices', noConsent)).status).toBe(400)
    const noAudio = base()
    noAudio.set('consent', JSON.stringify({ agreed: true, statement: 'This is my own voice and I consent to cloning it.' }))
    expect((await postForm('/api/voicestudio/voices', noAudio)).status).toBe(400)
    const ok = base()
    ok.set('audio', new File([new Uint8Array(makeWav(3))], 'me.wav', { type: 'audio/wav' }))
    ok.set('consent', JSON.stringify({ agreed: true, speaker: 'me', statement: 'This is my own voice and I consent to cloning it.' }))
    const r = await postForm('/api/voicestudio/voices', ok)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ name: 'Dana (clone)', kind: 'clone', engine: 'omnivoice', local: true, consent: { speaker: 'me' } })
    voiceId = r.body.id
    expect(fake.profiles.size).toBe(1)
    const voices = (await desk.json('GET', `/api/ai/voices?workspaceId=${cloudWs}`)).body
    expect(voices.find((v: { id: string }) => v.id === `vs:${voiceId}`)).toMatchObject({ available: true, source: 'clone' })
  })

  it('generates speech with the cloned voice on the desktop', async () => {
    const job = await desk.json('POST', '/api/ai/tts', { workspaceId: cloudWs, text: 'Made on my desktop.', voice: `vs:${voiceId}` })
    expect(job.body.kind).toBe('ai.tts')
    const done = await waitJob(desk, job.body.id)
    expect(done.status).toBe('done')
    expect(done.result.asset).toMatchObject({ origin: 'tts', asset: { kind: 'audio' } })
    const gen = fake.requests.filter((r) => r.path === '/generate')
    expect(gen.at(-1)!.body).toMatch(/name="profile_id"\r\n\r\np1/)
    expect(gen.at(-1)!.body).toMatch(/name="engine"\r\n\r\nomnivoice/)
  })

  it('syncs the voice to the cloud, and the web app generates with it through this desktop', async () => {
    await sync()
    const cloudList = await cloudHttp.json('GET', `/api/voice/profiles?workspaceId=${cloudWs}`)
    const v = cloudList.body.find((x: { id: string }) => x.id === voiceId)
    expect(v).toMatchObject({ name: 'Dana (clone)', local: false })
    expect(v.deviceId).toBeTruthy()
    const job = await cloudHttp.json('POST', '/api/ai/tts', { workspaceId: cloudWs, text: 'Requested from the browser.', voice: `vs:${voiceId}` })
    expect(job.body.kind).toBe('voice.relay')
    await (engine as unknown as { relayCheckAt: number; relayTick: () => Promise<void> }).relayTick()
    const done = await waitJob(cloudHttp, job.body.id)
    expect(done.status).toBe('done')
    const assetId = done.result.asset.asset.id
    expect((await cloudHttp.json('GET', `/api/assets/${assetId}`)).body).toMatchObject({ origin: 'tts', asset: { kind: 'audio' } })
  })

  it('imports a VoiceStudio output into the library', async () => {
    const job = await desk.json('POST', '/api/voicestudio/import', { workspaceId: cloudWs, source: '/audio/h2.wav', name: 'Best take', kind: 'audio' })
    expect(job.status).toBe(200)
    const done = await waitJob(desk, job.body.id)
    expect(done.status).toBe('done')
    expect(done.result.asset).toMatchObject({ origin: 'voicestudio', asset: { name: 'Best take', kind: 'audio' } })
    expect((await desk.json('POST', '/api/voicestudio/import', { workspaceId: cloudWs, source: '/system/info', name: 'x', kind: 'audio' })).status).toBe(400)
  })

  it('proxies the live dictation WebSocket only for this app’s signed-in pages, without leaking Origin or cookies', async () => {
    const http = await import('node:http')
    const { attachDictationProxy } = await import('../desktop/voicestudio/wsproxy')
    const server = http.createServer((_q, r) => r.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    attachDictationProxy(server, port)
    const url = `ws://127.0.0.1:${port}/api/voicestudio/ws/dictation?model=sherpa-x&evil=1`
    const open = (headers: Record<string, string>) =>
      new Promise<{ ok: boolean; messages: string[] }>((resolve) => {
        const ws = new (WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket)(url, { headers })
        const messages: string[] = []
        ws.onmessage = (m) => {
          messages.push(String(m.data))
          if (messages.length === 2) ws.send(new Uint8Array([1, 2, 3]))
        }
        ws.onclose = () => resolve({ ok: messages.length > 0, messages })
        ws.onerror = () => undefined
      })
    try {
      expect((await open({ origin: `http://127.0.0.1:${port}` })).ok).toBe(false) // no session
      expect((await open({ cookie: desk.cookie, origin: 'http://evil.test' })).ok).toBe(false) // cross-site
      const before = fake.upgrades.length
      const r = await open({ cookie: desk.cookie, origin: `http://127.0.0.1:${port}` })
      expect(r.messages.map((m) => JSON.parse(m).type)).toEqual(['session.started', 'partial', 'final'])
      expect(JSON.parse(r.messages[2]).text).toBe('Hello world.')
      expect(fake.upgrades.length).toBe(before + 1)
      expect(fake.upgrades.at(-1)).toMatchObject({ path: '/v1/audio/transcriptions/stream?model=sherpa-x', origin: undefined, cookie: undefined })
    } finally {
      server.close()
    }
  })

  it('batch: finished jobs queued from Producer are imported into the library per language', async () => {
    const f = new FormData()
    f.set('video', new File([new Uint8Array(fs.readFileSync(batchMp4))], 'clip.mp4', { type: 'video/mp4' }))
    f.set('langs', 'es,fr')
    const res = await app.request('/api/voicestudio/x/batch/enqueue', { method: 'POST', headers: { cookie: desk.cookie }, body: f })
    const { job_id } = await res.json()
    expect((await desk.json('POST', '/api/voicestudio/batch/track', { jobId: job_id, workspaceId: cloudWs, name: 'clip', langs: ['es', 'fr'] })).body).toEqual({ ok: true })
    expect((await desk.json('GET', '/api/voicestudio/batch/tracked')).body.map((t: { jobId: string }) => t.jobId)).toContain(job_id)
    const { pollBatches } = await import('../desktop/voicestudio/batch')
    expect(await pollBatches()).toBe(2)
    expect((await desk.json('GET', '/api/voicestudio/batch/tracked')).body).toEqual([])
    // the two import jobs finish into dub assets
    const end = Date.now() + 30_000
    for (;;) {
      const vids = (await desk.json('GET', `/api/assets?workspaceId=${cloudWs}&kind=video`)).body.filter((a: { origin: string; asset: { name: string } }) => a.origin === 'dub' && a.asset.name.startsWith('clip'))
      if (vids.length === 2 && vids.every((a: { status: string }) => a.status === 'ready')) {
        expect(vids.map((a: { asset: { name: string } }) => a.asset.name).sort()).toEqual(['clip — es', 'clip — fr'])
        break
      }
      if (Date.now() > end) throw new Error(`imports not ready: ${JSON.stringify(vids.map((a: { status: string }) => a.status))}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  })

  it('sends a library clip into the gallery (extracted audio, extra form fields passed through)', async () => {
    const lib = (await desk.json('GET', `/api/assets?workspaceId=${cloudWs}&kind=audio`)).body as Array<{ asset: { id: string } }>
    const before = fake.requests.length
    const r = await desk.json('POST', `/api/voicestudio/asset-to/gallery?assetId=${lib[0].asset.id}&name=Interview&category=import`)
    expect(r.body).toMatchObject({ name: 'Interview', duration: 2 })
    const req = fake.requests.slice(before).find((x) => x.path === '/gallery/upload')!
    expect(req.body).toMatch(/name="audio"; filename=/)
    expect(req.body).toMatch(/name="category"\r\n\r\nimport/)
    expect((await desk.json('POST', `/api/voicestudio/asset-to/nope?assetId=${lib[0].asset.id}`)).status).toBe(404)
  })

  it('deleting the voice on the web removes it from the desktop and from VoiceStudio', async () => {
    expect((await cloudHttp.json('DELETE', `/api/voice/profiles/${voiceId}`)).body).toEqual({ ok: true })
    await sync()
    expect((await desk.json('GET', `/api/voice/profiles?workspaceId=${cloudWs}`)).body).toEqual([])
    expect(fake.profiles.size).toBe(0)
  })
})

describe('workspace rename & delete', () => {
  const ids = async (h: Http) => (await h.json('GET', '/api/workspaces')).body.map((w: { id: string }) => w.id)

  it('a space deleted in the cloud disappears locally with its projects', async () => {
    const ws = (await cloudHttp.json('POST', '/api/workspaces', { name: 'Short-lived' })).body.id
    const pid = (await cloudHttp.json('POST', '/api/projects', { workspaceId: ws, name: 'In the space' })).body.summary.id
    await sync()
    expect(await ids(desk)).toContain(ws)
    expect((await desk.json('GET', `/api/projects/${pid}`)).status).toBe(200)
    expect((await cloudHttp.json('DELETE', `/api/workspaces/${ws}`)).status).toBe(200)
    const st = await sync()
    expect(st).toMatchObject({ state: 'idle', pending: 0 })
    expect(await ids(desk)).not.toContain(ws)
    expect((await desk.json('GET', `/api/projects/${pid}`)).status).toBe(404)
  })

  it('renaming and deleting on desktop go to the cloud first', async () => {
    const ws = (await desk.json('POST', '/api/workspaces', { name: 'From desktop' })).body.id
    expect(await ids(cloudHttp)).toContain(ws)
    const r = await desk.json('PATCH', `/api/workspaces/${ws}`, { name: 'Renamed on desktop' })
    expect(r.body).toMatchObject({ id: ws, name: 'Renamed on desktop' })
    expect((await cloudHttp.json('GET', '/api/workspaces')).body.find((w: { id: string }) => w.id === ws).name).toBe('Renamed on desktop')
    expect((await desk.json('DELETE', `/api/workspaces/${ws}`)).body).toEqual({ ok: true })
    expect(await ids(cloudHttp)).not.toContain(ws)
    expect(await ids(desk)).not.toContain(ws)
    expect((await sync()).state).toBe('idle')
    // the personal space can't be deleted (cloud refuses)
    expect((await desk.json('DELETE', `/api/workspaces/${cloudWs}`)).status).toBe(409)
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
