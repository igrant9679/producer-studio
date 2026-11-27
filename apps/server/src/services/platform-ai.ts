// Which shared key serves the spaces that chose no AI provider (owner, 27 Nov 2026: "a platform setting chooses the
// default provider for workspaces with no AI choice or key"): the server's Claude (ANTHROPIC_API_KEY, the default) or
// OpenRouter (OPENROUTER_API_KEY). An operator switches it under Operator → AI; it stays on Claude until the owner does,
// once the shared OpenRouter key is in. Either way it is the server's AI: members only (resolve.ts builtinFor).
// Cloud only; the desktop's own AI is the Claude CLI.
import type { PlatformAiProvider, PlatformAiSettings } from '@producer/core'
import { eq } from 'drizzle-orm'
import { ctx } from '../context'
import { platformSettings } from '../db/schema'
import { invalid } from '../http'

const KEY = 'ai'
const TTL_MS = 30_000

interface Stored {
  defaultProvider: PlatformAiProvider
  /** The model the shared OpenRouter key runs for a space that picked none ('' = the newest Claude Sonnet). */
  openrouterModel?: string
}

let cache: { at: number; value: Stored & { updatedAt?: number } } | undefined

/** The platform's AI choice (read through a 30-second cache; changing it clears the cache). */
export async function platformAi(): Promise<Stored & { updatedAt?: number }> {
  if (ctx().config.mode !== 'cloud') return { defaultProvider: 'anthropic' }
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const [row] = await ctx().db.select().from(platformSettings).where(eq(platformSettings.key, KEY)).limit(1)
  const v = (row?.value ?? {}) as Partial<Stored>
  const value = {
    defaultProvider: v.defaultProvider === 'openrouter' ? ('openrouter' as const) : ('anthropic' as const),
    ...(typeof v.openrouterModel === 'string' && v.openrouterModel ? { openrouterModel: v.openrouterModel } : {}),
    ...(row ? { updatedAt: row.updatedAt } : {}),
  }
  cache = { at: Date.now(), value }
  return value
}

/** The settings as the Operator page shows them (whether each shared key is set, never the keys). */
export async function platformAiView(): Promise<PlatformAiSettings> {
  const p = await platformAi()
  const { aiConfigured } = await import('../ai/claude')
  const { defaultOpenRouterModel, openRouterModels } = await import('../ai/openrouter')
  const model = p.openrouterModel || defaultOpenRouterModel(await openRouterModels().catch(() => []))
  return {
    defaultProvider: p.defaultProvider,
    openrouterKey: Boolean(ctx().config.openrouterKey),
    anthropicKey: ctx().config.aiProvider === 'anthropic-api' && aiConfigured(),
    openrouterModel: model,
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  }
}

/** Change it (an operator). OpenRouter can't become the default before its shared key is set on the server. */
export async function setPlatformAi(next: { defaultProvider?: PlatformAiProvider; openrouterModel?: string | null }, by: string): Promise<void> {
  const cur = await platformAi()
  const value: Stored = {
    defaultProvider: next.defaultProvider ?? cur.defaultProvider,
    ...(next.openrouterModel === null ? {} : next.openrouterModel !== undefined ? { openrouterModel: next.openrouterModel.trim() } : cur.openrouterModel ? { openrouterModel: cur.openrouterModel } : {}),
  }
  if (value.defaultProvider === 'openrouter' && !ctx().config.openrouterKey)
    throw invalid('Set OPENROUTER_API_KEY on the server (Railway → Variables) before making OpenRouter the default.')
  const now = Date.now()
  await ctx()
    .db.insert(platformSettings)
    .values({ key: KEY, value: value as unknown as Record<string, unknown>, updatedBy: by, updatedAt: now })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: value as unknown as Record<string, unknown>, updatedBy: by, updatedAt: now } })
  cache = undefined
}

/** Test hook: forget the cached setting. */
export function forgetPlatformAi() {
  cache = undefined
}
