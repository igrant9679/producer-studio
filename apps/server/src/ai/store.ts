// Where AI provider settings and keys live.
//   cloud   — per workspace: `workspace_ai_settings` (non-secret JSON) + `ai_keys` (AES-256-GCM, SECRETS_KEY).
//   desktop — one local scope inside the desktop settings file; keys sealed with the OS-keystore-protected key
//             (Electron safeStorage → DESKTOP_SECRET_KEY, see desktop/secrets.ts). Local only, never synced.
// Plaintext keys only exist in memory while a provider is built or a key is tested.
import { and, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { AiChoice, AiFeature, AiKeyProvider, MediaKeyProvider, StoredKeyProvider, VideoClipProvider } from '@producer/core'
import { ctx } from '../context'
import { aiKeys, workspaceAiSettings } from '../db/schema'
import { invalid } from '../http'
import type { AiScope } from './provider'
import { openKey, sealKey } from './secrets'

export const KEY_PROVIDERS: AiKeyProvider[] = ['anthropic', 'gemini', 'openai']
/** Keys that only make media (never a writing provider): fal.ai for Wan clips. */
export const MEDIA_KEY_PROVIDERS: MediaKeyProvider[] = ['fal']
const STORED: StoredKeyProvider[] = [...KEY_PROVIDERS, ...MEDIA_KEY_PROVIDERS]
export const isMediaKey = (p: StoredKeyProvider): p is MediaKeyProvider => (MEDIA_KEY_PROVIDERS as string[]).includes(p)
export const FEATURES: AiFeature[] = ['writer', 'script', 'assistant', 'animation']

const Choice = z.enum(['builtin', 'openai', 'gemini', 'anthropic'])
const ProviderDocSchema = z.object({
  model: z.string().max(200).catch(''),
  models: z.array(z.string().max(200)).max(500).optional().catch(undefined),
  valid: z.boolean().optional().catch(undefined),
  error: z.string().max(500).optional().catch(undefined),
  checkedAt: z.number().optional().catch(undefined),
})
const MediaDocSchema = z.object({
  valid: z.boolean().optional().catch(undefined),
  error: z.string().max(500).optional().catch(undefined),
  price: z.string().max(200).optional().catch(undefined),
  checkedAt: z.number().optional().catch(undefined),
})
const DocSchema = z.object({
  defaultProvider: Choice.nullable().catch(null),
  perFeature: z.object({ writer: Choice.optional(), script: Choice.optional(), assistant: Choice.optional(), animation: Choice.optional() }).catch({}),
  providers: z.object({ openai: ProviderDocSchema.optional(), gemini: ProviderDocSchema.optional(), anthropic: ProviderDocSchema.optional() }).catch({}),
  media: z.object({ fal: MediaDocSchema.optional() }).catch({}).optional(),
  videoProvider: z.enum(['gemini', 'fal']).nullable().optional().catch(undefined),
  animationModel: z.string().max(200).nullable().optional().catch(undefined),
})

export type ProviderDoc = z.infer<typeof ProviderDocSchema>
export type MediaDoc = z.infer<typeof MediaDocSchema>
export interface AiSettingsDoc {
  defaultProvider: AiChoice | null
  perFeature: Partial<Record<AiFeature, AiChoice>>
  providers: Partial<Record<AiKeyProvider, ProviderDoc>>
  /** Media-only keys' last test (fal.ai). */
  media?: Partial<Record<MediaKeyProvider, MediaDoc>>
  /** Who makes AI clips when both a Gemini and a fal.ai key are stored (absent/null = automatic). */
  videoProvider?: VideoClipProvider | null
  /** The model AI-drawn scenes use on a key-backed provider (absent/null = the most capable on the key's list). */
  animationModel?: string | null
}
export interface KeyMeta {
  last4: string
  updatedAt: number
}

export const emptyDoc = (): AiSettingsDoc => ({ defaultProvider: null, perFeature: {}, providers: {} })

export function normalizeDoc(raw: unknown): AiSettingsDoc {
  const r = DocSchema.safeParse(raw ?? {})
  return r.success ? (r.data as AiSettingsDoc) : emptyDoc()
}

const desktop = () => ctx().config.mode === 'desktop'
const aad = (workspaceId: string, provider: StoredKeyProvider) => `ai-key:${workspaceId}:${provider}`

function requireScope(scope: AiScope): string {
  if (!scope) throw invalid('workspaceId is required')
  return scope
}

export async function loadDoc(scope: AiScope): Promise<AiSettingsDoc> {
  if (desktop()) {
    const { getAiStore } = await import('../desktop/settings')
    return normalizeDoc(getAiStore().doc)
  }
  if (!scope) return emptyDoc()
  const rows = await ctx().db.select({ doc: workspaceAiSettings.doc }).from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, scope)).limit(1)
  return normalizeDoc(rows[0]?.doc)
}

