// The local Producer Studio server as a child process: Electron's own Node (ELECTRON_RUN_AS_NODE=1), MODE=desktop,
// 127.0.0.1 on a free port, a random per-launch DESKTOP_SECRET, logs to <userData>/logs/server.log (rotated by size).
// It watches its stdin and exits when this process goes away; on quit we close stdin (graceful: the server gives
// VoiceStudio its time, then closes the database), and kill the tree only if it's still running after that.
import { type ChildProcess, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'
import { resolveDataDir } from './datadir'
import { deviceKey } from './keystore'
import { RotatingLog } from './logs'
import { layout } from './paths'
import { stopGracefully } from './proc'

/** How long the server may take to shut down before its tree is killed (it exits on its own within 10 s). */
const STOP_GRACE_MS = 12_000

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

export interface DesktopPaths {
  userData: string
  dataDir: string
  logsDir: string
  settingsFile: string
}

export const dataDirEnv = () => ({ platform: process.platform, userData: app.getPath('userData'), localAppData: process.env.LOCALAPPDATA })

export function desktopPaths(): DesktopPaths {
  const userData = app.getPath('userData')
  const settingsFile = path.join(userData, 'settings.json')
  const dataDir = resolveDataDir(settingsFile, dataDirEnv())
  const logsDir = path.join(userData, 'logs')
  return { userData, dataDir, logsDir, settingsFile }
}

export class ServerProcess extends EventEmitter {
  port = 0
  private secret = ''
  private child?: ChildProcess
  private stopping = false
  paths = desktopPaths()
  private log = new RotatingLog(path.join(this.paths.logsDir, 'server.log'))

  /** Read where the data folder is again (after it was moved or switched to the default); the server is stopped. */
  refreshPaths() {
    this.paths = desktopPaths()
  }

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
    // never let a dev shell's cloud settings leak into the local server (nor the fixed dev secret: the server gets it as
    // DESKTOP_SECRET, which it keeps out of its own children)
    for (const k of ['DATABASE_URL', 'S3_BUCKET', 'ANTHROPIC_API_KEY', 'PGLITE_DIR', 'ROLE', 'AI_PROVIDER', 'PS_DESKTOP_SECRET']) delete env[k]
    this.log.write(`\n=== ${new Date().toISOString()} starting server on ${this.origin} (${app.isPackaged ? 'packaged' : 'dev'}) ===\n`)
    const child = spawn(process.execPath, l.serverArgs, { cwd: l.serverCwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.child = child
    child.stdout!.on('data', (b: Buffer) => this.log.write(b))
    child.stderr!.on('data', (b: Buffer) => this.log.write(b))
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
    if (!child) return
    // graceful: the server shuts down when its stdin closes (stops VoiceStudio and its workers, closes PGlite cleanly);
    // only a server still running after that has its tree killed (a process that has exited may have handed its id on)
    await stopGracefully(child, STOP_GRACE_MS)
  }
}
