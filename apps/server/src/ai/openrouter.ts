// AiProvider over OpenRouter (https://openrouter.ai/docs): OpenAI's Chat Completions shape at
// https://openrouter.ai/api/v1, one key for hundreds of models (owner, 27 Nov 2026: OpenRouter in all four apps).
// Two ids: `openrouter` = a space's own key; `openrouter-api` = the server's shared key (OPENROUTER_API_KEY, beside
// ANTHROPIC_API_KEY), which is the server's AI: members only, like the server's Claude (resolve.ts builtinFor).
//   write()      – a streamed chat completion, text deltas relayed as they arrive.
//   structured() – `response_format` json_schema where the model's endpoints take it (`provider.require_parameters`
//                  routes only to those), else the schema in words; validated with zod, one repair turn.
//   runAgent()   – the tool loop over the shared ToolSpecs (`tools` → `tool_calls` → role "tool" replies).
// Every response ends with its usage (tokens and its cost in dollars), streamed or not: noted for metering.
// Only text: pictures, clips, music and voice stay with their own providers.
import type { AiKeyTestResult, OpenRouterModel, WriteRequest } from '@producer/core'
import { ctx } from '../context'
import { HttpError } from '../http'
import { log } from '../log'
import { noteCost, noteTokens } from '../services/metering'
import { CUT_OFF, writePrompt } from './claude'
import { adaptJsonSchema, formatMismatch, jsonSchemaFor, redact, repairPrompt, validateStructured } from './common'
import type { AgentRequest, AiProvider, ProviderStatus, StructuredRequest } from './provider'

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
/** Only when the live list can't be read: the newest Claude Sonnet on OpenRouter when this was written. */
export const OPENROUTER_FALLBACK_MODEL = 'anthropic/claude-sonnet-5.5'
const APP_NAME = 'Producer Studio'
const MODELS_TTL_MS = 3 * 3600_000
/** Attempts for a rate limit, a timeout or OpenRouter / its model being down (before the answer starts). */
const ATTEMPTS = 3

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
const realFetch: FetchLike = (url, init) => fetch(url, init)
let fetcher: FetchLike = realFetch
let pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(abortError())), { once: true })
  })

/** Test hook: a fake fetch (and no waiting between retries). Pass undefined to restore the network. */
export function setOpenRouterFetch(f: FetchLike | undefined, opts?: { noWait?: boolean }) {
  fetcher = f ?? realFetch
  if (opts?.noWait) pause = async () => undefined
  modelCache = undefined
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

/** The headers every call carries: the key, and the app's name and address for OpenRouter's rankings (never a person's). */
function headers(key: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', 'X-OpenRouter-Title': APP_NAME, 'X-Title': APP_NAME }
  const url = ctx().config.publicUrl
  if (url) h['HTTP-Referer'] = url
  if (key) h.authorization = `Bearer ${key}`
  return h
}

// ---------------- the model list ----------------

interface RawModel {
  id?: string
  name?: string
  created?: number
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  supported_parameters?: string[]
  top_provider?: { max_completion_tokens?: number | null }
}

/** One entry of GET /models as Producer Studio uses it (prices per million tokens, from OpenRouter's per-token strings). */
export function toModel(m: RawModel): OpenRouterModel | undefined {
  if (!m.id || typeof m.id !== 'string') return undefined
  const out = m.architecture?.output_modalities
  if (out && !out.includes('text')) return undefined
  // batch endpoints answer hours later: no use to a person waiting
  if (/:batch$/.test(m.id)) return undefined
  const perM = (s?: string) => {
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1000) / 1000 : undefined
  }
  const prompt = perM(m.pricing?.prompt)
  const completion = perM(m.pricing?.completion)
  // -1: a router that prices per request (openrouter/auto): no price to show or meter by
  if ((prompt ?? 0) < 0 || (completion ?? 0) < 0) return undefined
  const sp = new Set(m.supported_parameters ?? [])
  return {
    id: m.id,
    name: m.name || m.id,
    created: Number(m.created) || 0,
    contextLength: Number(m.context_length) || 0,
    promptPerM: prompt ?? 0,
    completionPerM: completion ?? 0,
    tools: sp.has('tools'),
    structured: sp.has('structured_outputs') || sp.has('response_format'),
    vision: (m.architecture?.input_modalities ?? []).includes('image'),
    reasoning: sp.has('reasoning'),
    ...(m.top_provider?.max_completion_tokens ? { maxOutput: m.top_provider.max_completion_tokens } : {}),
  }
}

/**
 * Whether a model can give the structured answers (a Producer script, a drawing, the assistant's edits) most features
 * need: its endpoints list tools or response_format. Settings → AI offers only these.
 */
