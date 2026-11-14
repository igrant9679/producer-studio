// AiProvider over the Anthropic API (@anthropic-ai/sdk): claude-opus-5 by default, adaptive thinking, server-side
// refusal fallback (`fallbacks: "default"`, beta server-side-fallback-2026-07-01), streaming for long outputs.
// Two ids: `anthropic-api` = the server's own credentials (env), `anthropic-key` = a user-supplied key + model.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { WriteRequest } from '@producer/core'
import { HttpError } from '../http'
import { noteTokens } from '../services/metering'
import { BETAS, MODEL, aiConfigured, checkStop, getClient, keyClient, mapAiError, textOf, writeRequestParams } from './claude'
import type { AgentRequest, AiProvider, ProviderStatus, StructuredRequest } from './provider'

const isApiError = (err: unknown) => err instanceof Anthropic.APIError

type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
/** Tokens a response used, for the space's usage (cached input counted as input: the estimate errs high). */
const noteUsage = (u: Usage | null | undefined) => noteTokens((u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), u?.output_tokens)

export interface AnthropicProviderOptions {
  /** User-supplied key; omitted = the server's own credentials (env / profile). */
  apiKey?: string
  model?: string
  /** Injected client (tests). */
  client?: Anthropic
}

/** Output room of a structured answer (thinking included), streamed; and what a model that allows less is asked for. */
export const STRUCTURED_MAX_TOKENS = 64000
export const STRUCTURED_MIN_TOKENS = 16000

export class AnthropicApiProvider implements AiProvider {
  readonly id: 'anthropic-api' | 'anthropic-key'
  readonly model: string
  private readonly keyed: boolean
  private client?: Anthropic

  constructor(opts: AnthropicProviderOptions = {}) {
    this.keyed = Boolean(opts.apiKey || opts.client)
    this.id = this.keyed ? 'anthropic-key' : 'anthropic-api'
    this.model = opts.model?.trim() || MODEL
    this.client = opts.client ?? (opts.apiKey ? keyClient(opts.apiKey) : undefined)
  }

  private getClient(): Anthropic {
    return this.client ?? getClient()
  }

  private fail(err: unknown): never {
    mapAiError(err, { keyed: this.keyed, model: this.model })
  }

  async status(): Promise<ProviderStatus> {
    if (this.keyed) return { available: true, detail: 'Anthropic API · your key', model: this.model }
    return aiConfigured()
      ? { available: true, detail: 'Anthropic API', model: this.model }
      : { available: false, detail: 'ANTHROPIC_API_KEY is not set on this server', model: this.model }
  }

