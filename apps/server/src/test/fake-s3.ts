// A small in-memory S3 (path-style) for tests: objects, ranges, copies, multipart uploads, and failures on request.
// Enough of the protocol for the AWS SDK and presigned PUTs; signatures are not checked (a real bucket does that).
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeS3 {
  url: string
  bucket: string
  objects: Map<string, { body: Buffer; type?: string }>
  uploads: Map<string, { key: string; parts: Map<number, Buffer> }>
  /** Answer the next `n` requests (matching `match`, default any) with 503 SlowDown. */
  failNext(n: number, match?: (method: string, url: URL) => boolean): void
  requests: Array<{ method: string; path: string; query: string; range?: string }>
  /** Object bytes sent in GET answers so far. */
  readonly bytesOut: number
  close(): Promise<void>
}

const md5 = (b: Buffer) => `"${crypto.createHash('md5').update(b).digest('hex')}"`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export async function startFakeS3(bucket = 'b'): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; type?: string }>()
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>()
  const requests: FakeS3['requests'] = []
  let bytesOut = 0
  let failing: Array<(m: string, u: URL) => boolean> = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const u = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    requests.push({ method, path: u.pathname, query: u.search, range: req.headers.range })
    // in pieces, counting only what goes out before the client hangs up (ffmpeg reads a little and closes)
    const send = (b: Buffer) => {
      let at = 0
      const next = () => {
        while (at < b.length && !res.destroyed) {
          const piece = b.subarray(at, at + 65536)
          at += piece.length
          bytesOut += piece.length
          if (!res.write(piece)) return void res.once('drain', next)
        }
        if (!res.destroyed) res.end()
      }
      next()
    }
    const xml = (status: number, s: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${s}`)
    }
    const error = (status: number, code: string) => (method === 'HEAD' ? (res.writeHead(status), res.end()) : xml(status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`))
    const f = failing.findIndex((m) => m(method, u))
    if (f >= 0) {
      failing.splice(f, 1)
      return error(503, 'SlowDown')
    }
    const [, b, ...rest] = u.pathname.split('/')
    if (b !== bucket) return error(404, 'NoSuchBucket')
    const key = rest.map(decodeURIComponent).join('/')
    const q = u.searchParams
    const now = new Date().toISOString()
    // bucket level
    if (!key) {
      if (method === 'GET' && q.get('list-type') === '2') {
        const prefix = q.get('prefix') ?? ''
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        return xml(200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('')}</ListBucketResult>`)
      }
      if (method === 'POST' && q.has('delete')) {
        for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&'))
        return xml(200, '<DeleteResult></DeleteResult>')
      }
      return error(400, 'InvalidRequest')
    }
    const uploadId = q.get('uploadId')
    if (method === 'POST' && q.has('uploads')) {
      const id = crypto.randomBytes(8).toString('hex')
      uploads.set(id, { key, parts: new Map() })
      return xml(200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (uploadId) {
      const up = uploads.get(uploadId)
      if (!up || up.key !== key) return error(404, 'NoSuchUpload')
      if (method === 'PUT') {
        const n = Number(q.get('partNumber'))
        const src = req.headers['x-amz-copy-source']
        let part: Buffer = body
        if (typeof src === 'string') {
          const from = objects.get(decodeURIComponent(src).replace(/^\/?[^/]+\//, ''))
          if (!from) return error(404, 'NoSuchKey')
          const m = String(req.headers['x-amz-copy-source-range'] ?? '').match(/bytes=(\d+)-(\d+)/)
          part = m ? from.body.subarray(Number(m[1]), Number(m[2]) + 1) : from.body
          up.parts.set(n, part)
          return xml(200, `<CopyPartResult><ETag>${md5(part)}</ETag><LastModified>${now}</LastModified></CopyPartResult>`)
        }
        up.parts.set(n, part)
        res.writeHead(200, { etag: md5(part) })
        return res.end()
      }
      if (method === 'GET') {
        const parts = [...up.parts.entries()].sort((a, c) => a[0] - c[0])
        return xml(200, `<ListPartsResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${uploadId}</UploadId><IsTruncated>false</IsTruncated>${parts.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${md5(p)}</ETag><Size>${p.length}</Size><LastModified>${now}</LastModified></Part>`).join('')}</ListPartsResult>`)
      }
      if (method === 'POST') {
        const listed = [...body.toString().matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
          n: Number(m[1].match(/<PartNumber>(\d+)<\/PartNumber>/)?.[1]),
          etag: (m[1].match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? '').replace(/&quot;/g, '"'),
        }))
        const out: Buffer[] = []
        for (const p of listed) {
          const part = up.parts.get(p.n)
          if (!part || md5(part) !== p.etag) return error(400, 'InvalidPart')
          out.push(part)
        }
        objects.set(key, { body: Buffer.concat(out) })
        uploads.delete(uploadId)
        return xml(200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`)
      }
      if (method === 'DELETE') {
        uploads.delete(uploadId)
        res.writeHead(204)
        return res.end()
      }
    }
    if (method === 'PUT') {
      const src = req.headers['x-amz-copy-source']
      if (typeof src === 'string') {
        const from = objects.get(decodeURIComponent(src).replace(/^\/?[^/]+\//, ''))
        if (!from) return error(404, 'NoSuchKey')
        objects.set(key, { body: Buffer.from(from.body), type: String(req.headers['content-type'] ?? from.type ?? '') })
        return xml(200, `<CopyObjectResult><ETag>${md5(from.body)}</ETag><LastModified>${now}</LastModified></CopyObjectResult>`)
      }
      objects.set(key, { body, type: req.headers['content-type'] })
      res.writeHead(200, { etag: md5(body) })
      return res.end()
    }
    const obj = objects.get(key)
    if (method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    if (!obj) return error(404, 'NoSuchKey')
    if (method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(obj.body.length), 'content-type': obj.type ?? 'application/octet-stream', 'last-modified': new Date().toUTCString(), etag: md5(obj.body) })
      return res.end()
    }
    if (method === 'GET') {
      const m = String(req.headers.range ?? '').match(/bytes=(\d+)-(\d+)?/)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Math.min(Number(m[2]), obj.body.length - 1) : obj.body.length - 1
        res.writeHead(206, { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${obj.body.length}` })
        return send(obj.body.subarray(start, end + 1))
      }
      res.writeHead(200, { 'content-length': String(obj.body.length), 'content-type': obj.type ?? 'application/octet-stream' })
      return send(obj.body)
    }
    return error(405, 'MethodNotAllowed')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bucket,
    objects,
    uploads,
    requests,
    get bytesOut() {
      return bytesOut
    },
    failNext(n, match = () => true) {
      for (let i = 0; i < n; i++) failing.push(match)
    },
    close: () =>
      new Promise((r) => {
        failing = []
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
