// Bring-your-own-key providers (OpenAI Responses API, Gemini, Anthropic key) against injected fake SDK clients:
// request building, streamed write, structured output validation + one repair retry, the manual tool-call loop
// (parallel calls, tool errors, iteration cap, abort) and error mapping. No network.
import { describe, expect, it } from 'vitest'

process.env.LOG_SILENT = '1'
import * as z from 'zod/v4'
import OpenAI from 'openai'
import { ApiError } from '@google/genai'
import type { GenerateContentParameters, GenerateContentResponse, Model } from '@google/genai'
import type { Response, ResponseCreateParamsStreaming, ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { AnthropicApiProvider } from '../ai/anthropic'
import { adaptJsonSchema, filterGeminiModels, filterOpenAiModels, jsonSchemaFor, pickDefaultModel, redact, validateStructured } from '../ai/common'
import { GeminiProvider, listGeminiModels, mapGeminiError } from '../ai/gemini'
import { OpenAiProvider, listOpenAiModels, mapOpenAiError, type OpenAiClientLike } from '../ai/openai'
import { toolSpecs } from '../ai/assistant'
import { ScriptSchema } from '../ai/produce'
import type { AgentRequest } from '../ai/provider'

const Out = z.object({ title: z.string(), n: z.number(), note: z.string().optional() })

const TOOLS = [
  { name: 'split_at', description: 'Split', inputSchema: { type: 'object', properties: { time: { type: 'number', minimum: 0 } }, required: ['time'], additionalProperties: false } },
  { name: 'add_text', description: 'Text', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['text'] } },
]

function agentReq(over: Partial<AgentRequest> = {}): AgentRequest & { calls: Array<[string, unknown]>; text: string[] } {
  const calls: Array<[string, unknown]> = []
  const text: string[] = []
  return {
    system: 'SYS',
    messages: [
      { role: 'assistant', text: 'stale greeting' },
      { role: 'user', text: 'split at 2s and add a title' },
    ],
    tools: TOOLS,
    maxIterations: 5,
    onText: (d) => text.push(d),
    runTool: async (name, input) => {
      calls.push([name, input])
      if (name === 'add_text') return { content: 'text must not be empty', isError: true }
      return { content: `ok ${name}`, isError: false }
    },
    calls,
    text,
    ...over,
  }
}

// ---------------- OpenAI ----------------

function oaResponse(output: ResponseOutputItem[], status: Response['status'] = 'completed', incomplete?: Response['incomplete_details']): Response {
  return { id: 'resp_1', object: 'response', status, output, incomplete_details: incomplete ?? null, error: null } as unknown as Response
}
const oaMsg = (text: string): ResponseOutputItem => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }) as unknown as ResponseOutputItem
const oaCall = (id: string, name: string, args: string): ResponseOutputItem => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' }) as unknown as ResponseOutputItem

function fakeOpenAi(turns: Array<{ deltas?: string[]; response: Response } | { throws: unknown }>) {
  const requests: ResponseCreateParamsStreaming[] = []
  const client: OpenAiClientLike = {
    responses: {
      async create(body) {
        requests.push(JSON.parse(JSON.stringify(body)))
        const t = turns.shift()
        if (!t) throw new Error('unexpected extra request')
        if ('throws' in t) throw t.throws
        return (async function* () {
          for (const d of t.deltas ?? []) yield { type: 'response.output_text.delta', delta: d } as ResponseStreamEvent
          yield { type: t.response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: t.response } as ResponseStreamEvent
        })()
      },
    },
    models: {
      async *list() {
        for (const id of ['gpt-4o', 'gpt-5.5', 'gpt-5.5-mini', 'text-embedding-3-large', 'gpt-realtime', 'o3', 'gpt-5.5-pro', 'dall-e-3', 'gpt-5']) yield { id }
      },
    },
  }
  return { client, requests }
}

