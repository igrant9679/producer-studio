// Kokoro-82M narration worker. Long-lived child process: one JSON request per stdin line, one JSON reply per
// stdout line. Keeps the model warm so repeated TTS calls don't pay the load cost.
//   request:  {"id":"1","text":"Hello","voice":"af_heart","speed":1,"out":"/abs/file.wav"} | {"id":"2","type":"warm"}
//             {"type":"cancel","id":"1"}  (skip it if still queued, stop it between sentences if running)
//   reply:    {"id":"1","ok":true,"duration":1.23,"sampleRate":24000} | {"id":"1","ok":false,"error":"...",
//             "loadFailed"?:true,"cancelled"?:true}
//   while the model loads: {"type":"progress","progress":0.42,"downloading":true}, then {"type":"ready"}
// Env: KOKORO_CACHE — directory containing onnx-community/Kokoro-82M-v1.0-ONNX (used offline when present).
//      KOKORO_REMOTE_HOST — where to download the model from when it isn't (default Hugging Face; a mirror).
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const cache = process.env.KOKORO_CACHE || ''

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const logErr = (s) => process.stderr.write(`[tts] ${s}\n`)

class LoadError extends Error {}

let ttsPromise
let Splitter
async function load() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const tf = await import('@huggingface/transformers')
      const env = tf.env
      const local = cache && existsSync(path.join(cache, ...MODEL.split('/'), 'onnx', 'model_quantized.onnx'))
      if (cache) {
        env.cacheDir = cache
        env.localModelPath = cache.endsWith(path.sep) ? cache : cache + path.sep
      }
      if (process.env.KOKORO_REMOTE_HOST) env.remoteHost = process.env.KOKORO_REMOTE_HOST
      env.allowLocalModels = true
      env.allowRemoteModels = !local
      const { KokoroTTS, TextSplitterStream } = await import('kokoro-js')
      Splitter = TextSplitterStream
      const t0 = Date.now()
      logErr(`loading Kokoro-82M (${local ? 'local' : 'download'})`)
      // overall progress across the model's files, sent whenever it moves by a percent
      const files = new Map()
      let sent = -1
      const progress_callback = (p) => {
        if (p?.status !== 'progress' || !p.file || !(p.total > 0)) return
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        const pct = Math.floor((100 * loaded) / total)
        if (pct !== sent) {
          sent = pct
          send({ type: 'progress', progress: pct / 100, downloading: !local })
        }
      }
      const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu', progress_callback })
      logErr(`model ready in ${Date.now() - t0} ms`)
      send({ type: 'ready' })
      return tts
    })().catch((e) => {
      // not cached: the next request tries again (a network blip must not break voice until a restart)
      ttsPromise = undefined
      throw new LoadError(String(e?.message || e))
    })
  }
  return ttsPromise
}

function writeWav(file, samples, sampleRate) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  writeFileSync(file, buf)
}

const cancelled = new Set()
class Cancelled extends Error {}

async function synth(req) {
  const tts = await load()
  const text = String(req.text || '').trim()
  if (!text) throw new Error('Empty text')
  const voice = req.voice || 'af_heart'
  const speed = Number(req.speed || 1)
  const chunks = []
  let sampleRate = 24000
  // stream() splits into sentences, avoiding the 512-token truncation on long narration
  const splitter = new Splitter()
  splitter.push(text)
  splitter.close() // flush the final sentence; stream() alone waits forever for more input
  for await (const part of tts.stream(splitter, { voice, speed })) {
    if (cancelled.has(req.id)) throw new Cancelled('Cancelled')
    chunks.push(part.audio.audio)
    sampleRate = part.audio.sampling_rate
  }
  const gap = Math.round(sampleRate * 0.08)
  const total = chunks.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, chunks.length - 1)
  const out = new Float32Array(total)
  let o = 0
  chunks.forEach((c, i) => {
    out.set(c, o)
    o += c.length + (i < chunks.length - 1 ? gap : 0)
  })
  writeWav(req.out, out, sampleRate)
  return { duration: out.length / sampleRate, sampleRate }
}

const failure = (id, e) => ({ id, ok: false, error: String(e?.stack || e), ...(e instanceof LoadError ? { loadFailed: true } : {}), ...(e instanceof Cancelled ? { cancelled: true } : {}) })

// serialise requests: the ONNX session is not re-entrant
let chain = Promise.resolve()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ ok: false, error: 'bad json' })
  }
  if (req.type === 'cancel') return void cancelled.add(req.id)
  chain = chain.then(async () => {
    if (cancelled.delete(req.id)) return send({ id: req.id, ok: false, error: 'Cancelled', cancelled: true })
    try {
      if (req.type === 'warm') {
        await load()
        return send({ id: req.id, ok: true, warm: true })
      }
      const r = await synth(req)
      send({ id: req.id, ok: true, ...r })
    } catch (e) {
      send(failure(req.id, e))
    } finally {
      cancelled.delete(req.id)
    }
  })
})
rl.on('close', () => chain.then(() => process.exit(0)))
send({ type: 'hello', pid: process.pid })
