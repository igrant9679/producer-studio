// VoiceStudio runtime (desktop only): installs the pinned, unmodified VoiceStudio backend (AGPL-3.0,
// github.com/debpalash/VoiceStudio) into an app-private folder and runs it as a separate loopback process that the
// Producer server talks to over HTTP. Mirrors VoiceStudio 0.5.6's own Electron runtime setup
// (electron/src/main/runtime-project.ts + backend.ts): uv-managed CPython 3.11, `uv sync --frozen --no-dev`, the cuDNN 8
// compat libraries on CUDA hosts, an import probe, then `python -m uvicorn main:app --app-dir backend`.
//
// Layout under the root (default %LOCALAPPDATA%\Producer Studio\VoiceStudio):
//   tools/uv.exe  downloads/  project/ (sources + .venv + .runtime-ready)  .uv-cache/  .python/
//   data/ (OMNIVOICE_DATA_DIR: profiles DB, outputs, dub jobs)  models/ (OMNIVOICE_CACHE_DIR → HF cache)  env  logs/
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { VoiceStudioStatus } from '@producer/core'
import { childEnv } from '../../child-env'
import { ctx } from '../../context'
import { log } from '../../log'
import { killTree, run } from '../../media/proc'
import { getSettings } from '../settings'

export const VS_VERSION = '0.5.6'
export const VS_COMMIT = '3915a62cb482bb43117aaebab57d22745bd1cc21'
const VS_ARCHIVE_URL = `https://github.com/debpalash/VoiceStudio/archive/${VS_COMMIT}.zip`
/** Content hash of the extracted runtime sources (treeHash below); stable even if GitHub regenerates the zip. */
export const VS_TREE_SHA256 = 'c1a0c8eaa71297edae978302cddb0ab7528dff83fc51a132e46377f8789d74de'
export const VS_SOURCE_URL = `https://github.com/debpalash/VoiceStudio/tree/v${VS_VERSION}`
/** What VoiceStudio's runtime copies into its project folder. */
export const VS_SOURCES = ['backend', 'omnivoice', 'pyproject.toml', 'uv.lock', 'README.md', 'LICENSE']

const UV_VERSION = '0.12.13'
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
const UV_SHA256 = 'a86c9dc7bad9b03f388583b7187c05fe9951c2e0d392217e8fd43d97787f6ec2'
const CUDNN8_COMPAT_PIN = 'nvidia-cudnn-cu12==8.9.7.29'
const REQUIRED_FREE_BYTES = 9 * 1024 ** 3
const STARTUP_BUDGET_MS = 600_000
const STAMP = `producer-vs-${VS_VERSION}-${VS_COMMIT.slice(0, 12)}`

export interface InstallProgress {
  progress: (f: number, message: string) => void
  signal?: AbortSignal
}

/** sha256 over sorted relative paths + bytes of the runtime sources (deterministic across zip re-generation). */
export async function treeHash(root: string, sources = VS_SOURCES): Promise<string> {
  const files: string[] = []
  const walk = async (rel: string) => {
    const abs = path.join(root, rel)
    const st = await fsp.stat(abs)
    if (st.isDirectory()) {
      for (const name of (await fsp.readdir(abs)).sort()) await walk(rel ? `${rel}/${name}` : name)
    } else files.push(rel)
  }
  for (const s of sources) await walk(s)
  files.sort()
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f)
    h.update('\0')
    h.update(await fsp.readFile(path.join(root, f)))
    h.update('\0')
  }
  return h.digest('hex')
}

export function defaultRoot(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return process.platform === 'win32' ? path.join(local, 'Producer Studio', 'VoiceStudio') : path.join(ctx().config.dataDir, 'voicestudio')
}

export function vsRoot(): string {
  return process.env.PS_VOICESTUDIO_DIR || getSettings().voiceStudioDir || defaultRoot()
}

