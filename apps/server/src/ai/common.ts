// Shared helpers for the bring-your-own-key providers (OpenAI, Gemini, Anthropic key): JSON Schema dialects,
// structured-output validation + repair, model-list filtering/defaults and key redaction.
import * as z from 'zod/v4'
import type { AiKeyProvider } from '@producer/core'
import { HttpError } from '../http'
import { extractJson } from './cli/schema'

// ---------------- redaction ----------------

const KEY_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{6,}/g, /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_*-]{8,}/g, /AIza[0-9A-Za-z_-]{10,}/g, /\b(?:key|api[_-]?key)=[^&\s"']+/gi]

/** Remove anything that looks like an API key from a message before it is logged or returned. */
export function redact(text: string): string {
  let out = text
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

export function last4(key: string): string {
  return key.trim().slice(-4)
}

// ---------------- JSON Schema dialects ----------------

export type SchemaDialect = 'openai-strict' | 'openai-tool' | 'gemini'

/** Keywords each API accepts (others are dropped; descriptions keep their meaning in words). */
const ALLOWED: Record<SchemaDialect, Set<string>> = {
  // OpenAI strict structured outputs: https://platform.openai.com/docs/guides/structured-outputs (supported schemas)
  'openai-strict': new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', 'description', 'title', '$ref', '$defs', 'definitions', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']),
  // non-strict function parameters accept ordinary JSON Schema
  'openai-tool': new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', 'description', 'title', '$ref', '$defs', 'definitions', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'minLength', 'maxLength', 'default']),
  // Gemini responseJsonSchema / parametersJsonSchema subset (see GenerateContentConfig.responseJsonSchema in @google/genai)
  gemini: new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering']),
}

/** Keys whose value is a map of name → subschema. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions'])
/** Keys whose value is a subschema or an array of subschemas. */
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'prefixItems', 'not'])

function adapt(node: unknown, dialect: SchemaDialect): unknown {
  if (Array.isArray(node)) return node.map((n) => adapt(n, dialect))
  if (!node || typeof node !== 'object') return node
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const allowed = ALLOWED[dialect]
  for (const [k, v] of Object.entries(src)) {
    let key = k
    if (dialect === 'openai-strict' && k === 'oneOf') key = 'anyOf'
    if (!allowed.has(key)) continue
    if (SCHEMA_MAPS.has(key) && v && typeof v === 'object') {
      out[key] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([n, s]) => [n, adapt(s, dialect)]))
    } else if (SCHEMA_VALUES.has(key) && v && typeof v === 'object') {
      out[key] = adapt(v, dialect)
    } else out[key] = v
  }
  if (dialect === 'openai-strict' && out.type === 'object' && out.properties && typeof out.properties === 'object') {
    // strict mode: every property required, no extra properties; optional ones become nullable (nulls are stripped
    // again before zod validation, see validateStructured)
    const props = out.properties as Record<string, Record<string, unknown>>
    const required = new Set((out.required as string[] | undefined) ?? [])
    for (const [name, sub] of Object.entries(props)) {
      if (!required.has(name)) props[name] = { anyOf: [sub, { type: 'null' }] }
    }
    out.required = Object.keys(props)
    out.additionalProperties = false
  }
  return out
}

/** True when a schema uses a construct strict mode can't express (records / free-form maps). */
function hasOpenMaps(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasOpenMaps)
  if (!node || typeof node !== 'object') return false
  const o = node as Record<string, unknown>
  if (o.additionalProperties && typeof o.additionalProperties === 'object') return true
  if (o.type === 'object' && !o.properties) return true
  return Object.values(o).some(hasOpenMaps)
}

/** zod → JSON Schema adapted to one API's dialect. */
export function jsonSchemaFor(schema: z.ZodType, dialect: SchemaDialect): { schema: Record<string, unknown>; strict: boolean } {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete json.$schema
  return adaptJsonSchema(json, dialect)
}

export function adaptJsonSchema(json: Record<string, unknown>, dialect: SchemaDialect): { schema: Record<string, unknown>; strict: boolean } {
  if (dialect === 'openai-strict' && hasOpenMaps(json)) return { schema: adapt(json, 'openai-tool') as Record<string, unknown>, strict: false }
  return { schema: adapt(json, dialect) as Record<string, unknown>, strict: dialect === 'openai-strict' }
}

// ---------------- structured output validation ----------------

