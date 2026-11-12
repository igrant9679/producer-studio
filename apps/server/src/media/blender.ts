// Blender scenes: a drawn scene in the 'blender' drawing style is a Python script the space's AI writes (ai/drawn.ts,
// BLENDER_SYSTEM) that builds, lights and keyframes a 3D scene in Blender. This file runs those scripts, two ways:
//
//   - On this computer (the desktop edition, or a server with BLENDER_LOCAL=1): the person's own Blender, found at
//     BLENDER_PATH or where Blender installs itself. Free; as fast as the computer's graphics card.
//   - On a graphics card rented from RunPod with the space's own key (the web edition): one pod per video, started on
//     the first Blender scene and deleted when the video is done (runpod.ts). Billed by the second to that account.
//
// Either way Blender runs blender/harness.py, which refuses code that reaches outside the scene (see the comment
// there), and runs with factory settings, auto-run scripts off, a throwaway folder and no secrets in its environment.
// Code problems come back as DrawingError (the AI is asked to fix them, as for canvas drawings); a Blender or graphics
// card that can't be used comes back as HttpError.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SERVER_ROOT } from '../config'
import { ctx } from '../context'
import { HttpError } from '../http'
import { CancelledError } from '../jobs/worker'
import { log } from '../log'
import { tmpDir } from '../services/assets'
import { DrawingError, type DrawingEnv } from './drawing'

export const BLENDER_DIR = () => path.join(SERVER_ROOT, 'blender')
export const HARNESS_PY = () => path.join(BLENDER_DIR(), 'harness.py')

/** Test frames: a few stills at half size. */
export const BLENDER_TEST_TIMEOUT_MS = 8 * 60_000
/** A whole scene at full size (a CPU-only computer can take this long; a graphics card far less). */
export const BLENDER_RENDER_TIMEOUT_MS = 90 * 60_000

/** What the harness is told (job.json); `code_file` is added where it runs. */
export interface BlenderSpec {
  mode: 'test' | 'render'
  width: number
  height: number
  fps: number
  duration: number
  frames?: number[]
  words: DrawingEnv['words']
  palette: DrawingEnv['palette']
  engine: 'auto' | 'eevee' | 'cycles'
}

export interface BlenderResult {
  ok: boolean
  error?: string
  /** The error is Blender's or the graphics card's, not the code's (the AI can't fix it). */
  render?: boolean
  frames?: string[]
  video?: string
  engine?: string
  version?: string
  seconds?: number
}

