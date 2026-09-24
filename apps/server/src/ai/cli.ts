// ClaudeProvider over the locally installed Claude Code CLI (desktop edition: the user's own Claude subscription).
// Every run: `claude -p` with the prompt on stdin, `--output-format stream-json --verbose`, no session persistence,
// `--strict-mcp-config` (ignore the user's MCP servers), built-in tools disabled unless a feature needs one, a
// per-run temp working dir that is removed afterwards, and an environment stripped of anything that would point the
// CLI at another session or an API key. Never `--dangerously-skip-permissions`.
//   write()      – no tools; token streaming via --include-partial-messages.
//   structured() – --json-schema derived from the zod schema; contact sheets written into the run dir and readable
//                  with the Read tool only (--tools Read --allowedTools Read --add-dir <run>).
//   runAgent()   – a local stdio MCP server (scripts/mcp-server.mjs) exposes the same tools as the API provider;
//                  each tools/call is bridged back into this process and run through req.runTool, so project
//                  state, tool events and services (transcribe/TTS) are identical to the API provider.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WriteRequest } from '@producer/core'
import { SERVER_ROOT } from '../config'
import { HttpError } from '../http'
import { log } from '../log'
import { getSettings } from '../desktop/settings'
import { notConfigured, writeRequestParams } from './claude'
import { startToolBridge } from './cli/bridge'
import { type AuthStatus, type ClaudeInstall, authStatus, binaryInfo, findClaude } from './cli/detect'
import { type ClaudeRunResult, runClaude } from './cli/run'
import { extractJson, jsonSchemaOf } from './cli/schema'
import { TextRelay } from './cli/stream'
import type { AgentRequest, ClaudeProvider, ProviderStatus, StructuredRequest } from './provider'

const MCP_NAME = 'producer'
const TIMEOUT = { write: 3 * 60_000, structured: 10 * 60_000, agent: 10 * 60_000 }
const STATUS_TTL_MS = 30_000

export function mcpServerScript(): string {
  return process.env.PRODUCER_MCP_SCRIPT || path.join(SERVER_ROOT, 'scripts', 'mcp-server.mjs')
}

interface Probe {
  at: number
  cfgPath: string
  install: ClaudeInstall | null
  version?: string
  flags?: Set<string>
  auth?: AuthStatus
  error?: string
}

function describe(p: Probe): ProviderStatus {
  const model = getSettings().claudeModel || undefined
  if (!p.install) return { available: false, detail: 'Claude Code CLI not found. Install Claude Code, or set its path in Settings → AI.', model }
  const ver = p.version && p.version !== 'unknown' ? `Claude Code ${p.version}` : 'Claude Code'
  if (p.error) return { available: false, detail: `${ver} at ${p.install.path} could not be started: ${p.error}`, model }
  if (!p.auth?.loggedIn) return { available: false, detail: `${ver} is installed but not signed in. Use “Sign in to Claude”.`, model }
  const who = [p.auth.email, p.auth.subscriptionType ? `${p.auth.subscriptionType} plan` : undefined].filter(Boolean).join(' · ')
  return { available: true, detail: `Signed in${who ? ` as ${who}` : ''} · ${ver}`, model }
}

/** Map a failed run to an API error. */
export function cliFailure(r: Pick<ClaudeRunResult, 'result' | 'assistantError' | 'stderr' | 'code' | 'timedOut' | 'noise'>, what: string): HttpError {
  const text = `${r.result?.text ?? ''} ${r.assistantError ?? ''} ${r.stderr} ${r.noise.join(' ')}`
  if (r.timedOut) return new HttpError(504, 'server', `Claude took too long to ${what}.`)
  if (/authentication_failed|not logged in|\/login|oauth (session|token)|invalid api key|failed to authenticate/i.test(text))
    return new HttpError(503, 'server', 'Claude isn’t signed in on this computer. Open Settings → AI and choose “Sign in to Claude”.')
  if (/rate_limit|usage limit|rate limit|overloaded|529/i.test(text)) return new HttpError(429, 'quota', 'Your Claude plan’s usage limit was reached or Claude is busy. Try again in a moment.')
  if (r.result?.subtype === 'error_max_turns') return new HttpError(502, 'server', `Claude ran out of steps while trying to ${what}.`)
  const detail = (r.result?.text || r.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `exit code ${r.code}`).slice(0, 400)
  return new HttpError(502, 'server', `Claude couldn’t ${what}: ${detail}`)
}

export class ClaudeCliProvider implements ClaudeProvider {
  readonly id = 'claude-cli' as const
  private probe?: Probe
  private probing?: Promise<Probe>

