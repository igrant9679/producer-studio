// Child-process helpers: run with an AbortSignal (kills the process tree on cancel), capture output.
import { spawn, type SpawnOptions } from 'node:child_process'
import { CancelledError } from '../jobs/worker'
import { ctx } from '../context'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions extends Pick<SpawnOptions, 'cwd' | 'env'> {
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Keep only the last N chars of each stream (default 1 MB). */
  maxCapture?: number
  /** Collect raw stdout bytes (for binary output such as PCM). */
  onStdoutData?: (buf: Buffer) => void
  timeoutMs?: number
  input?: string
}

/** Kill a process and its children (taskkill /T on Windows, the process group elsewhere). */
export function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError())
    const max = opts.maxCapture ?? 1_000_000
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const onAbort = () => killTree(child.pid)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeoutMs ? setTimeout(() => killTree(child.pid), opts.timeoutMs) : undefined
    child.stdout!.on('data', (b: Buffer) => {
      if (opts.onStdoutData) opts.onStdoutData(b)
      else {
        const s = b.toString('utf8')
        stdout = (stdout + s).slice(-max)
        opts.onStdout?.(s)
      }
    })
    child.stderr!.on('data', (b: Buffer) => {
      const s = b.toString('utf8')
      stderr = (stderr + s).slice(-max)
      opts.onStderr?.(s)
    })
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input)
    }
    child.on('error', (err) => {
      if (done) return
      done = true
      opts.signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      opts.signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      if (opts.signal?.aborted) return reject(new CancelledError())
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Run and throw with the stderr tail on non-zero exit. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}, what = cmd): Promise<RunResult> {
  const r = await run(cmd, args, opts)
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim().split(/\r?\n/).slice(-6).join(' | ').slice(-800)}`)
  return r
}

export function ffmpeg(args: string[], opts: RunOptions = {}) {
  return runOk(ctx().config.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], opts, 'ffmpeg')
}

export function parseTimecode(s: string): number {
  const m = s.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0
}

/** ffmpeg with `-progress pipe:1`, reporting fraction of `duration` completed. */
export function ffmpegProgress(args: string[], duration: number, onProgress: (f: number) => void, opts: RunOptions = {}) {
  let buf = ''
  return ffmpeg(['-progress', 'pipe:1', '-nostats', ...args], {
    ...opts,
    onStdout: (s) => {
      buf += s
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/)
        if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration))
      }
    },
  })
}
