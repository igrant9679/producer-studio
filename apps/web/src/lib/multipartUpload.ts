// Resumable uploads in parts (P-5), the browser's side. A big file goes up a part at a time (three at once), each part
// tried again after a passing failure; the asset id is kept in this browser (by the file's name, size and date), so
// choosing the same file again after a drop or a reload carries on with only the parts still missing.
// The server's side and the protocol: apps/server/src/services/uploads.ts, packages/core/src/api.ts.
import type { MultipartPlan, UploadPartUrl, UploadTicket } from '@producer/core'

/** Files at least this big go up in parts (smaller ones in one PUT, as before). */
export const MULTIPART_FROM_BYTES = 32 * 1024 * 1024

export interface PartTransport {
  /** PUT one part; resolves with the HTTP status (0: the network failed). `onProgress` gets bytes of this part sent. */
  put(url: string, headers: Record<string, string>, body: Blob, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<number>
  /** A JSON call to the API. */
  json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>
  wait(ms: number): Promise<void>
}

const RESUME_PREFIX = 'ps.upload.'

/** What identifies "the same file" across a reload: its space, name, size and last change. */
export function resumeKey(workspaceId: string, file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${RESUME_PREFIX}${workspaceId}:${file.size}:${file.lastModified}:${file.name}`
}

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** The asset id of an unfinished upload of this file, if this browser started one. */
export function savedUpload(key: string): string | undefined {
  try {
    const v = storage()?.getItem(key)
    if (!v) return undefined
    const o = JSON.parse(v) as { assetId?: string; at?: number }
    // the server gives an untouched upload up after a week
    return o.assetId && (o.at ?? 0) > Date.now() - 7 * 24 * 3600_000 ? o.assetId : undefined
  } catch {
    return undefined
  }
}

export function rememberUpload(key: string, assetId: string | undefined) {
  try {
    if (assetId) storage()?.setItem(key, JSON.stringify({ assetId, at: Date.now() }))
    else storage()?.removeItem(key)
  } catch {
    /* private window: no resume after a reload */
  }
}

/** The upload stopped part way; its parts are kept, and choosing the same file again carries on. */
export class UploadPausedError extends Error {
  constructor(public sent: number, public total: number, public reason: string) {
    super(`the upload stopped at ${Math.round((sent / total) * 100)}% (${reason}). Choose the same file again to carry on from there.`)
  }
}

/** Send the parts of `file` the ticket doesn't list as done. `onProgress` gets 0..1 of the whole file. */
export async function sendParts(file: Blob, ticket: UploadTicket & { multipart: MultipartPlan }, t: PartTransport, opts: { onProgress?: (f: number) => void; concurrency?: number; attempts?: number; signal?: AbortSignal } = {}): Promise<void> {
  const plan = ticket.multipart
  const base = `/uploads/${encodeURIComponent(ticket.assetId)}/parts`
  const done = new Set(plan.done)
  const todo = Array.from({ length: plan.partCount }, (_, i) => i + 1).filter((n) => !done.has(n))
  const bytesOf = (n: number) => Math.min(plan.partSize, plan.size - (n - 1) * plan.partSize)
  let stored = plan.done.reduce((s, n) => s + bytesOf(n), 0)
  const inFlight = new Map<number, number>()
  const report = () => opts.onProgress?.(Math.min(1, (stored + [...inFlight.values()].reduce((a, b) => a + b, 0)) / plan.size))
  report()
  const urls = new Map<number, UploadPartUrl>()
  const urlFor = async (n: number, fresh: boolean) => {
    if (!fresh && urls.has(n)) return urls.get(n)!
    const batch = [n, ...todo.filter((m) => m > n && !urls.has(m)).slice(0, 19)]
    for (const p of (await t.json<{ parts: UploadPartUrl[] }>('POST', base, { parts: batch })).parts) urls.set(p.partNumber, p)
    return urls.get(n)!
  }
  const attempts = opts.attempts ?? 6
  let stop: Error | undefined
  const sendPart = async (n: number) => {
    let last = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (opts.signal?.aborted) throw new Error('the upload was cancelled')
      let p: UploadPartUrl
      try {
        // a URL can expire during a long upload: a part refused once gets a fresh one
        p = await urlFor(n, attempt > 1)
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
        await t.wait(1000 * 2 ** (attempt - 1))
        continue
      }
      const start = (n - 1) * plan.partSize
      const status = await t.put(p.url, p.headers, file.slice(start, start + p.size), (s) => (inFlight.set(n, s), report()), opts.signal)
      inFlight.delete(n)
      if (status >= 200 && status < 300) {
        stored += p.size
        report()
        return
      }
      // the upload itself is gone, or this part can never fit: trying again won't help
      if (status === 404 || status === 409 || status === 413) throw new Error(`storage refused part ${n} (${status})`)
      last = status ? `storage answered ${status}` : 'the network dropped'
      report()
      await t.wait(1000 * 2 ** (attempt - 1))
    }
    throw new UploadPausedError(stored, plan.size, last)
  }
  const queue = [...todo]
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
      for (let n = queue.shift(); n !== undefined && !stop; n = queue.shift()) {
        try {
          await sendPart(n)
        } catch (e) {
          stop ??= e instanceof Error ? e : new Error(String(e))
        }
      }
    }),
  )
  // how far it got counts every part that arrived, the other workers' too
  if (stop) throw stop instanceof UploadPausedError ? new UploadPausedError(stored, plan.size, stop.reason) : stop
}

/** The browser's transport: XHR for upload progress, cookies for the app's own part URLs (local storage). */
export function xhrTransport(json: PartTransport['json']): PartTransport {
  return {
    json,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    put: (url, headers, body, onProgress, signal) =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', url)
        xhr.withCredentials = url.startsWith('/')
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
        xhr.upload.onprogress = (e) => onProgress(e.loaded)
        xhr.onload = () => resolve(xhr.status)
        xhr.onerror = () => resolve(0)
        xhr.onabort = () => resolve(0)
        signal?.addEventListener('abort', () => xhr.abort(), { once: true })
        xhr.send(body)
      }),
  }
}
