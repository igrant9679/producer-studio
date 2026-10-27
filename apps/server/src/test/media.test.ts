import crypto from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ctx } from '../context'
import { downloadName, parseRange } from '../media/serve'
import { setup, signup, type Client, type TestEnv } from './helpers'

let t: TestEnv
let client: Client
let assetId: string
const bytes = crypto.randomBytes(64 * 1024 + 123)

beforeAll(async () => {
  t = await setup()
  const u = await signup(t.app)
  client = u.client
  const ticket = await client.json('POST', '/api/uploads', { workspaceId: u.workspaceId, filename: 'blob.mp4', mime: 'video/mp4', size: bytes.length })
  expect(ticket.status).toBe(200)
  expect(ticket.body.url).toBe(`/api/uploads/${ticket.body.assetId}/data`)
  assetId = ticket.body.assetId
  const put = await client.req('PUT', ticket.body.url, new Uint8Array(bytes), ticket.body.headers)
  expect(put.status).toBe(200)
  const done = await client.json('POST', `/api/assets/${assetId}/complete`)
  expect(done.body.status).toBe('processing')
  expect(done.body.asset.sizeBytes).toBe(bytes.length)
})

describe('media Range requests', () => {
  it('serves the full object with Accept-Ranges', async () => {
    const res = await client.req('GET', `/api/media/${assetId}/source`)
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('returns 206 with the exact bytes for bounded, open and suffix ranges', async () => {
    for (const [header, start, end] of [
      ['bytes=100-1099', 100, 1099],
      [`bytes=${bytes.length - 50}-`, bytes.length - 50, bytes.length - 1],
      ['bytes=-200', bytes.length - 200, bytes.length - 1],
      ['bytes=0-0', 0, 0],
    ] as const) {
      const res = await client.req('GET', `/api/media/${assetId}/source`, undefined, { range: header })
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
      expect(Number(res.headers.get('content-length'))).toBe(end - start + 1)
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(start, end + 1))).toBe(true)
    }
  })

  it('returns 416 for unsatisfiable ranges', async () => {
    const res = await client.req('GET', `/api/media/${assetId}/source`, undefined, { range: `bytes=${bytes.length + 10}-` })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
  })

  it('falls back to source for proxy/audio and 404s missing variants', async () => {
    expect((await client.req('GET', `/api/media/${assetId}/proxy`, undefined, { range: 'bytes=0-9' })).status).toBe(206)
    expect((await client.req('GET', `/api/media/${assetId}/filmstrip`)).status).toBe(404)
    expect((await client.req('GET', `/api/media/${assetId}/bogus`)).status).toBe(400)
  })

  it('storage that refuses a read answers 503 with the reason, not 404 (PIP-26)', async () => {
    const stat = vi.spyOn(ctx().storage, 'stat').mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied, stat '/data/x'"), { code: 'EACCES' }))
    const res = await client.json('GET', `/api/media/${assetId}/source`)
    expect(stat).toHaveBeenCalled()
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/Local storage can't be used \(EACCES\)/)
    expect(res.body.error).not.toMatch(/\/data/)
    stat.mockRestore()
  })

  it('parseRange edge cases', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=2-50', 10)).toEqual({ start: 2, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=5-2', 10)).toBe('invalid')
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull()
  })
})

describe('Download buttons (APP-11)', () => {
  it('?download=1 is an attachment named with the file type’s extension', async () => {
    const res = await client.req('GET', `/api/media/${assetId}/source?download=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="blob\.mp4"/)
    // without it the file still plays inline
    expect((await client.req('GET', `/api/media/${assetId}/source`)).headers.get('content-disposition')).toMatch(/^inline/)
    // a name without an extension gets one
    await client.json('PATCH', `/api/assets/${assetId}`, { name: 'Launch take 2' })
    const named = await client.req('GET', `/api/media/${assetId}/source?download=1`)
    expect(named.headers.get('content-disposition')).toMatch(/^attachment; filename="Launch take 2\.mp4"/)
    await client.json('PATCH', `/api/assets/${assetId}`, { name: 'blob.mp4' })
  })

  it('on a bucket the signed link carries the attachment', async () => {
    const storage = ctx().storage
    const presign = vi.fn(async (_key: string, o?: { disposition?: string }) => `https://bucket.example/obj?response-content-disposition=${encodeURIComponent(o?.disposition ?? '')}`)
    storage.presignGet = presign
    try {
      const res = await client.req('GET', `/api/media/${assetId}/source?download=1`)
      expect(res.status).toBe(302)
      expect(presign.mock.calls[0][1]).toMatchObject({ contentType: 'video/mp4', disposition: expect.stringMatching(/^attachment; filename="blob\.mp4"/) })
      await client.req('GET', `/api/media/${assetId}/source`)
      expect(presign.mock.calls[1][1]?.disposition).toMatch(/^inline/)
    } finally {
      delete storage.presignGet
    }
  })

  it('downloadName keeps a matching extension and adds or replaces the rest', () => {
    expect(downloadName('Clip.MOV', 'video/quicktime')).toBe('Clip.MOV')
    expect(downloadName('Voiceover — hello', 'audio/mpeg')).toBe('Voiceover — hello.mp3')
    expect(downloadName('Launch cut.mp4', 'video/webm')).toBe('Launch cut.webm')
    expect(downloadName('v1.2 final', 'video/mp4')).toBe('v1.2 final.mp4')
    expect(downloadName('Narration', 'audio/mp4')).toBe('Narration.m4a')
    expect(downloadName(undefined, 'image/png')).toBe('download.png')
  })
})
