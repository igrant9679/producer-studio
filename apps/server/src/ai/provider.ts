// AI provider seam. Features (writer, Producer script, editor assistant) are written against ClaudeProvider;
// cloud uses the Anthropic API, desktop will use the local Claude Code CLI. Prompts, schemas and tool handlers
// stay provider-agnostic: tools are plain data (name, description, JSON Schema) validated with zod and executed
// by `runTool` in tools.ts, so a CLI provider can expose the very same tools over MCP.
import type * as z from 'zod/v4'
import type { WriteRequest } from '@producer/core'
import { ctx } from '../context'

export type ProviderId = 'anthropic-api' | 'claude-cli' | 'none'

export interface ProviderStatus {
  available: boolean
  detail: string
  model?: string
}

export interface ScriptImage {
  label: string
  mediaType: 'image/jpeg' | 'image/png'
  /** base64 */
  data: string
}

export interface StructuredRequest<T> {
  system: string
  prompt: string
  images: ScriptImage[]
  /** zod schema of the expected JSON (providers may convert with z.toJSONSchema). */
  schema: z.ZodType<T>
  signal?: AbortSignal
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema (draft-7) of the tool input. */
  inputSchema: Record<string, unknown>
}

export interface AgentRequest {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  tools: ToolSpec[]
  /** Execute a tool call (validation included); isError results go back to the model as tool errors. */
  runTool: (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>
  maxIterations: number
  onText: (delta: string) => void
  signal?: AbortSignal
}

export interface ClaudeProvider {
  readonly id: ProviderId
  status(): Promise<ProviderStatus>
  /** Short streamed completion (AI writer). Returns the full text. */
  write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string>
  /** Structured output (Producer script). Returns JSON already validated against `schema`. */
  structured<T>(req: StructuredRequest<T>): Promise<T>
  /** Tool-use loop (editor assistant). Returns the model's final text. */
  runAgent(req: AgentRequest): Promise<{ text: string }>
}

let cached: ClaudeProvider | undefined

export async function getProvider(): Promise<ClaudeProvider> {
  if (cached) return cached
  const id = ctx().config.aiProvider
  if (id === 'claude-cli') {
    const { ClaudeCliProvider } = await import('./cli')
    cached = new ClaudeCliProvider()
  } else if (id === 'anthropic-api') {
    const { AnthropicApiProvider } = await import('./anthropic')
    cached = new AnthropicApiProvider()
  } else {
    const { NoProvider } = await import('./cli')
    cached = new NoProvider()
  }
  return cached
}

/** Test hook. */
export function setProvider(p: ClaudeProvider | undefined) {
  cached = p
}

/** Throw 503 unless the configured provider is usable. */
export async function requireProvider(): Promise<ClaudeProvider> {
  const p = await getProvider()
  const s = await p.status()
  if (!s.available) {
    const { notConfigured } = await import('./claude')
    throw notConfigured()
  }
  return p
}
