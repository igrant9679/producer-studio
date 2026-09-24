// AiProvider over the Gemini Developer API (Google AI Studio key, `@google/genai` SDK 2.x).
//   write()      – models.generateContentStream, text parts relayed as they arrive.
//   structured() – responseMimeType application/json + responseJsonSchema (the zod schema adapted to Gemini's JSON
//                  Schema subset), images as inlineData, validated with zod afterwards, one repair turn on failure.
//   runAgent()   – manual function-calling loop: functionDeclarations with parametersJsonSchema; every functionCall
//                  part in a turn (parallel calls included) runs through req.runTool and goes back as a
//                  functionResponse ({output} or {error}). Model turns are replayed verbatim so thought signatures
//                  stay attached to their parts.
import { GoogleGenAI } from '@google/genai'
import type { Content, FunctionCall, GenerateContentConfig, GenerateContentParameters, GenerateContentResponse, Model, Part } from '@google/genai'
import type { WriteRequest } from '@producer/core'
import { HttpError } from '../http'
import { log } from '../log'
import { writePrompt } from './claude'
import { adaptJsonSchema, filterGeminiModels, formatMismatch, jsonSchemaFor, redact, repairPrompt, validateStructured } from './common'
import type { AgentRequest, AiProvider, ProviderStatus, StructuredRequest } from './provider'

/** The slice of the SDK client this provider uses (tests inject a fake). */
export interface GeminiClientLike {
  models: {
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>>
    list(params?: { config?: { pageSize?: number } }): Promise<AsyncIterable<Model>>
  }
}

export function geminiClient(apiKey: string): GeminiClientLike {
  return new GoogleGenAI({ apiKey, vertexai: false }) as unknown as GeminiClientLike
}

/** The API's own message from an ApiError (its message is often the JSON error body). */
function apiMessage(err: { message?: string }): string {
  const m = err.message ?? ''
  try {
    const j = JSON.parse(m.slice(m.indexOf('{'))) as { error?: { message?: string } }
    if (j.error?.message) return j.error.message
  } catch {
    /* plain text */
  }
  return m
}

/** Map SDK errors to user-facing API errors (never echoing the key). */
export function mapGeminiError(err: unknown, model?: string): never {
  if (err instanceof HttpError) throw err
  if (err instanceof Error && err.name === 'AbortError') throw err
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') {
    const msg = apiMessage(err as Error)
    if (/API[_ ]KEY[_ ]INVALID|API key not valid|API key expired|API_KEY_EXPIRED/i.test(msg) || status === 401)
      throw new HttpError(400, 'invalid', 'The Gemini API key was rejected. Check or replace it in Settings → AI.')
    if (status === 403) throw new HttpError(403, 'forbidden', `This Gemini key isn’t allowed to do that: ${redact(msg).slice(0, 300)}`)
    if (status === 404) throw new HttpError(404, 'not_found', `Gemini model “${model ?? '?'}” isn’t available to this key. Pick another model in Settings → AI.`)
    if (status === 429) throw new HttpError(429, 'quota', 'Gemini quota or rate limit reached for this key. Try again in a moment, or check your plan in Google AI Studio.')
    if (status === 400) throw new HttpError(400, 'invalid', `Gemini rejected the request: ${redact(msg).slice(0, 400)}`)
    throw new HttpError(502, 'server', `Gemini request failed (${status})`)
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) throw new HttpError(502, 'server', 'Could not reach Gemini')
  throw err
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'LANGUAGE'])

interface Turn {
  parts: Part[]
  text: string
  calls: FunctionCall[]
  finishReason?: string
}

