// The web build (apps/web/dist) as static files: compressed when the browser takes it, cached by name.
// A build may ship `file.br` / `file.gz` next to a file; anything without one is compressed here once and kept in
// memory, keyed by its size and mtime, so a rebuilt file is never answered with the old one's bytes.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/** Text-like files worth compressing; images, fonts and media are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.wasm', '.ico'])
const MIN_BYTES = 1024
const MAX_BYTES = 16 * 1024 * 1024
const CACHE_BUDGET = 96 * 1024 * 1024

export type Encoding = 'br' | 'gzip'

/** The best encoding the request accepts (brotli over gzip), honouring `q=0`. */
export function pickEncoding(accept: string | undefined): Encoding | undefined {
  if (!accept) return undefined
  const ok = new Map<string, boolean>()
  for (const part of accept.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    ok.set(name.trim(), !q || Number(q.slice(2)) > 0)
  }
  const star = ok.get('*')
  for (const enc of ['br', 'gzip'] as const) if (ok.get(enc) ?? star) return enc
  return undefined
}

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)
const memo = new Map<string, { key: string; size: number; bytes: Promise<ArrayBuffer> }>()
let memoBytes = 0

function compressed(file: string, stat: fs.Stats, enc: Encoding): Promise<ArrayBuffer> {
  const id = `${file}|${enc}`
  const key = `${stat.size}:${stat.mtimeMs}`
  const hit = memo.get(id)
  if (hit?.key === key) return hit.bytes
  if (hit) {
    memo.delete(id)
    memoBytes -= hit.size
  }
  const bytes = fs.promises
    .readFile(file)
    .then((raw) => (enc === 'br' ? brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : gzip(raw, { level: 9 })))
    .then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  if (memoBytes + stat.size <= CACHE_BUDGET) {
    const entry = { key, size: stat.size, bytes }
    memo.set(id, entry)
    memoBytes += stat.size
    bytes.catch(() => {
      if (memo.get(id) === entry) {
        memo.delete(id)
        memoBytes -= stat.size
      }
    })
  }
  return bytes
}

function sibling(file: string, enc: Encoding, stat: fs.Stats): string | undefined {
  const p = `${file}.${enc === 'br' ? 'br' : 'gz'}`
  try {
    const s = fs.statSync(p)
    // a leftover from an older build would be the wrong file
    return s.isFile() && s.mtimeMs >= stat.mtimeMs ? p : undefined
  } catch {
    return undefined
  }
}

/**
 * Serve a file from the build. `index` is the SPA shell: never cached, so a deploy is picked up on the next load;
 * files under assets/ carry a content hash in their name and are cached for a year.
 */
export async function serveStatic(file: string, index: string, acceptEncoding: string | undefined): Promise<Response> {
  const ext = path.extname(file)
  const immutable = file !== index && /[\\/]assets[\\/]/.test(file)
  const headers: Record<string, string> = {
    'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  const stat = fs.statSync(file)
  const enc = COMPRESSIBLE.has(ext) && stat.size >= MIN_BYTES && stat.size <= MAX_BYTES ? pickEncoding(acceptEncoding) : undefined
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding'
  if (enc) {
    headers['Content-Encoding'] = enc
    const pre = sibling(file, enc, stat)
    if (pre) {
      headers['Content-Length'] = String(fs.statSync(pre).size)
      return new Response(Readable.toWeb(fs.createReadStream(pre)) as unknown as ReadableStream, { headers })
    }
    const body = await compressed(file, stat, enc)
    headers['Content-Length'] = String(body.byteLength)
    return new Response(body, { headers })
  }
  headers['Content-Length'] = String(stat.size)
  return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, { headers })
}
