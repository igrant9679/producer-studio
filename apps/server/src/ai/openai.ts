// AiProvider over the OpenAI Responses API (`openai` SDK 7.x) with a user-supplied key.
//   write()      – streamed `responses.create({stream: true})`, text deltas relayed as they arrive.
//   structured() – `text.format` = JSON schema (strict when the schema allows it), images inline as base64 data URLs,
//                  validated with zod afterwards, one repair turn on a validation failure.
//   runAgent()   – manual function-calling loop over the shared ToolSpecs: every function_call in a turn (parallel
//                  calls included) runs through req.runTool; tool errors go back as function_call_output text.
// Output items are replayed with the SDK's toResponseInputItems() so reasoning / tool-call items stay paired.
import OpenAI from 'openai'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'
import type { WriteRequest } from '@producer/core'
import { HttpError } from '../http'
import { log } from '../log'
import { writePrompt } from './claude'
import { adaptJsonSchema, filterOpenAiModels, formatMismatch, jsonSchemaFor, redact, repairPrompt, validateStructured } from './common'
import type { AgentRequest, AiProvider, ProviderStatus, StructuredRequest } from './provider'

/** The slice of the SDK client this provider uses (tests inject a fake). */
export interface OpenAiClientLike {
  responses: { create(body: ResponseCreateParamsStreaming, options?: { signal?: AbortSignal }): PromiseLike<AsyncIterable<ResponseStreamEvent>> }
  models: { list(): AsyncIterable<{ id: string }> }
}

export function openAiClient(apiKey: string): OpenAiClientLike {
  return new OpenAI({ apiKey, maxRetries: 2 }) as unknown as OpenAiClientLike
}

/** Map SDK errors to user-facing API errors (never echoing the key). */
export function mapOpenAiError(err: unknown, model?: string): never {
  if (err instanceof HttpError) throw err
  if (err instanceof OpenAI.APIUserAbortError) throw err
  if (err instanceof OpenAI.AuthenticationError) throw new HttpError(400, 'invalid', 'The OpenAI API key was rejected. Check or replace it in Settings → AI.')
  if (err instanceof OpenAI.PermissionDeniedError) throw new HttpError(403, 'forbidden', 'This OpenAI key isn’t allowed to do that (check the key’s project permissions or your organization’s access to the model).')
  if (err instanceof OpenAI.NotFoundError || (err instanceof OpenAI.APIError && err.code === 'model_not_found'))
    throw new HttpError(404, 'not_found', `OpenAI model “${model ?? '?'}” isn’t available to this key. Pick another model in Settings → AI.`)
  if (err instanceof OpenAI.RateLimitError) {
    if (err.code === 'insufficient_quota') throw new HttpError(429, 'quota', 'Your OpenAI account has run out of quota. Check your plan and billing on platform.openai.com.')
    throw new HttpError(429, 'quota', 'OpenAI rate limit reached for this key. Try again in a moment.')
  }
  if (err instanceof OpenAI.BadRequestError) throw new HttpError(400, 'invalid', `OpenAI rejected the request: ${redact(err.message)}`)
  if (err instanceof OpenAI.APIConnectionError) throw new HttpError(502, 'server', 'Could not reach OpenAI')
  if (err instanceof OpenAI.APIError) throw new HttpError(502, 'server', `OpenAI request failed (${err.status ?? 'network'})`)
  throw err
}

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })

function textOf(output: ResponseOutputItem[]): string {
  let text = ''
  for (const item of output) if (item.type === 'message') for (const c of item.content) if (c.type === 'output_text') text += c.text
  return text
}

function refusalOf(output: ResponseOutputItem[]): string | undefined {
  for (const item of output) if (item.type === 'message') for (const c of item.content) if (c.type === 'refusal') return c.refusal || 'refused'
  return undefined
}