export const answersInShape = (m: Pick<OpenRouterModel, 'tools' | 'structured'>) => m.tools || m.structured

let modelCache: { at: number; models: OpenRouterModel[] } | undefined

/** OpenRouter's text models (GET /models needs no key), newest first, read again every three hours. */
export async function openRouterModels(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<OpenRouterModel[]> {
  if (!opts.refresh && modelCache && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.models
  let res: Response
  try {
    res = await fetcher(`${OPENROUTER_BASE}/models`, { headers: headers(undefined), signal: opts.signal ?? AbortSignal.timeout(20_000) })
  } catch (err) {
    if (modelCache) return modelCache.models
    throw new HttpError(502, 'server', `Couldn’t read OpenRouter’s list of models (${redact(err instanceof Error ? err.message : String(err))}).`)
  }
  if (!res.ok) {
    if (modelCache) return modelCache.models
    throw new HttpError(502, 'server', `Couldn’t read OpenRouter’s list of models (OpenRouter answered ${res.status}).`)
  }
  const body = (await res.json().catch(() => ({}))) as { data?: RawModel[] }
  const models = (body.data ?? [])
    .map(toModel)
    .filter((m): m is OpenRouterModel => !!m)
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  if (models.length) modelCache = { at: Date.now(), models }
  return models
}

/** The default model: the newest Claude Sonnet on the list that takes tools (read from the live list, never guessed). */
export function defaultOpenRouterModel(models: readonly OpenRouterModel[]): string {
  const usable = models.filter((m) => m.tools && !m.id.includes(':'))
  return (usable.find((m) => /^anthropic\/claude-sonnet/.test(m.id)) ?? usable.find((m) => /^anthropic\/claude/.test(m.id)))?.id ?? OPENROUTER_FALLBACK_MODEL
}

async function modelInfo(id: string): Promise<OpenRouterModel | undefined> {
  try {
    return (await openRouterModels()).find((m) => m.id === id)
  } catch {
    return undefined
  }
}

// ---------------- errors ----------------

/** OpenRouter's own message, as the person reads it: the key's owner (a space's or the server's) decides the advice. */
export function openRouterError(status: number, message: string | undefined, o: { shared?: boolean; model?: string } = {}): HttpError {
  const said = message ? ` (OpenRouter: “${redact(message).slice(0, 300)}”)` : ''
  if (status === 401)
    return o.shared
      ? new HttpError(503, 'server', `The server’s OpenRouter key was rejected${said}. Add your own key in Settings → AI, or ask the operator.`)
      : new HttpError(400, 'invalid', `OpenRouter rejected the key: it’s wrong or was revoked${said}. Check or replace it in Settings → AI.`)
  if (status === 402)
    return o.shared
      ? new HttpError(429, 'quota', `The server’s OpenRouter key is out of credit${said}. Add your own key in Settings → AI, or try again later.`)
      : new HttpError(429, 'quota', `This OpenRouter key is out of credit${said}. Add credit at openrouter.ai/settings/credits, or raise the key’s limit.`)
  if (status === 429) return new HttpError(429, 'quota', `OpenRouter is limiting how fast this key can be used${said}. Try again in a moment.`)
  if (status === 403) return new HttpError(403, 'forbidden', `OpenRouter refused the request${said}.`)
  if (status === 404) return new HttpError(404, 'not_found', `OpenRouter has no way to run “${o.model ?? '?'}” for this request${said}. Pick another model in Settings → AI.`)
  if (status === 400 || status === 413 || status === 422) return new HttpError(400, 'invalid', `OpenRouter rejected the request${said}.`)
  if (status === 408) return new HttpError(502, 'server', `OpenRouter timed out${said}. Try again.`)
  return new HttpError(502, 'server', `OpenRouter or the model’s provider is unavailable right now${said}. Try again.`)
}

const transient = (status: number) => status === 408 || status === 429 || status >= 500

async function errorMessage(res: Response): Promise<string | undefined> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { error?: { message?: string } }
    return j.error?.message || undefined
  } catch {
    return text.trim().slice(0, 300) || undefined
  }
}

// ---------------- one streamed completion ----------------

type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Turn {
  text: string
  toolCalls: ToolCall[]
  finish?: string
}

interface Chunk {
  error?: { code?: number | string; message?: string }
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
}

export class OpenRouterProvider implements AiProvider {
  readonly id: 'openrouter' | 'openrouter-api'
  readonly model: string
  private readonly key: string
  private readonly shared: boolean

  constructor(opts: { apiKey: string; model: string; shared?: boolean }) {
    if (!opts.apiKey) throw new HttpError(503, 'server', 'No OpenRouter key is configured')
    this.key = opts.apiKey
    this.model = opts.model.trim() || OPENROUTER_FALLBACK_MODEL
    this.shared = !!opts.shared
    this.id = this.shared ? 'openrouter-api' : 'openrouter'
  }

