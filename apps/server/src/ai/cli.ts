// Placeholder providers. The desktop agent will implement ClaudeCliProvider (local Claude Code CLI, tools exposed
// over MCP from tools.ts: toolSpecs() + runTool()). Until then it reports available:false and every call is 503.
import type { WriteRequest } from '@producer/core'
import { notConfigured } from './claude'
import type { AgentRequest, ClaudeProvider, ProviderStatus, StructuredRequest } from './provider'

export class ClaudeCliProvider implements ClaudeProvider {
  readonly id = 'claude-cli' as const
  async status(): Promise<ProviderStatus> {
    return { available: false, detail: 'Claude Code CLI provider is not implemented yet' }
  }
  async write(_req: WriteRequest): Promise<string> {
    throw notConfigured()
  }
  async structured<T>(_req: StructuredRequest<T>): Promise<T> {
    throw notConfigured()
  }
  async runAgent(_req: AgentRequest): Promise<{ text: string }> {
    throw notConfigured()
  }
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
