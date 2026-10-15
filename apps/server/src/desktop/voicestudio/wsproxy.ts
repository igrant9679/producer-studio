// WebSocket pass-through for live dictation (desktop only): /api/voicestudio/ws/dictation → VoiceStudio's
// /v1/audio/transcriptions/stream. VoiceStudio refuses browser-origin WebSocket handshakes, and upgrades bypass Hono's
// middleware, so this re-applies the desktop server's checks itself (loopback peer, Host allow-list, same-origin
// Origin, a valid session cookie) and then splices the two TCP connections — the handshake is forwarded without
// Origin/Cookie, so VoiceStudio sees a native loopback client and answers the client's own Sec-WebSocket-Key.
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { and, eq, gt } from 'drizzle-orm'
import { ctx } from '../../context'
import { sessions } from '../../db/schema'
import { log } from '../../log'
import { voiceStudio } from './runtime'

export const DICTATION_WS_PATH = '/api/voicestudio/ws/dictation'
const UPSTREAM_PATH = '/v1/audio/transcriptions/stream'
/** Query options forwarded to VoiceStudio. */
const PASS_QUERY = new Set(['pcm', 'sr', 'model', 'aec'])

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function reject(socket: Duplex, code: number, reason: string) {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

async function sessionValid(token: string | undefined): Promise<boolean> {
  if (!token || token.length > 200) return false
  const id = createHash('sha256').update(token).digest('hex')
  const rows = await ctx().db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, id), gt(sessions.expiresAt, Date.now()))).limit(1)
  return rows.length > 0
}

/** Validate an upgrade request for the dictation socket. Returns an error tuple or null when allowed. */
export async function checkUpgrade(req: IncomingMessage, port: number): Promise<[number, string] | null> {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return [403, 'Forbidden']
  const host = (req.headers.host ?? '').toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return [403, 'Forbidden']
  // cross-site WebSocket hijacking: only our own page may open it
  const origin = req.headers.origin
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return [403, 'Forbidden']
  if (!(await sessionValid(cookie(req, 'ps_session')))) return [401, 'Unauthorized']
  if (voiceStudio.status().state !== 'running') return [503, 'Service Unavailable']
  return null
}

export function attachDictationProxy(server: Server, port: number) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== DICTATION_WS_PATH) return socket.destroy()
    void (async () => {
      const bad = await checkUpgrade(req, port).catch(() => [500, 'Internal Server Error'] as [number, string])
      if (bad) return reject(socket, bad[0], bad[1])
      let base: URL
      try {
        base = new URL(voiceStudio.url())
      } catch {
        return reject(socket, 503, 'Service Unavailable')
      }
      const q = new URLSearchParams()
      for (const [k, v] of url.searchParams) if (PASS_QUERY.has(k)) q.set(k, v.slice(0, 120))
      const key = req.headers['sec-websocket-key']
      const version = req.headers['sec-websocket-version'] ?? '13'
      if (typeof key !== 'string') return reject(socket, 400, 'Bad Request')
      const up = net.connect(Number(base.port), base.hostname)
      up.setNoDelay(true)
      ;(socket as net.Socket).setNoDelay?.(true)
      const lines = [
        `GET ${UPSTREAM_PATH}${q.size ? `?${q}` : ''} HTTP/1.1`,
        `Host: ${base.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${version}`,
      ]
      const ext = req.headers['sec-websocket-extensions']
      if (typeof ext === 'string') lines.push(`Sec-WebSocket-Extensions: ${ext}`)
      up.once('connect', () => {
        up.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head?.length) up.write(head)
        up.pipe(socket)
        socket.pipe(up)
      })
      const close = () => {
        up.destroy()
        socket.destroy()
      }
      up.on('error', (err) => {
        log.warn('voicestudio: dictation proxy upstream error', { err: String(err) })
        close()
      })
      socket.on('error', close)
      up.on('close', close)
      socket.on('close', close)
    })()
  })
}

/** Load the dictation model ahead of the first use (0.3 s of silence through a native session). Best effort. */
export async function warmDictation(model?: string): Promise<boolean> {
  let base: URL
  try {
    base = new URL(voiceStudio.url())
  } catch {
    return false
  }
  const q = new URLSearchParams({ pcm: '1', sr: '16000' })
  if (model) q.set('model', model)
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://${base.host}${UPSTREAM_PATH}?${q}`)
    const done = (ok: boolean) => {
      clearTimeout(t)
      try {
        ws.close()
      } catch {
        /* closed */
      }
      resolve(ok)
    }
    const t = setTimeout(() => done(false), 180_000)
    ws.onopen = () => {
      ws.send(new Uint8Array(16000 * 2 * 0.3))
      ws.send(JSON.stringify({ type: 'input_audio.end' }))
    }
    ws.onmessage = (m) => {
      const d = (() => {
        try {
          return JSON.parse(String(m.data)) as { type?: string }
        } catch {
          return {}
        }
      })()
      if (d.type === 'final' || d.type === 'error') done(d.type === 'final')
    }
    ws.onclose = () => done(true)
    ws.onerror = () => done(false)
  })
}
