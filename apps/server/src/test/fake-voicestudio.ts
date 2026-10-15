// A tiny stand-in for the VoiceStudio backend (the endpoints Producer uses), for tests: /health, /profiles,
// /generate (returns a real WAV), /engines/tts, /audio/<file>. Records every request.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  path: string
  contentType?: string
  body: string
  origin?: string
}

/** 16-bit mono PCM WAV of `seconds` of a quiet tone. */
export function makeWav(seconds = 1, rate = 24000): Buffer {
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 2000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export async function startFakeVoiceStudio() {
  const requests: FakeRequest[] = []
  const profiles = new Map<string, { id: string; name: string; kind: string }>()
  let n = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const body = Buffer.concat(chunks).toString('latin1')
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, contentType: req.headers['content-type'], body, origin: req.headers.origin as string | undefined })
      const json = (code: number, o: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json', 'x-omnivoice-backend': '0.5.6' })
        res.end(JSON.stringify(o))
      }
      const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1]
      if (url.pathname === '/health') return json(200, { status: 'ok', device: 'cpu', version: '0.5.6' })
      if (url.pathname === '/engines/tts') return json(200, { active: 'omnivoice', backends: [{ id: 'omnivoice', display_name: 'VoiceStudio (OmniVoice)', available: true, supports_cloning: true, supports_voice_design: true }] })
      if (url.pathname === '/profiles' && req.method === 'POST') {
        const kind = field('kind') ?? 'clone'
        if (kind === 'clone' && !/name="ref_audio"/.test(body)) return json(422, { detail: 'clone profiles require ref_audio' })
        const p = { id: `p${++n}`, name: field('name') ?? '', kind }
        profiles.set(p.id, p)
        return json(200, p)
      }
      if (url.pathname === '/profiles' && req.method === 'GET') return json(200, [...profiles.values()])
      const del = /^\/profiles\/([^/]+)$/.exec(url.pathname)
      if (del && req.method === 'DELETE') {
        if (!profiles.delete(del[1])) return json(404, { detail: 'Profile not found' })
        return json(200, { deleted: del[1] })
      }
      if (url.pathname === '/generate' && req.method === 'POST') {
        const pid = field('profile_id')
        if (pid && !profiles.has(pid)) return json(404, { detail: 'Profile not found' })
        const wav = makeWav(1.5)
        res.writeHead(200, { 'content-type': 'audio/wav', 'x-omnivoice-backend': '0.5.6', 'x-audio-id': `h${++n}`, 'x-seed': '42', 'x-audio-duration': '1.5', 'content-length': String(wav.length) })
        return res.end(wav)
      }
      if (url.pathname.startsWith('/audio/')) {
        const wav = makeWav(1)
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-disposition': 'attachment; filename="take.wav"', 'content-length': String(wav.length), 'x-omnivoice-backend': '0.5.6' })
        return res.end(wav)
      }
      json(404, { detail: `not in fake: ${req.method} ${url.pathname}` })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, requests, profiles, close: () => new Promise<void>((r) => server.close(() => r())) }
}
