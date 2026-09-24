// The local Producer Studio server as a child process: Electron's own Node (ELECTRON_RUN_AS_NODE=1), MODE=desktop,
// 127.0.0.1 on a free port, a random per-launch DESKTOP_SECRET, logs to <userData>/logs/server.log. It watches its
// stdin and exits when this process goes away; on quit we close stdin (graceful), then kill the tree.
import { type ChildProcess, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'
import { deviceKey } from './keystore'
import { layout } from './paths'

export function freePort(preferred?: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const s = net.createServer()
      s.once('error', reject)
      s.listen(p, '127.0.0.1', () => {
        const got = (s.address() as net.AddressInfo).port
        s.close(() => resolve(got))
      })
    })
  return preferred ? tryPort(preferred).catch(() => tryPort(0)) : tryPort(0)
}

function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
  else
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
}

export interface DesktopPaths {
  userData: string
  dataDir: string
  logsDir: string
  settingsFile: string
}

export function desktopPaths(): DesktopPaths {
  const userData = app.getPath('userData')
  const settingsFile = path.join(userData, 'settings.json')
  let dataDir = path.join(userData, 'data')
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { dataDir?: string }
    if (s.dataDir && path.isAbsolute(s.dataDir)) dataDir = s.dataDir
  } catch {
    /* first run */
  }
  const logsDir = path.join(userData, 'logs')
  return { userData, dataDir, logsDir, settingsFile }
}

function openLog(file: string): fs.WriteStream {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
  } catch {
    /* no log yet */
  }
  return fs.createWriteStream(file, { flags: 'a' })
}

export class ServerProcess extends EventEmitter {
  port = 0
  private secret = ''
  private child?: ChildProcess
  private stopping = false
  readonly paths = desktopPaths()
  private log = openLog(path.join(this.paths.logsDir, 'server.log'))

  get origin() {
    return `http://127.0.0.1:${this.port}`
  }

  get running() {
    return !!this.child && this.child.exitCode === null
  }

  async start(): Promise<void> {
    this.stopping = false
    this.port = await freePort(this.port || undefined)
    // PS_DESKTOP_SECRET: fixed secret for UI automation/tests in dev builds only; packaged builds always use a random
    // per-launch secret (so nothing in the environment can pre-arrange a way into the local API)
    const fixed = !app.isPackaged ? process.env.PS_DESKTOP_SECRET : undefined
    this.secret = fixed && fixed.length >= 16 ? fixed : crypto.randomBytes(32).toString('base64url')
    const l = layout()
    fs.mkdirSync(this.paths.dataDir, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...l.serverEnv,
      ELECTRON_RUN_AS_NODE: '1',
      MODE: 'desktop',
      PORT: String(this.port),
      HOST: '127.0.0.1',
      DATA_DIR: this.paths.dataDir,
      DESKTOP_SECRET: this.secret,
      DESKTOP_SETTINGS_FILE: this.paths.settingsFile,
      DESKTOP_PARENT_STDIN: '1',
      PRODUCER_DESKTOP_VERSION: app.getVersion(),
    }
    const key = deviceKey()
    if (key) env.DESKTOP_SECRET_KEY = key
    else delete env.DESKTOP_SECRET_KEY
    // never let a dev shell's cloud settings leak into the local server
    for (const k of ['DATABASE_URL', 'S3_BUCKET', 'ANTHROPIC_API_KEY', 'PGLITE_DIR', 'ROLE', 'AI_PROVIDER']) delete env[k]
    this.log.write(`\n=== ${new Date().toISOString()} starting server on ${this.origin} (${app.isPackaged ? 'packaged' : 'dev'}) ===\n`)
    const child = spawn(process.execPath, l.serverArgs, { cwd: l.serverCwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.child = child
    child.stdout!.pipe(this.log, { end: false })
    child.stderr!.pipe(this.log, { end: false })
    child.stdin!.on('error', () => undefined)
    child.on('exit', (code, signal) => {
      this.log.write(`=== server exited code=${code} signal=${signal} ===\n`)
      if (this.child === child) this.child = undefined
      if (!this.stopping) this.emit('crash', code ?? signal)
    })
    await this.waitHealthy(child)
  }

  private async waitHealthy(child: ChildProcess, timeoutMs = 90_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (child.exitCode !== null) throw new Error(`The local server exited during startup (code ${child.exitCode}). See ${path.join(this.paths.logsDir, 'server.log')}`)
      try {
        const r = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return
      } catch {
        /* still booting */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('The local server did not start in time')
  }

  /** A session token for the local user (becomes the ps_session cookie). */
  async session(): Promise<{ token: string; expiresAt: number }> {
    const r = await fetch(`${this.origin}/api/desktop/session`, { method: 'POST', headers: { 'x-desktop-secret': this.secret } })
    if (!r.ok) throw new Error(`Could not open a local session (HTTP ${r.status})`)
    return (await r.json()) as { token: string; expiresAt: number }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child || child.exitCode !== null) return
    // graceful: the server shuts down when its stdin closes (closes PGlite cleanly)
    child.stdin?.end()
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
    if (!exited) killTree(child.pid)
    else killTree(child.pid) // sweep leftover grandchildren (tts worker, renders) — no-op if gone
  }
}
