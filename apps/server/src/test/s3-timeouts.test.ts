// A storage call that hangs fails instead of holding its job "running" for good (PIP-2): the S3 client has
// connection and idle timeouts, and a download that stops mid-body is cut off.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3Storage } from '../storage/s3'

let server: http.Server
let mode: 'silent' | 'stall-body' = 'silent'
const open = new Set<http.ServerResponse>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    open.add(res)
    if (mode === 'stall-body') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1000000' })
      res.write(Buffer.alloc(1000))
    }
    // otherwise: accept the request and never answer
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
})

afterAll(() => {
  for (const r of open) r.destroy()
  server.close()
})

const storage = () =>
  new S3Storage(
    { bucket: 'b', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'auto', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true },
    { connectMs: 500, idleMs: 500 },
  )

/** Settles with the outcome, or 'hung' after `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => 'ok', (e: Error) => e), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])

describe('storage timeouts', () => {
  it('a request the bucket never answers fails', async () => {
    mode = 'silent'
    const r = await within(storage().delete('ws/x/assets/a/source.mp4'), 15_000)
    expect(r).toBeInstanceOf(Error)
  })

  it('a download that stops mid-file fails', async () => {
    mode = 'stall-body'
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-s3-')), 'source.mp4')
    const r = await within(storage().download('ws/x/assets/a/source.mp4', dest), 15_000)
    expect(r).toBeInstanceOf(Error)
  })
})