/** Output items that can be sent back as input (reasoning, messages, function calls …). */
function replayable(output: ResponseOutputItem[]): ResponseInputItem[] {
  try {
    return toResponseInputItems(output)
  } catch {
    // an item type this SDK build doesn't know: keep the ones we need
    return output.filter((o) => o.type === 'message' || o.type === 'function_call' || o.type === 'reasoning') as unknown as ResponseInputItem[]
  }
}

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai' as const
  readonly model: string
  private readonly client: OpenAiClientLike

  constructor(opts: { apiKey?: string; model: string; client?: OpenAiClientLike }) {
    if (!opts.client && !opts.apiKey) throw new HttpError(503, 'server', 'No OpenAI key is configured')
    this.model = opts.model
    this.client = opts.client ?? openAiClient(opts.apiKey!)
  }

  async status(): Promise<ProviderStatus> {
    return { available: true, detail: 'OpenAI · your key', model: this.model }
  }

  /** One streamed turn: relays text deltas and returns the final Response (completed or incomplete). */
  private async turn(body: Omit<ResponseCreateParamsStreaming, 'model' | 'stream'>, onText: ((d: string) => void) | undefined, signal: AbortSignal | undefined, what: string): Promise<Response> {
    if (signal?.aborted) throw abortError()
    let final: Response | undefined
    try {
      const stream = await this.client.responses.create({ ...body, model: this.model, stream: true }, { signal })
      for await (const ev of stream) {
        if (ev.type === 'response.output_text.delta') onText?.(ev.delta)
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response
        else if (ev.type === 'response.failed') {
          const e = ev.response.error
          if (e?.code === 'rate_limit_exceeded') throw new HttpError(429, 'quota', 'OpenAI rate limit reached for this key. Try again in a moment.')
          throw new HttpError(502, 'server', `OpenAI couldn’t ${what}: ${redact(e?.message ?? 'the response failed')}`)
        } else if (ev.type === 'error') throw new HttpError(502, 'server', `OpenAI couldn’t ${what}: ${redact(ev.message)}`)
      }
    } catch (err) {
      if (signal?.aborted) throw abortError()
      mapOpenAiError(err, this.model)
    }
    if (!final) throw new HttpError(502, 'server', `The OpenAI response ended before it finished (${what}).`)
    const refusal = refusalOf(final.output)
    if (refusal) throw new HttpError(422, 'invalid', `The AI declined to ${what}. Try rephrasing the request.`)
    if (final.status === 'incomplete') {
      const reason = final.incomplete_details?.reason
      if (reason === 'content_filter') throw new HttpError(422, 'invalid', `The AI declined to ${what} (content filter).`)
      if (reason === 'max_output_tokens' && !final.output.some((o) => o.type === 'function_call')) throw new HttpError(502, 'server', `The AI response for ${what} was cut off (too long).`)
    }
    return final
  }

  async write(req: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const { system, user } = writePrompt(req.kind, req.prompt, req.context, req.maxWords)
    const res = await this.turn({ instructions: system, input: user, max_output_tokens: 8000 }, onDelta, signal, 'write this')
    return textOf(res.output).trim()
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { schema, strict } = jsonSchemaFor(req.schema, 'openai-strict')
    const content: ResponseInputContent[] = []
    for (const img of req.images) {
      content.push({ type: 'input_text', text: img.label })
      content.push({ type: 'input_image', detail: 'auto', image_url: `data:${img.mediaType};base64,${img.data}` })
    }
    content.push({ type: 'input_text', text: req.prompt })
    const input: ResponseInputItem[] = [{ role: 'user', content }]
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.turn(
        { instructions: req.system, input, max_output_tokens: 32000, text: { format: { type: 'json_schema', name: 'output', schema, strict } } },
        undefined,
        req.signal,
        'complete this request',
      )
      const text = textOf(res.output)
      const v = validateStructured(req.schema, text)
      if (v.ok) return v.data
      log.warn('openai structured output failed validation', { attempt, error: v.error })
      input.push(...replayable(res.output), { role: 'user', content: repairPrompt(v.error) })
    }
    throw formatMismatch()
  }

  async runAgent(req: AgentRequest): Promise<{ text: string }> {
    const tools: FunctionTool[] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: adaptJsonSchema({ type: 'object', ...t.inputSchema }, 'openai-tool').schema,
      strict: false,
    }))
    const input: ResponseInputItem[] = []
    for (const m of req.messages) if (m.text.trim()) input.push({ role: m.role, content: m.text })
    while (input.length && (input[0] as { role?: string }).role !== 'user') input.shift()
    let finalText = ''
    for (let iter = 0; iter < req.maxIterations; iter++) {
      const res = await this.turn({ instructions: req.system, input, tools, parallel_tool_calls: true, max_output_tokens: 16000 }, req.onText, req.signal, 'finish the edit')
      const text = textOf(res.output)
      if (text) finalText += (finalText ? '\n' : '') + text
      const calls = res.output.filter((o): o is Extract<ResponseOutputItem, { type: 'function_call' }> => o.type === 'function_call')
      if (res.status === 'incomplete' && calls.length) throw new HttpError(502, 'server', 'The assistant response was cut off')
      input.push(...replayable(res.output))
      if (!calls.length) break
      for (const call of calls) {
        if (req.signal?.aborted) throw abortError()
        let args: unknown
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {}
        } catch {
          input.push({ type: 'function_call_output', call_id: call.call_id, output: `Error: the arguments for ${call.name} were not valid JSON.` })
          continue
        }
        const r = await req.runTool(call.name, args)
        input.push({ type: 'function_call_output', call_id: call.call_id, output: r.isError ? `Error: ${r.content}` : r.content })
      }
      if (iter === req.maxIterations - 1) finalText += (finalText ? '\n' : '') + 'I stopped after the maximum number of steps; the changes so far are applied.'
    }
    return { text: finalText }
  }
}

/** Validate a key by listing models; returns the chat/text-capable ids (newest first). */
export async function listOpenAiModels(client: OpenAiClientLike): Promise<string[]> {
  const ids: string[] = []
  try {
    for await (const m of client.models.list()) ids.push(m.id)
  } catch (err) {
    mapOpenAiError(err)
  }
  return filterOpenAiModels(ids)
}
