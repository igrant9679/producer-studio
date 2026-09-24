// Bring-your-own-key settings on cloud: key encryption at rest, masked responses (no key ever leaves the server),
// provider resolution order, and owner-only key management. Fake SDK clients, no network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import OpenAI from 'openai'
import { ApiError } from '@google/genai'
import { ctx } from '../context'
import { aiKeys, workspaceAiSettings } from '../db/schema'
import { setKeyClients } from '../ai/keys'
import { getProvider, requireProvider } from '../ai/provider'
import { resolveProvider } from '../ai/resolve'
import { openKey, resetSecretsKey, sealKey } from '../ai/secrets'
import { readKey } from '../ai/store'
import { type Client, setup, signup, type TestEnv } from './helpers'

const OPENAI_KEY = 'sk-proj-TESTKEY0123456789abcdefWXYZ'
const GEMINI_KEY = 'AIzaSyTESTKEY0123456789abcdefgh'
const BAD_KEY = 'sk-proj-INVALIDINVALIDINVALID9999'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
  setKeyClients({
    openai: (key) => ({
      responses: {
        async create() {
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'From OpenAI' } as never
            yield { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'From OpenAI' }] }] } } as never
          })()
        },
      },
      models: {
        async *list() {
          if (key === BAD_KEY) throw OpenAI.APIError.generate(401, { error: { message: `Incorrect API key provided: ${key}` } }, undefined, new Headers())
          yield* [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }, { id: 'text-embedding-3-small' }]
        },
      },
    }),
    gemini: (key) => ({
      models: {
        async generateContentStream() {
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'From Gemini' }] }, finishReason: 'STOP' }] } as never
          })()
        },
        async list() {
          if (key !== GEMINI_KEY) throw new ApiError({ status: 400, message: 'API key not valid. Please pass a valid API key.' })
          return (async function* () {
            yield* [{ name: 'models/gemini-3-pro', supportedActions: ['generateContent'] }, { name: 'models/gemini-3-flash', supportedActions: ['generateContent'] }]
          })()
        },
      },
    }),
  })
})
afterAll(() => setKeyClients(undefined))

const noKeys = (body: unknown) => {
  const s = JSON.stringify(body)
  expect(s).not.toContain(OPENAI_KEY)
  expect(s).not.toContain(GEMINI_KEY)
  expect(s).not.toContain(BAD_KEY)
  expect(s).not.toMatch(/ciphertext|"iv"|"tag"/)
}

async function invite(owner: { client: Client; workspaceId: string }, role: 'editor' | 'viewer') {
  const m = await signup(t.app, role)
  const inv = await owner.client.json('POST', `/api/workspaces/${owner.workspaceId}/invites`, { email: m.email, role })
  const token = inv.body.inviteUrl.split('/invite/')[1]
  expect((await m.client.json('POST', `/api/invites/${token}/accept`)).status).toBe(200)
  return m
}

describe('key encryption', () => {
  it('AES-256-GCM round-trip, bound to workspace + provider', () => {
    const s = sealKey(OPENAI_KEY, 'ai-key:ws_1:openai')
    expect(s.ciphertext).not.toContain('TESTKEY')
    expect(openKey(s, 'ai-key:ws_1:openai')).toBe(OPENAI_KEY)
    expect(openKey(s, 'ai-key:ws_2:openai')).toBeUndefined()
    expect(openKey({ ...s, tag: Buffer.alloc(16).toString('base64') }, 'ai-key:ws_1:openai')).toBeUndefined()
  })

  it('uses SECRETS_KEY when set (and rejects a wrong-length key)', () => {
    const prev = process.env.SECRETS_KEY
    try {
      process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
      resetSecretsKey()
      const s = sealKey('secret-value', 'a')
      process.env.SECRETS_KEY = Buffer.alloc(32, 8).toString('base64')
      expect(openKey(s, 'a')).toBeUndefined()
      process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
      expect(openKey(s, 'a')).toBe('secret-value')
      process.env.SECRETS_KEY = 'c2hvcnQ='
      expect(() => sealKey('x', 'a')).toThrow(/32 bytes/)
    } finally {
      if (prev === undefined) delete process.env.SECRETS_KEY
      else process.env.SECRETS_KEY = prev
      resetSecretsKey()
    }
  })
})

