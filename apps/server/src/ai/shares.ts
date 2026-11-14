// Sharing a space's AI keys with other spaces (cloud only). An owner of both spaces lets the other space use this
// space's stored key, a writing key or a media key, without ever seeing it. The share is a pointer (`ai_key_shares`),
// never a copy: replacing the key reaches every space that uses it, and removing the key or the share ends their use
// at once. The receiving space keeps its own choices (model, default provider); its use is metered as its own and
// billed by the provider to the key's account. A shared key is not passed on, and a space's own key always wins.
import { and, eq, inArray } from 'drizzle-orm'
import type { AiKeyProvider, StoredKeyProvider } from '@producer/core'
import { ctx } from '../context'
import { aiKeyShares, workspaces } from '../db/schema'
import { type AiSettingsDoc, isMediaKey, loadDoc, saveDoc } from './store'

export interface KeyShare {
  provider: StoredKeyProvider
  workspaceId: string
  name: string
}

/** The most spaces one key is shared with. */
export const MAX_KEY_SHARES = 50

/** Spaces this space's keys are shared with. */
export async function sharedWith(from: string): Promise<KeyShare[]> {
  const rows = await ctx()
    .db.select({ provider: aiKeyShares.provider, workspaceId: aiKeyShares.toWorkspaceId, name: workspaces.name })
    .from(aiKeyShares)
    .innerJoin(workspaces, eq(workspaces.id, aiKeyShares.toWorkspaceId))
    .where(eq(aiKeyShares.fromWorkspaceId, from))
    .orderBy(workspaces.name)
  return rows as KeyShare[]
}

/** The spaces whose keys are shared with this one. */
export async function sharedFrom(to: string): Promise<KeyShare[]> {
  const rows = await ctx()
    .db.select({ provider: aiKeyShares.provider, workspaceId: aiKeyShares.fromWorkspaceId, name: workspaces.name })
    .from(aiKeyShares)
    .innerJoin(workspaces, eq(workspaces.id, aiKeyShares.fromWorkspaceId))
    .where(eq(aiKeyShares.toWorkspaceId, to))
  return rows as KeyShare[]
}

export async function spaceNames(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  const rows = await ctx().db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids))
  return Object.fromEntries(rows.map((r) => [r.id, r.name]))
}

/** Point `to` at `from`'s key (replaces a share of the same provider from another space). */
export async function shareKey(from: string, to: string, provider: StoredKeyProvider, by: string): Promise<void> {
  const row = { toWorkspaceId: to, provider, fromWorkspaceId: from, createdBy: by, createdAt: Date.now() }
  await ctx()
    .db.insert(aiKeyShares)
    .values(row)
    .onConflictDoUpdate({ target: [aiKeyShares.toWorkspaceId, aiKeyShares.provider], set: { fromWorkspaceId: from, createdBy: by, createdAt: row.createdAt } })
}

/** End the share `to` uses for this provider. Returns the space it came from, if there was one. */
export async function unshareKey(to: string, provider: StoredKeyProvider): Promise<string | undefined> {
  const gone = await ctx()
    .db.delete(aiKeyShares)
    .where(and(eq(aiKeyShares.toWorkspaceId, to), eq(aiKeyShares.provider, provider)))
    .returning({ from: aiKeyShares.fromWorkspaceId })
  return gone[0]?.from
}

/** A key is going away: end every share of it. Returns the spaces that used it. */
export async function endSharesOf(from: string, provider: StoredKeyProvider): Promise<string[]> {
  const gone = await ctx()
    .db.delete(aiKeyShares)
    .where(and(eq(aiKeyShares.fromWorkspaceId, from), eq(aiKeyShares.provider, provider)))
    .returning({ to: aiKeyShares.toWorkspaceId })
  return gone.map((g) => g.to)
}

/** A space no longer has this provider's key: its choices stop pointing at it (the model it picked is kept). */
export function forgetProvider(doc: AiSettingsDoc, provider: StoredKeyProvider): AiSettingsDoc {
  if (doc.videoProvider === provider) doc.videoProvider = null
  if (isMediaKey(provider)) {
    if (doc.media) delete doc.media[provider]
    return doc
  }
  if (doc.defaultProvider === provider) doc.defaultProvider = null
  for (const f of Object.keys(doc.perFeature) as Array<keyof AiSettingsDoc['perFeature']>) if (doc.perFeature[f] === provider) delete doc.perFeature[f]
  const prev = doc.providers[provider]
  if (prev) doc.providers[provider] = { model: prev.model }
  return doc
}

/** The key's last test, as the sharing space recorded it, on a receiving space's settings (its own model is kept). */
function copyTest(src: AiSettingsDoc, dst: AiSettingsDoc, provider: StoredKeyProvider): void {
  if (isMediaKey(provider)) {
    const m = src.media?.[provider]
    dst.media = { ...dst.media, [provider]: m ? { ...m } : {} }
    return
  }
  const s = src.providers[provider]
  dst.providers[provider] = { model: dst.providers[provider]?.model || s?.model || '', models: s?.models, valid: s?.valid, error: s?.error, checkedAt: s?.checkedAt }
}

/**
 * A share was just made: the receiving space gets the key's model list and last test, and, when it has no AI at all
 * yet (no default and no usable built-in provider), the shared writing key becomes its default so AI works right away.
 */
export async function seedRecipient(from: string, to: string, provider: StoredKeyProvider, builtinAvailable: boolean): Promise<void> {
  const [src, dst] = await Promise.all([loadDoc(from), loadDoc(to)])
  copyTest(src, dst, provider)
  if (!isMediaKey(provider) && !dst.defaultProvider && !builtinAvailable && src.providers[provider as AiKeyProvider]?.valid !== false) dst.defaultProvider = provider as AiKeyProvider
  await saveDoc(to, dst)
}

/** The sharing space's key was saved or tested again: every space that uses it sees the same result. */
export async function mirrorTest(from: string, provider: StoredKeyProvider): Promise<void> {
  const tos = (await sharedWith(from)).filter((s) => s.provider === provider)
  if (!tos.length) return
  const src = await loadDoc(from)
  for (const s of tos) {
    const dst = await loadDoc(s.workspaceId)
    copyTest(src, dst, provider)
    await saveDoc(s.workspaceId, dst)
  }
}
