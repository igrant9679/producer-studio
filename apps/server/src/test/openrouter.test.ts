// OpenRouter as an AI provider (owner, 27 Nov 2026; the spec all four apps share): a space's own key first, else the
// server's shared key as the server's AI (members only); text only; models from OpenRouter's live list, only the ones
// that answer in shape offered; metered with the cost OpenRouter reports; OpenRouter's own message on errors; and a
// platform setting that can make it the server's AI for spaces that chose none.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/v4'
import { ctx } from '../context'
import { getProvider } from '../ai/provider'
import { answersInShape, defaultOpenRouterModel, openRouterError, openRouterModels, OpenRouterProvider, setOpenRouterFetch, toModel } from '../ai/openrouter'
import { builtinProvider, resolveProvider } from '../ai/resolve'
import { setBuiltinAi, withActor } from '../services/metering'
import { forgetPlatformAi, platformAi, setPlatformAi } from '../services/platform-ai'
import { setup, signup, type TestEnv } from './helpers'

const SHARED = 'sk-or-v1-shared-0000000000000000'
const OWN = 'sk-or-v1-own-1111111111111111'

const RAW = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 1790000000, context_length: 1000000, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format', 'structured_outputs', 'reasoning'], top_provider: { max_completion_tokens: 64000 } },
  { id: 'anthropic/claude-sonnet-5.5:batch', name: 'batch', created: 1790000001, pricing: { prompt: '0.000001', completion: '0.000005' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', created: 1780000000, pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
  { id: 'anthropic/claude-fable-5.2', name: 'Anthropic: Claude Fable 5.2', created: 1795000000, pricing: { prompt: '0.000008', completion: '0.00004' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format'] },
  { id: 'some/plain-chat', name: 'Plain chat', created: 1796000000, pricing: { prompt: '0.0000001', completion: '0.0000002' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['temperature'] },
  { id: 'openrouter/auto', name: 'Auto', created: 1797000000, pricing: { prompt: '-1', completion: '-1' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
  { id: 'some/image-maker', name: 'Pictures', created: 1798000000, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] }, supported_parameters: [] },
]

/** One recorded call to the fake OpenRouter. */
interface Call {
  url: string
  method: string
  auth?: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

let calls: Call[] = []
/** What /chat/completions answers next (one entry per call; the last one repeats). */
let replies: Array<{ status?: number; body?: unknown; sse?: unknown[]; retryAfter?: string }> = []
let keyStatus = 200

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + ': OPENROUTER PROCESSING\n\ndata: [DONE]\n\n'
const text = (s: string, usage = { prompt_tokens: 120, completion_tokens: 30, cost: 0.00054 }) => [
  { choices: [{ delta: { content: s.slice(0, 5) } }] },
  { choices: [{ delta: { content: s.slice(5) }, finish_reason: 'stop' }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
]

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const h = (init?.headers ?? {}) as Record<string, string>
  const call: Call = { url, method: init?.method ?? 'GET', auth: h.authorization, headers: h, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined }
  calls.push(call)
  if (url.endsWith('/models')) return Promise.resolve(Response.json({ data: RAW }))
  if (url.endsWith('/key')) {
    if (keyStatus !== 200) return Promise.resolve(Response.json({ error: { code: keyStatus, message: 'No auth credentials found' } }, { status: keyStatus }))
    return Promise.resolve(Response.json({ data: { label: 'sk-or-v1-own…', limit: 20, limit_remaining: 12.5, usage: 7.5, is_free_tier: false } }))
  }
  const r = replies.length > 1 ? replies.shift()! : replies[0]
  if (r.status && r.status !== 200) return Promise.resolve(Response.json(r.body ?? { error: { code: r.status, message: 'nope' } }, { status: r.status, headers: r.retryAfter ? { 'retry-after': r.retryAfter } : {} }))
  return Promise.resolve(new Response(sse(r.sse ?? text('Hello there')), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
}

let t: TestEnv
beforeAll(async () => {
  t = await setup()
  setOpenRouterFetch(fakeFetch, { noWait: true })
})
afterAll(() => {
  setOpenRouterFetch(undefined)
  ctx().config.openrouterKey = undefined
  forgetPlatformAi()
})
afterEach(() => {
  calls = []
  replies = [{}]
  keyStatus = 200
  ctx().config.openrouterKey = undefined
})

describe('the model list', () => {
  it('keeps text models with their prices per million tokens, newest first; batch, per-request routers and picture models go', async () => {
    const models = await openRouterModels({ refresh: true })
    expect(models.map((m) => m.id)).toEqual(['some/plain-chat', 'anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5'])
    expect(models.find((m) => m.id === 'anthropic/claude-sonnet-5.5')).toMatchObject({ promptPerM: 2, completionPerM: 10, tools: true, structured: true, vision: true, reasoning: true, maxOutput: 64000, contextLength: 1000000 })
    // read once, then from the cache for three hours
    const before = calls.length
    await openRouterModels()
    expect(calls.length).toBe(before)
  })

  it('offers only models that answer in shape (tools or a JSON schema); the default is the newest Claude Sonnet that takes tools', async () => {
    const models = await openRouterModels({ refresh: true })
    expect(models.filter(answersInShape).map((m) => m.id)).toEqual(['anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5'])
    expect(defaultOpenRouterModel(models)).toBe('anthropic/claude-sonnet-5.5')
    expect(toModel({ id: 'x/y', architecture: { output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] })).toMatchObject({ tools: false, structured: true })
    // a list that can't be read: the default still names a model
    expect(defaultOpenRouterModel([])).toBe('anthropic/claude-sonnet-5.5')
  })

  it('GET /api/ai/openrouter/models gives the list and the default', async () => {
    const a = await signup(t.app, 'Model Lister')
    const r = await a.client.json<{ models: Array<{ id: string }>; defaultModel: string }>('GET', '/api/ai/openrouter/models')
    expect(r.status).toBe(200)
    expect(r.body.defaultModel).toBe('anthropic/claude-sonnet-5.5')
    expect(r.body.models.length).toBe(4)
  })
})

describe('which key runs it', () => {
  it('a space’s own key first; without one the server’s shared key, as the server’s AI (members only); with neither, the next choice', async () => {
    const a = await signup(t.app, 'Key Order')
    const ws = a.workspaceId
    // no key anywhere: choosing OpenRouter is refused
    expect((await a.client.json('PUT', '/api/ai/settings', { workspaceId: ws, defaultProvider: 'openrouter' })).status).toBe(400)

    // the server has a shared key: the space may choose OpenRouter without one of its own
    ctx().config.openrouterKey = SHARED
    expect((await a.client.json('PUT', '/api/ai/settings', { workspaceId: ws, defaultProvider: 'openrouter' })).status).toBe(200)
    // …but it is the server's AI: off until the space may use it
    let r = await resolveProvider(ws)
    expect(r.provider.id).toBe('openrouter-api')
    expect((await r.provider.status()).available).toBe(false)
    await expect(withActor(undefined, () => r.provider.write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined))).rejects.toThrow(/doesn’t use the server’s AI/)
    await setBuiltinAi(ws, true, 'test')
    r = await resolveProvider(ws)
    expect((await r.provider.status()).available).toBe(true)
    expect(await (await getProvider(ws)).write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)).toBe('Hello there')
    expect(calls.filter((c) => c.url.endsWith('/chat/completions')).map((c) => c.auth)).toEqual([`Bearer ${SHARED}`])

    // the space's own key wins
    calls = []
    const saved = await a.client.json<{ ok: boolean; detail: string; models: string[] }>('PUT', '/api/ai/keys/openrouter', { workspaceId: ws, key: OWN })
    expect(saved.status).toBe(200)
    expect(saved.body.ok).toBe(true)
    expect(saved.body.detail).toBe('✓ valid · $12.50 left on its limit · 3 models')
    expect(saved.body.models).toEqual(['anthropic/claude-fable-5.2', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5'])
    r = await resolveProvider(ws)
    expect(r.provider.id).toBe('openrouter')
    expect((r.provider as OpenRouterProvider).model).toBe('anthropic/claude-sonnet-5.5')
    calls = []
    await (await getProvider(ws)).write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)
    expect(calls.find((c) => c.url.endsWith('/chat/completions'))?.auth).toBe(`Bearer ${OWN}`)

    // the settings say so, never the keys
    const s = await a.client.json<Record<string, unknown>>('GET', `/api/ai/settings?workspaceId=${ws}`)
    expect(JSON.stringify(s.body)).not.toContain(OWN)
    expect(JSON.stringify(s.body)).not.toContain(SHARED)
    expect(s.body.openrouterShared).toMatchObject({ available: true })
  })

  it('a wrong key is reported with OpenRouter’s own reason and isn’t used', async () => {
    const a = await signup(t.app, 'Wrong Key')
    keyStatus = 401
    const saved = await a.client.json<{ ok: boolean; detail: string }>('PUT', '/api/ai/keys/openrouter', { workspaceId: a.workspaceId, key: OWN })
    expect(saved.body.ok).toBe(false)
    expect(saved.body.detail).toMatch(/OpenRouter rejected the key: it’s wrong or was revoked \(OpenRouter: “No auth credentials found”\)/)
  })

  it('the operator can make OpenRouter the server’s AI for spaces that chose none, only once its key is set', async () => {
    await expect(setPlatformAi({ defaultProvider: 'openrouter' }, 'op')).rejects.toThrow(/Set OPENROUTER_API_KEY/)
    expect((await builtinProvider()).id).not.toBe('openrouter-api')
    ctx().config.openrouterKey = SHARED
    await setPlatformAi({ defaultProvider: 'openrouter', openrouterModel: 'anthropic/claude-fable-5.2' }, 'op')
    expect(await platformAi()).toMatchObject({ defaultProvider: 'openrouter', openrouterModel: 'anthropic/claude-fable-5.2' })
    const b = await builtinProvider()
    expect(b.id).toBe('openrouter-api')
    expect((b as OpenRouterProvider).model).toBe('anthropic/claude-fable-5.2')
    // still the server's AI: a space that hasn't turned it on can't use it
    const a = await signup(t.app, 'Platform Default')
    expect((await (await resolveProvider(a.workspaceId)).provider.status()).available).toBe(false)
    // back to today's default
    await setPlatformAi({ defaultProvider: 'anthropic', openrouterModel: null }, 'op')
    expect((await builtinProvider()).id).not.toBe('openrouter-api')
  })
})

describe('calls, usage and errors', () => {
  const own = () => new OpenRouterProvider({ apiKey: OWN, model: 'anthropic/claude-sonnet-5.5' })

  it('meters every call: the request, its tokens and the dollars OpenRouter reported, shown on the Usage page', async () => {
    const a = await signup(t.app, 'Metered')
    const ws = a.workspaceId
    await a.client.json('PUT', '/api/ai/keys/openrouter', { workspaceId: ws, key: OWN })
    await a.client.json('PUT', '/api/ai/settings', { workspaceId: ws, defaultProvider: 'openrouter' })
    // costs unlike the list-price estimate (0.006 for these tokens), so the reported dollars are what shows
    replies = [{ sse: text('First answer', { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0123 }) }, { sse: text('Second answer', { prompt_tokens: 500, completion_tokens: 100, cost: 0.0045 }) }]
    const p = await getProvider(ws)
    await withActor(undefined, () => p.write({ kind: 'freeform', prompt: 'one' } as never, () => undefined))
    await withActor(undefined, () => p.write({ kind: 'freeform', prompt: 'two' } as never, () => undefined))
    const u = await a.client.json<{ ai: { providers: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; estCostUsd: number }> } }>('GET', `/api/usage?workspaceId=${ws}`)
    const row = u.body.ai.providers.find((x) => x.provider === 'openrouter')!
    expect(row).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', requests: 2, inputTokens: 1500, outputTokens: 300 })
    expect(row.estCostUsd).toBeCloseTo(0.0168, 6)
  })

  it('sends the app’s name and address for attribution, never a person’s', async () => {
    ctx().config.publicUrl = 'https://producerstudio.app'
    try {
      await own().write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)
    } finally {
      ctx().config.publicUrl = undefined
    }
    const c = calls.find((x) => x.url.endsWith('/chat/completions'))!
    expect(c.headers['X-OpenRouter-Title']).toBe('Producer Studio')
    expect(c.headers['HTTP-Referer']).toBe('https://producerstudio.app')
    expect(c.body).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', stream: true })
  })

  it('a rate limit or an outage before the answer starts is tried again; then OpenRouter’s own message', async () => {
    replies = [{ status: 429, retryAfter: '1' }, { status: 502 }, { sse: text('Got there') }]
    expect(await own().write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)).toBe('Got there')
    expect(calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(3)
    replies = [{ status: 429, body: { error: { code: 429, message: 'Rate limit exceeded' } } }]
    await expect(own().write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)).rejects.toThrow(/OpenRouter is limiting how fast this key can be used \(OpenRouter: “Rate limit exceeded”\)/)
  })

  it('says what each failure means, for a space’s key and for the server’s', async () => {
    expect(openRouterError(401, 'User not found').message).toMatch(/rejected the key: it’s wrong or was revoked/)
    expect(openRouterError(401, 'User not found', { shared: true }).message).toMatch(/The server’s OpenRouter key was rejected/)
    expect(openRouterError(402, 'Insufficient credits').message).toMatch(/This OpenRouter key is out of credit \(OpenRouter: “Insufficient credits”\)\. Add credit/)
    expect(openRouterError(402, 'Insufficient credits', { shared: true }).message).toMatch(/The server’s OpenRouter key is out of credit.*Add your own key/)
    expect(openRouterError(404, 'No endpoints found', { model: 'x/y' }).message).toMatch(/no way to run “x\/y”/)
    expect(openRouterError(503, 'No provider').status).toBe(502)
    // a key in a message never comes back
    expect(openRouterError(400, `bad key ${OWN}`).message).not.toContain(OWN)
    // a failure after the answer started (the status stays 200)
    replies = [{ sse: [{ choices: [{ delta: { content: 'Hal' } }] }, { error: { code: 402, message: 'Insufficient credits' }, choices: [{ delta: {}, finish_reason: 'error' }] }] }]
    await expect(own().write({ kind: 'freeform', prompt: 'hi' } as never, () => undefined)).rejects.toThrow(/out of credit/)
  })

  it('structured answers: a JSON schema to a model that takes one; asked in words when the model turns it down; repaired once', async () => {
    await openRouterModels({ refresh: true })
    const schema = z.object({ title: z.string(), scenes: z.number() })
    replies = [{ sse: text('{"title":"Boat","scenes":3}') }]
    expect(await own().structured({ system: 'Write.', prompt: 'A film', images: [], schema, effort: 'medium' })).toEqual({ title: 'Boat', scenes: 3 })
    let body = calls.filter((c) => c.url.endsWith('/chat/completions')).at(-1)!.body!
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'output' } })
    expect(body.provider).toEqual({ require_parameters: true })
    expect(body.reasoning).toEqual({ effort: 'medium' })
    // a model whose endpoints turn the schema down: asked again with it in words
    calls = []
    replies = [{ status: 400, body: { error: { code: 400, message: 'response_format is not supported' } } }, { sse: text('Here: {"title":"Boat","scenes":2}') }]
    expect(await own().structured({ system: 'Write.', prompt: 'A film', images: [], schema })).toEqual({ title: 'Boat', scenes: 2 })
    body = calls.filter((c) => c.url.endsWith('/chat/completions')).at(-1)!.body!
    expect(body.response_format).toBeUndefined()
    expect(String((body.messages as Array<{ content: string }>)[0].content)).toMatch(/matches this JSON Schema/)
    // a wrong shape: one repair turn
    calls = []
    replies = [{ sse: text('{"title":"Boat"}') }, { sse: text('{"title":"Boat","scenes":4}') }]
    expect(await own().structured({ system: 'Write.', prompt: 'A film', images: [], schema })).toEqual({ title: 'Boat', scenes: 4 })
    expect(calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(2)
  })

  it('the assistant’s tools: a streamed tool call runs, its result goes back, the model finishes', async () => {
    replies = [
      {
        sse: [
          { choices: [{ delta: { content: 'Trimming.', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'trim', arguments: '{"seconds"' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':2}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } },
        ],
      },
      { sse: text('Done, trimmed.') },
    ]
    const ran: unknown[] = []
    const out = await own().runAgent({
      system: 'Edit.',
      messages: [{ role: 'user', text: 'trim 2s' }],
      tools: [{ name: 'trim', description: 'Trim', inputSchema: { properties: { seconds: { type: 'number' } }, required: ['seconds'] } }],
      runTool: async (name, input) => (ran.push([name, input]), { content: 'trimmed', isError: false }),
      maxIterations: 5,
      onText: () => undefined,
    })
    expect(ran).toEqual([['trim', { seconds: 2 }]])
    expect(out.text).toBe('Trimming.\nDone, trimmed.')
    const second = calls.filter((c) => c.url.endsWith('/chat/completions'))[1].body!
    expect((second.messages as Array<{ role: string; tool_call_id?: string; content: string }>).slice(-2)).toMatchObject([{ role: 'assistant' }, { role: 'tool', tool_call_id: 'call_1', content: 'trimmed' }])
    expect((second.tools as unknown[]).length).toBe(1)
  })
})
