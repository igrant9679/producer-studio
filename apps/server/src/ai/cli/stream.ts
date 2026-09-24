// Line-by-line parser for `claude -p --output-format stream-json --verbose [--include-partial-messages]`.
// Raw events are normalised into a small union the provider consumes.

export type CliEvent =
  | { kind: 'init'; model?: string; sessionId?: string; tools: string[]; mcpServers: Array<{ name: string; status: string }> }
  | { kind: 'text-delta'; messageId?: string; text: string }
  | { kind: 'message-start'; messageId?: string }
  | { kind: 'assistant'; messageId?: string; text: string; toolUses: Array<{ id: string; name: string; input: unknown }>; error?: string }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'result'; isError: boolean; subtype: string; text: string; structured?: unknown; numTurns?: number; costUsd?: number; durationMs?: number; terminalReason?: string }
  | { kind: 'other'; type: string }

type Raw = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && (b as Raw).type === 'text' ? str((b as Raw).text) : '')).join('')
  return content == null ? '' : JSON.stringify(content)
}

/** Normalise one parsed stream-json object. */
export function interpretEvent(ev: Raw): CliEvent[] {
  const type = str(ev.type)
  if (type === 'system' && ev.subtype === 'init') {
    const servers = Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as Raw[]).map((s) => ({ name: str(s.name), status: str(s.status) })) : []
    return [{ kind: 'init', model: str(ev.model) || undefined, sessionId: str(ev.session_id) || undefined, tools: Array.isArray(ev.tools) ? (ev.tools as unknown[]).map(String) : [], mcpServers: servers }]
  }
  if (type === 'stream_event') {
    const e = (ev.event ?? {}) as Raw
    if (e.type === 'message_start') return [{ kind: 'message-start', messageId: str((e.message as Raw | undefined)?.id) || undefined }]
    if (e.type === 'content_block_delta') {
      const d = (e.delta ?? {}) as Raw
      if (d.type === 'text_delta' && str(d.text)) return [{ kind: 'text-delta', text: str(d.text) }]
    }
    return [{ kind: 'other', type: `stream_event:${str(e.type)}` }]
  }
  if (type === 'assistant') {
    const msg = (ev.message ?? {}) as Raw
    const blocks = Array.isArray(msg.content) ? (msg.content as Raw[]) : []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text))
      .join('')
    const toolUses = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: str(b.id), name: str(b.name), input: b.input }))
    return [{ kind: 'assistant', messageId: str(msg.id) || undefined, text, toolUses, error: str(ev.error) || undefined }]
  }
  if (type === 'user') {
    const msg = (ev.message ?? {}) as Raw
    const blocks = Array.isArray(msg.content) ? (msg.content as Raw[]) : []
    return blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ kind: 'tool-result' as const, toolUseId: str(b.tool_use_id), content: contentText(b.content), isError: Boolean(b.is_error) }))
  }
  if (type === 'result') {
    return [
      {
        kind: 'result',
        isError: Boolean(ev.is_error),
        subtype: str(ev.subtype),
        text: str(ev.result),
        structured: ev.structured_output,
        numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
        terminalReason: str(ev.terminal_reason) || undefined,
      },
    ]
  }
  return [{ kind: 'other', type }]
}

/** Incremental parser: feed stdout chunks, get events for every complete JSON line. Non-JSON lines are returned as noise. */
export class StreamJsonParser {
  private buf = ''
  readonly noise: string[] = []

  push(chunk: string): CliEvent[] {
    this.buf += chunk
    const out: CliEvent[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      out.push(...this.line(line))
    }
    return out
  }

  end(): CliEvent[] {
    const rest = this.buf
    this.buf = ''
    return rest.trim() ? this.line(rest) : []
  }

  private line(line: string): CliEvent[] {
    const t = line.trim()
    if (!t) return []
    if (!t.startsWith('{')) {
      if (this.noise.length < 50) this.noise.push(t.slice(0, 500))
      return []
    }
    try {
      return interpretEvent(JSON.parse(t) as Raw)
    } catch {
      if (this.noise.length < 50) this.noise.push(t.slice(0, 500))
      return []
    }
  }
}

/**
 * Tracks text streaming across partial deltas and whole assistant messages so each piece of text is emitted once:
 * deltas stream as they arrive; an assistant message whose text was not streamed (no partial messages) is emitted whole.
 */
export class TextRelay {
  private streamedCurrent = false
  private startedCurrent = false
  private emitted = ''
  constructor(private onText: (delta: string) => void) {}

  handle(ev: CliEvent) {
    if (ev.kind === 'message-start') {
      this.streamedCurrent = false
      this.startedCurrent = false
    } else if (ev.kind === 'text-delta') {
      this.streamedCurrent = true
      this.emit(ev.text)
    } else if (ev.kind === 'assistant') {
      if (!this.streamedCurrent && ev.text && !ev.error) this.emit(ev.text)
      this.streamedCurrent = false
      this.startedCurrent = false
    }
  }

  private emit(t: string) {
    // separate text from consecutive assistant turns (before and after tool calls) with a newline
    if (!this.startedCurrent && this.emitted && !/\s$/.test(this.emitted)) {
      this.emitted += '\n'
      this.onText('\n')
    }
    this.startedCurrent = true
    this.emitted += t
    this.onText(t)
  }

  /** All text emitted so far. */
  get text() {
    return this.emitted
  }
}
