// AI video clips with Wan, hosted by fal.ai, billed to the workspace's own fal.ai key (Settings → AI). Wan's open
// weights (Apache-2.0, github.com/Wan-Video) need data-centre GPUs, so Producer Studio runs them through fal's queue
// API rather than on its own servers:
//   POST https://queue.fal.run/<model>                       → { request_id, status_url, response_url, cancel_url }
//   GET  status_url                                          → { status: IN_QUEUE | IN_PROGRESS | COMPLETED, queue_position? }
//   GET  response_url                                        → { video: { url, content_type? }, seed }
//   PUT  cancel_url                                          (a fired signal, or the 15-minute limit)
// with `Authorization: Key <key>`. The clip is then downloaded from fal's CDN (no key sent there). The key is only ever
// sent to fal's own hosts: URLs fal hands back are used only when they are https on *.fal.run.
// Key test: GET https://api.fal.ai/v1/models/pricing (costs nothing, needs a valid key) — and it says what a clip costs.
// Checked on 2026-11-10 against fal's model pages and queue OpenAPI (fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video,
// …/v2.7/text-to-video, fal.ai/docs/platform-apis/v1/models/pricing). fal says Wan 2.2 A14B will be removed on
// 2027-01-04; when it answers 404 the next candidate (Wan 2.7) is used, like any model a key can't use.
import { HttpError } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { redact } from '../common'
import type { GenAspect } from './index'

export interface FalVideoModel {
  id: string
  /** For people: settings, errors, the asset's provenance. */
  name: string
  minSeconds: number
  maxSeconds: number
  /** The request body for one clip (seconds already clamped to the model's range). */
  input(o: { prompt: string; aspect: GenAspect; seconds: number }): Record<string, unknown>
}

/** What a clip must not show; the scene writer already asks for no words or logos, and Wan honours a negative prompt. */
const NEGATIVE = 'text, words, letters, captions, subtitles, watermark, logo, signature, blurry, low quality, jpeg artifacts, distorted, deformed hands, extra limbs, flicker'

/** Wan 2.2 A14B renders at 16 fps (fal then interpolates to 32): `num_frames` 17–161, so 1–10 s. */
const WAN22_FPS = 16

export const FAL_VIDEO_MODELS: FalVideoModel[] = [
  {
    id: 'fal-ai/wan/v2.2-a14b/text-to-video',
    name: 'Wan 2.2',
    minSeconds: 2,
    maxSeconds: 10,
    input: ({ prompt, aspect, seconds }) => ({
      prompt,
      negative_prompt: NEGATIVE,
      aspect_ratio: aspect,
      resolution: '720p',
      num_frames: Math.min(161, Math.max(17, Math.round(seconds * WAN22_FPS) + 1)),
      frames_per_second: WAN22_FPS,
      enable_prompt_expansion: false,
      enable_safety_checker: true,
    }),
  },
  {
    // Wan 2.2's successor on fal: whole seconds 2–15; 720p (its default is 1080p, half again the price). Without an
    // audio_url it adds music, which doesn't matter here: AI clips are placed muted under the narration.
    id: 'fal-ai/wan/v2.7/text-to-video',
    name: 'Wan 2.7',
    minSeconds: 2,
    maxSeconds: 15,
    input: ({ prompt, aspect, seconds }) => ({
      prompt: prompt.slice(0, 5000),
      negative_prompt: NEGATIVE.slice(0, 500),
      aspect_ratio: aspect,
      resolution: '720p',
      duration: seconds,
      enable_prompt_expansion: false,
      enable_safety_checker: true,
    }),
  },
]

export const falModelName = (id: string) => FAL_VIDEO_MODELS.find((m) => m.id === id)?.name ?? id

const QUEUE = 'https://queue.fal.run'
const PRICING = 'https://api.fal.ai/v1/models/pricing'
/** A clip of 10 s at 720p is a few MB; anything near this is not a clip. */
const MAX_CLIP_BYTES = 512 * 1024 * 1024
const REFUSAL = /(content.?polic|safety|nsfw|polic(y|ies)|blocked|prohibited|violat|sensitive)/i

