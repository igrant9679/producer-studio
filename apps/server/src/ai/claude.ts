// Claude API access (@anthropic-ai/sdk). Model claude-opus-5 with adaptive thinking and the server-side
// refusal fallback (`fallbacks: "default"`, beta server-side-fallback-2026-07-01).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { HttpError } from '../http'

export const MODEL = 'claude-opus-5'
export const BETAS = ['server-side-fallback-2026-07-01']

let client: Anthropic | undefined

/** True when the SDK has a credential source to resolve (env key/token, profile, WIF, or an `ant` config dir). */
export function aiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true
  if (env.ANTHROPIC_FEDERATION_RULE_ID && (env.ANTHROPIC_IDENTITY_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE)) return true
  const dirs = [env.ANTHROPIC_CONFIG_DIR, path.join(os.homedir(), '.config', 'anthropic'), env.APPDATA ? path.join(env.APPDATA, 'anthropic') : undefined]
  return dirs.some((d) => d && fs.existsSync(path.join(d, 'configs')))
}

export const NOT_CONFIGURED = 'AI is not configured — add a key in Settings'
export const notConfigured = () => new HttpError(503, 'server', NOT_CONFIGURED)

/** Client for a user-supplied key (never cached here; the resolver caches providers per scope + settings). */
export function keyClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2 })
}

export function getClient(): Anthropic {
  if (!aiConfigured()) throw notConfigured()
  if (!client) {
    try {
      client = new Anthropic({ maxRetries: 3 })
    } catch {
      throw notConfigured()
    }
  }
  return client
}

/**
 * Translate SDK errors into API errors (typed classes, most specific first). `keyed` = a user-supplied key, so auth
 * failures blame the key (and say where to fix it) instead of the server configuration.
 */
export function mapAiError(err: unknown, opts: { keyed?: boolean; model?: string } = {}): never {
  if (err instanceof HttpError) throw err
  if (err instanceof Anthropic.APIUserAbortError) throw err
  if (err instanceof Anthropic.AuthenticationError) throw opts.keyed ? new HttpError(400, 'invalid', 'The Anthropic API key was rejected. Check or replace it in Settings → AI.') : notConfigured()
  if (err instanceof Anthropic.PermissionDeniedError) throw opts.keyed ? new HttpError(403, 'forbidden', 'This Anthropic API key isn’t allowed to use that model or feature.') : notConfigured()
  if (err instanceof Anthropic.NotFoundError) throw new HttpError(404, 'not_found', `Anthropic model “${opts.model ?? MODEL}” was not found. Pick another model in Settings → AI.`)
  if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'quota', opts.keyed ? 'Anthropic rate limit or quota reached for this key. Try again in a moment or check your plan’s limits.' : 'The AI service is busy right now. Please try again in a moment.')
  if (err instanceof Anthropic.BadRequestError) {
    if (opts.keyed && /credit balance|billing/i.test(err.message)) throw new HttpError(429, 'quota', 'Your Anthropic account is out of credit. Add credit in the Anthropic console.')
    throw new HttpError(400, 'invalid', `AI request rejected: ${err.message}`)
  }
  if (err instanceof Anthropic.APIConnectionError) throw new HttpError(502, 'server', 'Could not reach the AI service')
  if (err instanceof Anthropic.APIError) throw new HttpError(502, 'server', `AI request failed (${err.status ?? 'network'})`)
  if (err instanceof Anthropic.AnthropicError) throw notConfigured()
  throw err
}

/** Throw a readable error for stop reasons that mean the content is unusable. */
export function checkStop(msg: { stop_reason: string | null }, what: string) {
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'invalid', `The AI declined to ${what}. Try rephrasing the request.`)
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, 'server', `The AI response for ${what} was cut off (too long).`)
}

export function textOf(content: Array<{ type: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

const WRITE_SYSTEM: Record<string, string> = {
  voiceover:
    'You write voiceover narration for short videos. Output only the words the narrator will say: plain spoken prose, warm and clear, one idea per sentence, no stage directions, headings, quotes or markdown. Spell numbers and acronyms the way they should be spoken.',
  script:
    'You write short video scripts. Output a sequence of scenes, each as a short title line followed by the narration paragraph. Keep narration conversational and concrete; no markdown beyond line breaks.',
  headline: 'You write on-screen video headlines. Output one headline of 2 to 7 words, no quotes, no trailing period.',
  caption: 'You write social media captions for videos. Output one caption of one to three sentences, optionally ending with up to three relevant hashtags. No quotes.',
  rewrite: 'You rewrite text as requested, preserving meaning and facts. Output only the rewritten text, no preamble or quotes.',
}

/** System prompt + user message for the AI writer (shared by every provider). */
export function writePrompt(kind: string, prompt: string, context?: string, maxWords?: number): { system: string; user: string } {
  const system = WRITE_SYSTEM[kind] ?? WRITE_SYSTEM.rewrite
  const parts = [prompt.trim()]
  if (context?.trim()) parts.push(`Context:\n${context.trim()}`)
  if (maxWords) parts.push(`Keep it under ${maxWords} words.`)
  return { system, user: parts.join('\n\n') }
}

export function writeRequestParams(kind: string, prompt: string, context?: string, maxWords?: number, model: string = MODEL) {
  const { system, user } = writePrompt(kind, prompt, context, maxWords)
  return {
    model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' as const },
    system,
    messages: [{ role: 'user' as const, content: user }],
  }
}
