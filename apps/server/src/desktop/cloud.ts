// HTTP client for the cloud API (device token as Bearer). Network failures become CloudError{offline:true}. Calls give
// up when nothing has moved for a while (not after a fixed total time), so big documents sync on slow links.
import type { ApiError } from '@producer/core'

export class CloudError extends Error {
  constructor(
    public status: number,
    public body: ApiError | undefined,
    public offline = false,
  ) {
    super(body?.error || (offline ? 'The cloud is unreachable' : `Cloud request failed (HTTP ${status})`))
  }
  get code() {
    return this.body?.code
  }
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * The cloud URL as stored: https only, because linking sends the account password and every sync the device token.
 * Plain http is accepted for this computer alone (a cloud running locally, as in development and tests).
 */
export function normalizeCloudUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error('That isn’t a valid URL. The cloud URL must start with https://')
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOST.test(u.hostname))) {
    throw new Error(u.protocol === 'http:' ? 'The cloud URL must start with https:// (plain http would send your password and device token unencrypted)' : 'The cloud URL must start with https://')
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

/** JSON bodies above this go out as a stream, so a slow uplink counts as progress. */
const STREAM_BODY_BYTES = 256 * 1024
/** Once a body is handed over, the reply can lag by what sits in the network's buffers: allow 16 KB/s for up to 8 MB. */
const drainMs = (bytes: number) => Math.min(bytes, 8 * 1024 * 1024) / 16

/**
 * Aborts a transfer when no bytes have moved for `ms`, however long the whole transfer takes: large documents on a
 * slow link keep going, a dead connection is noticed.
 */
class StallGuard {
  readonly controller = new AbortController()
  stalled = false
  private timer?: NodeJS.Timeout
  constructor(private ms: number) {
    this.touch()
  }
  touch(ms = this.ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.stalled = true
      this.controller.abort(new Error(`no data for ${Math.round(ms / 1000)} s`))
    }, ms)
    this.timer.unref?.()
  }
  done() {
    clearTimeout(this.timer)
  }
  get error() {
    return new CloudError(0, { error: `The cloud stopped responding (nothing arrived for ${Math.round(this.ms / 1000)} s)` }, true)
  }
  /** A request body whose reads count as progress; when it's all sent, waits `drainMs` for the reply. */
  upload(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = src.getReader()
    let sent = 0
    return new ReadableStream<Uint8Array>(
      {
        pull: async (ctl) => {
          const { done, value } = await reader.read()
          if (done) {
            this.touch(this.ms + drainMs(sent))
            return ctl.close()
          }
          sent += value.byteLength
          this.touch()
          ctl.enqueue(value)
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    )
  }
  /** A response body whose reads count as progress; a stall surfaces as an offline CloudError. */
  download(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = src.getReader()
    return new ReadableStream<Uint8Array>({
      pull: async (ctl) => {
        try {
          const { done, value } = await reader.read()
          if (done) {
            this.done()
            return ctl.close()
          }
          this.touch()
          ctl.enqueue(value)
        } catch (err) {
          this.done()
          ctl.error(this.stalled ? this.error : err)
        }
      },
      cancel: (reason) => {
        this.done()
        return reader.cancel(reason)
      },
    })
  }
}

function chunks(buf: Uint8Array, size = 64 * 1024): ReadableStream<Uint8Array> {
  let off = 0
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (off >= buf.byteLength) return ctl.close()
      ctl.enqueue(buf.subarray(off, (off += size)))
    },
  })
}

export class CloudClient {
  constructor(
    readonly baseUrl: string,
    private token?: string,
  ) {}

  url(p: string) {
    return /^https?:\/\//i.test(p) ? p : `${this.baseUrl}${p}`
  }

  /**
   * Raw request; `p` may be absolute (presigned storage URLs never get the Bearer token). `idleTimeoutMs` gives up only
   * when nothing has moved for that long (request body, reply headers or reply body); `timeoutMs` caps the total.
   */
  async request(method: string, p: string, init: { body?: BodyInit | null; headers?: Record<string, string>; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const abs = /^https?:\/\//i.test(p)
    const sameOrigin = !abs || new URL(p).origin === new URL(this.baseUrl).origin
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (this.token && sameOrigin) headers.authorization = `Bearer ${this.token}`
    const guard = init.idleTimeoutMs ? new StallGuard(init.idleTimeoutMs) : undefined
    let body = init.body ?? undefined
    if (guard && typeof body === 'string' && body.length > STREAM_BODY_BYTES) {
      const buf = Buffer.from(body)
      headers['content-length'] = String(buf.byteLength)
      body = chunks(buf)
    }
    const streaming = !!body && typeof (body as ReadableStream).getReader === 'function'
    if (guard && streaming) body = guard.upload(body as ReadableStream<Uint8Array>)
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined, guard?.controller.signal].filter(Boolean) as AbortSignal[]
    let res: Response
    try {
      res = await fetch(this.url(p), {
        method,
        headers,
        body,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        redirect: 'follow',
        ...(streaming ? { duplex: 'half' } : {}),
      } as RequestInit)
    } catch (err) {
      guard?.done()
      if (init.signal?.aborted) throw err
      if (guard?.stalled) throw guard.error
      throw new CloudError(0, { error: `The cloud is unreachable (${(err as Error).message})` }, true)
    }
    if (!guard) return res
    guard.touch()
    if (!res.body) {
      guard.done()
      return res
    }
    return new Response(guard.download(res.body as ReadableStream<Uint8Array>), { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  /** JSON call. `idleTimeoutMs`: how long nothing may move before the cloud counts as unreachable. */
  async json<T>(method: string, p: string, body?: unknown, idleTimeoutMs = 60_000): Promise<T> {
    const res = await this.request(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      idleTimeoutMs,
    })
    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      // a reply cut off half way is never an (empty) answer
      if (err instanceof CloudError) throw err
      if (res.ok) throw new CloudError(0, { error: `The cloud is unreachable (${(err as Error).message})` }, true)
    }
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!res.ok) {
      const offline = res.status === 502 || res.status === 503 || res.status === 504 ? !parsed : false
      throw new CloudError(res.status, (parsed as ApiError) ?? { error: text.slice(0, 200) || res.statusText }, offline)
    }
    return parsed as T
  }
}
