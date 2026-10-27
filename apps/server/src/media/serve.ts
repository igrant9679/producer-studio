// Serve a stored object with HTTP Range support (206 partial content) or redirect to a signed URL (S3).
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { ctx } from '../context'
import { HttpError, notFound } from '../http'
import { log } from '../log'
import { SVG_MIME, isMediaMime } from '../services/assets'
import { describeStorageError } from '../services/storage-health'

export type Variant = 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio' | 'waveform'

export interface ServeTarget {
  key: string
  contentType: string
  filename?: string
}

/** Parse a single `bytes=` range. Returns null for "no range", 'invalid' for unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null // multi-range or malformed: serve whole body
  const [, a, b] = m
  let start: number
  let end: number
  if (a === '' && b === '') return 'invalid'
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

/**
 * `inline` or `attachment` with an ASCII fallback + RFC 5987 UTF-8 name (header values must be Latin-1). Local storage
 * sends it as a header and S3 as the signed URL's response-content-disposition, so both name a download alike.
 * encodeURIComponent leaves ' ( ) * ! as they are; in an RFC 5987 value they must be escaped too ("it's.mp4" would
 * end the charset'language' prefix early).
 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const name = filename.replace(/[\r\n]/g, '')
  const ascii = name.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_')
  const ext = encodeURIComponent(name).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${ext}`
}

/**
 * What the browser is told about a stored object. Media plays inline. SVG keeps its type (so `<img>` can draw a
 * logo) but is a download if opened directly: `<img>` ignores Content-Disposition and never runs an SVG's scripts,
 * while a navigation would. Anything else (a type stored before uploads were checked, or a desktop's synced file)
 * is an opaque download. Neither can run as a page on our origin or the bucket's.
 */
export function deliveryOf(t: ServeTarget): { contentType: string; disposition?: string; inline: boolean } {
  if (isMediaMime(t.contentType)) return { contentType: t.contentType, disposition: t.filename ? contentDisposition('inline', t.filename) : undefined, inline: true }
  const svg = t.contentType.split(';')[0].trim().toLowerCase() === SVG_MIME
  return { contentType: svg ? SVG_MIME : 'application/octet-stream', disposition: contentDisposition('attachment', t.filename ?? (svg ? 'image.svg' : 'download')), inline: false }
}

export async function serveObject(c: Context, t: ServeTarget, opts: { cache?: string; redirect?: boolean } = {}): Promise<Response> {
  const storage = ctx().storage
  const d = deliveryOf(t)
  if (storage.presignGet && opts.redirect !== false) {
    const url = await storage.presignGet(t.key, { expiresSec: 900, contentType: d.contentType, disposition: d.disposition })
    return c.redirect(url, 302)
  }
  const st = await storage.stat(t.key).catch((err) => {
    // storage that can't be read is not a missing file: say what is wrong
    log.warn('media: storage stat failed', { key: t.key, err })
    throw new HttpError(503, 'server', describeStorageError(err))
  })
  if (!st) throw notFound('Media not available')
  const headers = new Headers({
    'Content-Type': d.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'private, max-age=3600',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    ETag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
    'X-Content-Type-Options': 'nosniff',
  })
  if (d.disposition) headers.set('Content-Disposition', d.disposition)
  if (!d.inline) headers.set('Content-Security-Policy', 'sandbox')
  const etag = headers.get('ETag')!
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })
  const ifRange = c.req.header('if-range')
  const range = ifRange && ifRange !== etag ? null : parseRange(c.req.header('range'), st.size)
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${st.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (c.req.method === 'HEAD') {
    headers.set('Content-Length', String(range ? range.end - range.start + 1 : st.size))
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  if (st.size === 0) {
    headers.set('Content-Length', '0')
    return new Response(null, { status: 200, headers })
  }
  const stream = await storage.getStream(t.key, range ?? undefined)
  const web = Readable.toWeb(stream) as unknown as ReadableStream
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    return new Response(web, { status: 206, headers })
  }
  headers.set('Content-Length', String(st.size))
  return new Response(web, { status: 200, headers })
}

export function assertVariant(v: string): Variant {
  if (!['source', 'proxy', 'thumb', 'filmstrip', 'audio', 'waveform'].includes(v)) throw new HttpError(400, 'invalid', `Unknown media variant "${v}"`)
  return v as Variant
}
