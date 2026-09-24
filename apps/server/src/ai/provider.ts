// AI provider seam. Features (writer, Producer script, editor assistant) are written against AiProvider:
//   anthropic-api  – the cloud server's own Anthropic credentials (ANTHROPIC_API_KEY …)
//   anthropic-key  – a workspace/user-supplied Anthropic API key
//   openai, gemini – user-supplied OpenAI / Google AI Studio keys
//   claude-cli     – the locally installed Claude Code CLI (desktop, the user's own subscription)
// Prompts, schemas and tool handlers stay provider-agnostic: tools are plain data (name, description, JSON Schema)
// validated with zod and executed by `runTool` in tools.ts, so every provider (and the CLI over MCP) exposes the very
// same tools. Which provider serves a request is resolved per scope + feature in resolve.ts.
import type * as z from 'zod/v4'
import type { AiFeature, AiProviderId, WriteRequest } from '@producer/core'

export type ProviderId = AiProviderId

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

export interface AiProvider {
  readonly id: ProviderId
  status(): Promise<ProviderStatus>
  /** Short streamed completion (AI writer). Returns the full text. */
  write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string>
  /** Structured output (Producer script). Returns JSON already validated against `schema`. */
  structured<T>(req: StructuredRequest<T>): Promise<T>
  /** Tool-use loop (editor assistant). Returns the model's final text. */
  runAgent(req: AgentRequest): Promise<{ text: string }>
}

/** @deprecated use AiProvider (kept so existing imports keep working). */
export type ClaudeProvider = AiProvider

/** Settings scope: a workspace id on cloud; ignored on desktop (one local scope). */
export type AiScope = string | undefined

export const LOCAL_SCOPE = 'local'

export type { AiFeature }

let override: AiProvider | undefined

/** Provider for a scope + feature (feature undefined = the default provider). */
export async function getProvider(scope?: AiScope, feature?: AiFeature): Promise<AiProvider> {
  if (override) return override
  const { resolveProvider } = await import('./resolve')
  return (await resolveProvider(scope, feature)).provider
}

/** Test hook: force one provider for every scope and feature (undefined restores resolution). */
export function setProvider(p: AiProvider | undefined) {
  override = p
}

/** Throw 503 unless the provider for this scope + feature is usable. */
export async function requireProvider(scope?: AiScope, feature?: AiFeature): Promise<AiProvider> {
  const p = await getProvider(scope, feature)
  const s = await p.status()
  if (!s.available) {
    const { HttpError } = await import('../http')
    const { notConfigured } = await import('./claude')
    // a chosen provider that isn't usable explains itself (e.g. "Claude isn't signed in"); nothing configured → the generic message
    throw p.id === 'none' || p.id === 'anthropic-api' ? notConfigured() : new HttpError(503, 'server', s.detail || notConfigured().message)
  }
  return p
}
