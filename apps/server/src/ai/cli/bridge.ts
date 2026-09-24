// Per-run tool bridge between the local MCP server (spawned by the Claude CLI) and this server process.
// Tool handlers need this process's database, storage, whisper and TTS (PGlite is single-process), and the
// assistant's project state lives here, so the MCP server forwards each tools/call over a private local socket
// (a Windows named pipe / a unix socket in the run's temp dir) authenticated with a random per-run token.
// Line protocol (JSON per line):  → {"type":"hello","token"}  → {"id","name","input"}  ← {"id","content","isError"}
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'

export type ToolHandler = (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>

export interface ToolBridge {
  address: string
  token: string
  /** Number of tool calls served. */
  calls: number
  close(): Promise<void>
}

export async function startToolBridge(runDir: string, handler: ToolHandler): Promise<ToolBridge> {
  const token = crypto.randomBytes(24).toString('base64url')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\producer-mcp-${crypto.randomBytes(12).toString('hex')}` : path.join(runDir, 'bridge.sock')
  const sockets = new Set<net.Socket>()
  const state = { calls: 0 }
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    let authed = false
    // one call at a time per connection, in order (tool calls mutate shared project state)
    let chain = Promise.resolve()
    const rl = createInterface({ input: sock })
    const send = (o: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n')
    }
    rl.on('line', (line) => {
      let msg: { type?: string; token?: string; id?: number | string; name?: string; input?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        sock.destroy()
        return
      }
      if (!authed) {
        const ok = msg.type === 'hello' && typeof msg.token === 'string' && msg.token.length === token.length && crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(token))
        if (!ok) {
          sock.destroy()
          return
        }
        authed = true
        send({ type: 'ready' })
        return
      }
      if (msg.id === undefined || typeof msg.name !== 'string') return
      const { id, name, input } = msg
      chain = chain.then(async () => {
        state.calls++
        try {
          const r = await handler(name, input)
          send({ id, content: r.content, isError: r.isError })
        } catch (err) {
          send({ id, content: err instanceof Error ? err.message : String(err), isError: true })
        }
      })
    })
  })
  server.maxConnections = 4
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    address,
    token,
    get calls() {
      return state.calls
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
        if (process.platform !== 'win32') fs.rm(address, { force: true }, () => undefined)
      }),
  }
}
