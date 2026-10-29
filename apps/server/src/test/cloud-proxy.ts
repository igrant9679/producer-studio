// A loopback proxy between the desktop under test and the cloud: it can drop the network (every connection reset, as
// when Wi-Fi goes) and rewrite JSON answers (to stand in for a cloud that compacted its tombstones).
import http from 'node:http'
import type net from 'node:net'

export interface CloudProxy {
  url: string
  /** While true every request is cut off (a connection reset), like a network that's gone. */
  down: boolean
  /** Change a JSON answer before the desktop sees it. */
  rewrite?: (path: string, body: any) => any
  /** Answer this instead of asking the cloud (a refusal), by method and path. */
  fail?: (method: string, path: string) => { status: number; body: unknown } | undefined
  /** Held while this resolves (a slow request), by path. */
  hold?: (method: string, path: string) => Promise<void> | undefined
  /** Paths requested, in order. */
  log: string[]
  close: () => Promise<void>
}

export async function startProxy(target: string): Promise<CloudProxy> {
  const sockets = new Set<net.Socket>()
  const p: CloudProxy = { url: '', down: false, log: [], close: async () => undefined }
  const server = http.createServer(async (req, res) => {
    const path = req.url ?? '/'
    p.log.push(`${req.method} ${path}`)
    if (p.down) return req.socket.destroy()
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    await p.hold?.(req.method ?? 'GET', path)
    if (p.down) return req.socket.destroy()
    const refusal = p.fail?.(req.method ?? 'GET', path)
    if (refusal) {
      const text = JSON.stringify(refusal.body)
      res.writeHead(refusal.status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
      return res.end(text)
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'connection' && k !== 'content-length') headers[k] = v
    let up: Response
    try {
      up = await fetch(`${target}${path}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
    } catch {
      return req.socket.destroy()
    }
    let buf: Buffer = Buffer.from(await up.arrayBuffer())
    const type = up.headers.get('content-type') ?? ''
    if (p.rewrite && type.includes('application/json') && buf.length) {
      const next = p.rewrite(path, JSON.parse(buf.toString('utf8')))
      if (next !== undefined) buf = Buffer.from(JSON.stringify(next))
    }
    const out: Record<string, string> = {}
    up.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding' && k !== 'connection') out[k] = v
    })
    res.writeHead(up.status, { ...out, 'content-length': String(buf.length) })
    res.end(buf)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  p.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
  p.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    })
  return p
}