/** Drop null-valued object properties (strict-mode stand-ins for omitted optional fields). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (!v || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== null) out[k] = stripNulls(x)
  return out
}

export type Validated<T> = { ok: true; data: T } | { ok: false; error: string }

/** Parse model text as JSON and validate it with zod (nulls-as-omitted tolerated). */
export function validateStructured<T>(schema: z.ZodType<T>, text: string): Validated<T> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = extractJson(text)
  }
  if (raw === undefined) return { ok: false, error: 'The reply was not valid JSON.' }
  const a = schema.safeParse(raw)
  if (a.success) return { ok: true, data: a.data }
  const b = schema.safeParse(stripNulls(raw))
  if (b.success) return { ok: true, data: b.data }
  const issues = a.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  return { ok: false, error: issues.join('; ') }
}

export const repairPrompt = (error: string) =>
  `Your previous reply did not match the required JSON schema (${error.slice(0, 600)}). Reply again with only the corrected JSON object.`

export const formatMismatch = () => new HttpError(502, 'server', 'The AI response did not match the expected format')

// ---------------- models ----------------

export const PROVIDER_LABEL: Record<AiKeyProvider, string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** Hardcoded only as a last resort (no live list yet); users can always type another id. */
export const FALLBACK_MODEL: Record<AiKeyProvider, string> = { openai: 'gpt-5.5', gemini: 'gemini-pro-latest', anthropic: 'claude-opus-5' }

/** Main version numbers of a model id (snapshot dates and preview suffixes ignored), e.g. claude-sonnet-4-5 → [4, 5]. */
const NUM = (id: string) =>
  (id.replace(/-(preview|exp|experimental|beta)\b.*$/, '').replace(/\d{4}-\d{2}-\d{2}|\d{8}/g, '').match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 2).map(Number)

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Chat/text-capable OpenAI model ids (drops audio, image, embedding, moderation, realtime, search, TTS …). */
export function filterOpenAiModels(ids: string[]): string[] {
  const keep = ids.filter(
    (id) =>
      /^(gpt-|o\d|chatgpt-)/.test(id) &&
      !/(audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|computer-use|codex|diarize|sora|-deep-research)/.test(id),
  )
  return sortNewest(keep)
}

/** Gemini models that support generateContent and produce text (no embeddings, image/video/TTS-only models). */
export function filterGeminiModels(models: Array<{ name?: string; supportedActions?: string[] }>): string[] {
  const ids = models
    .filter((m) => m.name && (!m.supportedActions || m.supportedActions.includes('generateContent')))
    .map((m) => m.name!.replace(/^models\//, ''))
    .filter((id) => /^gemini-/.test(id) && !/(embedding|imagen|image|tts|audio|live|veo|aqa|robotics|computer-use|native-audio)/.test(id))
  return sortNewest(ids)
}

export function filterAnthropicModels(ids: string[]): string[] {
  return sortNewest(ids.filter((id) => /^claude-/.test(id)))
}

/** Newest version first; stable before preview/experimental/dated snapshots at the same version. */
function sortNewest(ids: string[]): string[] {
  const unstable = (id: string) => (/(preview|exp|experimental|beta)/.test(id) ? 2 : /\d{4}-?\d{2}-?\d{2}|\d{3,}$/.test(id) ? 1 : 0)
  return [...new Set(ids)].sort((a, b) => cmpVersion(NUM(b), NUM(a)) || unstable(a) - unstable(b) || a.length - b.length || a.localeCompare(b))
}

/** Pick the newest general flagship from a live list (falls back to the provider default). */
export function pickDefaultModel(provider: AiKeyProvider, models: string[]): string {
  if (provider === 'anthropic') return models.find((m) => m === 'claude-opus-5') ?? models.find((m) => /^claude-opus-/.test(m)) ?? models[0] ?? FALLBACK_MODEL.anthropic
  if (provider === 'openai') {
    const flagship = models.filter((m) => /^gpt-\d+(\.\d+)?$/.test(m))
    return flagship[0] ?? models.find((m) => /^gpt-\d/.test(m) && !/(mini|nano|pro|chat|oss)/.test(m)) ?? models[0] ?? FALLBACK_MODEL.openai
  }
  const pro = models.filter((m) => /^gemini-\d+(\.\d+)?-pro/.test(m))
  return pro[0] ?? models.find((m) => m === 'gemini-pro-latest') ?? models[0] ?? FALLBACK_MODEL.gemini
}
