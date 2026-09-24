// HTTP client for the cloud API (device token as Bearer). Network failures become CloudError{offline:true}.
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

export function normalizeCloudUrl(raw: string): string {
  const u = new URL(raw.trim())
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The cloud URL must start with https://')
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export class CloudClient {
  constructor(
    readonly baseUrl: string,
    private token?: string,
  ) {}

  url(p: string) {
    return /^https?:\/\//i.test(p) ? p : `${this.baseUrl}${p}`
  }

  /** Raw request; `p` may be absolute (presigned storage URLs never get the Bearer token). */
  async request(method: string, p: string, init: { body?: BodyInit | null; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const abs = /^https?:\/\//i.test(p)
    const sameOrigin = !abs || new URL(p).origin === new URL(this.baseUrl).origin
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (this.token && sameOrigin) headers.authorization = `Bearer ${this.token}`
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter(Boolean) as AbortSignal[]
    try {
      return await fetch(this.url(p), {
        method,
        headers,
        body: init.body ?? undefined,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        redirect: 'follow',
        ...(init.body && typeof (init.body as ReadableStream).getReader === 'function' ? { duplex: 'half' } : {}),
      } as RequestInit)
    } catch (err) {
      if (init.signal?.aborted) throw err
      throw new CloudError(0, { error: `The cloud is unreachable (${(err as Error).message})` }, true)
    }
  }

  async json<T>(method: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await this.request(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      timeoutMs,
    })
    const text = await res.text().catch(() => '')
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