  /** Forget the cached probe (after sign-in, a settings change, or an auth failure). */
  invalidate() {
    this.probe = undefined
  }

  private async getProbe(): Promise<Probe> {
    const cfgPath = getSettings().claudePath
    if (this.probe && Date.now() - this.probe.at < STATUS_TTL_MS && this.probe.cfgPath === cfgPath) return this.probe
    this.probing ??= (async () => {
      const install = await findClaude(cfgPath)
      const p: Probe = { at: Date.now(), cfgPath, install }
      if (install) {
        try {
          const info = await binaryInfo(install.path)
          p.version = info.version
          p.flags = info.flags
          p.auth = await authStatus(install.path)
        } catch (err) {
          p.error = err instanceof Error ? err.message : String(err)
        }
      }
      this.probe = p
      return p
    })().finally(() => {
      this.probing = undefined
    })
    return this.probing
  }

  async status(): Promise<ProviderStatus> {
    return describe(await this.getProbe())
  }

  /** Resolved binary + flags, or a 503 when the CLI can't be used. */
  private async ready(): Promise<{ bin: string; flags: Set<string> }> {
    const p = await this.getProbe()
    const s = describe(p)
    if (!p.install) throw new HttpError(503, 'server', s.detail)
    if (!s.available) throw new HttpError(503, 'server', /not signed in/.test(s.detail) ? 'Claude isn’t signed in on this computer. Open Settings → AI and choose “Sign in to Claude”.' : s.detail)
    return { bin: p.install.path, flags: p.flags ?? new Set() }
  }