/** An HTTP answer from fal that wasn't a success: `status` lets the model fallback tell "no such model" (404) apart. */
export class FalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind?: string,
  ) {
    super(message)
    this.name = 'FalError'
  }
}

export interface FalDeps {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** fal's own hosts only: the key must never follow a URL somewhere else. */
function falUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && (url.hostname === 'fal.run' || url.hostname.endsWith('.fal.run')) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** fal's error text: `detail` (a string, or FastAPI's [{ msg, type }]), `error.message`, or `message`. */
function errorText(body: unknown): { text: string; kind?: string } {
  const b = body as { detail?: unknown; error?: unknown; message?: unknown; error_type?: unknown } | null
  if (!b || typeof b !== 'object') return { text: '' }
  if (typeof b.detail === 'string') return { text: b.detail }
  if (Array.isArray(b.detail)) {
    const items = b.detail as Array<{ msg?: unknown; type?: unknown }>
    return { text: items.map((d) => (typeof d?.msg === 'string' ? d.msg : '')).filter(Boolean).join('; '), kind: items.map((d) => d?.type).find((t): t is string => typeof t === 'string') }
  }
  if (b.error && typeof b.error === 'object') {
    const e = b.error as { message?: unknown; type?: unknown }
    return { text: typeof e.message === 'string' ? e.message : '', kind: typeof e.type === 'string' ? e.type : undefined }
  }
  if (typeof b.error === 'string') return { text: b.error, kind: typeof b.error_type === 'string' ? b.error_type : undefined }
  return { text: typeof b.message === 'string' ? b.message : '' }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 300) }
  }
}