describe('OpenAI provider', () => {
  it('write streams text deltas and builds a Responses request', async () => {
    const { client, requests } = fakeOpenAi([{ deltas: ['Hel', 'lo'], response: oaResponse([oaMsg('Hello')]) }])
    const p = new OpenAiProvider({ client, model: 'gpt-5.5' })
    const got: string[] = []
    expect(await p.write({ kind: 'headline', prompt: 'spreadsheets', maxWords: 7 }, (d) => got.push(d))).toBe('Hello')
    expect(got).toEqual(['Hel', 'lo'])
    expect(requests[0]).toMatchObject({ model: 'gpt-5.5', stream: true, input: expect.stringContaining('spreadsheets') })
    expect(requests[0].instructions).toMatch(/headline/)
  })

  it('structured: strict JSON schema, inline images, zod validation and one repair retry', async () => {
    const bad = oaResponse([oaMsg('{"title":"x"}')])
    const good = oaResponse([oaMsg('{"title":"x","n":2,"note":null}')])
    const { client, requests } = fakeOpenAi([{ response: bad }, { response: good }])
    const p = new OpenAiProvider({ client, model: 'gpt-5.5' })
    const r = await p.structured({ system: 'S', prompt: 'P', images: [{ label: 'Sheet:', mediaType: 'image/jpeg', data: 'QUJD' }], schema: Out })
    expect(r).toEqual({ title: 'x', n: 2 })
    expect(requests).toHaveLength(2)
    const fmt = requests[0].text?.format as { type: string; strict: boolean; schema: { required: string[]; properties: Record<string, unknown> } }
    expect(fmt).toMatchObject({ type: 'json_schema', strict: true })
    expect(fmt.schema.required).toEqual(['title', 'n', 'note'])
    expect(fmt.schema.properties.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    const first = (requests[0].input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0].content
    expect(first.find((c) => c.type === 'input_image')?.image_url).toBe('data:image/jpeg;base64,QUJD')
    const retryInput = requests[1].input as Array<{ role?: string; content?: unknown }>
    expect(JSON.stringify(retryInput[retryInput.length - 1])).toMatch(/did not match the required JSON schema.*n/)
  })

  it('structured gives up with a clear 502 after the repair retry fails too', async () => {
    const { client } = fakeOpenAi([{ response: oaResponse([oaMsg('nope')]) }, { response: oaResponse([oaMsg('{"title":1}')]) }])
    await expect(new OpenAiProvider({ client, model: 'm' }).structured({ system: 'S', prompt: 'P', images: [], schema: Out })).rejects.toMatchObject({ status: 502, message: /expected format/ })
  })

  it('runAgent: parallel function calls, tool errors returned to the model, final text streamed', async () => {
    const { client, requests } = fakeOpenAi([
      { deltas: ['On it. '], response: oaResponse([oaMsg('On it. '), oaCall('c1', 'split_at', '{"time":2}'), oaCall('c2', 'add_text', '{"text":""}')]) },
      { deltas: ['Split at 2s.'], response: oaResponse([oaMsg('Split at 2s.')]) },
    ])
    const req = agentReq()
    const r = await new OpenAiProvider({ client, model: 'gpt-5.5' }).runAgent(req)
    expect(req.calls).toEqual([
      ['split_at', { time: 2 }],
      ['add_text', { text: '' }],
    ])
    expect(r.text).toBe('On it. \nSplit at 2s.')
    expect(req.text.join('')).toBe('On it. Split at 2s.')
    // first request: history starts on the user turn, tools mapped as non-strict functions
    expect((requests[0].input as Array<{ role: string }>)[0].role).toBe('user')
    expect(requests[0].tools?.[0]).toMatchObject({ type: 'function', name: 'split_at', strict: false, parameters: { type: 'object', required: ['time'] } })
    expect(requests[0].parallel_tool_calls).toBe(true)
    const outputs = (requests[1].input as Array<{ type?: string; call_id?: string; output?: string }>).filter((i) => i.type === 'function_call_output')
    expect(outputs).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'ok split_at' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: text must not be empty' },
    ])
    // the model's own items (message + both calls) are replayed before the outputs
    expect((requests[1].input as Array<{ type?: string }>).filter((i) => i.type === 'function_call')).toHaveLength(2)
  })

  it('runAgent stops at maxIterations and reports invalid JSON arguments as a tool error', async () => {
    const loop = () => ({ response: oaResponse([oaCall('c', 'split_at', '{bad json')]) })
    const { client, requests } = fakeOpenAi([loop(), loop()])
    const req = agentReq({ maxIterations: 2 })
    const r = await new OpenAiProvider({ client, model: 'm' }).runAgent(req)
    expect(requests).toHaveLength(2)
    expect(req.calls).toHaveLength(0)
    expect(r.text).toMatch(/maximum number of steps/)
    expect(JSON.stringify(requests[1].input)).toMatch(/not valid JSON/)
  })

  it('honours abort before any request', async () => {
    const { client, requests } = fakeOpenAi([])
    const ac = new AbortController()
    ac.abort()
    await expect(new OpenAiProvider({ client, model: 'm' }).runAgent(agentReq({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(0)
  })

  it('maps refusals, cut-offs and SDK errors to user-facing messages', async () => {
    const refusal = oaResponse([{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] } as unknown as ResponseOutputItem])
    let f = fakeOpenAi([{ response: refusal }])
    await expect(new OpenAiProvider({ client: f.client, model: 'm' }).write({ kind: 'headline', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ status: 422 })
    f = fakeOpenAi([{ response: oaResponse([oaMsg('abc')], 'incomplete', { reason: 'max_output_tokens' }) }])
    await expect(new OpenAiProvider({ client: f.client, model: 'm' }).write({ kind: 'headline', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ status: 502, message: /cut off/ })
    const auth = OpenAI.APIError.generate(401, { error: { message: 'Incorrect API key provided: sk-abc12345678***wxyz' } }, undefined, new Headers())
    f = fakeOpenAi([{ throws: auth }])
    const e = await new OpenAiProvider({ client: f.client, model: 'm' }).write({ kind: 'headline', prompt: 'x' }, () => undefined).catch((x) => x)
    expect(e).toMatchObject({ status: 400, message: /OpenAI API key was rejected/ })
    expect(e.message).not.toMatch(/sk-/)
    expect(() => mapOpenAiError(OpenAI.APIError.generate(429, { error: { code: 'insufficient_quota', message: 'quota' } }, undefined, new Headers()))).toThrow(/run out of quota/)
    expect(() => mapOpenAiError(OpenAI.APIError.generate(429, { error: { message: 'slow down' } }, undefined, new Headers()))).toThrow(/rate limit/)
    expect(() => mapOpenAiError(OpenAI.APIError.generate(404, { error: { code: 'model_not_found', message: 'nope' } }, undefined, new Headers()), 'gpt-9')).toThrow(/gpt-9/)
  })

  it('lists chat-capable models newest first and picks the flagship', async () => {
    const { client } = fakeOpenAi([])
    const ids = await listOpenAiModels(client)
    expect(ids).not.toContain('text-embedding-3-large')
    expect(ids).not.toContain('gpt-realtime')
    expect(ids).not.toContain('dall-e-3')
    expect(ids[0]).toMatch(/^gpt-5\.5/)
    expect(pickDefaultModel('openai', ids)).toBe('gpt-5.5')
  })
})

// ---------------- Gemini ----------------

type Chunk = Partial<GenerateContentResponse>
function fakeGemini(turns: Array<Chunk[] | { throws: unknown }>, models: Model[] = []) {
  const requests: GenerateContentParameters[] = []
  const client = {
    models: {
      async generateContentStream(params: GenerateContentParameters) {
        const { abortSignal: _a, ...config } = params.config ?? {}
        requests.push(JSON.parse(JSON.stringify({ ...params, config })))
        const t = turns.shift()
        if (!t) throw new Error('unexpected extra request')
        if ('throws' in t) throw t.throws
        return (async function* () {
          for (const c of t) yield c as GenerateContentResponse
        })()
      },
      async list() {
        return (async function* () {
          for (const m of models) yield m
        })()
      },
    },
  }
  return { client, requests }
}
const gText = (text: string, finishReason?: string): Chunk => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] }) as Chunk

describe('Gemini provider', () => {
  it('write streams text parts', async () => {
    const { client, requests } = fakeGemini([[gText('Hel'), gText('lo', 'STOP')]])
    const got: string[] = []
    expect(await new GeminiProvider({ client, model: 'gemini-3-pro' }).write({ kind: 'caption', prompt: 'demo' }, (d) => got.push(d))).toBe('Hello')
    expect(got).toEqual(['Hel', 'lo'])
    expect(requests[0]).toMatchObject({ model: 'gemini-3-pro', contents: [{ role: 'user', parts: [{ text: expect.stringContaining('demo') }] }] })
    expect(String(requests[0].config?.systemInstruction)).toMatch(/caption/)
  })

  it('structured: responseJsonSchema, inlineData images, repair retry', async () => {
    const { client, requests } = fakeGemini([[gText('{"title":"t"}', 'STOP')], [gText('{"title":"t",', undefined), gText('"n":3}', 'STOP')]])
    const r = await new GeminiProvider({ client, model: 'g' }).structured({ system: 'S', prompt: 'P', images: [{ label: 'Sheet:', mediaType: 'image/png', data: 'UE5H' }], schema: Out })
    expect(r).toEqual({ title: 't', n: 3 })
    expect(requests[0].config).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object', required: ['title', 'n'] } })
    expect(JSON.stringify(requests[0].contents)).toContain('"inlineData":{"mimeType":"image/png","data":"UE5H"}')
    const retry = requests[1].contents as Array<{ role: string; parts: Array<{ text?: string }> }>
    expect(retry.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(retry[2].parts[0].text).toMatch(/did not match/)
  })

  it('runAgent: parallel functionCalls → functionResponses (errors as {error}), thought signatures replayed', async () => {
    const { client, requests } = fakeGemini([
      [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Working. ' }] } }] } as Chunk,
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: { id: 'a', name: 'split_at', args: { time: 2 } }, thoughtSignature: 'sig1' }, { functionCall: { id: 'b', name: 'add_text', args: { text: '' } } }] },
              finishReason: 'STOP',
            },
          ],
        } as Chunk,
      ],
      [gText('Done.', 'STOP')],
    ])
    const req = agentReq()
    const r = await new GeminiProvider({ client, model: 'g' }).runAgent(req)
    expect(req.calls).toEqual([
      ['split_at', { time: 2 }],
      ['add_text', { text: '' }],
    ])
    expect(r.text).toBe('Working. \nDone.')
    const decl = (requests[0].config?.tools as Array<{ functionDeclarations: Array<{ name: string; parametersJsonSchema: Record<string, unknown> }> }>)[0].functionDeclarations
    expect(decl[1].parametersJsonSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
    const c2 = requests[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    expect(c2[0].role).toBe('user')
    expect(c2[1]).toEqual({ role: 'model', parts: [{ text: 'Working. ' }, { functionCall: { id: 'a', name: 'split_at', args: { time: 2 } }, thoughtSignature: 'sig1' }, { functionCall: { id: 'b', name: 'add_text', args: { text: '' } } }] })
    expect(c2[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'a', name: 'split_at', response: { output: 'ok split_at' } } }, { functionResponse: { id: 'b', name: 'add_text', response: { error: 'text must not be empty' } } }],
    })
  })

  it('maps blocked prompts, safety stops and API errors', async () => {
    let f = fakeGemini([[{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } as Chunk]])
    await expect(new GeminiProvider({ client: f.client, model: 'g' }).write({ kind: 'headline', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ status: 422 })
    f = fakeGemini([[gText('', 'SAFETY')]])
    await expect(new GeminiProvider({ client: f.client, model: 'g' }).write({ kind: 'headline', prompt: 'x' }, () => undefined)).rejects.toMatchObject({ status: 422 })
    const bad = new ApiError({ status: 400, message: JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }) })
    expect(() => mapGeminiError(bad)).toThrow(/Gemini API key was rejected/)
    expect(() => mapGeminiError(new ApiError({ status: 429, message: 'RESOURCE_EXHAUSTED' }))).toThrow(/quota/)
    expect(() => mapGeminiError(new ApiError({ status: 404, message: 'not found' }), 'gemini-x')).toThrow(/gemini-x/)
  })

  it('lists generateContent text models and picks the newest pro', async () => {
    const { client } = fakeGemini([], [
      { name: 'models/gemini-2.5-pro', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3-pro-preview', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
      { name: 'models/imagen-4.0-generate-001', supportedActions: ['predict'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedActions: ['generateContent'] },
    ])
    const ids = await listGeminiModels(client)
    expect(ids).toEqual(['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'])
    expect(pickDefaultModel('gemini', ids)).toBe('gemini-3-pro-preview')
    expect(filterGeminiModels([{ name: 'models/gemini-3.1-pro' }, { name: 'models/gemini-3.1-pro-preview' }])).toEqual(['gemini-3.1-pro', 'gemini-3.1-pro-preview'])
  })
})