describe('AI settings API (cloud)', () => {
  it('stores a key encrypted, tests it, returns only hasKey/last4 and live models', async () => {
    const A = await signup(t.app, 'Owner')
    const put = await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: `  ${OPENAI_KEY} ` })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ ok: true, models: ['gpt-5.5', 'gpt-5.5-mini'], defaultModel: 'gpt-5.5', detail: '✓ valid · 2 models' })
    expect(put.body.settings.providers.openai).toMatchObject({ hasKey: true, keyLast4: 'WXYZ', model: 'gpt-5.5', valid: true })
    // the built-in provider (server key) isn't configured in tests → the first working key becomes the default
    expect(put.body.settings.defaultProvider).toBe('openai')
    expect(put.body.settings.effective.writer).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    noKeys(put.body)

    const row = (await ctx().db.select().from(aiKeys).where(and(eq(aiKeys.workspaceId, A.workspaceId), eq(aiKeys.provider, 'openai'))))[0]
    expect(row.ciphertext).not.toContain('TESTKEY')
    expect(row.last4).toBe('WXYZ')
    expect(await readKey(A.workspaceId, 'openai')).toBe(OPENAI_KEY)
    const doc = (await ctx().db.select().from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, A.workspaceId)))[0]
    noKeys(doc.doc)

    const get = await A.client.json('GET', `/api/ai/settings?workspaceId=${A.workspaceId}`)
    expect(get.body).toMatchObject({ canEdit: true, defaultProvider: 'openai', builtin: { id: 'anthropic-api', available: false } })
    noKeys(get.body)
    const test = await A.client.json('POST', '/api/ai/keys/openai/test', { workspaceId: A.workspaceId })
    expect(test.body).toMatchObject({ ok: true })
    noKeys(test.body)
    const sys = await A.client.json('GET', `/api/system?workspaceId=${A.workspaceId}`)
    expect(sys.body.ai).toMatchObject({ provider: 'openai', available: true, model: 'gpt-5.5' })
    noKeys(sys.body)
    // without the workspace (or for a non-member) /api/system reports the built-in provider
    expect((await A.client.json('GET', '/api/system')).body.ai.provider).toBe('anthropic-api')
    const X = await signup(t.app, 'Stranger')
    expect((await X.client.json('GET', `/api/system?workspaceId=${A.workspaceId}`)).body.ai.provider).toBe('anthropic-api')

    // the writer now streams from OpenAI for this user's personal workspace
    const res = await A.client.req('POST', '/api/ai/write', { kind: 'headline', prompt: 'x' })
    expect(await res.text()).toContain('From OpenAI')
  })

  it('an invalid key is stored masked with a clean error and is not made the default', async () => {
    const A = await signup(t.app, 'Owner2')
    const put = await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: BAD_KEY })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ ok: false, models: [], detail: 'The OpenAI API key was rejected. Check or replace it in Settings → AI.' })
    expect(put.body.settings.providers.openai).toMatchObject({ hasKey: true, keyLast4: '9999', valid: false })
    expect(put.body.settings.defaultProvider).toBeNull()
    noKeys(put.body)
    // explicitly chosen anyway: the chip says why it's unavailable and AI calls get that reason as a 503
    await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, defaultProvider: 'openai' })
    const sys = await A.client.json('GET', `/api/system?workspaceId=${A.workspaceId}`)
    expect(sys.body.ai).toMatchObject({ provider: 'openai', available: false, detail: /key was rejected/ })
    const w = await A.client.json('POST', '/api/ai/write', { kind: 'headline', prompt: 'x', workspaceId: A.workspaceId })
    expect(w).toMatchObject({ status: 503, body: { error: /OpenAI API key was rejected/ } })
    // a key given to /test is checked without being stored
    const t2 = await A.client.json('POST', '/api/ai/keys/gemini/test', { workspaceId: A.workspaceId, key: 'AIzaWRONGWRONGWRONG' })
    expect(t2.body).toMatchObject({ ok: false, detail: /Gemini API key was rejected/ })
    expect((await A.client.json('GET', `/api/ai/settings?workspaceId=${A.workspaceId}`)).body.providers.gemini).toBeUndefined()
    expect((await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: 'short' })).status).toBe(400)
    expect((await A.client.json('PUT', '/api/ai/keys/mistral', { workspaceId: A.workspaceId, key: OPENAI_KEY })).status).toBe(400)
  })

  it('resolution order: per-feature override → default → built-in → 503', async () => {
    const A = await signup(t.app, 'Resolver')
    const ws = A.workspaceId
    expect((await resolveProvider(ws, 'writer')).provider.id).toBe('anthropic-api')
    await expect(requireProvider(ws, 'writer')).rejects.toMatchObject({ status: 503, message: 'AI is not configured — add a key in Settings' })

    await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: ws, key: OPENAI_KEY })
    await A.client.json('PUT', '/api/ai/keys/gemini', { workspaceId: ws, key: GEMINI_KEY })
    // choosing a provider without a key is refused
    expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: ws, perFeature: { script: 'anthropic' } })).status).toBe(400)
    const set = await A.client.json('PUT', '/api/ai/settings', { workspaceId: ws, defaultProvider: 'gemini', perFeature: { writer: 'openai' }, models: { gemini: 'gemini-3-flash' } })
    expect(set.status).toBe(200)
    expect(set.body.effective).toEqual({ writer: { provider: 'openai', model: 'gpt-5.5' }, script: { provider: 'gemini', model: 'gemini-3-flash' }, assistant: { provider: 'gemini', model: 'gemini-3-flash' } })
    expect((await getProvider(ws, 'writer')).id).toBe('openai')
    expect((await getProvider(ws, 'assistant')).id).toBe('gemini')
    expect((await getProvider(ws)).id).toBe('gemini')
    expect((await resolveProvider(ws, 'writer')).source).toBe('feature')
    expect((await resolveProvider(ws, 'script')).source).toBe('default')
    // an override to the built-in provider wins over the default
    await A.client.json('PUT', '/api/ai/settings', { workspaceId: ws, perFeature: { assistant: 'builtin' } })
    expect((await getProvider(ws, 'assistant')).id).toBe('anthropic-api')
    // removing the default provider's key clears it and falls back to the built-in provider
    const del = await A.client.json('DELETE', `/api/ai/keys/gemini?workspaceId=${ws}`)
    expect(del.body.defaultProvider).toBeNull()
    expect(del.body.providers.gemini).toMatchObject({ hasKey: false, model: 'gemini-3-flash' })
    expect((await getProvider(ws, 'script')).id).toBe('anthropic-api')
    expect((await getProvider(ws, 'writer')).id).toBe('openai')
    // a changed model is picked up on the next request (provider cache keyed by model + key hash)
    await A.client.json('PUT', '/api/ai/settings', { workspaceId: ws, models: { openai: 'gpt-5.5-mini' } })
    expect((await (await getProvider(ws, 'writer')).status()).model).toBe('gpt-5.5-mini')
    expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: ws, models: { openai: 'bad model!' } })).status).toBe(400)
  })

  it('only owners manage keys and settings; editors and viewers read the masked settings', async () => {
    const A = await signup(t.app, 'Boss')
    await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: OPENAI_KEY })
    for (const role of ['editor', 'viewer'] as const) {
      const M = await invite(A, role)
      const g = await M.client.json('GET', `/api/ai/settings?workspaceId=${A.workspaceId}`)
      expect(g.status).toBe(200)
      expect(g.body).toMatchObject({ canEdit: false, providers: { openai: { hasKey: true, keyLast4: 'WXYZ' } } })
      noKeys(g.body)
      for (const [method, url, b] of [
        ['PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: OPENAI_KEY }],
        ['DELETE', `/api/ai/keys/openai?workspaceId=${A.workspaceId}`, undefined],
        ['POST', '/api/ai/keys/openai/test', { workspaceId: A.workspaceId }],
        ['PUT', '/api/ai/settings', { workspaceId: A.workspaceId, defaultProvider: null }],
      ] as const) {
        const r = await M.client.json(method, url, b)
        expect(r.status, `${role} ${method} ${url}`).toBe(403)
        expect(r.body.error).toBe('Only workspace owners can manage AI keys and settings')
      }
    }
    // non-members can't even see the settings
    const X = await signup(t.app, 'Outsider')
    expect((await X.client.json('GET', `/api/ai/settings?workspaceId=${A.workspaceId}`)).status).toBe(404)
    expect((await X.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: OPENAI_KEY })).status).toBe(404)
    expect((await A.client.json('GET', '/api/ai/settings')).status).toBe(400)
  })

  it('AI settings tables stay out of the sync change feed', async () => {
    const A = await signup(t.app, 'Syncer')
    await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: OPENAI_KEY })
    const ch = await A.client.json('GET', '/api/sync/changes?since=0')
    expect(ch.status).toBe(200)
    noKeys(ch.body)
    expect(JSON.stringify(ch.body)).not.toMatch(/keyLast4|defaultProvider/)
  })
})
