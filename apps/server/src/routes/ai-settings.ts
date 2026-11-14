// Bring-your-own-key AI settings (mounted under /api/ai). Cloud: per workspace, owners edit, members read the masked
// settings. Desktop: one local scope (workspaceId ignored). Keys are write-only: no response ever contains one.
// Cloud: an owner of two spaces can share a key of one with the other (ai/shares.ts); only owners can, and only
// between spaces they own.
import { Hono, type Context } from 'hono'
import * as z from 'zod/v4'
import type { AiKeyProvider, AiKeyTestResult, Role, StoredKeyProvider } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { audit } from '../services/audit'
import { ctx } from '../context'
import { HttpError, body, invalid, memberRole, notFound, requireRole } from '../http'
import { checkKeyShape, testKey } from '../ai/keys'
import { PROVIDER_LABEL } from '../ai/common'
import { builtinProvider, describeSettings } from '../ai/resolve'
import { MAX_KEY_SHARES, endSharesOf, forgetProvider, mirrorTest, seedRecipient, shareKey, sharedWith, spaceNames, unshareKey } from '../ai/shares'
import { type AiSettingsDoc, isMediaKey, keyMeta, loadDoc, readKey, removeKey, saveDoc, writeKey } from '../ai/store'

export const aiSettingsRoutes = new Hono<AppEnv>()

const Provider = z.enum(['openai', 'gemini', 'anthropic', 'fal', 'runpod'])
const Choice = z.enum(['builtin', 'openai', 'gemini', 'anthropic'])
const ModelId = z
  .string()
  .trim()
  .max(200)
  .regex(/^[\w.:/@-]*$/, 'model ids may only contain letters, digits and . : / @ - _')

async function access(c: Context<AppEnv>, workspaceId: string | undefined, min: Role): Promise<{ scope: string; canEdit: boolean }> {
  const u = requireUser(c)
  if (ctx().config.mode === 'desktop') return { scope: 'local', canEdit: true }
  if (!workspaceId) throw invalid('workspaceId is required')
  const role = await requireRole(u.id, workspaceId, min)
  return { scope: workspaceId, canEdit: role === 'owner' }
}

const ownerOnly = (c: Context<AppEnv>, workspaceId: string | undefined) =>
  access(c, workspaceId, 'owner').catch((err) => {
    if (err instanceof HttpError && err.status === 403) throw new HttpError(403, 'forbidden', 'Only workspace owners can manage AI keys and settings')
    throw err
  })

const cloud = () => ctx().config.mode !== 'desktop'

/** One audit entry in each space: the one whose key it is (direction out) and the one that uses it (in). */
async function auditShare(c: Context<AppEnv>, kind: 'ai.key.shared' | 'ai.key.unshared', from: string, to: string, provider: StoredKeyProvider): Promise<void> {
  const names = await spaceNames([from, to])
  const quoted = (id: string) => (names[id] ? `“${names[id]}”` : 'another space')
  await audit(c, { kind, workspaceId: from, targetId: to, target: quoted(to), data: { provider, direction: 'out' } })
  await audit(c, { kind, workspaceId: to, targetId: from, target: quoted(from), data: { provider, direction: 'in' } })
}

function providerParam(c: Context<AppEnv>): StoredKeyProvider {
  const r = Provider.safeParse(c.req.param('provider'))
  if (!r.success) throw invalid('provider must be openai, gemini, anthropic, fal or runpod')
  return r.data
}

/** Record a test result (non-secret) on the settings document. */
async function recordTest(scope: string, provider: StoredKeyProvider, result: AiKeyTestResult, doc?: AiSettingsDoc): Promise<AiSettingsDoc> {
  const d = doc ?? (await loadDoc(scope))
  if (isMediaKey(provider)) {
    const prev = d.media?.[provider]
    d.media = {
      ...d.media,
      [provider]: { valid: result.ok, error: result.ok ? undefined : result.detail.slice(0, 500), price: result.ok ? result.price : prev?.price, checkedAt: Date.now() },
    }
    return d
  }
  const prev = d.providers[provider]
  d.providers[provider] = {
    model: prev?.model || (result.ok ? (result.defaultModel ?? '') : ''),
    models: result.ok ? result.models : prev?.models,
    valid: result.ok,
    error: result.ok ? undefined : result.detail.slice(0, 500),
    checkedAt: Date.now(),
  }
  return d
}

