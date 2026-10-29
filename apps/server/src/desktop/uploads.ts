// How a clip's file goes up to the cloud (D-7), and what is going up now (SyncStatus.uploads). Today: one PUT to the
// ticket's URL, whose size the cloud signs into it; an upload cut short starts that file again (from its first byte)
// on the next try. The resumable multipart protocol (R4-B's P-5) plugs in through setFileSender without the engine
// changing: a sender gets the ticket, the file and a progress callback, and resolves once the cloud holds every byte.
import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import type { SyncUpload, UploadTicket } from '@producer/core'
import { type CloudClient, CloudError } from './cloud'

export interface SendFile {
  client: CloudClient
  ticket: UploadTicket
  /** The file on this computer. */
  file: string
  bytes: number
  name: string
  /** Bytes handed to the network so far. */
  onProgress: (sent: number) => void
  /** A transfer that moves nothing for this long counts as offline. */
  idleMs: number
}

export type FileSender = (a: SendFile) => Promise<void>

/** One PUT of the whole file (the cloud's signed URL refuses any other length). */
export const putWhole: FileSender = async ({ client, ticket, file, bytes, name, onProgress, idleMs }) => {
  let sent = 0
  const count = new Transform({
    transform(chunk: Buffer, _e, cb) {
      sent += chunk.length
      onProgress(sent)
      cb(null, chunk)
    },
  })
  const src = fs.createReadStream(file)
  src.on('error', (err) => count.destroy(err))
  const body = Readable.toWeb(src.pipe(count)) as unknown as ReadableStream
  const put = await client.request('PUT', ticket.url, { body, headers: { ...ticket.headers, 'content-length': String(bytes) }, idleTimeoutMs: idleMs })
  if (!put.ok) {
    const text = await put.text().catch(() => '')
    let parsed: { error?: string } | undefined
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not json */
    }
    throw new CloudError(put.status, { error: `Upload of ${name} failed: ${parsed?.error ?? (text.slice(0, 200) || put.statusText)}` })
  }
  await put.body?.cancel().catch(() => undefined)
}

let sender: FileSender = putWhole

/** Swap how files go up (a resumable protocol); undefined puts the single PUT back. */
export function setFileSender(fn: FileSender | undefined) {
  sender = fn ?? putWhole
}

export const sendFile = (a: SendFile) => sender(a)

/** Clips going up now (or queued for the next free lane), for the sync panel. */
export class UploadBoard {
  private items = new Map<string, SyncUpload>()
  private lastEmit = 0
  constructor(private changed: () => void) {}

  queue(id: string, name: string, bytes: number) {
    if (!this.items.has(id)) this.items.set(id, { id, name, bytes, sent: 0, startedAt: 0 })
  }

  has(id: string) {
    return this.items.has(id)
  }

  start(id: string, name: string, bytes: number) {
    this.items.set(id, { id, name, bytes, sent: 0, startedAt: Date.now() })
    this.changed()
  }

  /** At most a couple of status updates a second while bytes move. */
  progress(id: string, sent: number) {
    const u = this.items.get(id)
    if (!u) return
    u.sent = Math.min(sent, u.bytes)
    if (Date.now() - this.lastEmit < 500) return
    this.lastEmit = Date.now()
    this.changed()
  }

  done(id: string) {
    if (this.items.delete(id)) this.changed()
  }

  list(): SyncUpload[] {
    return [...this.items.values()].map((u) => ({ ...u }))
  }
}

/** Run `fn` over `list`, `lanes` at a time. The first failure stops new starts; it's thrown once the running ones end. */
export async function inLanes<T>(list: T[], lanes: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  let failed: { err: unknown } | undefined
  const lane = async () => {
    while (!failed && i < list.length) {
      const x = list[i++]
      try {
        await fn(x)
      } catch (err) {
        failed ??= { err }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, list.length) }, lane))
  if (failed) throw failed.err
}
