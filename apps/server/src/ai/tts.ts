// Kokoro TTS via one warm child process (scripts/tts-worker.mjs), requests serialised.
import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { VOICES } from '@producer/core'
import { SERVER_ROOT } from '../config'
import { ctx } from '../context'
import { CancelledError } from '../jobs/worker'
import { log } from '../log'

interface Pending {
  resolve: (r: { duration: number; sampleRate: number }) => void
  reject: (e: Error) => void
}

class TtsEngine {
  private child?: ChildProcess
  private pending = new Map<string, Pending>()
  private seq = 0
  private idleTimer?: NodeJS.Timeout

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const script = path.join(SERVER_ROOT, 'scripts', 'tts-worker.mjs')
    const child = spawn(process.execPath, [script], {
      cwd: SERVER_ROOT,
      env: { ...process.env, KOKORO_CACHE: ctx().config.kokoroCache ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: { id?: string; ok?: boolean; error?: string; duration?: number; sampleRate?: number; type?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!msg.id) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve({ duration: msg.duration ?? 0, sampleRate: msg.sampleRate ?? 24000 })
      else p.reject(new Error(`TTS failed: ${(msg.error ?? 'unknown').split('\n')[0]}`))
    })
    child.stderr!.on('data', (b: Buffer) => log.debug('tts worker', { out: b.toString().trim().slice(0, 500) }))
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined
      for (const [id, p] of this.pending) {
        p.reject(new Error(`TTS worker exited (code ${code})`))
        this.pending.delete(id)
      }
    })
    log.info('tts worker started', { pid: child.pid })
    return child
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), 20 * 60 * 1000)
    this.idleTimer.unref()
  }

  stop() {
    this.child?.kill()
    this.child = undefined
  }

  private request(msg: Record<string, unknown>, signal?: AbortSignal): Promise<{ duration: number; sampleRate: number }> {
    if (signal?.aborted) return Promise.reject(new CancelledError())
    const child = this.ensure()
    this.touch()
    const id = String(++this.seq)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        // the worker is busy with this request; kill it (it restarts on the next call)
        this.stop()
        reject(new CancelledError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      child.stdin!.write(JSON.stringify({ id, ...msg }) + '\n')
    })
  }

  synthesize(text: string, out: string, opts: { voice: string; speed: number; signal?: AbortSignal }) {
    return this.request({ text, voice: opts.voice, speed: opts.speed, out }, opts.signal)
  }

  warm() {
    return this.request({ type: 'warm' })
  }
}

export const tts = new TtsEngine()

export function validVoice(v: string | undefined): string {
  return VOICES.some((x) => x.id === v) ? v! : 'af_heart'
}
