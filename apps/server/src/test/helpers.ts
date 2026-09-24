// Test harness: in-memory PGlite, temp local storage, the real Hono app, and a tiny cookie-jar client.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Hono } from 'hono'
import type { AppEnv } from '../auth'

export interface TestEnv {
  app: Hono<AppEnv>
  dataDir: string
}

let env: TestEnv | undefined

export async function setup(): Promise<TestEnv> {
  if (env) return env
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'))
  process.env.LOG_SILENT = '1'
  process.env.DATA_DIR = dataDir
  process.env.PGLITE_DIR = 'memory://'
  delete process.env.DATABASE_URL
  delete process.env.S3_BUCKET
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_PROFILE
  process.env.ANTHROPIC_CONFIG_DIR = path.join(dataDir, 'no-anthropic-config')
  const { loadConfig } = await import('../config')
  const { initCtx } = await import('../context')
  const { createApp } = await import('../app')
  const { registerHandlers } = await import('../jobs/handlers')
  await initCtx(loadConfig())
  registerHandlers()
  env = { app: createApp(), dataDir }
  return env
}

export class Client {
  cookie = ''
  constructor(private app: Hono<AppEnv>) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array || typeof body === 'string') payload = body as BodyInit
    else if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res = await this.app.request(url, { method, headers: h, body: payload })
    const set = res.headers.get('set-cookie')
    if (set) {
      const m = set.match(/ps_session=([^;]*)/)
      if (m) this.cookie = m[1] ? `ps_session=${m[1]}` : ''
      if (/ps_session=;/.test(set) || /Max-Age=0/i.test(set)) this.cookie = ''
    }
    return res
  }

  async json<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.req(method, url, body)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
}

let n = 0
export async function signup(app: Hono<AppEnv>, name = 'Test User'): Promise<{ client: Client; workspaceId: string; email: string }> {
  const client = new Client(app)
  const email = `user${Date.now()}${n++}@example.com`
  const r = await client.json('POST', '/api/auth/signup', { email, password: 'correct-horse-1', name })
  if (r.status !== 200) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`)
  return { client, workspaceId: r.body.workspaces[0].id, email }
}