const p = (...parts: string[]) => path.join(vsRoot(), ...parts)
const projectDir = () => p('project')
const pythonExe = () => path.join(projectDir(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const uvExe = () => p('tools', process.platform === 'win32' ? 'uv.exe' : 'uv')

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function download(url: string, dest: string, opts: InstallProgress & { label: string; from: number; to: number }) {
  const res = await fetch(url, { signal: opts.signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let got = 0
  let last = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      got += chunk.byteLength
      if (Date.now() - last > 500) {
        last = Date.now()
        const f = total ? got / total : 0.5
        opts.progress(opts.from + (opts.to - opts.from) * f, `${opts.label} · ${(got / 1024 ** 2).toFixed(0)} MB${total ? ` of ${(total / 1024 ** 2).toFixed(0)} MB` : ''}`)
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  await fsp.rename(tmp, dest)
}

/** Extract a .zip with Windows' bsdtar (System32\tar.exe) or unzip elsewhere. */
async function unzip(zip: string, dest: string, signal?: AbortSignal) {
  await fsp.mkdir(dest, { recursive: true })
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip'
  const args = process.platform === 'win32' ? ['-xf', zip, '-C', dest] : ['-q', '-o', zip, '-d', dest]
  const r = await run(tar, args, { signal })
  if (r.code !== 0) throw new Error(`Extracting ${path.basename(zip)} failed: ${r.stderr.slice(-400)}`)
}

async function dirSize(dir: string): Promise<number> {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) n += (await fsp.stat(full).catch(() => ({ size: 0 }))).size
    }
  }
  return n
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`

function baseEnv(): NodeJS.ProcessEnv {
  const env = childEnv()
  // never leak our own Python / Claude / Anthropic settings into VoiceStudio
  for (const k of Object.keys(env)) if (/^(PYTHONHOME|PYTHONPATH|CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_|VIRTUAL_ENV|CONDA_)/.test(k)) delete env[k]
  return env
}

function uvEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    UV_PROJECT_ENVIRONMENT: path.join(projectDir(), '.venv'),
    UV_CACHE_DIR: p('.uv-cache'),
    UV_PYTHON_INSTALL_DIR: p('.python'),
    UV_HTTP_TIMEOUT: '120',
    UV_HTTP_CONNECT_TIMEOUT: '30',
    UV_HTTP_RETRIES: '5',
    UV_NO_PROGRESS: '1',
    // use the OS certificate store (works behind TLS-intercepting proxies / antivirus that uv's bundled roots don't trust)
    ...(process.platform === 'win32' ? { UV_SYSTEM_CERTS: '1', UV_NATIVE_TLS: '1' } : {}),
  }
}

/** certifi + the Windows ROOT/CA stores → one PEM bundle for VoiceStudio's Python (requests, huggingface_hub, pip). */
const CA_SCRIPT = [
  'import ssl, sys',
  'out = sys.argv[1]',
  'pems = []',
  'try:',
  '    import certifi',
  '    pems.append(open(certifi.where(), encoding="ascii", errors="ignore").read())',
  'except Exception:',
  '    pass',
  'for store in ("ROOT", "CA"):',
  '    try:',
  '        for cert, enc, trust in ssl.enum_certificates(store):',
  '            if enc == "x509_asn":',
  '                pems.append(ssl.DER_cert_to_PEM_cert(cert))',
  '    except Exception:',
  '        pass',
  'open(out, "w", encoding="ascii").write("\\n".join(pems))',
  'print(len(pems))',
].join('\n')

async function writeCaBundle(signal?: AbortSignal) {
  if (process.platform !== 'win32' || !fs.existsSync(pythonExe())) return
  const out = p('ca-bundle.pem')
  const r = await run(pythonExe(), ['-c', CA_SCRIPT, out], { cwd: projectDir(), env: baseEnv(), signal }).catch(() => null)
  if (!r || r.code !== 0) log.warn('voicestudio: CA bundle not written', { err: r?.stderr.slice(-300) })
}

/** Environment for the VoiceStudio backend: everything app-private, analytics off, exits when our stdin closes. */
export function backendEnv(port: number): NodeJS.ProcessEnv {
  const env = baseEnv()
  Object.assign(env, {
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    OMNIVOICE_PORT: String(port),
    OMNIVOICE_DESKTOP_CONTAINED: '1',
    OMNIVOICE_DATA_DIR: p('data'),
    OMNIVOICE_CACHE_DIR: p('models'),
    OMNIVOICE_ENV_FILE: p('env'),
    OMNIVOICE_ANALYTICS_DISABLED: '1',
    OMNIVOICE_BUNDLED_UV: uvExe(),
  })
  if (process.platform === 'win32') {
    Object.assign(env, { TORCHDYNAMO_DISABLE: '1', HF_HUB_DISABLE_SYMLINKS: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', FOR_DISABLE_CONSOLE_CTRL_HANDLER: '1' })
  }
  // No API key: VoiceStudio 0.5.6 only asks non-loopback clients for one (core/auth.py resolve_principal and
  // BearerKeyMiddleware let every 127.0.0.1 caller through), so a per-launch key wouldn't keep other local processes
  // out. Binding to loopback only is the boundary we have (see docs/voicestudio.md).
  for (const k of ['OMNIVOICE_SERVER_MODE', 'OMNIVOICE_API_KEY', 'OMNIVOICE_BIND_HOST', 'OMNIVOICE_BACKEND_CMD']) delete env[k]
  const ca = p('ca-bundle.pem')
  if (fs.existsSync(ca)) Object.assign(env, { SSL_CERT_FILE: ca, REQUESTS_CA_BUNDLE: ca, CURL_CA_BUNDLE: ca, UV_SYSTEM_CERTS: '1', UV_NATIVE_TLS: '1' })
  return env
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

type State = VoiceStudioStatus['state']

export class VoiceStudioRuntime {
  private state: State = 'not-installed'
  private child?: ChildProcess
  private port = 0
  private error?: string
  private message?: string
  private progressValue?: number
  private device?: string
  private starting?: Promise<void>
  private logStream?: fs.WriteStream
  private stopping = false
  private listeners = new Set<(s: VoiceStudioStatus) => void>()

  /** Re-read install state from disk (cheap; called at boot and after install). */
  refresh() {
    if (this.state === 'installing' || this.state === 'starting' || this.state === 'running') return
    this.state = this.installedVersion() ? 'stopped' : 'not-installed'
  }

  /** PS_VOICESTUDIO_URL: attach to an already-running VoiceStudio backend (tests, or a developer's own instance). */
  private external(): string | undefined {
    return process.env.PS_VOICESTUDIO_URL?.replace(/\/+$/, '') || undefined
  }

  installedVersion(): string | undefined {
    if (this.external()) return VS_VERSION
    try {
      const stamp = fs.readFileSync(path.join(projectDir(), '.runtime-ready'), 'utf8').trim()
      return stamp === STAMP ? VS_VERSION : stamp ? 'outdated' : undefined
    } catch {
      return undefined
    }
  }

  status(): VoiceStudioStatus {
    return {
      supported: ctx().config.mode === 'desktop' && (process.platform === 'win32' || !!this.external()),
      state: this.state,
      version: VS_VERSION,
      installedVersion: this.installedVersion(),
      device: this.device,
      progress: this.progressValue,
      message: this.message,
      error: this.error,
      dir: vsRoot(),
    }
  }

  onChange(fn: (s: VoiceStudioStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: { state?: State; message?: string; progress?: number; error?: string | null; device?: string }) {
    if (patch.state) this.state = patch.state
    if ('message' in patch) this.message = patch.message
    if ('progress' in patch) this.progressValue = patch.progress
    if (patch.error !== undefined) this.error = patch.error ?? undefined
    if (patch.device) this.device = patch.device
    const s = this.status()
    this.listeners.forEach((f) => f(s))
  }

  /** Base URL of the running backend. Throws when it isn't running. */
  url(): string {
    if (this.state !== 'running') throw new Error('VoiceStudio is not running')
    const ext = this.external()
    if (ext) return ext
    if (!this.port) throw new Error('VoiceStudio is not running')
    return `http://127.0.0.1:${this.port}`
  }

  // ---------------- install ----------------

  async install(opts: InstallProgress): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') await this.stop()
    this.set({ state: 'installing', error: null, progress: 0, message: 'Preparing' })
    try {
      await this.doInstall(opts)
      this.set({ state: 'stopped', progress: undefined, message: 'Installed' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.set({ state: this.installedVersion() === VS_VERSION ? 'stopped' : 'not-installed', error: msg, progress: undefined, message: undefined })
      throw e
    }
  }

  private async doInstall(opts: InstallProgress) {
    const step = (f: number, m: string) => {
      this.set({ progress: f, message: m })
      opts.progress(f, m)
    }
    const signal = opts.signal
    const root = vsRoot()
    await fsp.mkdir(root, { recursive: true })
    const free = await fsp.statfs(root).then((s) => s.bavail * s.bsize).catch(() => Infinity)
    if (free < REQUIRED_FREE_BYTES) throw new Error(`VoiceStudio needs at least 9 GB of free disk space in ${root} (${gb(free)} free).`)
    for (const d of ['tools', 'downloads', 'data', 'models', 'logs']) await fsp.mkdir(p(d), { recursive: true })
    if (!fs.existsSync(p('env'))) await fsp.writeFile(p('env'), '# Producer Studio keeps VoiceStudio isolated from ~/.config/omnivoice/env\n')

    // 1. uv (checksum-pinned release zip)
    if (!fs.existsSync(uvExe())) {
      const zip = p('downloads', `uv-${UV_VERSION}.zip`)
      if (!fs.existsSync(zip) || (await sha256File(zip)) !== UV_SHA256) await download(UV_URL, zip, { ...opts, label: 'Downloading uv', from: 0.01, to: 0.04 })
      if ((await sha256File(zip)) !== UV_SHA256) throw new Error('The uv download failed its checksum. Try again.')
      const tmp = p('downloads', 'uv-x')
      await fsp.rm(tmp, { recursive: true, force: true })
      await unzip(zip, tmp, signal)
      const found = await findFile(tmp, process.platform === 'win32' ? 'uv.exe' : 'uv')
      if (!found) throw new Error('uv.exe was not found in the uv download')
      await fsp.copyFile(found, uvExe())
      await fsp.rm(tmp, { recursive: true, force: true })
    }
    signal?.throwIfAborted()

    // 2. VoiceStudio sources (pinned commit, verified by content hash)
    step(0.05, `Downloading VoiceStudio ${VS_VERSION}`)
    const zip = p('downloads', `voicestudio-${VS_COMMIT.slice(0, 12)}.zip`)
    if (!fs.existsSync(zip)) await download(VS_ARCHIVE_URL, zip, { ...opts, label: `Downloading VoiceStudio ${VS_VERSION}`, from: 0.05, to: 0.1 })
    const ex = p('downloads', 'vs-x')
    await fsp.rm(ex, { recursive: true, force: true })
    await unzip(zip, ex, signal)
    const top = (await fsp.readdir(ex)).find((n) => fs.statSync(path.join(ex, n)).isDirectory())
    if (!top) throw new Error('The VoiceStudio download is empty')
    const src = path.join(ex, top)
    const hash = await treeHash(src)
    if (hash !== VS_TREE_SHA256) {
      await fsp.rm(zip, { force: true })
      throw new Error(`The VoiceStudio download doesn't match the pinned ${VS_VERSION} sources (content hash mismatch). Try again.`)
    }
    const project = projectDir()
    await fsp.mkdir(project, { recursive: true })
    await fsp.writeFile(path.join(project, '.runtime-installing'), '')
    await fsp.rm(path.join(project, '.runtime-ready'), { force: true })
    for (const s of VS_SOURCES) {
      await fsp.rm(path.join(project, s), { recursive: true, force: true })
      await fsp.cp(path.join(src, s), path.join(project, s), { recursive: true })
    }
    await fsp.rm(ex, { recursive: true, force: true })
    signal?.throwIfAborted()

    // 3. Python 3.11 + locked dependencies (multi-GB: torch with CUDA 12.8 wheels)
    step(0.12, 'Installing Python and VoiceStudio’s packages (several GB, often 10–20 minutes)')
    const env = uvEnv()
    const venvPy = pythonExe()
    let pyArgs = ['--managed-python', '--python', '3.11']
    if (fs.existsSync(venvPy)) {
      const ok = await run(venvPy, ['-c', 'import sys, sentencepiece; assert sys.version_info[:2] == (3, 11)'], { cwd: project, env, signal }).then((r) => r.code === 0)
      if (ok) pyArgs = ['--python', venvPy]
    }
    const ticker = setInterval(() => {
      void Promise.all([dirSize(p('.uv-cache')), dirSize(path.join(project, '.venv'))]).then(([cache, venv]) => step(Math.min(0.85, 0.12 + (cache / (6 * 1024 ** 3)) * 0.6), `Installing packages · ${gb(cache)} downloaded · ${gb(venv)} installed`))
    }, 8000)
    try {
      const r = await run(uvExe(), ['sync', '--frozen', '--no-dev', ...pyArgs], { cwd: project, env, signal, onStderr: (s) => this.logLine(s), onStdout: (s) => this.logLine(s) })
      if (r.code !== 0) throw new Error(`Installing VoiceStudio’s Python packages failed: ${lastLines(r.stderr || r.stdout)}`)
    } finally {
      clearInterval(ticker)
    }
    signal?.throwIfAborted()

    await writeCaBundle(signal)

    // 4. cuDNN 8 compat on CUDA hosts (VoiceStudio's ASR engines need it next to torch's cuDNN 9)
    step(0.88, 'Checking the GPU')
    const probe = await run(venvPy, ['-c', "import json, sysconfig\ntry:\n    import torch\n    d = 'cuda' if torch.cuda.is_available() else 'cpu'\n    n = torch.cuda.get_device_name(0) if d == 'cuda' else ''\nexcept Exception:\n    d, n = 'unknown', ''\nprint('PSPROBE' + json.dumps({'device': d, 'name': n, 'site': sysconfig.get_paths()['purelib']}))"], { cwd: project, env, signal })
    const line = probe.stdout.split(/\r?\n/).find((l) => l.startsWith('PSPROBE'))
    const info = line ? (JSON.parse(line.slice(7)) as { device: string; name: string; site: string }) : undefined
    if (info?.device === 'cuda') {
      this.set({ device: info.name || 'CUDA GPU' })
      const compat = path.join(info.site, 'cudnn8_compat')
      if (!(await hasCudnn8(compat))) {
        step(0.9, 'Installing GPU transcription libraries')
        const r = await run(uvExe(), ['pip', 'install', '--no-deps', '--target', compat, '--python', venvPy, CUDNN8_COMPAT_PIN], { cwd: project, env, signal })
        if (r.code !== 0 || !(await hasCudnn8(compat))) throw new Error(`Installing the cuDNN 8 compatibility libraries failed: ${lastLines(r.stderr)}`)
      }
    } else this.set({ device: 'CPU' })

    // 5. import probe, stamp
    step(0.95, 'Verifying')
    const v = await run(venvPy, ['-c', 'import fastapi, uvicorn, omnivoice, faster_whisper, sentencepiece'], { cwd: project, env, signal })
    if (v.code !== 0) throw new Error(`VoiceStudio’s runtime failed its import check: ${lastLines(v.stderr)}`)
    await fsp.writeFile(path.join(project, '.runtime-ready'), STAMP)
    await fsp.rm(path.join(project, '.runtime-installing'), { force: true })
    step(1, 'VoiceStudio installed')
    log.info('voicestudio: installed', { version: VS_VERSION, root, device: this.device, sourceHash: hash })
  }

  // ---------------- run ----------------

  /** Start the backend (idempotent); resolves when /health is ok. */
  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve()
    if (this.starting) return this.starting
    if (this.installedVersion() !== VS_VERSION) return Promise.reject(new Error('Install VoiceStudio first'))
    this.starting = this.doStart().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private openLog() {
    const file = p('logs', 'voicestudio.log')
    try {
      if (fs.statSync(file).size > 5 * 1024 ** 2) fs.renameSync(file, `${file}.1`)
    } catch {
      /* new */
    }
    this.logStream?.end()
    this.logStream = fs.createWriteStream(file, { flags: 'a' })
  }

  private tail: string[] = []
  private logLine(chunk: string) {
    this.logStream?.write(chunk)
    for (const l of chunk.split(/\r?\n/)) if (l.trim()) this.tail.push(l)
    if (this.tail.length > 60) this.tail.splice(0, this.tail.length - 60)
  }

  private async doStart() {
    const ext = this.external()
    if (ext) {
      const r = await fetch(`${ext}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
      const j = r?.ok ? ((await r.json().catch(() => ({}))) as { device?: string }) : null
      if (!j) {
        this.set({ state: 'error', error: `No VoiceStudio backend answered at ${ext}` })
        throw new Error(this.error)
      }
      this.set({ state: 'running', error: null, device: j.device })
      return
    }
    this.stopping = false
    this.tail = []
    this.openLog()
    this.port = await freePort()
    this.set({ state: 'starting', error: null, progress: -1, message: 'Starting VoiceStudio' })
    // proxy certificates rotate: refresh the bundle each start
    await writeCaBundle()
    const child = spawn(pythonExe(), ['-m', 'uvicorn', 'main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', String(this.port)], {
      cwd: projectDir(),
      env: backendEnv(this.port),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout!.on('data', (b: Buffer) => this.logLine(b.toString()))
    child.stderr!.on('data', (b: Buffer) => this.logLine(b.toString()))
    child.stdin!.on('error', () => undefined)
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = undefined
      this.port = 0
      if (this.stopping) this.set({ state: 'stopped', message: undefined, progress: undefined })
      else this.set({ state: 'error', error: `VoiceStudio stopped unexpectedly (exit ${code}). ${lastLines(this.tail.join('\n'), 3)}`, progress: undefined, message: undefined })
    })
    const deadline = Date.now() + STARTUP_BUDGET_MS
    for (;;) {
      if (this.child !== child) throw new Error(this.error || 'VoiceStudio exited during startup')
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(3000) })
        if (r.headers.get('x-omnivoice-backend')) {
          const j = (await r.json().catch(() => ({}))) as { status?: string; label?: string; device?: string }
          if (r.ok && j.status === 'ok') {
            this.set({ state: 'running', progress: undefined, message: undefined, device: j.device || this.device })
            log.info('voicestudio: running', { port: this.port, device: j.device })
            return
          }
          if (j.label) this.set({ message: j.label })
        }
      } catch {
        /* booting */
      }
      if (Date.now() > deadline) {
        await this.stop()
        this.set({ state: 'error', error: `VoiceStudio didn't become ready within ${STARTUP_BUDGET_MS / 60000} minutes. ${lastLines(this.tail.join('\n'), 3)}` })
        throw new Error(this.error)
      }
      await new Promise((r) => setTimeout(r, 750))
    }
  }

  async stop(): Promise<void> {
    if (this.external()) {
      if (this.state === 'running') this.set({ state: 'stopped' })
      return
    }
    const child = this.child
    if (!child) {
      this.refresh()
      return
    }
    this.stopping = true
    if (this.port) await fetch(`http://127.0.0.1:${this.port}/system/shutdown-intent`, { method: 'POST', signal: AbortSignal.timeout(1000) }).catch(() => undefined)
    child.stdin?.end()
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        killTree(child.pid)
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    this.child = undefined
    this.port = 0
    this.set({ state: 'stopped', message: undefined, progress: undefined })
  }

  /** Last lines of the backend log (for the status panel / bug reports). */
  logTail(n = 40): string[] {
    return this.tail.slice(-n)
  }
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isFile() && e.name.toLowerCase() === name) return full
    if (e.isDirectory()) {
      const f = await findFile(full, name)
      if (f) return f
    }
  }
  return undefined
}

async function hasCudnn8(compat: string): Promise<boolean> {
  const dir = path.join(compat, 'nvidia', 'cudnn', process.platform === 'win32' ? 'bin' : 'lib')
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  return names.filter((n) => (process.platform === 'win32' ? n.startsWith('cudnn') && n.endsWith('64_8.dll') : n.startsWith('libcudnn') && n.endsWith('.so.8'))).length >= 5
}

function lastLines(s: string, n = 6): string {
  return s.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(' · ').slice(-1200)
}

export const voiceStudio = new VoiceStudioRuntime()
