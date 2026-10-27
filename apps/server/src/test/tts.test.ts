import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TtsEngine } from '../ai/tts'
import { SERVER_ROOT } from '../config'

process.env.LOG_SILENT = '1'

const FAKE = path.join(SERVER_ROOT, 'src', 'test', 'fixtures', 'fake-tts-worker.mjs')
const engines: TtsEngine[] = []
afterEach(() => {
  for (const e of engines.splice(0)) e.stop()
})

/** An engine running the stand-in worker (or the real one) with `env` on top of this process's environment. */
function engine(env: Record<string, string> = {}, script = FAKE) {
  const e = new TtsEngine({ script, env: () => ({ ...process.env, ...env }) })
  engines.push(e)
  return e
}
const say = (e: TtsEngine, text: string, signal?: AbortSignal, progress?: (f: number, m: string) => void) =>
  e.synthesize(text, path.join(os.tmpdir(), 'unused.wav'), { voice: 'af_heart', speed: 1, signal, progress })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('voice engine', () => {
  it('cancelling a queued voiceover drops only that one (PIP-10)', async () => {
    const e = engine()
    const running = say(e, 'wait:300')
    const ac = new AbortController()
    const queued = say(e, 'wait:50', ac.signal)
    const pid = e.pid
    ac.abort()
    await expect(queued).rejects.toThrow(/Cancelled/)
    await expect(running).resolves.toMatchObject({ duration: 0.3 })
    expect(e.pid).toBe(pid)
  })

  it('cancelling the running voiceover lets the next one in line finish (PIP-10)', async () => {
    const e = engine()
    const ac = new AbortController()
    const running = say(e, 'wait:20000', ac.signal)
    const next = say(e, 'wait:20')
    const pid = e.pid
    await sleep(100)
    ac.abort()
    await expect(running).rejects.toThrow(/Cancelled/)
    // the worker stops the cancelled one early and moves on, in the same process
    const t0 = Date.now()
    await expect(next).resolves.toMatchObject({ duration: 0.02 })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(e.pid).toBe(pid)
  })

  it('a failed model load starts a fresh voice process for the next request (PIP-11)', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tts-')), 'fail')
    fs.writeFileSync(marker, '')
    const e = engine({ FAKE_TTS_FAIL_LOAD: marker })
    const first = say(e, 'wait:10')
    const pid = e.pid
    await expect(first).rejects.toThrow(/voice model could not load/)
    fs.rmSync(marker)
    await expect(say(e, 'wait:10')).resolves.toMatchObject({ duration: 0.01 })
    expect(e.pid).not.toBe(pid)
  })

  it('the real worker retries a model load that failed instead of keeping the failure (PIP-11)', async () => {
    // a model host that is down: every file request fails
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.writeHead(503).end('down')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kokoro-'))
      const e = engine({ KOKORO_CACHE: cache, KOKORO_REMOTE_HOST: host }, path.join(SERVER_ROOT, 'scripts', 'tts-worker.mjs'))
      await expect(say(e, 'Hello there.')).rejects.toThrow(/voice model could not load/)
      const first = hits
      expect(first).toBeGreaterThan(0)
      await expect(say(e, 'Hello there.')).rejects.toThrow(/voice model could not load/)
      expect(hits).toBeGreaterThan(first)
    } finally {
      server.close()
    }
  }, 300_000)

  it('a voice process that dies under a write fails its requests but cannot crash the server (PIP-35)', async () => {
    const e = engine()
    const first = say(e, 'wait:3000')
    const child = () => (e as unknown as { proc: { child: ChildProcess } }).proc.child
    // what Linux reports when the process died after the request went out (an 'error' event nobody handles
    // is thrown, and takes the whole server down); Windows doesn't report it, so it is raised here by hand
    expect(() => child().stdin!.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    await expect(first).rejects.toThrow(/voice engine stopped/)
    // the next voiceover gets a new process; one that can't be started fails its request the same way
    const next = say(e, 'wait:3000')
    expect(() => child().emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }))).not.toThrow()
    await expect(next).rejects.toThrow(/voice engine could not run/)
    await expect(say(e, 'wait:10')).resolves.toMatchObject({ duration: 0.01 })
  })

  it('shows the model download on the voiceover waiting for it and runs below API priority (QA-11)', async () => {
    const e = engine({ FAKE_TTS_LOAD_STEPS: '4' })
    const seen: string[] = []
    await say(e, 'wait:10', undefined, (_f, m) => seen.push(m))
    expect(seen).toEqual(['Downloading the voice model (25%)', 'Downloading the voice model (50%)', 'Downloading the voice model (75%)', 'Downloading the voice model (100%)', 'Generating voice'])
    expect(os.getPriority(e.pid!)).toBeGreaterThanOrEqual(10)
  })

  it('fetches the model at start only when it is not on disk (QA-11)', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kokoro-'))
    const idle = engine()
    const model = path.join(cache, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx')
    fs.mkdirSync(model, { recursive: true })
    fs.writeFileSync(path.join(model, 'model_quantized.onnx'), '')
    expect(idle.prepare(cache)).toBeUndefined()
    expect(idle.pid).toBeUndefined()
    const fetching = engine({ FAKE_TTS_LOAD_STEPS: '2' })
    const ready = fetching.prepare(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kokoro-')))
    expect(fetching.pid).toBeDefined()
    await ready
    // the first voiceover then finds the model loaded
    const seen: string[] = []
    await say(fetching, 'wait:10', undefined, (_f, m) => seen.push(m))
    expect(seen).toEqual([])
  })
})
