// The desktop's cloud client on a slow link: a transfer that keeps moving is never cut off, however long it takes;
// one that stops moving is reported as offline (never as an empty success).
import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CloudClient, CloudError } from '../desktop/cloud'

let server: http.Server
let base: string
const received: Record<string, number> = {}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/slow') {
      // ~2.4 s for the whole answer, but a chunk every 120 ms
      const doc = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'x'.repeat(100) })) })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(doc) })
      for (let i = 0; i < 20; i++) {
        res.write(doc.slice((i * doc.length) / 20, ((i + 1) * doc.length) / 20))
        await wait(120)
      }
      res.end()
    } else if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
      res.write('{"items": [')
      // ...and nothing more
    } else if (req.url === '/slow-read') {
      // a slow uplink: the body is taken a bite at a time
      let n = 0
      req.on('data', (chunk: Buffer) => {
        n += chunk.length
        req.pause()
        setTimeout(() => req.resume(), 15)
      })
      req.on('end', () => {
        received['slow-read'] = n
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, bytes: n }))
      })
    } else if (req.url === '/portal') {
      // a captive portal answering for every address
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>Sign in to Hotel Wi-Fi</body></html>')
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections?.()
  server.close()
})

describe('cloud client on a slow link (DSK-12)', () => {
  it('waits for a slow answer that keeps arriving, past the time limit for silence', async () => {
    const c = new CloudClient(base)
    const t0 = Date.now()
    const r = await c.json<{ items: unknown[] }>('GET', '/slow', undefined, 800)
    expect(r.items).toHaveLength(2000)
    expect(Date.now() - t0).toBeGreaterThan(1500)
  })

  it('sends a large document to a slow uplink without cutting it off', async () => {
    const c = new CloudClient(base)
    const doc = { project: { text: 'y'.repeat(3 * 1024 * 1024) } }
    const r = await c.json<{ ok: boolean; bytes: number }>('PUT', '/slow-read', doc, 800)
    expect(r).toEqual({ ok: true, bytes: Buffer.byteLength(JSON.stringify(doc)) })
  })

  it('reports a transfer that stops moving as offline, not as an empty answer', async () => {
    const c = new CloudClient(base)
    const t0 = Date.now()
    const err = await c.json('GET', '/stall', undefined, 600).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudError)
    expect((err as CloudError).offline).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('cloud client behind a Wi-Fi sign-in page (DSK-32)', () => {
  it('takes a success that isn’t JSON as offline, not as an answer', async () => {
    const err = await new CloudClient(base).json('GET', '/portal').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudError)
    expect((err as CloudError).offline).toBe(true)
    expect((err as CloudError).message).toMatch(/Wi-Fi sign-in/)
  })
})
