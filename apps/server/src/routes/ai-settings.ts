// Bring-your-own-key AI settings (mounted under /api/ai). Cloud: per workspace, owners edit, members read the masked
// settings. Desktop: one local scope (workspaceId ignored). Keys are write-only: no response ever contains one.
import { Hono, type Context } from 'hono'
import * as z from 'zod/v4'
import type { AiKeyProvider, AiKeyTestResult, Role } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { HttpError, body, invalid, requireRole } from '../http'
import { checkKeyShape, testKey } from '../ai/keys'
import { PROVIDER_LABEL } from '../ai/common'
import { builtinProvider, describeSettings } from '../ai/resolve'
import { type AiSettingsDoc, keyMeta, loadDoc, readKey, removeKey, saveDoc, writeKey } from '../ai/store'

export const aiSettingsRoutes = new Hono<AppEnv>()

const Provider = z.enum(['openai', 'gemini', 'anthropic'])
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

function providerParam(c: Context<AppEnv>): AiKeyProvider {
  const r = Provider.safeParse(c.req.param('provider'))
  if (!r.success) throw invalid('provider must be openai, gemini or anthropic')
  return r.data
}

/** Record a test result (non-secret) on the settings document. */
async function recordTest(scope: string, provider: AiKeyProvider, result: AiKeyTestResult, doc?: AiSettingsDoc): Promise<AiSettingsDoc> {
  const d = doc ?? (await loadDoc(scope))
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
      perFeature: z.object({ writer: Choice.nullable().optional(), script: Choice.nullable().optional(), assistant: Choice.nullable().optional() }).optional(),
      models: z.object({ openai: ModelId.optional(), gemini: ModelId.optional(), anthropic: ModelId.optional() }).optional(),
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
  await writeKey(scope, provider, key)
  const result = await testKey(provider, key)
  const doc = await recordTest(scope, provider, result)
  // first working key while the built-in provider isn't usable: make it the default so AI works right away
  if (result.ok && !doc.defaultProvider && !(await (await builtinProvider()).status()).available) doc.defaultProvider = provider
  await saveDoc(scope, doc)
  return c.json({ ...result, settings: await describeSettings(scope, canEdit) } satisfies AiKeyTestResult)
})

aiSettingsRoutes.delete('/keys/:provider', async (c) => {
  const provider = providerParam(c)
  const { scope, canEdit } = await ownerOnly(c, c.req.query('workspaceId') || undefined)
  await removeKey(scope, provider)
  const doc = await loadDoc(scope)
  if (doc.defaultProvider === provider) doc.defaultProvider = null
  for (const f of Object.keys(doc.perFeature) as Array<keyof AiSettingsDoc['perFeature']>) if (doc.perFeature[f] === provider) delete doc.perFeature[f]
  const prev = doc.providers[provider]
  if (prev) doc.providers[provider] = { model: prev.model }
  await saveDoc(scope, doc)
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
  return c.json({ ...result, settings: await describeSettings(scope, canEdit) } satisfies AiKeyTestResult)
})
