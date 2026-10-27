// Child-process helpers: run with an AbortSignal (ends the process tree on cancel), capture output.
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import { childEnv } from '../child-env'
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

/** How long a process gets to clean up (Chrome closing its pages, ffmpeg its file) between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3000

export interface KillSystem {
  platform: NodeJS.Platform
  kill(pid: number, signal: NodeJS.Signals): void
  /** Every descendant of `pid`, whatever process group it moved to. */
  descendants(pid: number): number[]
  taskkill(pid: number): void
}

/** pid → parent pid for every process (Linux /proc, else `ps`). */
function processTable(): Array<[number, number]> {
  if (process.platform === 'linux') {
    const rows: Array<[number, number]> = []
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        // "pid (comm) state ppid ...": comm can hold spaces and parentheses
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
        rows.push([Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])])
      } catch {
        /* exited meanwhile */
      }
    }
    return rows
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
    .filter(([pid, ppid]) => pid > 0 && ppid >= 0)
}

const realSystem: KillSystem = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  descendants(pid) {
    let table: Array<[number, number]>
    try {
      table = processTable()
    } catch {
      return []
    }
    const out: number[] = []
    const queue = [pid]
    while (queue.length) {
      const p = queue.shift()!
      for (const [c, pp] of table) if (pp === p && !out.includes(c)) (out.push(c), queue.push(c))
    }
    return out
  },
  taskkill: (pid) => void spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined),
}

/**
 * End a process and everything it started. Windows (the desktop edition): taskkill /T. Elsewhere SIGTERM first, to
 * the process group and to every descendant (Chrome and its ffmpeg run in process groups of their own, and a parent
 * killed outright never closes them), then SIGKILL to all of them after `graceMs`.
 */
export function killTree(pid: number | undefined, graceMs = KILL_GRACE_MS, sys: KillSystem = realSystem) {
  if (!pid) return
  if (sys.platform === 'win32') return sys.taskkill(pid)
  // read the tree before anything dies: an orphan is re-parented and can't be found from `pid` afterwards
  const tree = new Set(sys.descendants(pid))
  const signal = (sig: NodeJS.Signals) => {
    try {
      sys.kill(-pid, sig)
    } catch {
      /* the group is gone */
    }
    for (const p of [pid, ...tree]) {
      try {
        sys.kill(p, sig)
      } catch {
        /* gone */
      }
    }
  }
  signal('SIGTERM')
  const t = setTimeout(() => {
    for (const p of sys.descendants(pid)) tree.add(p)
    signal('SIGKILL')
  }, graceMs)
  t.unref?.()
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError())
    const max = opts.maxCapture ?? 1_000_000
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: childEnv(opts.env ?? process.env),
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
