// Stand-in for the Claude Code CLI in tests: same flags and stream-json output shape, no network.
// With --mcp-config it launches the configured MCP server, lists its tools and calls split_at + add_text through it,
// exactly as the real CLI would. FAKE_CLAUDE_LOG receives one JSON line per invocation (argv, cwd, selected env).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), env: { CLAUDECODE: process.env.CLAUDECODE ?? null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null } }) + '\n',
  )
}
const loggedOut = process.env.FAKE_CLAUDE_LOGGED_OUT === '1'
if (argv[0] === '--version') {
  console.log('9.9.9 (Claude Code)')
  process.exit(0)
}
if (argv[0] === '--help') {
  console.log('Options: --add-dir --allowedTools --disable-slash-commands --include-partial-messages --json-schema --max-turns --mcp-config --model --no-session-persistence --output-format --permission-prompts --strict-mcp-config --system-prompt --tools --verbose')
  process.exit(0)
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: !loggedOut, authMethod: loggedOut ? 'none' : 'claude.ai', email: loggedOut ? undefined : 'tester@example.com', subscriptionType: loggedOut ? undefined : 'max' }))
  process.exit(loggedOut ? 1 : 0)
}

const prompt = fs.readFileSync(0, 'utf8')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const flag = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const result = (extra) => out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, duration_ms: 5, result: '', ...extra })

if (loggedOut) {
  out({ type: 'system', subtype: 'init', session_id: 's0', model: 'fake', tools: [], mcp_servers: [] })
  out({ type: 'assistant', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] }, error: 'authentication_failed' })
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  process.exit(1)
}

async function mcpSession(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const [name, server] = Object.entries(cfg.mcpServers)[0]
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const rl = createInterface({ input: child.stdout })
  const waiting = new Map()
  rl.on('line', (l) => {
    const m = JSON.parse(l)
    waiting.get(m.id)?.(m)
  })
  let id = 0
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const i = ++id
      waiting.set(i, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    })
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '9.9.9' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const list = await rpc('tools/list', {})
  return { name, child, rpc, init, tools: list.result.tools }
}

if (flag('--mcp-config')) {
  const s = await mcpSession(flag('--mcp-config'))
  const allowed = (flag('--allowedTools') ?? '').split(',')
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake', tools: s.tools.map((t) => `mcp__${s.name}__${t.name}`), mcp_servers: [{ name: s.name, status: 'connected' }] })
  const calls = [
    ['get_timeline', {}],
    ['split_at', { time: 4 }],
    ['add_text', { text: 'Hello from Claude', start: 1, duration: 2, position: 'top' }],
    ['delete_items', { itemIds: ['does-not-exist'] }],
  ]
  let n = 0
  for (const [tool, input] of calls) {
    const full = `mcp__${s.name}__${tool}`
    if (!allowed.includes(full)) throw new Error(`tool not allowed: ${full}`)
    const tu = `tu_${++n}`
    out({ type: 'assistant', message: { id: `m${n}`, role: 'assistant', content: [{ type: 'tool_use', id: tu, name: full, input }] } })
    const r = await s.rpc('tools/call', { name: tool, arguments: input })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: r.result.content, is_error: r.result.isError }] } })
  }
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'mfinal' } } })
  for (const d of ['I split the clip ', 'and added a title.']) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } } })
  out({ type: 'assistant', message: { id: 'mfinal', role: 'assistant', content: [{ type: 'text', text: 'I split the clip and added a title.' }] } })
  result({ num_turns: 5, result: 'I split the clip and added a title.' })
  s.child.stdin.end()
} else if (flag('--json-schema')) {
  const schema = JSON.parse(flag('--json-schema'))
  out({ type: 'system', subtype: 'init', session_id: 's2', model: 'fake', tools: argv.includes('Read') ? ['Read'] : [], mcp_servers: [] })
  const images = [...prompt.matchAll(/(\S+\.(?:jpg|png))/g)].map((m) => m[1]).filter((p) => fs.existsSync(p))
  result({ result: 'done', structured_output: { ...JSON.parse(process.env.FAKE_STRUCTURED ?? '{}'), _schemaKeys: Object.keys(schema.properties ?? {}), _images: images.length } })
} else {
  out({ type: 'system', subtype: 'init', session_id: 's3', model: 'fake', tools: [], mcp_servers: [] })
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'mw' } } })
  const words = ['Bright ', 'ideas, ', 'clearly told.']
  for (const w of words) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } })
  out({ type: 'assistant', message: { id: 'mw', role: 'assistant', content: [{ type: 'text', text: words.join('') }] } })
  result({ result: words.join('') + (prompt.includes('under') ? '' : '') })
}
