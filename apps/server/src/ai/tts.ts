// Kokoro TTS via one warm child process (scripts/tts-worker.mjs). The worker runs one request at a time; cancelling
// a request drops just that one (from the worker's queue, or between sentences), never the others waiting with it.
// The process runs at low priority so synthesis can't starve API requests, and the model is fetched at start when
// it isn't on disk yet, with its download progress shown on any voiceover that has to wait for it.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { VOICES, isProfileVoice } from '@producer/core'
import { childEnv } from '../child-env'
import { SERVER_ROOT } from '../config'
import { ctx } from '../context'
import { CancelledError } from '../jobs/worker'
import { log } from '../log'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** Whether the voice model is already in `cache` (the worker then loads it without the network). */
export function kokoroModelCached(cache: string | undefined): boolean {
  return Boolean(cache) && fs.existsSync(path.join(cache!, ...MODEL.split('/'), 'onnx', 'model_quantized.onnx'))
}

type Progress = (fraction: number, message: string) => void

interface Pending {
  resolve: (r: { duration: number; sampleRate: number }) => void
  reject: (e: Error) => void
  progress?: Progress
}

/** One voice process and the requests sent to it (a replaced process fails only its own). */
interface Proc {
  child: ChildProcess
  pending: Map<string, Pending>
  /** While the model loads: how far (0..1), and whether it is being downloaded. */
  loading?: { fraction: number; downloading: boolean }
  logged?: number
}

interface Reply {
  id?: string
  type?: string
  ok?: boolean
  error?: string
  duration?: number
  sampleRate?: number
  loadFailed?: boolean
  progress?: number
  downloading?: boolean
}

export class TtsEngine {
  private proc?: Proc
  private seq = 0
  private idleTimer?: NodeJS.Timeout

  constructor(
    private readonly opts: { script?: string; env?: () => NodeJS.ProcessEnv } = {},
  ) {}

  /** The running voice process (tests). */
  get pid(): number | undefined {
    return this.proc?.child.pid
  }

  private alive(p: Proc | undefined): p is Proc {
    return Boolean(p && p.child.exitCode === null && p.child.signalCode === null && !p.child.killed && p.child.stdin?.writable)
  }

  private start(): Proc {
    const script = this.opts.script ?? path.join(SERVER_ROOT, 'scripts', 'tts-worker.mjs')
    const env = this.opts.env?.() ?? childEnv(process.env, { KOKORO_CACHE: ctx().config.kokoroCache ?? '' })
    const child = spawn(process.execPath, [script], { cwd: SERVER_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const proc: Proc = { child, pending: new Map() }
    this.proc = proc
    // below API requests: a long narration must not slow the editor down
    try {
      if (child.pid) os.setPriority(child.pid, 10)
    } catch {
      /* not allowed here: runs at normal priority */
    }
    const fail = (err: Error) => {
      if (this.proc === proc) this.proc = undefined
      for (const [id, p] of proc.pending) {
        proc.pending.delete(id)
        p.reject(err)
      }
    }
    // a voice process that can't start, or dies while being written to, fails its requests; it never takes the server down
    child.on('error', (err) => {
      log.warn('tts worker error', { err })
      fail(new Error(`The voice engine could not run: ${err.message}`))
    })
    child.stdin!.on('error', (err) => {
      log.warn('tts worker input closed', { err })
      fail(new Error('The voice engine stopped unexpectedly'))
      child.kill()
    })
    child.on('exit', (code, sig) => fail(new Error(`The voice engine stopped unexpectedly (${code ?? sig})`)))
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: Reply
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      this.onReply(proc, msg)
    })
    child.stderr!.on('data', (b: Buffer) => log.debug('tts worker', { out: b.toString().trim().slice(0, 500) }))
    log.info('tts worker started', { pid: child.pid })
    return proc
  }

  private onReply(proc: Proc, msg: Reply) {
    if (msg.type === 'progress') {
      const loading = { fraction: Math.max(0, Math.min(1, msg.progress ?? 0)), downloading: Boolean(msg.downloading) }
      proc.loading = loading
      const step = Math.floor(loading.fraction * 10)
      if (loading.downloading && step !== proc.logged) {
        proc.logged = step
        log.info('downloading the voice model', { percent: step * 10 })
      }
      for (const p of proc.pending.values()) p.progress?.(loading.fraction, loadingMessage(loading))
      return
    }
    if (msg.type === 'ready') {
      if (proc.loading) for (const p of proc.pending.values()) p.progress?.(1, 'Generating voice')
      proc.loading = undefined
      return
    }
    if (!msg.id) return
    const p = proc.pending.get(msg.id)
    if (!p) return
    proc.pending.delete(msg.id)
    if (msg.ok) return p.resolve({ duration: msg.duration ?? 0, sampleRate: msg.sampleRate ?? 24000 })
    const why = (msg.error ?? 'unknown').split('\n')[0]
    if (msg.loadFailed) {
      // the next request gets a fresh process; this one finishes what it was given (each retries the load) and exits
      if (this.proc === proc) this.proc = undefined
      proc.child.stdin?.end()
      return p.reject(new Error(`The voice model could not load: ${why}`))
    }
    p.reject(new Error(`TTS failed: ${why}`))
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => (this.proc?.pending.size ? this.touch() : this.stop()), 20 * 60 * 1000)
    this.idleTimer.unref()
  }

  stop() {
    this.proc?.child.kill()
    this.proc = undefined
  }

  private request(msg: Record<string, unknown>, signal?: AbortSignal, progress?: Progress): Promise<{ duration: number; sampleRate: number }> {
    if (signal?.aborted) return Promise.reject(new CancelledError())
    const proc = this.alive(this.proc) ? this.proc : this.start()
    this.touch()
    const id = String(++this.seq)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        // drop only this request: the worker skips it, or stops it between sentences
        if (!proc.pending.delete(id)) return
        this.send(proc, { type: 'cancel', id })
        reject(new CancelledError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
        progress,
      })
      if (proc.loading) progress?.(proc.loading.fraction, loadingMessage(proc.loading))
      this.send(proc, { id, ...msg })
    })
  }

  private send(proc: Proc, msg: Record<string, unknown>) {
    if (!proc.child.stdin?.writable) return
    proc.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  synthesize(text: string, out: string, opts: { voice: string; speed: number; signal?: AbortSignal; progress?: Progress }) {
    return this.request({ text, voice: opts.voice, speed: opts.speed, out }, opts.signal, opts.progress)
  }

  warm() {
    return this.request({ type: 'warm' })
  }

  /** At start: fetch the voice model in the background when it isn't on disk, so the first voiceover doesn't wait. */
  prepare(cache = ctx().config.kokoroCache): Promise<void> | undefined {
    if (kokoroModelCached(cache)) return
    log.info('fetching the voice model in the background', { cache })
    return this.warm().then(
      () => log.info('voice model ready'),
      (err) => log.warn('voice model fetch failed; the first voiceover will try again', { err }),
    )
  }
}

function loadingMessage(l: { fraction: number; downloading: boolean }): string {
  return l.downloading ? `Downloading the voice model (${Math.round(l.fraction * 100)}%)` : 'Loading the voice model'
}

export const tts = new TtsEngine()

/** A known Kokoro voice, a VoiceStudio profile voice (`vs:<id>`, checked when used), else the default. */
export function validVoice(v: string | undefined): string {
  if (isProfileVoice(v) && v.length <= 80) return v
  return VOICES.some((x) => x.id === v) ? v! : 'af_heart'
}
