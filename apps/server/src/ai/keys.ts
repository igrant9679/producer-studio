// Key validation (a cheap model-list call) and provider construction for the bring-your-own-key providers.
import Anthropic from '@anthropic-ai/sdk'
import type { AiKeyProvider, AiKeyTestResult } from '@producer/core'
import { HttpError } from '../http'
import { log } from '../log'
import { AnthropicApiProvider } from './anthropic'
import { keyClient, mapAiError } from './claude'
import { FALLBACK_MODEL, PROVIDER_LABEL, filterAnthropicModels, pickDefaultModel, redact } from './common'
import { type GeminiClientLike, GeminiProvider, geminiClient, listGeminiModels } from './gemini'
import { type OpenAiClientLike, OpenAiProvider, listOpenAiModels, openAiClient } from './openai'
import type { AiProvider } from './provider'

/** Model-listing slice of the Anthropic client. */
export interface AnthropicClientLike {
  models: { list(params?: { limit?: number }): AsyncIterable<{ id: string }> }
}

export interface KeyClients {
  openai: (key: string) => OpenAiClientLike
  gemini: (key: string) => GeminiClientLike
  anthropic: (key: string) => AnthropicClientLike & Partial<Anthropic>
}

const realClients: KeyClients = {
  openai: openAiClient,
  gemini: geminiClient,
  anthropic: (key) => keyClient(key),
}
let clients: KeyClients = realClients

/** Test hook: fake SDK clients (no network). Pass undefined to restore the real SDKs. */
export function setKeyClients(c: Partial<KeyClients> | undefined) {
  clients = c ? { ...realClients, ...c } : realClients
}

/** Basic shape check before we store or send a key anywhere. */
export function checkKeyShape(provider: AiKeyProvider, key: string): string {
  const k = key.trim()
  if (k.length < 8 || k.length > 400 || /\s/.test(k)) throw new HttpError(400, 'invalid', `That doesn’t look like a${provider === 'openai' ? 'n' : ''} ${PROVIDER_LABEL[provider]} API key.`)
  return k
}

async function listAnthropicModels(client: AnthropicClientLike): Promise<string[]> {
  const ids: string[] = []
  try {
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id)
  } catch (err) {
    mapAiError(err, { keyed: true })
  }
  return filterAnthropicModels(ids)
}

export async function listModels(provider: AiKeyProvider, key: string): Promise<string[]> {
  if (provider === 'openai') return listOpenAiModels(clients.openai(key))
  if (provider === 'gemini') return listGeminiModels(clients.gemini(key))
  return listAnthropicModels(clients.anthropic(key))
}

/** Validate a key with a model-list call; never throws for key problems (they come back as ok:false + detail). */
export async function testKey(provider: AiKeyProvider, key: string): Promise<AiKeyTestResult> {
  try {
    const models = await listModels(provider, key)
    const defaultModel = pickDefaultModel(provider, models)
    return { ok: true, models, defaultModel, detail: `✓ valid · ${models.length} model${models.length === 1 ? '' : 's'}` }
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, models: [], detail: redact(err.message) }
    log.warn('ai key test failed', { provider, error: redact(err instanceof Error ? err.message : String(err)) })
    return { ok: false, models: [], detail: `Couldn’t check the ${PROVIDER_LABEL[provider]} key. Try again.` }
  }
}

/** Provider instance for a stored key + model. */
export function buildKeyProvider(provider: AiKeyProvider, key: string, model: string): AiProvider {
  const m = model.trim() || FALLBACK_MODEL[provider]
  if (provider === 'openai') return new OpenAiProvider({ client: clients.openai(key), model: m })
  if (provider === 'gemini') return new GeminiProvider({ client: clients.gemini(key), model: m })
  const c = clients.anthropic(key)
  return new AnthropicApiProvider({ client: c as Anthropic, model: m })
}
