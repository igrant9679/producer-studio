// Desktop ⇄ cloud test harness: a real cloud server (MODE=cloud, child process on a free port, its own data dir) and
// this process running MODE=desktop (in-memory PGlite, its own data dir) with the real sync engine over HTTP.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { AppEnv } from '../auth'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

/** Minimal cookie-jar HTTP client for the cloud (real network) and the desktop (in-process app.request). */
export class Http {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async json<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.req(method, url, body, headers)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
}

export interface Cloud {
  url: string
  proc: ChildProcess
  http: () => Http
  /** Sign up a new cloud account; its client keeps the session cookie. */
  signup: (name: string, email?: string) => Promise<{ http: Http; email: string; userId: string; workspaceId: string }>
}

export const PASSWORD = 'correct-horse-1'

export async function startCloud(env: Record<string, string> = {}): Promise<Cloud> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const cloudData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cloud-'))
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, MODE: 'cloud', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: cloudData, PGLITE_DIR: 'memory://', LOG_SILENT: '1', AI_PROVIDER: 'none', DESKTOP_SECRET: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  proc.stderr!.on('data', (b) => (err += String(b)))
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break
    } catch {
      /* booting */
    }
    // a loaded machine (several suites at once) can take a minute to compile and boot the cloud
    if (i > 600 || proc.exitCode != null) throw new Error(`cloud did not start: ${err}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  // a pooled keep-alive socket the cloud has just closed resets the next request on it; the test client tries once more
  const send = async (u: string, init: RequestInit) => {
    try {
      return await fetch(`${url}${u}`, init)
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw err
      return fetch(`${url}${u}`, init)
    }
  }
  const http = () => new Http(send)
  let n = 0
  return {
    url,
    proc,
    http,
    async signup(name, email = `u${Date.now()}${n++}@example.com`) {
      const h = http()
      const su = await h.json('POST', '/api/auth/signup', { email, password: PASSWORD, name })
      if (su.status !== 200) throw new Error(`signup failed ${su.status} ${JSON.stringify(su.body)}`)
      return { http: h, email, userId: su.body.user.id, workspaceId: su.body.workspaces[0].id }
    },
  }
}

export interface Desktop {
  app: Hono<AppEnv>
  desk: Http
  engine: typeof import('../desktop/sync').syncEngine
  stop: () => void
}

/** Boot the desktop edition in this process (call once per test file) and open a local session. */
export async function startDesktop(): Promise<Desktop> {
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
  const app = createApp()
  worker.startWorker({ concurrency: 1 })
  const engine = (await import('../desktop/sync')).syncEngine
  await engine.start()
  const desk = new Http(async (u, init) => app.request(u, init))
  return {
    app,
    desk,
    engine,
    stop: () => {
      engine.stop()
      worker.stopWorker()
    },
  }
}

/** A local session for the desktop client (the per-launch secret the Electron shell would send). */
export async function deskSession(desk: Http) {
  const s = await desk.json('POST', '/api/desktop/session', {}, { 'x-desktop-secret': 'test-secret-0123456789' })
  if (s.status !== 200) throw new Error(`desktop session failed ${s.status}`)
  desk.cookie = `ps_session=${s.body.token}`
}