aiSettingsRoutes.get('/settings', async (c) => {
  const { scope, canEdit } = await access(c, c.req.query('workspaceId') || undefined, 'viewer')
  return c.json(await describeSettings(scope, canEdit))
})

aiSettingsRoutes.put('/settings', async (c) => {
  const b = await body(
    c,
    z.object({
      workspaceId: z.string().max(100).optional(),
      defaultProvider: Choice.nullable().optional(),
      perFeature: z.object({ writer: Choice.nullable().optional(), script: Choice.nullable().optional(), assistant: Choice.nullable().optional(), animation: Choice.nullable().optional() }).optional(),
      models: z.object({ openai: ModelId.optional(), gemini: ModelId.optional(), anthropic: ModelId.optional() }).optional(),
      videoProvider: z.enum(['gemini', 'fal']).nullable().optional(),
      animationModel: ModelId.nullable().optional(),
    }),
  )
  const { scope, canEdit } = await ownerOnly(c, b.workspaceId)
  const doc = await loadDoc(scope)
  const stored = new Set(Object.keys(await keyMeta(scope)))
  const usable = (choice: string) => {
    if (choice !== 'builtin' && !stored.has(choice)) throw invalid(`Add a ${PROVIDER_LABEL[choice as AiKeyProvider]} key before choosing it`)
  }
  if (b.defaultProvider !== undefined) {
    if (b.defaultProvider) usable(b.defaultProvider)
    doc.defaultProvider = b.defaultProvider
  }
  for (const [f, v] of Object.entries(b.perFeature ?? {}) as Array<[keyof AiSettingsDoc['perFeature'], string | null | undefined]>) {
    if (v === undefined) continue
    if (v === null) delete doc.perFeature[f]
    else {
      usable(v)
      doc.perFeature[f] = v as AiSettingsDoc['perFeature'][typeof f]
    }
  }
  if (b.videoProvider !== undefined) {
    if (b.videoProvider) usable(b.videoProvider)
    doc.videoProvider = b.videoProvider
  }
  if (b.animationModel !== undefined) doc.animationModel = b.animationModel?.trim() || null
  for (const [p, m] of Object.entries(b.models ?? {}) as Array<[AiKeyProvider, string | undefined]>) {
    if (m === undefined) continue
    doc.providers[p] = { ...(doc.providers[p] ?? {}), model: m }
  }
  await saveDoc(scope, doc)
  return c.json(await describeSettings(scope, canEdit))
})

aiSettingsRoutes.put('/keys/:provider', async (c) => {
  const provider = providerParam(c)
  const b = await body(c, z.object({ workspaceId: z.string().max(100).optional(), key: z.string().max(1000) }))
  const { scope, canEdit } = await ownerOnly(c, b.workspaceId)
  const key = checkKeyShape(provider, b.key)
  // a key of its own replaces one another space shared with this one (writeKey drops the pointer)
  const lentBy = cloud() ? (await keyMeta(scope))[provider]?.sharedFrom : undefined
  await writeKey(scope, provider, key)
  await audit(c, { kind: 'ai.key.set', workspaceId: b.workspaceId ?? null, target: provider, data: { provider, last4: key.slice(-4) } })
  if (lentBy) await auditShare(c, 'ai.key.unshared', lentBy, scope, provider)
  const result = await testKey(provider, key)
  const doc = await recordTest(scope, provider, result)
  // first working key while the built-in provider isn't usable: make it the default so AI works right away
  // (a media key makes clips only: it is never a writing provider)
  if (result.ok && !isMediaKey(provider) && !doc.defaultProvider && !(await (await builtinProvider()).status()).available) doc.defaultProvider = provider
  await saveDoc(scope, doc)
  if (cloud()) await mirrorTest(scope, provider)
  return c.json({ ...result, settings: await describeSettings(scope, canEdit) } satisfies AiKeyTestResult)
})

aiSettingsRoutes.delete('/keys/:provider', async (c) => {
  const provider = providerParam(c)
  const { scope, canEdit } = await ownerOnly(c, c.req.query('workspaceId') || undefined)
  const lentBy = cloud() ? (await keyMeta(scope))[provider]?.sharedFrom : undefined
  if (lentBy) {
    // the key is another space's: this space stops using it, the key itself stays where it is
    await unshareKey(scope, provider)
    await auditShare(c, 'ai.key.unshared', lentBy, scope, provider)
  } else {
    await removeKey(scope, provider)
    await audit(c, { kind: 'ai.key.removed', workspaceId: c.req.query('workspaceId') || null, target: provider, data: { provider } })
    // the spaces it was shared with lose it too
    if (cloud())
      for (const to of await endSharesOf(scope, provider)) {
        await saveDoc(to, forgetProvider(await loadDoc(to), provider))
        await auditShare(c, 'ai.key.unshared', scope, to, provider)
      }
  }
  await saveDoc(scope, forgetProvider(await loadDoc(scope), provider))
  return c.json(await describeSettings(scope, canEdit))
})