async function call(deps: FalDeps, key: string, method: string, url: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const res = await deps.fetch(url, {
    method,
    headers: { Authorization: `Key ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
  })
  const json = await readJson(res)
  if (!res.ok) {
    const { text, kind } = errorText(json)
    throw new FalError(res.status, text || res.statusText || `HTTP ${res.status}`, kind)
  }
  return json
}

const refused = () => new HttpError(422, 'invalid', 'fal.ai declined to make this clip (Wan’s content rules). Try describing the scene differently.')

/** A fal error in words for people. `model` names the clip's model in a 404. */
export function mapFalError(err: unknown): never {
  if (err instanceof HttpError || err instanceof CancelledError) throw err
  if (err instanceof FalError) {
    const msg = err.message
    if (err.kind === 'content_policy_violation' || ((err.status === 400 || err.status === 422) && REFUSAL.test(msg))) throw refused()
    if (err.status === 401) throw new HttpError(503, 'server', 'fal.ai didn’t accept this space’s key. An owner can replace it in Settings → AI.')
    if (err.status === 402 || (err.status === 403 && /(balance|locked|billing|credit|payment)/i.test(msg)))
      throw new HttpError(429, 'quota', 'This fal.ai account is out of credit. Top it up in fal.ai’s billing page, then try again.')
    if (err.status === 403) throw new HttpError(503, 'server', `fal.ai refused this key: ${redact(msg).slice(0, 200)}. Check its permissions on fal.ai (an API key is needed).`)
    if (err.status === 429) throw new HttpError(429, 'quota', 'fal.ai’s rate limit was reached for this key. Try again in a moment.')
    if (err.status >= 500) throw new HttpError(502, 'server', 'fal.ai had a problem making the clip. Try again in a moment.')
    throw new HttpError(502, 'server', `fal.ai couldn’t make this clip: ${redact(msg).slice(0, 300) || `HTTP ${err.status}`}`)
  }
  if (err instanceof TypeError || (err instanceof Error && /(ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network)/i.test(err.message))) throw new HttpError(502, 'server', 'Could not reach fal.ai')
  throw err
}

export interface FalClipOptions {
  prompt: string
  aspect: GenAspect
  seconds: number
  signal?: AbortSignal
  timeoutMs: number
  pollFirstMs: number
  pollMaxMs: number
  typicalMs: number
  maxPollErrors: number
}

/** One clip from one fal model: queue it, wait for it, download it. Throws FalError for the caller's fallback/mapping. */
export async function falClip(
  deps: FalDeps,
  key: string,
  m: FalVideoModel,
  o: FalClipOptions,
  say: (fraction: number, message: string) => void,
): Promise<{ bytes: Buffer; mime: string; seconds: number }> {
  const seconds = Math.min(m.maxSeconds, Math.max(m.minSeconds, Math.round(o.seconds)))
  const started = deps.now()
  const deadline = started + o.timeoutMs
  const sub = (await call(deps, key, 'POST', `${QUEUE}/${m.id}`, o.signal, m.input({ prompt: o.prompt, aspect: o.aspect, seconds }))) as {
    request_id?: unknown
    status_url?: unknown
    response_url?: unknown
    cancel_url?: unknown
    status?: unknown
    queue_position?: unknown
  }
  const id = typeof sub?.request_id === 'string' && /^[\w-]{1,100}$/.test(sub.request_id) ? sub.request_id : undefined
  if (!id) throw new HttpError(502, 'server', 'fal.ai accepted the clip but sent back no request id. Try again.')
  const base = `${QUEUE}/${m.id}/requests/${id}`
  const statusUrl = falUrl(sub.status_url) ?? `${base}/status`
  const responseUrl = falUrl(sub.response_url) ?? base
  const cancelUrl = falUrl(sub.cancel_url) ?? `${base}/cancel`
  const cancel = async () => {
    try {
      await call(deps, key, 'PUT', cancelUrl, AbortSignal.timeout(10_000))
    } catch (err) {
      log.warn('could not cancel a fal clip', { id, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) })
    }
  }
  let status = typeof sub.status === 'string' ? sub.status : 'IN_QUEUE'
  let last: Record<string, unknown> = sub as Record<string, unknown>
  let wait = o.pollFirstMs
  let errors = 0
  try {
    while (status !== 'COMPLETED') {
      const left = deadline - deps.now()
      if (left <= 0) {
        await cancel()
        throw new HttpError(504, 'server', `The AI clip wasn’t ready after ${o.timeoutMs / 60_000} minutes, so it was stopped. Try again, perhaps with a simpler scene.`)
      }
      await deps.sleep(Math.min(wait, left), o.signal)
      wait = Math.min(o.pollMaxMs, Math.round(wait * 1.5))
      try {
        last = ((await call(deps, key, 'GET', `${statusUrl}${statusUrl.includes('?') ? '&' : '?'}logs=0`, o.signal)) ?? {}) as Record<string, unknown>
        errors = 0
      } catch (err) {
        const s = err instanceof FalError ? err.status : undefined
        if (o.signal?.aborted || ++errors > o.maxPollErrors || (s !== undefined && s !== 429 && s < 500)) throw err
        log.warn('fal clip status check failed, retrying', { id, status: s, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) })
        continue
      }
      status = typeof last.status === 'string' ? last.status : status
      const pos = typeof last.queue_position === 'number' && last.queue_position > 0 ? ` (${last.queue_position} ahead)` : ''
      say(0.05 + 0.85 * (1 - Math.exp(-(deps.now() - started) / o.typicalMs)), status === 'IN_QUEUE' ? `Waiting in fal.ai’s queue${pos}` : 'Generating the clip')
    }
  } catch (err) {
    if (o.signal?.aborted || err instanceof CancelledError) {
      await cancel()
      throw new CancelledError()
    }
    throw err
  }
  // a failed request completes too: its status may carry the error, and its result answers with one
  if (last.error) {
    const { text, kind } = errorText(last)
    throw new FalError(422, text, kind ?? (typeof last.error_type === 'string' ? last.error_type : undefined))
  }
  const out = (await call(deps, key, 'GET', responseUrl, o.signal)) as { video?: { url?: unknown; content_type?: unknown } } | undefined
  const url = out?.video?.url
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new HttpError(502, 'server', 'fal.ai finished the clip but didn’t say where it is. Try again.')
  say(0.92, 'Downloading the clip')
  // the CDN link needs no key, so none is sent
  const res = await deps.fetch(url, { signal: o.signal })
  if (!res.ok) throw new HttpError(502, 'server', `Couldn’t download the clip from fal.ai (HTTP ${res.status}). Try again.`)
  const size = Number(res.headers.get('content-length') ?? 0)
  if (size > MAX_CLIP_BYTES) throw new HttpError(502, 'server', 'fal.ai sent back a file far larger than a clip.')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_CLIP_BYTES) throw new HttpError(502, 'server', 'fal.ai sent back a file far larger than a clip.')
  const type = typeof out?.video?.content_type === 'string' ? out.video.content_type : (res.headers.get('content-type') ?? '')
  return { bytes, mime: type.startsWith('video/') ? type.split(';')[0] : 'video/mp4', seconds }
}

/** "$0.08 per second of video" from a pricing row. */
function priceText(p: { unit_price?: unknown; unit?: unknown; currency?: unknown }): string | undefined {
  if (typeof p.unit_price !== 'number' || !Number.isFinite(p.unit_price)) return undefined
  const cur = typeof p.currency === 'string' ? p.currency.toUpperCase() : 'USD'
  const amount = cur === 'USD' ? `$${p.unit_price}` : `${p.unit_price} ${cur}`
  const unit = typeof p.unit === 'string' ? p.unit.replace(/_/g, ' ').trim() : ''
  const per = /second/i.test(unit) ? 'second of video' : /^videos?$/i.test(unit) ? 'clip' : unit.replace(/s$/, '') || 'clip'
  return `${amount} per ${per}`
}

/**
 * Check a fal.ai key without spending anything: fal's price list needs a valid key. Never throws for key problems:
 * `{ ok: false, detail }` says what's wrong. On success `price` is what a clip costs with the first Wan model listed.
 */
export async function testFalKey(deps: FalDeps, key: string): Promise<{ ok: boolean; detail: string; price?: string }> {
  const ask = async (ids: string[]) => (await call(deps, key, 'GET', `${PRICING}?endpoint_id=${ids.map(encodeURIComponent).join(',')}`, AbortSignal.timeout(20_000))) as { prices?: Array<Record<string, unknown>> }
  try {
    let price: string | undefined
    try {
      const r = await ask(FAL_VIDEO_MODELS.map((m) => m.id))
      for (const m of FAL_VIDEO_MODELS) {
        const row = r?.prices?.find((p) => p.endpoint_id === m.id)
        const t = row && priceText(row)
        if (t) {
          price = `${m.name}: ${t}`
          break
        }
      }
    } catch (err) {
      // a model fal no longer lists can fail the whole query: check the key against a model it certainly lists
      if (!(err instanceof FalError) || (err.status !== 400 && err.status !== 404)) throw err
      await ask(['fal-ai/flux/dev'])
    }
    return { ok: true, detail: price ? `✓ valid · ${price}` : '✓ valid', ...(price ? { price } : {}) }
  } catch (err) {
    if (err instanceof FalError) {
      if (err.status === 401) return { ok: false, detail: 'fal.ai didn’t accept this key. Copy it again from fal.ai → API keys.' }
      if (err.status === 403) return { ok: false, detail: `fal.ai refused this key: ${redact(err.message).slice(0, 200)}` }
      if (err.status === 429) return { ok: false, detail: 'fal.ai’s rate limit was reached. Test the key again in a moment.' }
      return { ok: false, detail: `Couldn’t check the fal.ai key (HTTP ${err.status}). Try again.` }
    }
    log.warn('fal key test failed', { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) })
    return { ok: false, detail: 'Couldn’t reach fal.ai to check the key. Try again.' }
  }
}