  async write(req: WriteRequest, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
    const client = this.getClient()
    try {
      const stream = client.beta.messages.stream(
        {
          ...writeRequestParams(req.kind, req.prompt, req.context, req.maxWords, this.model),
          betas: BETAS,
          // @ts-expect-error SDK 0.110 types `fallbacks` as an array only; the "default" scalar form (beta server-side-fallback-2026-07-01) routes refusals by category server-side.
          fallbacks: 'default',
        },
        { signal },
      )
      stream.on('text', (d) => onDelta(d))
      const msg = await stream.finalMessage()
      noteUsage(msg.usage)
      checkStop(msg, 'write this')
      return textOf(msg.content).trim()
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * The output room of a structured answer. The model's thinking and its answer share it, and an animation's code with
   * the reasoning behind it does not fit in the 16,000 a request that isn't streamed is held to: every AI-drawn scene
   * came back "cut off" on the strongest models. So the request is streamed and given STRUCTURED_MAX_TOKENS; a model
   * that allows less says so (400), and is asked again within STRUCTURED_MIN_TOKENS from then on.
   */
  private structuredMax = STRUCTURED_MAX_TOKENS

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const client = this.getClient()
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    for (const img of req.images) {
      content.push({ type: 'text', text: img.label })
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
    }
    content.push({ type: 'text', text: req.prompt })
    // one repair retry when the output fails validation (the SDK parses + validates with the zod schema)
    for (let attempt = 0; attempt < 2; attempt++) {
      let parsed: T | null = null
      try {
        const ask = (maxTokens: number) => {
          const stream = client.beta.messages.stream(
              {
                model: this.model,
                max_tokens: maxTokens,
                thinking: { type: 'adaptive' },
                betas: BETAS,
                // @ts-expect-error SDK 0.110 types `fallbacks` as an array only; the "default" scalar form (beta server-side-fallback-2026-07-01) routes refusals by category server-side.
                fallbacks: 'default',
                system: req.system,
                messages: [
                  {
                    role: 'user',
                    content: attempt ? [...content, { type: 'text', text: 'Your previous answer did not match the required JSON schema. Answer again with JSON that matches it exactly.' }] : content,
                  },
                ],
                output_config: { format: betaZodOutputFormat(req.schema) },
              },
              { signal: req.signal },
            )
          // a long answer (thinking, then thousands of lines of code) says it is still coming
          if (req.onActivity) stream.on('streamEvent', req.onActivity)
          return stream.finalMessage()
        }
        let msg: Awaited<ReturnType<typeof ask>>
        try {
          msg = await ask(this.structuredMax)
        } catch (err) {
          // an older model with a smaller output limit refuses the request outright and names the parameter
          if (!(err instanceof Anthropic.BadRequestError) || !/max_tokens/.test(err.message) || this.structuredMax <= STRUCTURED_MIN_TOKENS) throw err
          this.structuredMax = STRUCTURED_MIN_TOKENS
          msg = await ask(this.structuredMax)
        }
        noteUsage(msg.usage)
        checkStop(msg, 'complete this request')
        parsed = (msg.parsed_output as T | null | undefined) ?? null
      } catch (err) {
        // parse/validation failures are local (not API errors): retry once; everything else maps to a user-facing error
        if (attempt === 0 && !(err instanceof HttpError) && !isApiError(err) && !req.signal?.aborted) continue
        this.fail(err)
      }
      if (parsed != null) return parsed
    }
    throw new HttpError(502, 'server', 'The AI response did not match the expected format')
  }

  async runAgent(req: AgentRequest): Promise<{ text: string }> {
    const client = this.getClient()
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.inputSchema } as Anthropic.Beta.BetaTool['input_schema'],
      eager_input_streaming: true,
    }))
    // merge consecutive same-role turns and start on a user turn
    const messages: Anthropic.Beta.BetaMessageParam[] = []
    for (const m of req.messages) {
      const last = messages[messages.length - 1]
      if (last && last.role === m.role && typeof last.content === 'string') last.content += `\n\n${m.text}`
      else messages.push({ role: m.role, content: m.text })
    }
    while (messages.length && messages[0].role !== 'user') messages.shift()
    let finalText = ''
    for (let iter = 0; iter < req.maxIterations; iter++) {
      let msg: Anthropic.Beta.BetaMessage
      try {
        const stream = client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            betas: BETAS,
            // @ts-expect-error SDK 0.110 types `fallbacks` as an array only; the "default" scalar form (beta server-side-fallback-2026-07-01) routes refusals by category server-side.
            fallbacks: 'default',
            system: req.system,
            tools,
            messages,
          },
          { signal: req.signal },
        )
        stream.on('text', (d) => req.onText(d))
        msg = await stream.finalMessage()
        noteUsage(msg.usage)
      } catch (err) {
        this.fail(err)
      }
      const text = textOf(msg.content)
      if (text) finalText += (finalText ? '\n' : '') + text
      if (msg.stop_reason === 'refusal') throw new HttpError(422, 'invalid', 'The assistant declined this request.')
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (msg.stop_reason === 'max_tokens' && uses.length) throw new HttpError(502, 'server', 'The assistant response was cut off')
      messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] })
      if (msg.stop_reason === 'pause_turn') continue
      if (msg.stop_reason !== 'tool_use' || !uses.length) break
      // all tool results go back in one user message
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const u of uses) {
        const r = await req.runTool(u.name, u.input)
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: results })
      if (iter === req.maxIterations - 1) finalText += (finalText ? '\n' : '') + 'I stopped after the maximum number of steps; the changes so far are applied.'
    }
    return { text: finalText }
  }
}