// ---- sharing a key with another space (cloud) ----

/** The sharing space (the caller must be an owner of it). The desktop edition has one local scope: nothing to share with. */
async function sharingSpace(c: Context<AppEnv>, workspaceId: string | undefined) {
  if (!cloud()) throw notFound()
  return ownerOnly(c, workspaceId)
}

aiSettingsRoutes.put('/keys/:provider/shares/:to', async (c) => {
  const provider = providerParam(c)
  const b = await body(c, z.object({ workspaceId: z.string().max(100) }))
  const { scope, canEdit } = await sharingSpace(c, b.workspaceId)
  const to = c.req.param('to')
  if (to === scope) throw invalid('A space can’t share a key with itself')
  // only with a space the caller also owns: its people will send their work through this key's account
  const role = await memberRole(requireUser(c).id, to)
  if (!role) throw notFound('No such space')
  if (role !== 'owner') throw new HttpError(403, 'forbidden', 'You can only share a key with a space you own')
  const label = PROVIDER_LABEL[provider]
  const mine = (await keyMeta(scope))[provider]
  if (!mine) throw new HttpError(409, 'conflict', `Add a ${label} key to this space before sharing it`)
  if (mine.sharedFrom) throw new HttpError(409, 'conflict', `This space uses a ${label} key shared by another space, so it can’t pass it on. Share it from the space the key belongs to.`)
  const theirs = (await keyMeta(to))[provider]
  const names = await spaceNames([to])
  if (theirs && !theirs.sharedFrom) throw new HttpError(409, 'conflict', `“${names[to] ?? 'That space'}” has its own ${label} key. Remove it there first.`)
  if (theirs?.sharedFrom !== scope) {
    if ((await sharedWith(scope)).filter((s) => s.provider === provider).length >= MAX_KEY_SHARES) throw new HttpError(409, 'conflict', `A key can be shared with at most ${MAX_KEY_SHARES} spaces`)
    await shareKey(scope, to, provider, requireUser(c).id)
    await seedRecipient(scope, to, provider, (await (await builtinProvider()).status()).available)
    await auditShare(c, 'ai.key.shared', scope, to, provider)
  }
  return c.json(await describeSettings(scope, canEdit))
})

aiSettingsRoutes.delete('/keys/:provider/shares/:to', async (c) => {
  const provider = providerParam(c)
  const { scope, canEdit } = await sharingSpace(c, c.req.query('workspaceId') || undefined)
  const to = c.req.param('to')
  if (!(await sharedWith(scope)).some((s) => s.provider === provider && s.workspaceId === to)) throw notFound('That key isn’t shared with that space')
  await unshareKey(to, provider)
  await saveDoc(to, forgetProvider(await loadDoc(to), provider))
  await auditShare(c, 'ai.key.unshared', scope, to, provider)
  return c.json(await describeSettings(scope, canEdit))
})

aiSettingsRoutes.post('/keys/:provider/test', async (c) => {
  const provider = providerParam(c)
  const b = await body(c, z.object({ workspaceId: z.string().max(100).optional(), key: z.string().max(1000).optional() }))
  const { scope, canEdit } = await ownerOnly(c, b.workspaceId)
  if (b.key) return c.json(await testKey(provider, checkKeyShape(provider, b.key)))
  const stored = await readKey(scope, provider)
  if (!stored) throw new HttpError(404, 'not_found', `No ${PROVIDER_LABEL[provider]} key is stored`)
  const result = await testKey(provider, stored)
  await saveDoc(scope, await recordTest(scope, provider, result))
  // this space's own key: the spaces it is shared with see the same result (a shared key's test stays here)
  if (cloud() && !(await keyMeta(scope))[provider]?.sharedFrom) await mirrorTest(scope, provider)
  return c.json({ ...result, settings: await describeSettings(scope, canEdit) } satisfies AiKeyTestResult)
})
