import crypto from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseRange } from '../media/serve'
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

  it('parseRange edge cases', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseRange('bytes=2-50', 10)).toEqual({ start: 2, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=5-2', 10)).toBe('invalid')
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull()
  })
})
