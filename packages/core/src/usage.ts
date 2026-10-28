// Usage, limits and the queue as people see them (P-1, A-18, A-9, and the job history from A-8).
// GET  /api/usage?workspaceId=&days=        -> UsageSummary (members of the space; owners also see per-member rows)
// PUT  /api/usage/builtin-ai {workspaceId, enabled}  -> {enabled}  (owners: use the server's own AI key in this space)
// GET  /api/jobs/queue?workspaceId=         -> {jobs: Record<jobId, QueueInfo>}  (the space's queued jobs)
// GET  /api/jobs/history?workspaceId=&status=done|error|cancelled&cursor=  -> Page<Job> (finished jobs, newest first)
// POST /api/jobs/:id/retry                  -> Job  (editors: the same work queued again)
import type { AiProviderId, JobKind } from './api'

/** Why a queued job hasn't started yet. */
export type QueueReason =
  /** Every slot that could run it is busy with other jobs. */
  | 'lane-full'
  /** Other spaces with fewer running jobs go first (fair share). */
  | 'fair-share'
  /** A cloned or designed voice: the desktop that holds it does the work. */
  | 'desktop'
  /** Older jobs in the same lane go first. */
  | 'behind'
  /** Nothing in the way: a worker picks it up within seconds. */
  | 'next'

export interface QueueInfo {
  /** 1 = next in its lane. */
  position: number
  /** Estimated wait in ms from how long recent jobs of the same kinds took, or null when there's too little to go on. */
  waitMs: number | null
  reason: QueueReason
  /** The reason in words. */
  detail: string
}

/** USD per million tokens, input and output. An estimate from published list prices; not a bill. */
export interface TokenRate {
  input: number
  output: number
}

/** Longest matching model prefix wins; the provider's own row is the fallback for a model not listed. */
const RATES: Array<[provider: string, modelPrefix: string, rate: TokenRate]> = [
  ['anthropic', 'claude-opus-5-5', { input: 4, output: 20 }],
  ['anthropic', 'claude-opus', { input: 5, output: 25 }],
  ['anthropic', 'claude-sonnet-5', { input: 2, output: 10 }],
  ['anthropic', 'claude-sonnet', { input: 3, output: 15 }],
  ['anthropic', 'claude-haiku-5', { input: 0.1, output: 0.5 }],
  ['anthropic', 'claude-haiku', { input: 1, output: 5 }],
  ['anthropic', 'claude-fable', { input: 10, output: 50 }],
  ['anthropic', '', { input: 5, output: 25 }],
  ['openai', 'gpt-5', { input: 1.25, output: 10 }],
  ['openai', '', { input: 2.5, output: 10 }],
  ['gemini', 'gemini-2.5-flash', { input: 0.3, output: 2.5 }],
  ['gemini', '', { input: 1.25, output: 10 }],
]

/** Which rate family a provider id belongs to (the server's key and a space's own Anthropic key cost the same). */
export function rateFamily(provider: AiProviderId | string): string {
  if (provider === 'anthropic-api' || provider === 'anthropic-key' || provider === 'claude-cli') return 'anthropic'
  return provider
}

export function tokenRate(provider: AiProviderId | string, model = ''): TokenRate | undefined {
  const fam = rateFamily(provider)
  let best: [string, TokenRate] | undefined
  for (const [p, prefix, rate] of RATES) if (p === fam && model.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, rate]
  return best?.[1]
}

/** Estimated USD for these tokens; 0 for a provider with no rate (the Claude CLI runs on the person's own plan). */
export function estimateCost(provider: AiProviderId | string, model: string, inputTokens: number, outputTokens: number): number {
  if (provider === 'claude-cli' || provider === 'none') return 0
  const r = tokenRate(provider, model)
  return r ? (inputTokens * r.input + outputTokens * r.output) / 1_000_000 : 0
}

export interface UsageLimitView {
  /** What the limit counts, in words ("AI requests today"). */
  label: string
  used: number
  /** 0 = no limit. */
  limit: number
  unit: 'requests' | 'tokens' | 'minutes' | 'bytes' | 'jobs'
}

export interface UsageSummary {
  workspaceId: string
  /** The period the totals cover (epoch ms), and how many days. */
  from: number
  to: number
  days: number
  ai: {
    providers: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; estCostUsd: number }>
    requests: number
    inputTokens: number
    outputTokens: number
    estCostUsd: number
    /** Costs are estimates from list prices in code (packages/core/src/usage.ts), not the provider's bill. */
    estimate: true
  }
  jobs: { minutes: number; byKind: Array<{ kind: JobKind | string; minutes: number; runs: number }> }
  storage: { bytes: number; files: number; byKind: Array<{ kind: string; bytes: number; files: number }> }
  /** Every space this person belongs to, with its storage. */
  spaces: Array<{ id: string; name: string; bytes: number }>
  /** Owners only: who used what in this period. */
  members?: Array<{ userId: string; name: string; aiRequests: number; tokens: number; jobMinutes: number }>
  limits: UsageLimitView[]
  builtinAi: {
    /** This space may use the server's own AI key. */
    enabled: boolean
    /** The server has a built-in AI provider at all. */
    available: boolean
    /** Owners can turn it on or off. */
    canChange: boolean
  }
}
