// The client side of resumable uploads (P-5), for Node callers: the desktop's sync engine pushing a clip to the cloud,
// and tests. (The browser has its own copy in apps/web/src/lib/multipartUpload.ts, with progress from XHR.)
//
//   const ticket = await cloud.json('POST', '/api/uploads', { ...clip, size, multipart: true })
//   if (ticket.multipart) await uploadInParts({ ticket, file, request, json })   // only the parts not yet there
//   else  ...one PUT to ticket.url, as before
//   await cloud.json('POST', `/api/assets/${ticket.assetId}/complete`)
//
// Sending the same assetId again later (after a crash, or the network dropping for good) resumes: the ticket's
// `multipart.done` lists the parts already in storage.
import fs from 'node:fs'
import { Readable } from 'node:stream'
import type { MultipartPlan, UploadPartUrl, UploadTicket } from '@producer/core'
import { backoffMs } from './retry'

export interface PartRequestInit {
  body: ReadableStream | Uint8Array
  headers: Record<string, string>
  signal?: AbortSignal
}

export interface UploadInPartsOptions {
  ticket: UploadTicket & { multipart: MultipartPlan }
  /** The file on disk. */
  file: string
  /** PUT a part to a URL (absolute for a bucket, /api/... for the server itself): the caller's HTTP client. */
  request: (method: 'PUT', url: string, init: PartRequestInit) => Promise<Response>
  /** A JSON call to the API (signed in): used for part URLs. */
  json: <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<T>
  /** Parts in flight at once. */
  concurrency?: number
  /** Tries per part. */
  attempts?: number
  /** Bytes in storage so far (parts done before count from the start). */
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

/** A part refused for a reason trying again can't fix (the upload is gone, too large). */
export class PartRefusedError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const partStart = (plan: MultipartPlan, n: number) => (n - 1) * plan.partSize

/** Send every part of `file` the ticket doesn't list as done. Resolves when all are in storage. */
export async function uploadInParts(o: UploadInPartsOptions): Promise<void> {
  const plan = o.ticket.multipart
  const size = fs.statSync(o.file).size
  if (size !== plan.size) throw new Error(`The file is ${size} bytes but the upload was started for ${plan.size}`)
  const done = new Set(plan.done)
  const todo = Array.from({ length: plan.partCount }, (_, i) => i + 1).filter((n) => !done.has(n))
  const base = `/api/uploads/${encodeURIComponent(o.ticket.assetId)}/parts`
  let sent = plan.done.reduce((s, n) => s + Math.min(plan.partSize, plan.size - partStart(plan, n)), 0)
  o.onProgress?.(sent, plan.size)
  const urls = new Map<number, UploadPartUrl>()
  const urlFor = async (n: number, fresh = false): Promise<UploadPartUrl> => {
    if (!fresh && urls.has(n)) return urls.get(n)!
    // ask for this part and the next few still to send in one call
    const batch = [n, ...todo.filter((m) => m > n && !urls.has(m)).slice(0, 19)]
    const r = await o.json<{ parts: UploadPartUrl[] }>('POST', base, { parts: batch })
    for (const p of r.parts) urls.set(p.partNumber, p)
    return urls.get(n)!
  }
  const attempts = o.attempts ?? 5
  const sendPart = async (n: number) => {
    for (let attempt = 1; ; attempt++) {
      if (o.signal?.aborted) throw new Error('The upload was stopped')
      // a URL can expire during a long upload (or after a resume): a refused one is asked for again
      const p = await urlFor(n, attempt > 1)
      const start = partStart(plan, n)
      try {
        const body = Readable.toWeb(fs.createReadStream(o.file, { start, end: start + p.size - 1 })) as unknown as ReadableStream
        const res = await o.request('PUT', p.url, { body, headers: { ...p.headers, 'content-length': String(p.size) }, signal: o.signal })
        await res.body?.cancel().catch(() => undefined)
        if (res.ok) {
          sent += p.size
          o.onProgress?.(sent, plan.size)
          return
        }
        // the upload itself is gone or the part is wrong: no point trying again
        if (res.status === 404 || res.status === 409 || res.status === 413) throw new PartRefusedError(res.status, `Part ${n} was refused (${res.status})`)
        if (attempt >= attempts) throw new Error(`Part ${n} failed ${attempts} times (last answer ${res.status})`)
      } catch (err) {
        if (err instanceof PartRefusedError || attempt >= attempts || o.signal?.aborted) throw err
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt, 500)))
    }
  }
  const queue = [...todo]
  const workers = Array.from({ length: Math.min(o.concurrency ?? 3, queue.length) }, async () => {
    try {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n)
    } catch (err) {
      // the others stop taking parts too; what arrived stays for the next try
      queue.length = 0
      throw err
    }
  })
  await Promise.all(workers)
}
