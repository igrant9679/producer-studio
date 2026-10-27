// Stand-in for scripts/tts-worker.mjs (same line protocol, no model). A request's text says what it does:
// "wait:<ms>" takes that long (stopping early when cancelled). Env:
//   FAKE_TTS_LOAD_STEPS=<n>    the first request "downloads" the model first: n progress lines, 30 ms apart
//   FAKE_TTS_FAIL_LOAD=<file>  while that file exists, the model load fails (delete it to let loads succeed)
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cancelled = new Set()
let loaded = false

async function load() {
  if (loaded) return
  const fail = process.env.FAKE_TTS_FAIL_LOAD
  if (fail && fs.existsSync(fail)) throw Object.assign(new Error('could not fetch the model'), { load: true })
  const steps = Number(process.env.FAKE_TTS_LOAD_STEPS || 0)
  for (let i = 1; i <= steps; i++) {
    await sleep(30)
    send({ type: 'progress', progress: i / steps, downloading: true })
  }
  send({ type: 'ready' })
  loaded = true
}

async function handle(req) {
  await load()
  if (req.type === 'warm') return { warm: true }
  const ms = Number(/^wait:(\d+)/.exec(req.text ?? '')?.[1] ?? 0)
  for (let t = 0; t < ms; t += 10) {
    if (cancelled.has(req.id)) throw Object.assign(new Error('Cancelled'), { cancelled: true })
    await sleep(10)
  }
  return { duration: ms / 1000, sampleRate: 24000, pid: process.pid }
}

let chain = Promise.resolve()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.type === 'cancel') return void cancelled.add(req.id)
  chain = chain.then(async () => {
    if (cancelled.delete(req.id)) return send({ id: req.id, ok: false, error: 'Cancelled', cancelled: true })
    try {
      send({ id: req.id, ok: true, ...(await handle(req)) })
    } catch (e) {
      send({ id: req.id, ok: false, error: e.message, ...(e.load ? { loadFailed: true } : {}), ...(e.cancelled ? { cancelled: true } : {}) })
    } finally {
      cancelled.delete(req.id)
    }
  })
})
rl.on('close', () => chain.then(() => process.exit(0)))
send({ type: 'hello', pid: process.pid })