/** Runs Blender scene scripts for one video (a RunPod pod lives until close()). */
export interface BlenderRunner {
  where: 'computer' | 'runpod'
  /** JPEGs of the scene at `times` (seconds from its start), at half size. Throws DrawingError for code problems. */
  test(code: string, env: DrawingEnv, times: number[], signal?: AbortSignal): Promise<Buffer[]>
  /** The whole scene as an H.264 mp4 at outFile. */
  render(code: string, env: DrawingEnv, outFile: string, opts?: { signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<void>
  close(): Promise<void>
}

/** The frame (1-based) the harness renders for `t` seconds into a scene. */
export const blenderFrame = (env: Pick<DrawingEnv, 'fps' | 'duration'>, t: number) => Math.min(Math.max(1, Math.round(env.duration * env.fps)), 1 + Math.round(Math.max(0, t) * env.fps))

export function blenderSpec(env: DrawingEnv, mode: 'test' | 'render', times: number[] = []): BlenderSpec {
  return {
    mode,
    width: env.width,
    height: env.height,
    fps: env.fps,
    duration: env.duration,
    ...(mode === 'test' ? { frames: times.map((t) => blenderFrame(env, t)) } : {}),
    words: env.words,
    palette: env.palette,
    engine: 'auto',
  }
}

/** Blender itself can't be used for this video (the card didn't start, a render failed): the remaining Blender
 * scenes are drawn in the 3D studio style instead. */
export class BlenderUnavailableError extends HttpError {
  constructor(message: string, status = 502) {
    super(status, 'server', message)
  }
}

/** A failed run as the error writeDrawing understands: code problems are the AI's to fix, the rest aren't. */
export function blenderError(r: BlenderResult, where: 'computer' | 'runpod'): Error {
  const msg = (r.error || 'Blender stopped without saying why').slice(0, 500)
  if (r.render) return new BlenderUnavailableError(where === 'runpod' ? `the graphics card couldn’t render it (${msg.slice(0, 160)})` : `Blender couldn’t render it on this computer (${msg.slice(0, 160)})`)
  return new DrawingError(msg)
}

// --- this computer's Blender ---------------------------------------------------------------------------------------

/** Blender on this computer: BLENDER_PATH, else where its installers put it (the newest version first). */
export function findLocalBlender(): string | undefined {
  const env = process.env.BLENDER_PATH?.trim()
  if (env) return fs.existsSync(env) ? env : undefined
  const candidates: string[] = []
  const versioned = (dir: string, exe: string) => {
    try {
      for (const d of fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(path.join(dir, d, exe))
    } catch {
      // not installed there
    }
  }
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      versioned(path.join(pf, 'Blender Foundation'), 'blender.exe')
      candidates.push(path.join(pf, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'))
    }
    if (process.env.LOCALAPPDATA) versioned(path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation'), 'blender.exe')
    // the Microsoft Store edition (signed, so Smart App Control lets it run; the zip's unsigned DLL is blocked there)
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'blender.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender', path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'))
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender')
  }
  return candidates.find((c) => fs.existsSync(c))
}

/** This computer's Blender may run scene scripts: the desktop edition, or a server that asks for it. */
export const localBlenderAllowed = () => ctx().config.mode === 'desktop' || process.env.BLENDER_LOCAL === '1'

const versions = new Map<string, Promise<string | undefined>>()
/** "Blender 5.2.4" (cached per executable), or undefined when it doesn't start. */
export function localBlenderVersion(exe: string): Promise<string | undefined> {
  let v = versions.get(exe)
  if (!v) {
    v = new Promise((resolve) => {
      const p = spawn(exe, ['-b', '--factory-startup', '-noaudio', '--version'], { env: blenderEnv(os.tmpdir()), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      const t = setTimeout(() => p.kill(), 60_000)
      p.stdout.on('data', (d: Buffer) => (out += d.toString()))
      p.on('error', () => resolve(undefined))
      p.on('close', () => {
        clearTimeout(t)
        const m = /Blender\s+\d+\.\d+(?:\.\d+)?/.exec(out)
        resolve(m?.[0])
      })
    })
    versions.set(exe, v)
  }
  return v
}

/** Blender's environment: the system's essentials only (no keys, no tokens), its user folders inside `work`. */
export function blenderEnv(work: string): NodeJS.ProcessEnv {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LD_LIBRARY_PATH', 'DISPLAY', 'XDG_RUNTIME_DIR']
  const out: NodeJS.ProcessEnv = {}
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k]
  return { ...out, HOME: work, USERPROFILE: work, APPDATA: path.join(work, 'appdata'), LOCALAPPDATA: path.join(work, 'local'), TEMP: work, TMP: work, TMPDIR: work, BLENDER_USER_RESOURCES: path.join(work, 'user') }
}

/** Run the harness once in `work` (its job.json and code.py written here); the result and outputs land in work/out. */
export async function runHarness(exe: string, work: string, code: string, spec: BlenderSpec, o: { timeoutMs: number; signal?: AbortSignal; onFrame?: (n: number, of: number) => void }): Promise<BlenderResult> {
  const out = path.join(work, 'out')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(work, 'code.py'), code)
  fs.writeFileSync(path.join(work, 'job.json'), JSON.stringify({ ...spec, code_file: path.join(work, 'code.py') }))
  const p = spawn(exe, ['-b', '--factory-startup', '--disable-autoexec', '-noaudio', '--python-exit-code', '1', '--python', HARNESS_PY(), '--', path.join(work, 'job.json'), out], { cwd: work, env: blenderEnv(work), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  let timedOut = false
  const keep = (d: Buffer) => {
    const s = d.toString()
    tail = (tail + s).slice(-4000)
    for (const m of s.matchAll(/PS_FRAME (\d+)\/(\d+)/g)) o.onFrame?.(Number(m[1]), Number(m[2]))
  }
  p.stdout.on('data', keep)
  p.stderr.on('data', keep)
  const kill = () => p.kill('SIGKILL')
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, o.timeoutMs)
  o.signal?.addEventListener('abort', kill, { once: true })
  const exit = await new Promise<number>((resolve) => {
    p.on('error', () => resolve(-1))
    p.on('close', (c) => resolve(c ?? -1))
  })
  clearTimeout(timer)
  o.signal?.removeEventListener('abort', kill)
  if (o.signal?.aborted) throw new CancelledError()
  if (timedOut) return { ok: false, error: `it took longer than ${Math.round(o.timeoutMs / 60_000)} minutes (an endless loop, or far too much to render)` }
  try {
    return JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8')) as BlenderResult
  } catch {
    log.warn('blender stopped without a result', { exit, tail: tail.slice(-1500) })
    return { ok: false, render: exit === -1, error: exit === -1 ? 'Blender could not be started' : `Blender stopped without a result (${tail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)})` }
  }
}

export class LocalBlender implements BlenderRunner {
  readonly where = 'computer' as const
  constructor(readonly exe: string) {}

  async test(code: string, env: DrawingEnv, times: number[], signal?: AbortSignal): Promise<Buffer[]> {
    const work = tmpDir('blender')
    try {
      const r = await runHarness(this.exe, work, code, blenderSpec(env, 'test', times), { timeoutMs: BLENDER_TEST_TIMEOUT_MS, signal })
      if (!r.ok || !r.frames?.length) throw blenderError(r, this.where)
      return r.frames.map((f) => fs.readFileSync(path.join(work, 'out', path.basename(f))))
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => undefined)
    }
  }

  async render(code: string, env: DrawingEnv, outFile: string, opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<void> {
    const work = tmpDir('blender')
    try {
      const r = await runHarness(this.exe, work, code, blenderSpec(env, 'render'), { timeoutMs: BLENDER_RENDER_TIMEOUT_MS, signal: opts.signal, onFrame: (n, of) => opts.onProgress?.(n / of) })
      if (!r.ok || !r.video) throw blenderError({ ...r, render: true }, this.where)
      fs.copyFileSync(path.join(work, 'out', path.basename(r.video)), outFile)
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => undefined)
    }
  }

  async close(): Promise<void> {}
}

// --- which one a space gets ----------------------------------------------------------------------------------------

/** Where this space's Blender scenes would render, or undefined (the Blender style isn't offered). */
export async function blenderCapability(workspaceId: string): Promise<{ where: 'computer' | 'runpod'; version?: string } | undefined> {
  if (localBlenderAllowed()) {
    const exe = findLocalBlender()
    if (exe) {
      const version = await localBlenderVersion(exe)
      if (version) return { where: 'computer', version }
    }
  }
  const { runpodReady } = await import('./runpod')
  return (await runpodReady(workspaceId)) ? { where: 'runpod', version: 'Blender 5.2' } : undefined
}

/** A runner for one video's Blender scenes, or an HttpError saying why there's none. */
export async function openBlender(workspaceId: string): Promise<BlenderRunner> {
  if (localBlenderAllowed()) {
    const exe = findLocalBlender()
    if (exe && (await localBlenderVersion(exe))) return new LocalBlender(exe)
  }
  const { RunpodBlender, runpodKey } = await import('./runpod')
  const key = await runpodKey(workspaceId)
  if (key) return new RunpodBlender(key)
  throw new HttpError(
    409,
    'conflict',
    ctx().config.mode === 'desktop' ? 'Blender isn’t installed on this computer (blender.org/download, or set BLENDER_PATH)' : 'Blender scenes need a RunPod key in Settings → AI',
  )
}
