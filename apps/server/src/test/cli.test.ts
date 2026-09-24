// Claude Code CLI provider: stream-json parsing, detection order, schema derivation, the stdio MCP server + tool
// bridge, and full provider runs against a fake `claude` (same flags/output shape, no network, no billing).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/v4'
import { addAsset, addItem, createProject, createVideoItem, type Asset, type Project } from '@producer/core'
import { runAssistant, toolSpecs } from '../ai/assistant'
import { ClaudeCliProvider, cliFailure, mcpServerScript, renderConversation } from '../ai/cli'
import { startToolBridge } from '../ai/cli/bridge'
import { claudeCandidates, cliEnv, compareVersions, parseAuthStatus, pickClaude, type DetectDeps } from '../ai/cli/detect'
import { extractJson, jsonSchemaOf } from '../ai/cli/schema'
import { type CliEvent, StreamJsonParser, TextRelay, interpretEvent } from '../ai/cli/stream'
import { ScriptSchema } from '../ai/produce'
import { runTool, type ToolEnv, type ToolState } from '../ai/tools'
import { setup } from './helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs')

const clip: Asset = { id: 'as_clip', kind: 'video', name: 'clip.mp4', src: '/api/media/as_clip/source', duration: 10, width: 1920, height: 1080, hasAudio: true }
function fixtureState(): ToolState {
  let p: Project = createProject({ name: 'Fixture' })
  p = addAsset(p, clip)
  p = addItem(p, createVideoItem(clip, 0, { id: 'v_1', duration: 10 }))
  return { project: p, playhead: 0, selection: [], changes: [] }
}
const env: ToolEnv = {
  transcribe: async () => ({ language: 'en', engine: 'test', segments: [] }),
  tts: async () => {
    throw new Error('no tts in tests')
  },
}

describe('stream-json parser', () => {
  it('parses a recorded logged-out run (real CLI 2.1.280 output) and maps it to "sign in"', () => {
    const raw = fs.readFileSync(path.join(here, 'fixtures', 'cli-logged-out.jsonl'), 'utf8')
    const p = new StreamJsonParser()
    // feed in awkward chunks to exercise line reassembly
    const evs: CliEvent[] = []
    for (let i = 0; i < raw.length; i += 97) evs.push(...p.push(raw.slice(i, i + 97)))
    evs.push(...p.end())
    const kinds = evs.map((e) => e.kind)
    expect(kinds[0]).toBe('init')
    expect(kinds).toContain('assistant')
    const res = evs.find((e) => e.kind === 'result') as Extract<CliEvent, { kind: 'result' }>
    expect(res).toMatchObject({ isError: true, text: expect.stringMatching(/OAuth session expired/) })
    const asst = evs.find((e) => e.kind === 'assistant') as Extract<CliEvent, { kind: 'assistant' }>
    expect(asst.error).toBe('authentication_failed')
    const err = cliFailure({ result: res, assistantError: asst.error, stderr: '', code: 1, timedOut: false, noise: [] }, 'write this')
    expect(err.status).toBe(503)
    expect(err.message).toMatch(/Sign in to Claude/)
  })

  it('normalises init, partial deltas, tool_use, tool_result and result with structured_output', () => {
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-opus-5', tools: ['mcp__producer__split_at'], mcp_servers: [{ name: 'producer', status: 'connected' }] },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Spl' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'itting.' } } },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Splitting.' }, { type: 'tool_use', id: 'tu1', name: 'mcp__producer__split_at', input: { time: 3 } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"ok":true}' }], is_error: false }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done', num_turns: 2, total_cost_usd: 0.01, structured_output: { a: 1 } },
    ]
    const p = new StreamJsonParser()
    const evs = p.push(lines.map((l) => JSON.stringify(l)).join('\r\n') + '\r\nnot json\n')
    expect(evs[0]).toMatchObject({ kind: 'init', model: 'claude-opus-5', mcpServers: [{ name: 'producer', status: 'connected' }] })
    expect(evs.filter((e) => e.kind === 'text-delta').map((e) => (e as { text: string }).text)).toEqual(['Spl', 'itting.'])
    expect(evs.find((e) => e.kind === 'assistant')).toMatchObject({ text: 'Splitting.', toolUses: [{ id: 'tu1', name: 'mcp__producer__split_at', input: { time: 3 } }] })
    expect(evs.find((e) => e.kind === 'tool-result')).toMatchObject({ toolUseId: 'tu1', content: '{"ok":true}', isError: false })
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ isError: false, text: 'Done', structured: { a: 1 }, numTurns: 2, costUsd: 0.01 })
    expect(p.noise).toEqual(['not json'])
    expect(interpretEvent({ type: 'rate_limit_event' })).toEqual([{ kind: 'other', type: 'rate_limit_event' }])
  })

  it('TextRelay emits each piece of text once, with or without partial messages', () => {
    const got: string[] = []
    const r = new TextRelay((t) => got.push(t))
    // streamed message: deltas only, the whole assistant message is not re-emitted
    r.handle({ kind: 'message-start' })
    r.handle({ kind: 'text-delta', text: 'Hello ' })
    r.handle({ kind: 'text-delta', text: 'there.' })
    r.handle({ kind: 'assistant', text: 'Hello there.', toolUses: [] })
    // un-streamed message (older CLI): emitted whole, separated from the previous turn
    r.handle({ kind: 'assistant', text: 'All done.', toolUses: [] })
    expect(got.join('')).toBe('Hello there.\nAll done.')
    expect(r.text).toBe('Hello there.\nAll done.')
  })
})