// ---------------- Anthropic (user key) ----------------

function fakeAnthropic(stream: Array<{ content: Array<Record<string, unknown>>; stop_reason: string }>, parse: Array<unknown> = []) {
  const streamReqs: unknown[] = []
  const parseReqs: unknown[] = []
  const client = {
    beta: {
      messages: {
        stream(params: unknown) {
          streamReqs.push(JSON.parse(JSON.stringify(params)))
          const msg = stream.shift()!
          return {
            on(ev: string, cb: (d: string) => void) {
              if (ev === 'text') for (const b of msg.content) if (b.type === 'text') cb(b.text as string)
              return this
            },
            finalMessage: async () => msg,
          }
        },
        async parse(params: unknown) {
          parseReqs.push(params)
          const r = parse.shift()
          if (r instanceof Error) throw r
          return r
        },
      },
    },
    models: {
      async *list() {
        yield* [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }]
      },
    },
  }
  return { client, streamReqs, parseReqs }
}

describe('Anthropic key provider', () => {
  it('uses the injected key client and model; runAgent returns all parallel tool results in one turn', async () => {
    const f = fakeAnthropic([
      {
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 't1', name: 'split_at', input: { time: 2 } },
          { type: 'tool_use', id: 't2', name: 'add_text', input: { text: '' } },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
    ])
    const p = new AnthropicApiProvider({ client: f.client as never, model: 'claude-sonnet-4-5' })
    expect(p.id).toBe('anthropic-key')
    expect(await p.status()).toMatchObject({ available: true, model: 'claude-sonnet-4-5' })
    const req = agentReq()
    const r = await p.runAgent(req)
    expect(r.text).toBe('Sure.\nDone.')
    expect(req.calls.map((c) => c[0])).toEqual(['split_at', 'add_text'])
    const second = f.streamReqs[1] as { model: string; messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> }> }
    expect(second.model).toBe('claude-sonnet-4-5')
    const results = second.messages[second.messages.length - 1].content
    expect(results.map((x) => [x.tool_use_id, x.is_error ?? false])).toEqual([
      ['t1', false],
      ['t2', true],
    ])
  })

  it('structured retries once when the SDK parse/validation fails locally', async () => {
    const f = fakeAnthropic([], [new SyntaxError('Unexpected token'), { stop_reason: 'end_turn', content: [], parsed_output: { title: 'a', n: 1 } }])
    const p = new AnthropicApiProvider({ client: f.client as never, model: 'claude-opus-5' })
    expect(await p.structured({ system: 'S', prompt: 'P', images: [], schema: Out })).toEqual({ title: 'a', n: 1 })
    expect(f.parseReqs).toHaveLength(2)
    expect(JSON.stringify(f.parseReqs[1])).toMatch(/did not match the required JSON schema/)
  })

  it('the env provider keeps the anthropic-api id and default model', async () => {
    const p = new AnthropicApiProvider()
    expect(p.id).toBe('anthropic-api')
    expect(p.model).toBe('claude-opus-5')
  })
})

