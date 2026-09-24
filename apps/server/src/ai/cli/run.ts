// Spawn one `claude -p` run: prompt on stdin (no command-line length limits), stream-json on stdout parsed line by
// line, process tree killed on cancel or timeout.
import { spawn } from 'node:child_process'
import { CancelledError } from '../../jobs/worker'
import { killTree } from '../../media/proc'
import { cliEnv, spawnable } from './detect'
import { type CliEvent, StreamJsonParser } from './stream'

export interface ClaudeRunOptions {
  bin: string
  args: string[]
  cwd: string
  prompt: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs: number
  onEvent?: (ev: CliEvent) => void
}

export interface ClaudeRunResult {
  code: number
  events: CliEvent[]
  result?: Extract<CliEvent, { kind: 'result' }>
  /** First assistant-level error (e.g. authentication_failed, rate_limit). */
  assistantError?: string
  stderr: string
  noise: string[]
  timedOut: boolean
}

export function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new CancelledError())
    const { file, args, env } = spawnable(o.bin, o.args)
    const child = spawn(file, args, {
      cwd: o.cwd,
      env: cliEnv(process.env, { ...env, ...o.env }),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const parser = new StreamJsonParser()
    const events: CliEvent[] = []
    let stderr = ''
    let result: ClaudeRunResult['result']
    let assistantError: string | undefined
    let timedOut = false
    let settled = false
    const handle = (evs: CliEvent[]) => {
      for (const ev of evs) {
        events.push(ev)
        if (ev.kind === 'result') result = ev
        if (ev.kind === 'assistant' && ev.error && !assistantError) assistantError = ev.error
        try {
          o.onEvent?.(ev)
        } catch {
          /* listener errors must not break the stream */
        }
      }
    }
    const onAbort = () => killTree(child.pid)
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, o.timeoutMs)
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (s: string) => handle(parser.push(s)))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (s: string) => {
      stderr = (stderr + s).slice(-20000)
    })
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(o.prompt)
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      handle(parser.end())
      finish(() => {
        if (o.signal?.aborted) return reject(new CancelledError())
        resolve({ code: code ?? -1, events, result, assistantError, stderr, noise: parser.noise, timedOut })
      })
    })
  })
}
