// Producer Studio local MCP server (stdio, JSON-RPC 2.0, newline-delimited) for the Claude Code CLI provider.
// Launched by `claude --mcp-config <run>/mcp.json` for one assistant run. Serves the provider-agnostic editing
// tools listed in PRODUCER_MCP_TOOLS (written by the server from ai/tools.ts) and forwards every tools/call to the
// Producer server process over PRODUCER_MCP_BRIDGE (a named pipe / unix socket) authenticated with
// PRODUCER_MCP_TOKEN. The server applies the call with the same handlers as the Anthropic API provider.
// Dependency-free on purpose: it runs from the source tree in dev and is copied as-is into the packaged app.
import fs from 'node:fs'
import net from 'node:net'
import { createInterface } from 'node:readline'

const TOOLS_FILE = process.env.PRODUCER_MCP_TOOLS || ''
const BRIDGE = process.env.PRODUCER_MCP_BRIDGE || ''
const TOKEN = process.env.PRODUCER_MCP_TOKEN || ''
const NAME = process.env.PRODUCER_MCP_NAME || 'producer'
const VERSION = '1.0.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

let tools = []
try {
  tools = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'))
  if (!Array.isArray(tools)) tools = []
} catch (err) {
  process.stderr.write(`[producer-mcp] cannot read tools: ${err && err.message}\n`)
}
const toolNames = new Set(tools.map((t) => t.name))

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

// ---- bridge client (lazy, one connection, calls answered in order) ----
let conn
let connecting
let seq = 0
const waiting = new Map()

function connect() {
  if (conn && !conn.destroyed) return Promise.resolve(conn)
  if (connecting) return connecting
  connecting = new Promise((resolve, reject) => {
    if (!BRIDGE || !TOKEN) return reject(new Error('Producer bridge is not configured'))
    const sock = net.connect(BRIDGE)
    const rl = createInterface({ input: sock })
    let ready = false
    sock.once('error', (err) => {
      connecting = undefined
      if (!ready) reject(err)
    })
    sock.on('close', () => {
      conn = undefined
      connecting = undefined
      for (const [, w] of waiting) w({ content: 'Producer Studio closed the connection', isError: true })
      waiting.clear()
    })
    rl.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'ready') {
        ready = true
        conn = sock
        connecting = undefined
        resolve(sock)
        return
      }
      const w = waiting.get(msg.id)
      if (w) {
        waiting.delete(msg.id)
        w({ content: String(msg.content ?? ''), isError: Boolean(msg.isError) })
      }
    })
    sock.write(JSON.stringify({ type: 'hello', token: TOKEN }) + '\n')
  })
  return connecting
}

async function callTool(name, input) {
  const sock = await connect()
  const id = ++seq
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    sock.write(JSON.stringify({ id, name, input }) + '\n')
  })
}

// ---- JSON-RPC ----
async function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions: 'Editing tools for the Producer Studio project the user has open. Call get_timeline first.',
      })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      return isRequest && reply(id, {})
    case 'tools/list':
      return reply(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
    case 'tools/call': {
      const name = params && params.name
      if (!toolNames.has(name)) return reply(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
      try {
        const r = await callTool(name, (params && params.arguments) || {})
        return reply(id, { content: [{ type: 'text', text: r.content }], isError: r.isError })
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `Producer Studio is not reachable: ${err && err.message}` }], isError: true })
      }
    }
    default:
      if (isRequest) fail(id, -32601, `Method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return fail(null, -32700, 'Parse error')
  }
  const batch = Array.isArray(msg) ? msg : [msg]
  for (const m of batch) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      if (m && m.id !== undefined) fail(m.id, -32600, 'Invalid request')
      continue
    }
    handle(m).catch((err) => m.id !== undefined && fail(m.id, -32603, String(err && err.message)))
  }
})
rl.on('close', () => {
  if (conn) conn.end()
  process.exit(0)
})