// ---------------- schema dialects & helpers ----------------

describe('schema adaptation and helpers', () => {
  it('the Producer ScriptSchema converts to a strict OpenAI schema and a Gemini schema', () => {
    const o = jsonSchemaFor(ScriptSchema, 'openai-strict')
    expect(o.strict).toBe(true)
    expect(JSON.stringify(o.schema)).not.toMatch(/\$schema|minLength/)
    const g = jsonSchemaFor(ScriptSchema, 'gemini')
    expect(JSON.stringify(g.schema)).not.toMatch(/additionalProperties":false,"x|\$schema/)
    expect((g.schema.properties as Record<string, unknown>).scenes).toBeTruthy()
  })

  it('every editor tool schema adapts to both dialects (no unsupported keywords for Gemini)', () => {
    const allowed = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering'])
    const walk = (n: unknown, inProps = false): void => {
      if (Array.isArray(n)) return n.forEach((x) => walk(x))
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n)) {
        if (!inProps) expect(allowed.has(k), `unexpected keyword ${k}`).toBe(true)
        walk(v, k === 'properties')
      }
    }
    for (const t of toolSpecs()) {
      walk(adaptJsonSchema(t.inputSchema, 'gemini').schema)
      expect(adaptJsonSchema(t.inputSchema, 'openai-tool').strict).toBe(false)
    }
  })

  it('records/free-form objects fall back to non-strict for OpenAI', () => {
    const s = jsonSchemaFor(z.object({ m: z.record(z.string(), z.number()) }), 'openai-strict')
    expect(s.strict).toBe(false)
  })

  it('validateStructured parses fenced JSON and tolerates nulls for optional fields', () => {
    expect(validateStructured(Out, '```json\n{"title":"a","n":1,"note":null}\n```')).toEqual({ ok: true, data: { title: 'a', n: 1 } })
    expect(validateStructured(Out, '{"title":1}')).toMatchObject({ ok: false, error: expect.stringMatching(/title/) })
  })

  it('redacts key-like strings', () => {
    expect(redact('bad key sk-proj-abcdefghijklmnop and AIzaSyA1234567890abcdefgh and sk-ant-api03-xyzxyzxyz')).toBe('bad key [redacted] and [redacted] and [redacted]')
  })

  it('model filters and defaults', () => {
    expect(filterOpenAiModels(['gpt-5.5-2026-03-01', 'gpt-5.5', 'o4-mini', 'whisper-1', 'omni-moderation-latest', 'gpt-4o-audio-preview'])).toEqual(['gpt-5.5', 'gpt-5.5-2026-03-01', 'o4-mini'])
    expect(pickDefaultModel('anthropic', ['claude-sonnet-4-5', 'claude-opus-5'])).toBe('claude-opus-5')
    expect(pickDefaultModel('openai', [])).toBe('gpt-5.5')
  })
})
