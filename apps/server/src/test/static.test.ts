// QA-4: the web build goes over the wire compressed, hashed files are cached for good and index.html never is.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { pickEncoding } from '../static'
import { setup, type TestEnv } from './helpers'

const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-static-'))
const script = `export const big = ${JSON.stringify('producer studio '.repeat(4000))}\n`
fs.writeFileSync(path.join(webDist, 'index.html'), `<!doctype html><title>app</title>${'<!-- pad -->'.repeat(200)}`)
fs.mkdirSync(path.join(webDist, 'assets'))
fs.writeFileSync(path.join(webDist, 'assets', 'index-abc123.js'), script)
fs.writeFileSync(path.join(webDist, 'assets', 'tiny-abc.css'), 'a{}')
fs.writeFileSync(path.join(webDist, 'assets', 'logo-abc.png'), Buffer.alloc(4096, 7))
process.env.WEB_DIST = webDist

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const get = (url: string, accept?: string) => t.app.request(url, { headers: accept ? { 'accept-encoding': accept } : {} })

describe('static files', () => {
  it('sends the main script brotli-compressed with a year-long immutable cache', async () => {
    const res = await get('/assets/index-abc123.js', 'gzip, deflate, br, zstd')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBeLessThan(script.length / 10)
    expect(Number(res.headers.get('content-length'))).toBe(body.length)
    expect(zlib.brotliDecompressSync(body).toString()).toBe(script)
  })

  it('falls back to gzip, and to the plain file for a client that takes neither', async () => {
    const gz = await get('/assets/index-abc123.js', 'gzip;q=1.0, br;q=0')
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(script)

    const plain = await get('/assets/index-abc123.js')
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(script)
  })

  it('serves a precompressed copy from the build when there is one', async () => {
    const file = path.join(webDist, 'assets', 'pre-abc.js')
    fs.writeFileSync(file, script)
    fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(Buffer.from('// the build made this')))
    const res = await get('/assets/pre-abc.js', 'br')
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(zlib.brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe('// the build made this')
  })

  it('compresses index.html but never caches it, for deep links too', async () => {
    for (const url of ['/', '/library?tab=assets', '/edit/p_123']) {
      const res = await get(url, 'br')
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('content-encoding')).toBe('br')
      expect(zlib.brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toContain('<title>app</title>')
    }
  })

  it('leaves tiny files and images alone', async () => {
    const css = await get('/assets/tiny-abc.css', 'br')
    expect(css.headers.get('content-encoding')).toBeNull()
    expect(await css.text()).toBe('a{}')
    const png = await get('/assets/logo-abc.png', 'br')
    expect(png.headers.get('content-encoding')).toBeNull()
    expect(png.headers.get('vary')).toBeNull()
    expect((await png.arrayBuffer()).byteLength).toBe(4096)
  })

  it('serves a rebuilt file, not the compressed copy of the old one', async () => {
    const file = path.join(webDist, 'assets', 'index-abc123.js')
    const first = await get('/assets/index-abc123.js', 'br')
    await first.arrayBuffer()
    const changed = `${script}export const v = 2\n`
    fs.writeFileSync(file, changed)
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    const res = await get('/assets/index-abc123.js', 'br')
    expect(zlib.brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(changed)
  })
})

describe('pickEncoding', () => {
  it('prefers brotli, honours q=0 and the wildcard', () => {
    expect(pickEncoding('gzip, br')).toBe('br')
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip')
    expect(pickEncoding('identity')).toBeUndefined()
    expect(pickEncoding('*')).toBe('br')
    expect(pickEncoding('*, br;q=0')).toBe('gzip')
    expect(pickEncoding(undefined)).toBeUndefined()
  })
})
