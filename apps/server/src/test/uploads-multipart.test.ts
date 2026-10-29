// Resumable uploads in parts (P-5): a big file goes up part by part, carries on after a drop or a reload (the same
// asset id resumes, sending only the parts still missing), each part takes exactly its bytes, and nothing is
// processed until every part has arrived.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { MultipartPlan, UploadPartUrl, UploadTicket } from '@producer/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { assets, uploadSessions } from '../db/schema'
import { reconcileAssets } from '../services/asset-recovery'
import { MULTIPART_MIN_PART, partPlan, UPLOAD_SESSION_MAX_IDLE_MS } from '../services/uploads'
import { uploadInParts } from '../storage/multipart-client'
import { type Client, setup, signup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
let A: { client: Client; workspaceId: string }
let file: string
let bytes: Buffer
const SIZE = 2 * MULTIPART_MIN_PART + 3 * 1024 * 1024 // three parts: 16 + 16 + 3 MB

beforeAll(async () => {
  t = await setup()
  A = await signup(t.app)
  bytes = crypto.randomBytes(SIZE)
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mp-')), 'big recording.mov')
  fs.writeFileSync(file, bytes)
})

const start = (client: Client, body: Record<string, unknown> = {}) =>
  client.json<UploadTicket & { multipart: MultipartPlan }>('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'big recording.mov', mime: 'video/quicktime', size: SIZE, multipart: true, ...body })

/** The caller's HTTP client, as the desktop's cloud client would be: through the app, signed in. */
const via = (client: Client, opts: { failFirst?: number; puts?: string[] } = {}) => {
  let fail = opts.failFirst ?? 0
  return {
    request: async (method: 'PUT', url: string, init: { body: ReadableStream | Uint8Array; headers: Record<string, string> }) => {
      opts.puts?.push(url)
      const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      if (fail > 0) {
        fail--
        return new Response('busy', { status: 503 })
      }
      return client.req(method, url, body, init.headers)
    },
    json: async <T,>(method: 'GET' | 'POST', p: string, b?: unknown) => {
      const r = await client.json<T>(method, p, b)
      if (r.status !== 200) throw new Error(`${p}: ${r.status} ${JSON.stringify(r.body)}`)
      return r.body
    },
  }
}

describe('resumable uploads in parts (P-5)', () => {
  it('cuts a file into whole-megabyte parts, few enough for S3', () => {
    expect(partPlan(SIZE)).toEqual({ partSize: MULTIPART_MIN_PART, partCount: 3 })
    const huge = partPlan(200 * 1024 ** 3)
    expect(huge.partCount).toBeLessThanOrEqual(10_000)
    expect(huge.partSize % (1024 * 1024)).toBe(0)
  })

  it('carries on after a reload, sending only the missing parts, and the joined file is the one sent', async () => {
    const first = await start(A.client)
    expect(first.status).toBe(200)
    const plan = first.body.multipart
    expect(plan).toMatchObject({ size: SIZE, partSize: MULTIPART_MIN_PART, partCount: 3, done: [] })
    const id = first.body.assetId
    // part 1 goes up, then the tab closes
    const urls = (await A.client.json<{ parts: UploadPartUrl[] }>('POST', `/api/uploads/${id}/parts`, { parts: [1] })).body.parts
    expect(urls[0]).toMatchObject({ partNumber: 1, size: MULTIPART_MIN_PART })
    expect((await A.client.req('PUT', urls[0].url, bytes.subarray(0, MULTIPART_MIN_PART), urls[0].headers)).status).toBe(200)
    // nothing is processed before every part is there
    const early = await A.client.json('POST', `/api/assets/${id}/complete`)
    expect(early.status).toBe(409)
    expect(early.body.details.missingParts).toEqual([2, 3])
    // back again with the same asset id: the ticket says part 1 is done
    const again = await start(A.client, { assetId: id })
    expect(again.body.multipart.done).toEqual([1])
    expect((await A.client.json('GET', `/api/uploads/${id}/parts`)).body.done).toEqual([1])
    const puts: string[] = []
    const progress: number[] = []
    await uploadInParts({ ticket: again.body, file, ...via(A.client, { puts }), onProgress: (s) => progress.push(s) })
    expect(puts.map((u) => u.split('/').pop())).toEqual(expect.arrayContaining(['2', '3']))
    expect(puts.length).toBe(2)
    expect(progress[0]).toBe(MULTIPART_MIN_PART)
    expect(progress.at(-1)).toBe(SIZE)
    const done = await A.client.json('POST', `/api/assets/${id}/complete`)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('processing')
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, id)))[0]
    expect(row.size).toBe(SIZE)
    expect(row.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
    expect(fs.readFileSync(ctx().storage.localPath!(row.sourceKey)).equals(bytes)).toBe(true)
    // the session is gone once the file is whole
    expect(await ctx().db.select().from(uploadSessions).where(eq(uploadSessions.assetId, id))).toEqual([])
  })

  it('a part that fails in passing is sent again', async () => {
    const r = await start(A.client)
    await uploadInParts({ ticket: r.body, file, ...via(A.client, { failFirst: 2 }), attempts: 4 })
    expect((await A.client.json('POST', `/api/assets/${r.body.assetId}/complete`)).body.status).toBe('processing')
  })

  it('each part takes exactly its bytes', async () => {
    const r = await start(A.client)
    const id = r.body.assetId
    const [p3] = (await A.client.json<{ parts: UploadPartUrl[] }>('POST', `/api/uploads/${id}/parts`, { parts: [3] })).body.parts
    expect(p3.size).toBe(3 * 1024 * 1024)
    expect((await A.client.req('PUT', p3.url, bytes.subarray(0, p3.size + 10), p3.headers)).status).toBe(413)
    expect((await A.client.req('PUT', p3.url, bytes.subarray(0, p3.size - 10), p3.headers)).status).toBe(400)
    expect((await A.client.json('GET', `/api/uploads/${id}/parts`)).body.done).toEqual([])
    expect((await A.client.json('POST', `/api/uploads/${id}/parts`, { parts: [4] })).status).toBe(400)
  })

  it('only editors of the space may send parts', async () => {
    const r = await start(A.client)
    const B = await signup(t.app, 'Stranger')
    expect((await B.client.json('POST', `/api/uploads/${r.body.assetId}/parts`, { parts: [1] })).status).toBe(404)
    expect((await B.client.json('GET', `/api/uploads/${r.body.assetId}/parts`)).status).toBe(404)
  })

  it('stopping the upload removes its parts; a week-old upload nobody carried on is cleared', async () => {
    const r = await start(A.client)
    const id = r.body.assetId
    const [p1] = (await A.client.json<{ parts: UploadPartUrl[] }>('POST', `/api/uploads/${id}/parts`, { parts: [1] })).body.parts
    await A.client.req('PUT', p1.url, bytes.subarray(0, MULTIPART_MIN_PART), p1.headers)
    expect((await A.client.json('POST', `/api/assets/${id}/abort`, { reason: 'Cancelled' })).body.status).toBe('error')
    expect(await ctx().db.select().from(uploadSessions).where(eq(uploadSessions.assetId, id))).toEqual([])

    const old = await start(A.client)
    await ctx().db.update(uploadSessions).set({ updatedAt: Date.now() - UPLOAD_SESSION_MAX_IDLE_MS - 1000 }).where(eq(uploadSessions.assetId, old.body.assetId))
    await reconcileAssets()
    expect(await ctx().db.select().from(uploadSessions).where(eq(uploadSessions.assetId, old.body.assetId))).toEqual([])
  })

  it('an upload left part way for hours says it can carry on, and does, with the parts already sent', async () => {
    const r = await start(A.client)
    const id = r.body.assetId
    const [p1] = (await A.client.json<{ parts: UploadPartUrl[] }>('POST', `/api/uploads/${id}/parts`, { parts: [1] })).body.parts
    await A.client.req('PUT', p1.url, bytes.subarray(0, MULTIPART_MIN_PART), p1.headers)
    // three hours later the reconciler calls it stopped
    await ctx().db.update(assets).set({ updatedAt: Date.now() - 3 * 3600_000 }).where(eq(assets.id, id))
    await reconcileAssets()
    const stopped = (await A.client.json('GET', `/api/assets/${id}`)).body
    expect(stopped.status).toBe('error')
    expect(stopped.error).toMatch(/stopped part way.*same file again/)
    // the same file chosen again: the part is still there
    const again = await start(A.client, { assetId: id })
    expect(again.status).toBe(200)
    expect(again.body.multipart.done).toEqual([1])
    expect((await A.client.json('GET', `/api/assets/${id}`)).body.status).toBe('uploading')
  })

  it('a client that sends in one piece still can', async () => {
    const r = await A.client.json<UploadTicket>('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'small.mov', mime: 'video/quicktime', size: 1000 })
    expect(r.body.multipart).toBeUndefined()
    expect(r.body.url).toBe(`/api/uploads/${r.body.assetId}/data`)
  })
})