  private baseArgs(flags: Set<string>, systemFile: string): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    for (const f of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) if (flags.has(f)) args.push(f)
    if (flags.has('--permission-prompts')) args.push('--permission-prompts', 'none')
    args.push('--system-prompt-file', systemFile)
    const model = getSettings().claudeModel.trim()
    if (model) args.push('--model', model)
    return args
  }

  private async withRunDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-claude-'))
    try {
      return await fn(dir)
    } finally {
      fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => undefined)
    }
  }

  private check(r: ClaudeRunResult, what: string): NonNullable<ClaudeRunResult['result']> {
    if (r.result && !r.result.isError && !r.assistantError) return r.result
    const err = cliFailure(r, what)
    if (err.status === 503) this.invalidate()
    log.warn('claude cli run failed', { what, code: r.code, subtype: r.result?.subtype, error: r.assistantError, stderr: r.stderr.slice(-500) })
    throw err
  }

  async write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const { bin, flags } = await this.ready()
    const params = writeRequestParams(req.kind, req.prompt, req.context, req.maxWords)
    return this.withRunDir(async (dir) => {
      const sys = path.join(dir, 'system.md')
      fs.writeFileSync(sys, params.system)
      const args = [...this.baseArgs(flags, sys), '--tools', '', '--max-turns', '1']
      if (flags.has('--include-partial-messages')) args.push('--include-partial-messages')
      const relay = new TextRelay(onDelta)
      const r = await runClaude({ bin, args, cwd: dir, prompt: params.messages[0].content, signal, timeoutMs: TIMEOUT.write, onEvent: (ev) => relay.handle(ev) })
      const res = this.check(r, 'write this')
      return (res.text || relay.text).trim()
    })
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { bin, flags } = await this.ready()
    if (!flags.has('--json-schema')) throw new HttpError(503, 'server', 'This version of Claude Code is too old for structured output. Update Claude Code and try again.')
    return this.withRunDir(async (dir) => {
      const sys = path.join(dir, 'system.md')
      fs.writeFileSync(sys, req.system)
      const files: string[] = []
      req.images.forEach((img, i) => {
        const f = path.join(dir, `image-${String(i + 1).padStart(2, '0')}.${img.mediaType === 'image/png' ? 'png' : 'jpg'}`)
        fs.writeFileSync(f, Buffer.from(img.data, 'base64'))
        files.push(`- ${img.label} ${f}`)
      })
      const prompt = files.length
        ? `${req.prompt}\n\nReference images (open each one with the Read tool before answering):\n${files.join('\n')}\n\nReturn your answer as the structured output.`
        : `${req.prompt}\n\nReturn your answer as the structured output.`
      const args = [...this.baseArgs(flags, sys), '--json-schema', JSON.stringify(jsonSchemaOf(req.schema))]
      if (files.length) args.push('--tools', 'Read', '--allowedTools', 'Read', '--add-dir', dir, '--max-turns', String(files.length + 4))
      else args.push('--tools', '', '--max-turns', '3')
      const r = await runClaude({
        bin,
        args,
        cwd: dir,
        prompt,
        signal: req.signal,
        timeoutMs: TIMEOUT.structured,
        onEvent: (ev) => {
          if (ev.kind === 'init') log.info('claude init', { model: ev.model, tools: ev.tools })
          if (ev.kind === 'assistant' && ev.toolUses.length) log.info('claude tool_use', { names: ev.toolUses.map((t) => t.name), files: ev.toolUses.map((t) => (t.input as { file_path?: string })?.file_path).filter(Boolean) })
        },
      })
      const res = this.check(r, 'complete this request')
      const raw = res.structured ?? extractJson(res.text)
      const parsed = req.schema.safeParse(raw)
      if (!parsed.success) throw new HttpError(502, 'server', 'The AI response did not match the expected format')
      return parsed.data
    })
  }

  async runAgent(req: AgentRequest): Promise<{ text: string }> {
    const { bin, flags } = await this.ready()
    return this.withRunDir(async (dir) => {
      const sys = path.join(dir, 'system.md')
      fs.writeFileSync(sys, `${req.system}\n\nYour tools are provided by the "${MCP_NAME}" MCP server (named mcp__${MCP_NAME}__<tool>); they are the only tools available.`)
      const toolsFile = path.join(dir, 'tools.json')
      fs.writeFileSync(toolsFile, JSON.stringify(req.tools))
      const bridge = await startToolBridge(dir, req.runTool)
      try {
        const env: Record<string, string> = { PRODUCER_MCP_TOOLS: toolsFile, PRODUCER_MCP_BRIDGE: bridge.address, PRODUCER_MCP_TOKEN: bridge.token, PRODUCER_MCP_NAME: MCP_NAME }
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
        const mcpConfig = path.join(dir, 'mcp.json')
        fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'stdio', command: process.execPath, args: [mcpServerScript()], env } } }, null, 2))
        const allowed = req.tools.map((t) => `mcp__${MCP_NAME}__${t.name}`).join(',')
        const args = [...this.baseArgs(flags, sys), '--mcp-config', mcpConfig, '--tools', '', '--allowedTools', allowed, '--max-turns', String(req.maxIterations * 2 + 2)]
        if (flags.has('--include-partial-messages')) args.push('--include-partial-messages')
        const relay = new TextRelay(req.onText)
        const r = await runClaude({
          bin,
          args,
          cwd: dir,
          prompt: renderConversation(req.messages),
          signal: req.signal,
          timeoutMs: TIMEOUT.agent,
          env: { MCP_TIMEOUT: '30000', MCP_TOOL_TIMEOUT: '600000' },
          onEvent: (ev) => {
            relay.handle(ev)
            if (ev.kind === 'assistant' && ev.toolUses.length) {
              const names = ev.toolUses.map((t) => t.name)
              // only our MCP tools are allowed; anything else would be denied by the CLI, but make it visible
              if (names.some((n) => !n.startsWith(`mcp__${MCP_NAME}__`))) log.warn('claude attempted a non-producer tool', { names })
              else log.info('claude tool_use', { names })
            }
            if (ev.kind === 'init') {
              log.info('claude init', { model: ev.model, tools: ev.tools, mcp: ev.mcpServers })
              const s = ev.mcpServers.find((m) => m.name === MCP_NAME)
              if (s && s.status !== 'connected') log.warn('producer mcp server not connected', { status: s.status })
            }
          },
        })
        if (r.result?.subtype === 'error_max_turns' && !r.assistantError) {
          return { text: `${relay.text}${relay.text ? '\n' : ''}I stopped after the maximum number of steps; the changes so far are applied.` }
        }
        const res = this.check(r, 'finish the edit')
        return { text: res.text || relay.text }
      } finally {
        await bridge.close()
      }
    })
  }
}

/** Fold the chat history into one prompt (the CLI runs one stateless turn per request). */
export function renderConversation(messages: AgentRequest['messages']): string {
  const turns = messages.filter((m) => m.text.trim())
  if (turns.length <= 1) return turns[0]?.text ?? ''
  const last = turns[turns.length - 1]
  const earlier = turns
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.trim()}`)
    .join('\n\n')
  return `Conversation so far:\n\n${earlier}\n\nThe user's new request:\n\n${last.text}`
}

export class NoProvider implements ClaudeProvider {
  readonly id = 'none' as const
  async status(): Promise<ProviderStatus> {
    return { available: false, detail: 'AI is disabled on this server' }
  }
  async write(): Promise<string> {
    throw notConfigured()
  }
  async structured<T>(): Promise<T> {
    throw notConfigured()
  }
  async runAgent(): Promise<{ text: string }> {
    throw notConfigured()
  }
}