/** Merge streamed parts: adjacent plain text parts join; anything carrying a signature/call stays its own part. */
function mergeParts(parts: Part[]): Part[] {
  const out: Part[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    const plain = (x: Part) => typeof x.text === 'string' && Object.keys(x).every((k) => k === 'text')
    if (prev && plain(prev) && plain(p)) out[out.length - 1] = { text: (prev.text ?? '') + (p.text ?? '') }
    else out.push({ ...p })
  }
  return out
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini' as const
  readonly model: string
  private readonly client: GeminiClientLike

  constructor(opts: { apiKey?: string; model: string; client?: GeminiClientLike }) {
    if (!opts.client && !opts.apiKey) throw new HttpError(503, 'server', 'No Gemini key is configured')
    this.model = opts.model
    this.client = opts.client ?? geminiClient(opts.apiKey!)
  }

  async status(): Promise<ProviderStatus> {
    return { available: true, detail: 'Gemini · your key', model: this.model }
  }

  private async turn(contents: Content[], config: GenerateContentConfig, onText: ((d: string) => void) | undefined, signal: AbortSignal | undefined, what: string): Promise<Turn> {
    if (signal?.aborted) throw abortError()
    const parts: Part[] = []
    let text = ''
    let finishReason: string | undefined
    try {
      const stream = await this.client.models.generateContentStream({ model: this.model, contents, config: { ...config, abortSignal: signal } })
      for await (const chunk of stream) {
        const block = chunk.promptFeedback?.blockReason
        if (block) throw new HttpError(422, 'invalid', `The AI declined to ${what} (${String(block).toLowerCase().replace(/_/g, ' ')}). Try rephrasing the request.`)
        const cand = chunk.candidates?.[0]
        if (!cand) continue
        for (const p of cand.content?.parts ?? []) {
          parts.push(p)
          if (typeof p.text === 'string' && !p.thought && p.text) {
            text += p.text
            onText?.(p.text)
          }
        }
        if (cand.finishReason) finishReason = String(cand.finishReason)
      }
    } catch (err) {
      if (signal?.aborted) throw abortError()
      mapGeminiError(err, this.model)
    }
    const calls = parts.map((p) => p.functionCall).filter((c): c is FunctionCall => Boolean(c?.name))
    if (finishReason && BLOCKED.has(finishReason)) throw new HttpError(422, 'invalid', `The AI declined to ${what}. Try rephrasing the request.`)
    if (finishReason === 'MAX_TOKENS' && !calls.length) throw new HttpError(502, 'server', `The AI response for ${what} was cut off (too long).`)
    return { parts: mergeParts(parts), text, calls, finishReason }
  }

  async write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const { system, user } = writePrompt(req.kind, req.prompt, req.context, req.maxWords)
    const t = await this.turn([{ role: 'user', parts: [{ text: user }] }], { systemInstruction: system }, onDelta, signal, 'write this')
    return t.text.trim()
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { schema } = jsonSchemaFor(req.schema, 'gemini')
    const parts: Part[] = []
    for (const img of req.images) parts.push({ text: img.label }, { inlineData: { mimeType: img.mediaType, data: img.data } })
    parts.push({ text: req.prompt })
    const contents: Content[] = [{ role: 'user', parts }]
    const config: GenerateContentConfig = { systemInstruction: req.system, responseMimeType: 'application/json', responseJsonSchema: schema }
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.turn(contents, config, undefined, req.signal, 'complete this request')
      const v = validateStructured(req.schema, t.text)
      if (v.ok) return v.data
      log.warn('gemini structured output failed validation', { attempt, error: v.error })
      contents.push({ role: 'model', parts: t.parts.length ? t.parts : [{ text: t.text }] }, { role: 'user', parts: [{ text: repairPrompt(v.error) }] })
    }
    throw formatMismatch()
  }

  async runAgent(req: AgentRequest): Promise<{ text: string }> {
    const config: GenerateContentConfig = {
      systemInstruction: req.system,
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: adaptJsonSchema({ type: 'object', ...t.inputSchema }, 'gemini').schema })) }],
    }
    // merge consecutive same-role turns and start on a user turn
    const contents: Content[] = []
    for (const m of req.messages) {
      if (!m.text.trim()) continue
      const role = m.role === 'assistant' ? 'model' : 'user'
      const last = contents[contents.length - 1]
      if (last && last.role === role) last.parts!.push({ text: m.text })
      else contents.push({ role, parts: [{ text: m.text }] })
    }
    while (contents.length && contents[0].role !== 'user') contents.shift()
    let finalText = ''
    let malformed = 0
    for (let iter = 0; iter < req.maxIterations; iter++) {
      const t = await this.turn(contents, config, req.onText, req.signal, 'finish the edit')
      if (t.text) finalText += (finalText ? '\n' : '') + t.text
      if (t.finishReason === 'MALFORMED_FUNCTION_CALL' && !t.calls.length && malformed++ < 1) {
        contents.push({ role: 'user', parts: [{ text: 'Your last function call was malformed. Call the tool again with valid arguments.' }] })
        continue
      }
      if (t.parts.length) contents.push({ role: 'model', parts: t.parts })
      if (!t.calls.length) break
      const responses: Part[] = []
      for (const call of t.calls) {
        if (req.signal?.aborted) throw abortError()
        const r = await req.runTool(call.name!, call.args ?? {})
        responses.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: r.isError ? { error: r.content } : { output: r.content } } })
      }
      contents.push({ role: 'user', parts: responses })
      if (iter === req.maxIterations - 1) finalText += (finalText ? '\n' : '') + 'I stopped after the maximum number of steps; the changes so far are applied.'
    }
    return { text: finalText }
  }
}

/** Validate a key by listing models; returns generateContent-capable text model ids (newest first). */
export async function listGeminiModels(client: GeminiClientLike): Promise<string[]> {
  const models: Model[] = []
  try {
    const pager = await client.models.list({ config: { pageSize: 100 } })
    for await (const m of pager) models.push(m)
  } catch (err) {
    mapGeminiError(err)
  }
  return filterGeminiModels(models)
}