describe('CLI detection', () => {
  const home = 'C:\\Users\\u'
  function deps(files: string[], dirs: Record<string, string[]>, which: string[] = []): DetectDeps {
    const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
    return {
      env: { APPDATA: `${home}\\AppData\\Roaming`, LOCALAPPDATA: `${home}\\AppData\\Local` },
      platform: 'win32',
      home,
      exists: (p) => files.map(norm).includes(norm(p)),
      readdir: (p) => dirs[norm(p)] ?? [],
      which: () => which,
    }
  }
  const bundle = `${home}\\AppData\\Roaming\\Claude\\claude-code`
  const msixPkg = 'Claude_pzs8sxrjxfjjc'
  const msix = `${home}\\AppData\\Local\\Packages\\${msixPkg}\\LocalCache\\Roaming\\Claude\\claude-code`
  const local = `${home}\\.local\\bin\\claude.exe`

  it('orders settings path, desktop bundle (newest version first), MSIX, ~/.local/bin, then PATH', () => {
    const files = [`${bundle}\\2.1.99\\claude.exe`, `${bundle}\\2.1.280\\claude.exe`, `${msix}\\2.0.5\\claude.exe`, local, 'D:\\tools\\claude.exe', 'C:\\bin\\claude.exe']
    const d = deps(files, { [bundle.toLowerCase()]: ['2.1.99', '2.1.280', 'broken'], [`${home}\\AppData\\Local\\Packages`.toLowerCase()]: ['Other_app', msixPkg], [msix.toLowerCase()]: ['2.0.5'] }, ['C:\\bin\\claude.exe'])
    const c = claudeCandidates('D:\\tools\\claude.exe', d)
    expect(c.map((x) => x.source)).toEqual(['settings', 'desktop-bundle', 'desktop-bundle', 'msix', 'local-bin', 'path'])
    expect(c[1].path).toMatch(/2\.1\.280/)
    expect(c[2].path).toMatch(/2\.1\.99/)
    // a configured path that doesn't exist is skipped (auto-detect)
    expect(claudeCandidates('Z:\\missing.exe', d)[0].source).toBe('desktop-bundle')
    // nothing installed
    expect(claudeCandidates('', deps([], {}))).toEqual([])
    expect(claudeCandidates('', deps([local], {}))[0]).toEqual({ path: local, source: 'local-bin' })
    // the newest version wins across locations; the configured path always wins
    const auto = claudeCandidates('', d)
    const versions: Record<string, string> = { [local]: '2.1.281' }
    expect(pickClaude(auto, (p) => versions[p] ?? p.match(/(\d+\.\d+\.\d+)/)?.[1])).toEqual({ path: local, source: 'local-bin' })
    expect(pickClaude(c, () => '9.9.9')!.source).toBe('settings')
    expect(pickClaude(auto, (p) => p.match(/(\d+\.\d+\.\d+)/)?.[1])!.path).toMatch(/2\.1\.280/)
  })

  it('compares versions numerically and parses auth status JSON and text', () => {
    expect(compareVersions('2.1.280', '2.1.99')).toBeGreaterThan(0)
    expect(compareVersions('2.1.261', '2.1.280')).toBeLessThan(0)
    expect(parseAuthStatus('{\n "loggedIn": false,\n "authMethod": "none"\n}')).toMatchObject({ loggedIn: false, authMethod: 'none' })
    expect(parseAuthStatus('warn\n{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}')).toMatchObject({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' })
    expect(parseAuthStatus('Not logged in').loggedIn).toBe(false)
  })

  it('strips variables that would redirect the CLI away from the user’s login', () => {
    const e = cliEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://proxy', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_MODEL: 'm', CLAUDE_CONFIG_DIR: 'keep' })
    expect(e).toMatchObject({ PATH: 'x', CLAUDE_CONFIG_DIR: 'keep' })
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_MESSAGING_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) expect(e[k]).toBeUndefined()
  })
})

describe('schema derivation', () => {
  it('derives the --json-schema from the same zod ScriptSchema as the API provider', () => {
    const s = jsonSchemaOf(ScriptSchema) as { $schema?: string; type: string; properties: Record<string, any>; required: string[] }
    expect(s.$schema).toBeUndefined()
    expect(s.type).toBe('object')
    expect(s.required).toEqual(expect.arrayContaining(['message', 'scenes']))
    const scene = s.properties.scenes.items
    expect(scene.required).toEqual(expect.arrayContaining(['id', 'title', 'headline', 'narration', 'footage', 'visuals']))
    expect(scene.properties.footage.items.properties.start.type).toBe('number')
    expect(extractJson('Here:\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] })
  })

  it('MCP tool inputSchemas are JSON Schema objects for every tool', () => {
    const specs = toolSpecs()
    expect(specs.length).toBeGreaterThan(15)
    for (const t of specs) expect(t.inputSchema).toMatchObject({ type: 'object' })
    expect(specs.find((t) => t.name === 'split_at')!.inputSchema).toMatchObject({ properties: { time: { type: 'number' } }, required: ['time'] })
  })

  it('folds chat history into one prompt', () => {
    expect(renderConversation([{ role: 'user', text: 'Hi' }])).toBe('Hi')
    const p = renderConversation([
      { role: 'user', text: 'Add a title' },
      { role: 'assistant', text: 'Added.' },
      { role: 'user', text: 'Make it red' },
    ])
    expect(p).toMatch(/User: Add a title[\s\S]*Assistant: Added\.[\s\S]*new request:\s+Make it red$/)
  })
})

describe('MCP server (stdio JSON-RPC) + tool bridge', () => {
  it('initialize, tools/list and tools/call apply the real tool handlers to a fixture project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mcp-'))
    const state = fixtureState()
    const specs = toolSpecs()
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(specs))
    const called: string[] = []
    const bridge = await startToolBridge(dir, async (name, input) => {
      called.push(name)
      try {
        const r = await runTool(state, name, input, env)
        return { content: r.result, isError: false }
      } catch (err) {
        return { content: (err as Error).message, isError: true }
      }
    })
    const child = spawn(process.execPath, [mcpServerScript()], {
      env: { ...process.env, PRODUCER_MCP_TOOLS: path.join(dir, 'tools.json'), PRODUCER_MCP_BRIDGE: bridge.address, PRODUCER_MCP_TOKEN: bridge.token },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: child.stdout! })
    const waiting = new Map<number, (m: any) => void>()
    rl.on('line', (l) => {
      const m = JSON.parse(l)
      waiting.get(m.id)?.(m)
    })
    let id = 0
    const rpc = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const i = ++id
        waiting.set(i, resolve)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
      })
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'producer' } })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const list = await rpc('tools/list')
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(specs.map((s) => s.name))
      expect(list.result.tools[0].inputSchema.type).toBe('object')

      const tl = await rpc('tools/call', { name: 'get_timeline', arguments: {} })
      expect(tl.result.isError).toBe(false)
      expect(JSON.parse(tl.result.content[0].text).tracks[0].items[0].id).toBe('v_1')

      const split = await rpc('tools/call', { name: 'split_at', arguments: { time: 4 } })
      expect(split.result.isError).toBe(false)
      expect(state.project.tracks.find((t) => t.main)!.items).toHaveLength(2)
      expect(state.changes).toEqual(['Split at 4s'])

      const bad = await rpc('tools/call', { name: 'trim_item', arguments: { itemId: 'nope', edge: 'end', time: 2 } })
      expect(bad.result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/No item with id nope/) }] })
      const unknown = await rpc('tools/call', { name: 'rm_rf', arguments: {} })
      expect(unknown.result.isError).toBe(true)
      const missing = await rpc('resources/list')
      expect(missing.error.code).toBe(-32601)
      expect(called).toEqual(['get_timeline', 'split_at', 'trim_item'])
    } finally {
      child.kill()
      await bridge.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the bridge rejects connections without the per-run token', async () => {
    const net = await import('node:net')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mcp-'))
    let calls = 0
    const bridge = await startToolBridge(dir, async () => {
      calls++
      return { content: 'x', isError: false }
    })
    const closed = await new Promise<boolean>((resolve) => {
      const s = net.connect(bridge.address, () => {
        s.write(JSON.stringify({ type: 'hello', token: 'wrong-token-wrong-token-' }) + '\n')
        s.write(JSON.stringify({ id: 1, name: 'split_at', input: {} }) + '\n')
      })
      s.on('close', () => resolve(true))
      s.on('error', () => resolve(true))
    })
    expect(closed).toBe(true)
    expect(calls).toBe(0)
    await bridge.close()
  })
})