  async status(): Promise<ProviderStatus> {
    return { available: true, detail: this.shared ? 'OpenRouter · Producer Studio’s key' : 'OpenRouter · your key', model: this.model }
  }

  /** One streamed turn; retried (before it starts) on a rate limit, a timeout or an outage. */
  private async chat(body: Record<string, unknown>, o: { onText?: (d: string) => void; onActivity?: () => void; signal?: AbortSignal; what: string }): Promise<Turn> {
    let res: Response | undefined
    for (let attempt = 1; ; attempt++) {
      if (o.signal?.aborted) throw abortError()
      try {
        res = await fetcher(`${OPENROUTER_BASE}/chat/completions`, { method: 'POST', headers: headers(this.key), body: JSON.stringify({ ...body, model: this.model, stream: true }), signal: o.signal })
      } catch (err) {
        if (o.signal?.aborted) throw abortError()
        if (attempt >= ATTEMPTS) throw new HttpError(502, 'server', 'Could not reach OpenRouter')
        await pause(1000 * attempt, o.signal)
        continue
      }
      if (res.ok) break
      const message = await errorMessage(res)
      if (transient(res.status) && attempt < ATTEMPTS) {
        const after = Number(res.headers.get('retry-after'))
        await pause(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 1500 * attempt, o.signal)
        continue
      }
      throw openRouterError(res.status, message, { shared: this.shared, model: this.model })
    }
    const turn: Turn = { text: '', toolCalls: [] }
    const calls: Array<{ id: string; name: string; args: string }> = []
    let usage: Chunk['usage']
    const handle = (data: string) => {
      if (data === '[DONE]') return
      let chunk: Chunk
      try {
        chunk = JSON.parse(data) as Chunk
      } catch {
        return
      }
      // a failure after the answer started: the status stays 200, the chunk carries the error
      if (chunk.error) throw openRouterError(Number(chunk.error.code) || 502, chunk.error.message, { shared: this.shared, model: this.model })
      if (chunk.usage) usage = chunk.usage
      for (const ch of chunk.choices ?? []) {
        const d = ch.delta
        if (d?.content) {
          turn.text += d.content
          o.onText?.(d.content)
        }
        for (const tc of d?.tool_calls ?? []) {
          const i = tc.index ?? calls.length
          const c = (calls[i] ??= { id: '', name: '', args: '' })
          if (tc.id) c.id = tc.id
          if (tc.function?.name) c.name += tc.function.name
          if (tc.function?.arguments) c.args += tc.function.arguments
        }
        if (ch.finish_reason && ch.finish_reason !== 'error') turn.finish = ch.finish_reason
        if (ch.finish_reason === 'error') throw new HttpError(502, 'server', `OpenRouter couldn’t ${o.what}: the model’s provider stopped with an error. Try again.`)
      }
    }
    try {
      const reader = res!.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        o.onActivity?.()
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          // ": OPENROUTER PROCESSING" keeps the connection alive: skip comments
          if (line.startsWith('data:')) handle(line.slice(5).trim())
        }
      }
      if (buf.startsWith('data:')) handle(buf.slice(5).trim())
    } catch (err) {
      if (o.signal?.aborted) throw abortError()
      if (err instanceof HttpError) throw err
      throw new HttpError(502, 'server', `The OpenRouter answer stopped before it finished (${o.what}).`)
    } finally {
      noteTokens(usage?.prompt_tokens, usage?.completion_tokens)
      noteCost(usage?.cost)
    }
    turn.toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args } }))
    if (turn.finish === 'content_filter') throw new HttpError(422, 'invalid', `The AI declined to ${o.what} (content filter).`)
    if (turn.finish === 'length' && !turn.toolCalls.length) throw new HttpError(502, 'server', CUT_OFF)
    return turn
  }

  async write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const { system, user } = writePrompt(req.kind, req.prompt, req.context, req.maxWords)
    const turn = await this.chat(
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 8000,
      },
      { onText: onDelta, signal, what: 'write this' },
    )
    return turn.text.trim()
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const info = await modelInfo(this.model)
    const room = Math.min(32000, info?.maxOutput ?? 32000)
    const content: Extract<Message, { role: 'user' }>['content'] = []
    for (const img of req.images) {
      content.push({ type: 'text', text: img.label })
      content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })
    }
    content.push({ type: 'text', text: req.prompt })
    // a model the list says takes a JSON schema (or one the list can't be read for) is sent it; one that turns it down
    // anyway is asked again with the schema in words
    let schemaMode = info ? info.structured : true
    const strictSchema = jsonSchemaFor(req.schema, 'openai-strict')
    const inWords = () => `${req.system}\n\nReply with only one JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(jsonSchemaFor(req.schema, 'openai-tool').schema)}`
    const messages: Message[] = [{ role: 'user', content }]
    for (let attempt = 0; attempt < 2; attempt++) {
      let turn: Turn
      try {
        turn = await this.chat(
          {
            messages: [{ role: 'system', content: schemaMode ? req.system : inWords() }, ...messages],
            max_tokens: room,
            ...(schemaMode ? { response_format: { type: 'json_schema', json_schema: { name: 'output', strict: strictSchema.strict, schema: strictSchema.schema } }, provider: { require_parameters: true } } : {}),
            ...(req.effort && info?.reasoning ? { reasoning: { effort: req.effort } } : {}),
          },
          { onActivity: req.onActivity, signal: req.signal, what: 'complete this request' },
        )
      } catch (err) {
        if (schemaMode && err instanceof HttpError && (err.status === 400 || err.status === 404) && attempt === 0) {
          log.warn('openrouter: the model turned down a JSON schema; asking with the schema in words', { model: this.model })
          schemaMode = false
          attempt--
          continue
        }
        throw err
      }
      const v = validateStructured(req.schema, turn.text)
      if (v.ok) return v.data
      log.warn('openrouter structured output failed validation', { attempt, model: this.model, error: v.error })
      messages.push({ role: 'assistant', content: turn.text }, { role: 'user', content: repairPrompt(v.error) })
    }
    throw formatMismatch()
  }

  async runAgent(req: AgentRequest): Promise<{ text: string }> {
    const info = await modelInfo(this.model)
    const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: adaptJsonSchema({ type: 'object', ...t.inputSchema }, 'openai-tool').schema } }))
    const messages: Message[] = []
    for (const m of req.messages) if (m.text.trim()) messages.push(m.role === 'user' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text })
    while (messages.length && messages[0].role !== 'user') messages.shift()
    let finalText = ''
    for (let iter = 0; iter < req.maxIterations; iter++) {
      const turn = await this.chat(
        { messages: [{ role: 'system', content: req.system }, ...messages], tools, tool_choice: 'auto', provider: { require_parameters: true }, max_tokens: Math.min(16000, info?.maxOutput ?? 16000) },
        { onText: req.onText, signal: req.signal, what: 'finish the edit' },
      )
      if (turn.text) finalText += (finalText ? '\n' : '') + turn.text
      if (turn.finish === 'length' && turn.toolCalls.length) throw new HttpError(502, 'server', 'The assistant response was cut off')
      messages.push({ role: 'assistant', content: turn.text || null, ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}) })
      if (!turn.toolCalls.length) break
      for (const call of turn.toolCalls) {
        if (req.signal?.aborted) throw abortError()
        let args: unknown
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: the arguments for ${call.function.name} were not valid JSON.` })
          continue
        }
        const r = await req.runTool(call.function.name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.isError ? `Error: ${r.content}` : r.content })
      }
      if (iter === req.maxIterations - 1) finalText += (finalText ? '\n' : '') + 'I stopped after the maximum number of steps; the changes so far are applied.'
    }
    return { text: finalText }
  }
}

// ---------------- checking a key ----------------

/**
 * A key's check: GET /key (its limit and what's left of it), then the models a feature can use. Never throws for a
 * key problem: it comes back as ok:false with OpenRouter's reason.
 */
export async function testOpenRouterKey(key: string): Promise<AiKeyTestResult> {
  let res: Response
  try {
    res = await fetcher(`${OPENROUTER_BASE}/key`, { headers: headers(key), signal: AbortSignal.timeout(20_000) })
  } catch {
    return { ok: false, models: [], detail: 'Couldn’t reach OpenRouter to check the key. Try again.' }
  }
  if (!res.ok) return { ok: false, models: [], detail: openRouterError(res.status, await errorMessage(res)).message }
  const info = ((await res.json().catch(() => ({}))) as { data?: { limit_remaining?: number | null; is_free_tier?: boolean } }).data ?? {}
  let models: OpenRouterModel[] = []
  try {
    models = await openRouterModels()
  } catch (err) {
    log.warn('openrouter: the model list could not be read during a key test', { error: err instanceof Error ? err.message : String(err) })
  }
  const usable = models.filter(answersInShape)
  const left = typeof info.limit_remaining === 'number' ? `$${info.limit_remaining.toFixed(2)} left on its limit` : 'no spending limit on this key'
  return {
    ok: true,
    models: usable.map((m) => m.id).slice(0, 500),
    defaultModel: defaultOpenRouterModel(models),
    detail: `✓ valid · ${left}${info.is_free_tier ? ' · free tier' : ''} · ${usable.length} models`,
  }
}
