// The local Producer Studio server (MODE=desktop) on 127.0.0.1 and a free port, with a random per-launch
// DESKTOP_SECRET, logging to <userData>/logs/server.log (rotated by size). Packaged builds host it in an Electron
// utility process (D-12, see engine-host.ts); dev runs it as a Node child (ELECTRON_RUN_AS_NODE=1) that watches its
// stdin. On quit it is asked to stop (stdin closed, or a stop message over the parent port: graceful, the server gives
// VoiceStudio its time, then closes the database), and its tree is killed only if it's still running after that.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app, utilityProcess } from 'electron'
import { resolveDataDir } from './datadir'
import { type EngineHost, STOP_MESSAGE, engineEnv, engineHost, utilityLaunch } from './engine-host'
import { deviceKey } from './keystore'
import { RotatingLog } from './logs'
import { type Layout, layout } from './paths'
import { type Stoppable, stopGracefully } from './proc'

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

/** The engine process, however it is hosted. */
type EngineChild = Stoppable &
  Pick<EventEmitter, 'on'> & {
    stdout: NodeJS.ReadableStream | null
    stderr: NodeJS.ReadableStream | null
  }

/** A utility process seen as a child: exit code, pid, and "close stdin" as a stop message over the parent port. */
function wrapUtility(up: Electron.UtilityProcess): EngineChild {
  const em = new EventEmitter()
  const c = Object.assign(em, {
    pid: up.pid as number | undefined,
    exitCode: null as number | null,
    signalCode: null,
    stdout: up.stdout as NodeJS.ReadableStream | null,
    stderr: up.stderr as NodeJS.ReadableStream | null,
    stdin: { end: () => up.postMessage(STOP_MESSAGE) },
  })
  up.once('spawn', () => (c.pid = up.pid))
  up.once('exit', (code) => {
    c.exitCode = code
    em.emit('exit', code, null)
  })
  return c as unknown as EngineChild
}

export class ServerProcess extends EventEmitter {
  port = 0
  private secret = ''
  private child?: EngineChild
  private stopping = false
  /** Starting: an exit now is a failed start (start() throws), not a crash. */
  private starting = false
  /** How the engine is hosted this launch (a utility process that couldn't start falls back to a child, once). */
  host: EngineHost = engineHost({ packaged: app.isPackaged, env: process.env })
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

  private launch(l: Layout, env: NodeJS.ProcessEnv): EngineChild {
    if (this.host === 'utility') {
      const { modulePath, args, execArgv } = utilityLaunch(l.serverArgs)
      return wrapUtility(utilityProcess.fork(modulePath, args, { cwd: l.serverCwd, env, execArgv, stdio: 'pipe', serviceName: 'Producer Studio engine' }))
    }
    const child = spawn(process.execPath, l.serverArgs, { cwd: l.serverCwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    child.stdin!.on('error', () => undefined)
    return child as unknown as EngineChild
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
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      ...l.serverEnv,
      MODE: 'desktop',
      PORT: String(this.port),
      HOST: '127.0.0.1',
      DATA_DIR: this.paths.dataDir,
      DESKTOP_SECRET: this.secret,
      DESKTOP_SETTINGS_FILE: this.paths.settingsFile,
      PRODUCER_DESKTOP_VERSION: app.getVersion(),
    }
    const key = deviceKey()
    if (key) base.DESKTOP_SECRET_KEY = key
    else delete base.DESKTOP_SECRET_KEY
    // never let a dev shell's cloud settings leak into the local server (nor the fixed dev secret: the server gets it as
    // DESKTOP_SECRET, which it keeps out of its own children)
    for (const k of ['DATABASE_URL', 'S3_BUCKET', 'ANTHROPIC_API_KEY', 'PGLITE_DIR', 'ROLE', 'AI_PROVIDER', 'PS_DESKTOP_SECRET', 'PS_ENGINE_HOST']) delete base[k]
    const env = engineEnv(base, this.host)
    this.log.write(`\n=== ${new Date().toISOString()} starting server on ${this.origin} (${app.isPackaged ? 'packaged' : 'dev'}, ${this.host === 'utility' ? 'utility process' : 'child process'}) ===\n`)
    const child = this.launch(l, env)
    this.child = child
    child.stdout?.on('data', (b: Buffer) => this.log.write(b))
    child.stderr?.on('data', (b: Buffer) => this.log.write(b))
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.log.write(`=== server exited code=${code} signal=${signal} ===\n`)
      if (this.child === child) this.child = undefined
      if (!this.stopping && !this.starting) this.emit('crash', code ?? signal)
    })
    this.starting = true
    try {
      await this.waitHealthy(child)
    } catch (err) {
      // a utility process that couldn't run the engine: start it the way dev does, once per launch
      if (this.host === 'utility' && child.exitCode !== null) {
        this.log.write(`=== the utility process didn't start the engine (${(err as Error).message}); starting it as a child process ===\n`)
        this.host = 'child'
        return this.start()
      }
      throw err
    } finally {
      this.starting = false
    }
  }

  private async waitHealthy(child: EngineChild, timeoutMs = 90_000) {
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
    // graceful: the server shuts down when asked (stdin closed, or a stop message for a utility process): it stops
    // VoiceStudio and its workers and closes PGlite cleanly; only a server still running after that has its tree
    // killed (a process that has exited may have handed its id on)
    await stopGracefully(child, STOP_GRACE_MS)
  }
}
