// HTTP client for the local VoiceStudio backend (loopback, no auth; we never send an Origin header, so VoiceStudio's
// browser guard treats these as same-machine tool calls).
import { HttpError } from '../../http'
import { voiceStudio } from './runtime'

export interface VsInit {
  method?: string
  json?: unknown
  form?: FormData
  body?: BodyInit
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
  timeoutMs?: number
}

function qs(q?: VsInit['query']): string {
  if (!q) return ''
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

/** Human message from a VoiceStudio error body ({detail: string | {message} | [{msg}]}). */
export function vsErrorMessage(body: unknown, status: number): string {
  const d = (body as { detail?: unknown } | undefined)?.detail ?? body
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map((x) => (x as { msg?: string }).msg ?? JSON.stringify(x)).join('; ')
  if (d && typeof d === 'object') {
    const o = d as { message?: string; error?: string; code?: string }
    return o.message || o.error || o.code || JSON.stringify(d).slice(0, 300)
  }
  return `VoiceStudio request failed (HTTP ${status})`
}

export async function vs(pathname: string, init: VsInit = {}): Promise<Response> {
  let base: string
  try {
    base = voiceStudio.url()
  } catch {
    throw new HttpError(503, 'server', 'VoiceStudio isn’t running. Start it from Voice Studio → Engine.')
  }
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  let body: BodyInit | undefined = init.body
  if (init.json !== undefined) {
    body = JSON.stringify(init.json)
    headers['content-type'] = 'application/json'
  } else if (init.form) body = init.form
  const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s)
  return fetch(`${base}${pathname}${qs(init.query)}`, {
    method: init.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
    // Node fetch needs this for streamed request bodies
    ...(body && typeof (body as ReadableStream).getReader === 'function' ? { duplex: 'half' } : {}),
  } as RequestInit)
}

/** Request and throw an HttpError (status preserved for 4xx, 502 for 5xx) on failure. */
export async function vsOk(pathname: string, init: VsInit = {}): Promise<Response> {
  const res = await vs(pathname, init)
  if (res.ok) return res
  const text = await res.text().catch(() => '')
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* text */
  }
  const msg = vsErrorMessage(parsed, res.status)
  if (res.status >= 400 && res.status < 500) throw new HttpError(res.status, res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : res.status === 403 ? 'forbidden' : 'invalid', msg, parsed)
  throw new HttpError(502, 'server', msg, parsed)
}

export async function vsJson<T>(pathname: string, init: VsInit = {}): Promise<T> {
  return (await (await vsOk(pathname, init)).json()) as T
}

/** Parse an SSE body into {event, data} records. */
export async function* sse(res: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
        let event = 'message'
        const data: string[] = []
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        if (!data.length) continue
        const raw = data.join('\n')
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          /* raw */
        }
        yield { event, data: parsed }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