describe('ClaudeCliProvider against a fake claude binary', () => {
  let log: string
  const prev = { ...process.env }
  beforeAll(async () => {
    await setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fakecli-'))
    log = path.join(dir, 'argv.jsonl')
    process.env.DESKTOP_SETTINGS_FILE = path.join(dir, 'settings.json')
    process.env.FAKE_CLAUDE_LOG = log
    process.env.CLAUDECODE = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'
    const { resetSettingsCache, saveSettings } = await import('../desktop/settings')
    resetSettingsCache()
    saveSettings({ claudePath: FAKE, claudeModel: 'sonnet' })
  })
  afterAll(async () => {
    process.env = prev
    const { resetSettingsCache } = await import('../desktop/settings')
    resetSettingsCache()
  })
  const runs = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: Record<string, string | null> })
      .filter((r) => r.argv[0] === '-p')

  it('status reports the signed-in account and version', async () => {
    const p = new ClaudeCliProvider()
    expect(await p.status()).toEqual({ available: true, detail: 'Signed in as tester@example.com · max plan · Claude Code 9.9.9', model: 'sonnet' })
  })

  it('write streams deltas with no tools, a temp cwd (removed afterwards) and a clean environment', async () => {
    const p = new ClaudeCliProvider()
    const deltas: string[] = []
    const text = await p.write({ kind: 'headline', prompt: 'A headline about clarity' }, (d) => deltas.push(d))
    expect(text).toBe('Bright ideas, clearly told.')
    expect(deltas).toEqual(['Bright ', 'ideas, ', 'clearly told.'])
    const r = runs().at(-1)!
    expect(r.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--include-partial-messages', '--model', 'sonnet']))
    expect(r.argv[r.argv.indexOf('--tools') + 1]).toBe('')
    expect(r.argv).not.toContain('--dangerously-skip-permissions')
    expect(r.env).toEqual({ CLAUDECODE: null, ANTHROPIC_API_KEY: null, CLAUDE_CODE_ENTRYPOINT: null })
    expect(path.basename(r.cwd)).toMatch(/^producer-claude-/)
    await new Promise((res) => setTimeout(res, 300))
    expect(fs.existsSync(r.cwd)).toBe(false)
  })

  it('structured passes --json-schema, allows only Read for image files and validates with zod', async () => {
    const p = new ClaudeCliProvider()
    process.env.FAKE_STRUCTURED = JSON.stringify({ message: 'ok' })
    const schema = z.object({ message: z.string(), _schemaKeys: z.array(z.string()), _images: z.number() })
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    const out = await p.structured({ system: 'sys', prompt: 'Write it', images: [{ label: 'Contact sheet for as_1:', mediaType: 'image/jpeg', data: jpg }], schema })
    expect(out).toEqual({ message: 'ok', _schemaKeys: ['message', '_schemaKeys', '_images'], _images: 1 })
    const r = runs().at(-1)!
    expect(JSON.parse(r.argv[r.argv.indexOf('--json-schema') + 1]).type).toBe('object')
    expect(r.argv[r.argv.indexOf('--tools') + 1]).toBe('Read')
    expect(r.argv[r.argv.indexOf('--allowedTools') + 1]).toBe('Read')
    expect(r.argv[r.argv.indexOf('--add-dir') + 1]).toBe(r.cwd)
    await expect(p.structured({ system: 's', prompt: 'p', images: [], schema: z.object({ nope: z.string() }) })).rejects.toMatchObject({ status: 502 })
  })

  it('assistant: MCP tools bridged into runAssistant produce the same result + events as the API provider', async () => {
    const p = new ClaudeCliProvider()
    const state = fixtureState()
    const text: string[] = []
    const tools: Array<[string, string]> = []
    const result = await runAssistant(p, { projectId: 'p1', project: state.project, playhead: 0, selection: [], messages: [{ role: 'user', text: 'Split at 4 and add a title' }] }, env, {
      text: (d) => text.push(d),
      tool: (n, s) => tools.push([n, s]),
    })
    expect(result.text).toBe('I split the clip and added a title.')
    expect(result.changes).toEqual(['Split at 4s', 'Added text "Hello from Claude" at 1s'])
    expect(result.project!.tracks.find((t) => t.main)!.items).toHaveLength(2)
    expect(result.project!.tracks.flatMap((t) => t.items).some((i) => i.type === 'text' && i.text === 'Hello from Claude')).toBe(true)
    expect(tools.map((t) => t[0])).toEqual(['get_timeline', 'split_at', 'add_text', 'delete_items'])
    expect(tools[3][1]).toMatch(/^Could not delete items/)
    expect(text.join('')).toBe('I split the clip and added a title.')
    const r = runs().at(-1)!
    expect(r.argv[r.argv.indexOf('--tools') + 1]).toBe('')
    const allowed = r.argv[r.argv.indexOf('--allowedTools') + 1].split(',')
    expect(allowed.every((a) => a.startsWith('mcp__producer__'))).toBe(true)
    expect(allowed).toContain('mcp__producer__split_at')
    expect(r.argv).not.toContain('--dangerously-skip-permissions')
    expect(r.argv).toContain('--strict-mcp-config')
  })

  it('a signed-out CLI surfaces 503 "Sign in to Claude" and status says not signed in', async () => {
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1'
    try {
      const p = new ClaudeCliProvider()
      const s = await p.status()
      expect(s.available).toBe(false)
      expect(s.detail).toMatch(/not signed in/)
      await expect(p.write({ kind: 'headline', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ status: 503 })
    } finally {
      delete process.env.FAKE_CLAUDE_LOGGED_OUT
    }
  })
})
