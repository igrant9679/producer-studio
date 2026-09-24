// Serve a stored object with HTTP Range support (206 partial content) or redirect to a signed URL (S3).
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { ctx } from '../context'
import { HttpError, notFound } from '../http'

export type Variant = 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio'

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

export async function serveObject(c: Context, t: ServeTarget, opts: { cache?: string; redirect?: boolean } = {}): Promise<Response> {
  const storage = ctx().storage
  if (storage.presignGet && opts.redirect !== false) {
    const url = await storage.presignGet(t.key, { expiresSec: 900, contentType: t.contentType, filename: t.filename })
    return c.redirect(url, 302)
  }
  const st = await storage.stat(t.key)
  if (!st) throw notFound('Media not available')
  const headers = new Headers({
    'Content-Type': t.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'private, max-age=3600',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    ETag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
  })
  if (t.filename) headers.set('Content-Disposition', `inline; filename="${t.filename.replace(/["\\\r\n]/g, '')}"`)
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
  if (!['source', 'proxy', 'thumb', 'filmstrip', 'audio'].includes(v)) throw new HttpError(400, 'invalid', `Unknown media variant "${v}"`)
  return v as Variant
}