export async function saveDoc(scope: AiScope, doc: AiSettingsDoc): Promise<void> {
  const clean = normalizeDoc(doc)
  if (desktop()) {
    const { getAiStore, saveAiStore } = await import('../desktop/settings')
    saveAiStore({ ...getAiStore(), doc: clean as unknown as Record<string, unknown> })
    return
  }
  const ws = requireScope(scope)
  const now = Date.now()
  await ctx()
    .db.insert(workspaceAiSettings)
    .values({ workspaceId: ws, doc: clean as unknown as Record<string, unknown>, updatedAt: now })
    .onConflictDoUpdate({ target: workspaceAiSettings.workspaceId, set: { doc: clean as unknown as Record<string, unknown>, updatedAt: now } })
}

/** last4 + timestamp of each stored key (no secrets), media-only keys included. */
export async function keyMeta(scope: AiScope): Promise<Partial<Record<StoredKeyProvider, KeyMeta>>> {
  const out: Partial<Record<StoredKeyProvider, KeyMeta>> = {}
  if (desktop()) {
    const { getAiStore } = await import('../desktop/settings')
    for (const [p, k] of Object.entries(getAiStore().keys)) if (STORED.includes(p as StoredKeyProvider)) out[p as StoredKeyProvider] = { last4: k.last4, updatedAt: k.updatedAt }
    return out
  }
  if (!scope) return out
  const rows = await ctx().db.select({ provider: aiKeys.provider, last4: aiKeys.last4, updatedAt: aiKeys.updatedAt }).from(aiKeys).where(eq(aiKeys.workspaceId, scope))
  for (const r of rows) if (STORED.includes(r.provider as StoredKeyProvider)) out[r.provider as StoredKeyProvider] = { last4: r.last4, updatedAt: r.updatedAt }
  return out
}

/** Decrypted key, or undefined (none stored / undecryptable). Server-internal only. */
export async function readKey(scope: AiScope, provider: StoredKeyProvider): Promise<string | undefined> {
  if (desktop()) {
    const { getAiStore } = await import('../desktop/settings')
    const { unseal } = await import('../desktop/secrets')
    return unseal(getAiStore().keys[provider])
  }
  if (!scope) return undefined
  const rows = await ctx().db.select().from(aiKeys).where(and(eq(aiKeys.workspaceId, scope), eq(aiKeys.provider, provider))).limit(1)
  const r = rows[0]
  return r ? openKey({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag }, aad(scope, provider)) : undefined
}

export async function writeKey(scope: AiScope, provider: StoredKeyProvider, key: string): Promise<KeyMeta> {
  const meta = { last4: key.slice(-4), updatedAt: Date.now() }
  if (desktop()) {
    const { getAiStore, saveAiStore } = await import('../desktop/settings')
    const { seal } = await import('../desktop/secrets')
    const store = getAiStore()
    saveAiStore({ ...store, keys: { ...store.keys, [provider]: { ...seal(key), ...meta } } })
    return meta
  }
  const ws = requireScope(scope)
  const s = sealKey(key, aad(ws, provider))
  const row = { workspaceId: ws, provider, ...s, ...meta }
  await ctx()
    .db.insert(aiKeys)
    .values(row)
    .onConflictDoUpdate({ target: [aiKeys.workspaceId, aiKeys.provider], set: { ...s, ...meta } })
  return meta
}

export async function removeKey(scope: AiScope, provider: StoredKeyProvider): Promise<void> {
  if (desktop()) {
    const { getAiStore, saveAiStore } = await import('../desktop/settings')
    const store = getAiStore()
    const keys = { ...store.keys }
    delete keys[provider]
    saveAiStore({ ...store, keys })
    return
  }
  await ctx()
    .db.delete(aiKeys)
    .where(and(eq(aiKeys.workspaceId, requireScope(scope)), eq(aiKeys.provider, provider)))
}
