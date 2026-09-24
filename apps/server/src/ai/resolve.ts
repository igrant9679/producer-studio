// Which provider serves a request. Resolution order for (scope, feature):
//   1. the per-feature override, 2. the default provider — each only if it's the built-in provider or a key-backed
//   provider that has a stored key; 3. the built-in provider (cloud: the server's ANTHROPIC_API_KEY; desktop: the
//   Claude Code CLI; AI_PROVIDER overrides); 4. none (503 "AI is not configured — add a key in Settings").
// Key-backed providers are cached per scope + provider + model + key hash, so a changed key or model is picked up on
// the next request and the SDK client is reused otherwise.
import crypto from 'node:crypto'
import type { AiChoice, AiFeature, AiKeyProvider, AiSettings } from '@producer/core'
import { ctx } from '../context'
import { buildKeyProvider } from './keys'
import type { AiProvider, AiScope } from './provider'
import { type AiSettingsDoc, FEATURES, KEY_PROVIDERS, keyMeta, loadDoc, readKey } from './store'

let builtin: AiProvider | undefined

/** The edition's own provider (Claude CLI on desktop, server Anthropic credentials on cloud). */
export async function builtinProvider(): Promise<AiProvider> {
  if (builtin) return builtin
  const id = ctx().config.aiProvider
  if (id === 'claude-cli') {
    const { ClaudeCliProvider } = await import('./cli')
    builtin = new ClaudeCliProvider()
  } else if (id === 'anthropic-api') {
    const { AnthropicApiProvider } = await import('./anthropic')
    builtin = new AnthropicApiProvider()
  } else {
    const { NoProvider } = await import('./cli')
    builtin = new NoProvider()
  }
  return builtin
}

/** Forget cached probes (Claude CLI sign-in state) of the built-in provider. */
export async function invalidateBuiltin() {
  ;((await builtinProvider()) as { invalidate?: () => void }).invalidate?.()
}

const MAX_CACHED = 200
const cache = new Map<string, AiProvider>()

async function keyProvider(scope: AiScope, p: AiKeyProvider, doc: AiSettingsDoc): Promise<AiProvider | undefined> {
  const key = await readKey(scope, p)
  if (!key) return undefined
  const model = doc.providers[p]?.model ?? ''
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  const id = `${scope ?? 'local'}|${p}|${model}|${hash}`
  let prov = cache.get(id)
  if (!prov) {
    prov = buildKeyProvider(p, key, model)
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!)
    cache.set(id, prov)
  }
  // the last key test failed (rejected key, no quota …): report it instead of pretending the provider is ready
  const d = doc.providers[p]
  if (d?.valid === false) return new FailedKeyProvider(prov, d.error || 'The key failed its last test. Test it again in Settings → AI.')
  return prov
}

/** A key provider whose last test failed: status (and so requireProvider's 503) says why until the key is re-tested. */
class FailedKeyProvider implements AiProvider {
  constructor(
    private readonly inner: AiProvider,
    private readonly reason: string,
  ) {}
  get id() {
    return this.inner.id
  }
  async status() {
    const s = await this.inner.status()
    return { ...s, available: false, detail: this.reason }
  }
  write: AiProvider['write'] = (...a) => this.inner.write(...a)
  structured: AiProvider['structured'] = (req) => this.inner.structured(req)
  runAgent: AiProvider['runAgent'] = (req) => this.inner.runAgent(req)
}

export interface Resolved {
  provider: AiProvider
  /** Which step picked it. */
  source: 'feature' | 'default' | 'builtin'
  choice: AiChoice
}

export async function resolveProvider(scope: AiScope, feature?: AiFeature, preloaded?: { doc: AiSettingsDoc; keys: Set<AiKeyProvider> }): Promise<Resolved> {
  const scoped = ctx().config.mode === 'desktop' ? 'local' : scope
  const doc = preloaded?.doc ?? (await loadDoc(scoped))
  const keys = preloaded?.keys ?? new Set(Object.keys(await keyMeta(scoped)) as AiKeyProvider[])
  const candidates: Array<[Resolved['source'], AiChoice | null | undefined]> = [
    ['feature', feature ? doc.perFeature[feature] : undefined],
    ['default', doc.defaultProvider],
  ]
  for (const [source, choice] of candidates) {
    if (!choice) continue
    if (choice === 'builtin') return { provider: await builtinProvider(), source, choice }
    if (!keys.has(choice)) continue
    const p = await keyProvider(scoped, choice, doc)
    if (p) return { provider: p, source, choice }
  }
  return { provider: await builtinProvider(), source: 'builtin', choice: 'builtin' }
}

/** The masked settings document the API returns (no key material, only hasKey + last4). */
export async function describeSettings(scope: AiScope, canEdit: boolean): Promise<AiSettings> {
  const scoped = ctx().config.mode === 'desktop' ? 'local' : scope
  const doc = await loadDoc(scoped)
  const meta = await keyMeta(scoped)
  const keys = new Set(Object.keys(meta) as AiKeyProvider[])
  const b = await builtinProvider()
  const bs = await b.status()
  const providers: AiSettings['providers'] = {}
  for (const p of KEY_PROVIDERS) {
    const d = doc.providers[p]
    const m = meta[p]
    if (!d && !m) continue
    providers[p] = {
      model: d?.model ?? '',
      hasKey: Boolean(m),
      ...(m ? { keyLast4: m.last4, updatedAt: m.updatedAt } : {}),
      ...(d?.models ? { models: d.models } : {}),
      ...(d?.valid !== undefined ? { valid: d.valid } : {}),
      ...(d?.error ? { error: d.error } : {}),
      ...(d?.checkedAt ? { checkedAt: d.checkedAt } : {}),
    }
  }
  const effective = {} as AiSettings['effective']
  for (const f of FEATURES) {
    const r = await resolveProvider(scoped, f, { doc, keys })
    const s = r.provider === b ? bs : await r.provider.status()
    effective[f] = { provider: r.provider.id, model: s.model }
  }
  return { defaultProvider: doc.defaultProvider, perFeature: doc.perFeature, providers, builtin: { id: b.id, available: bs.available, detail: bs.detail, model: bs.model }, effective, canEdit }
}

