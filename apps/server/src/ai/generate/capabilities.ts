// Which media generation a workspace can use right now, and with what: its own OpenAI / Gemini key from Settings → AI
// (never the server's keys) and the first candidate model that works for that key. Also the candidate model lists
// (edit them here) and the test hook for the SDK clients, fetch, ffprobe and the clock.
//   stills – OpenAI GPT Image or Gemini image models; when both keys are stored the space's default provider wins,
//            otherwise OpenAI.
//   clips  – Gemini (Omni Flash) or Wan on fal.ai (fal.ts). With both keys stored the space's video choice wins
//            (Settings → AI), otherwise Gemini. OpenAI shut its Sora video API down on 24 Sep 2026 with no replacement,
//            and Google moved the Gemini API from Veo to Gemini Omni Flash (the Veo 3.1 previews shut down on 22 Oct 2026).
// Candidates are tried in list order. One the key can't use (404, no permission, unknown model) is remembered for
// MEMO_MS and the next is tried: models.list() has been seen advertising image/video models that then 404 for a key.
// Model ids were checked on 2026-10-26 against the SDK types (openai 7.23.0, @google/genai 2.24.0) and the providers'
// docs (developers.openai.com/api/docs/deprecations, ai.google.dev/gemini-api/docs/deprecations, …/docs/omni).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import type { ImageGenerateParamsNonStreaming, ImagesResponse } from 'openai/resources/images'
import { GoogleGenAI } from '@google/genai'
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import type { StoredKeyProvider } from '@producer/core'
import { ctx } from '../../context'
import { HttpError } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { redact } from '../common'
import { LOCAL_SCOPE } from '../provider'
import { type AiSettingsDoc, type KeyMeta, keyMeta, loadDoc, readKey } from '../store'
import { FAL_VIDEO_MODELS, FalError } from './fal'
import type { GenCapabilities, GenProvider } from './index'

// ---------------- candidate models (first that works for the key wins) ----------------

export interface OpenAiImageModel {
  id: string
  /** custom = any WIDTHxHEIGHT in multiples of 16 (GPT Image 2 and later); standard = 1024², 1536×1024, 1024×1536 only. */
  sizes: 'custom' | 'standard'
}
export interface GeminiImageModel {
  id: string
  /** imageConfig.imageSize ('1K' | '2K' | '4K'); unset = the model's default (1K). */
  imageSize?: string
}
export interface GeminiVideoModel {
  id: string
  minSeconds: number
  maxSeconds: number
  /** Reference pictures a request may carry, to keep characters and objects the same from clip to clip. */
  references?: number
  /** Seconds a clip can be extended to, 3–10 s a turn, each turn continuing from the clip so far (Omni's extensions;
   * Google's Omni guide: up to 30 s in all). Absent: one generation is the longest clip. */
  extendTo?: number
}

/** gpt-image-1 shut down on 2026-10-23; gpt-image-1.5 shuts down on 2026-12-01. */
export const OPENAI_IMAGE_MODELS: OpenAiImageModel[] = [
  { id: 'gpt-image-2.5-flare', sizes: 'custom' },
  { id: 'gpt-image-2', sizes: 'custom' },
  { id: 'gpt-image-1.5', sizes: 'standard' },
]
/** Nano Banana models over generateContent (Imagen left the Gemini API on 2026-08-17). 2K because 1K at 16:9 is 1376×768. */
export const GEMINI_IMAGE_MODELS: GeminiImageModel[] = [
  { id: 'gemini-nano-banana-2.1', imageSize: '2K' },
  { id: 'gemini-3.1-flash-image', imageSize: '2K' },
  { id: 'gemini-3.1-flash-lite-image' },
]
/**
 * Gemini Omni Flash, Interactions API. One generation is 3–10 s at 24 fps (Google's Omni page doesn't state the range;
 * third-party docs quoting Google do); longer clips need extensions, not used here.
 */
// Omni 1.2 first (Google's current model, 3-15 s); 1.1 (3-10 s) after it: Google routes 1.1 to 1.2 from 3 Dec 2026
export const GEMINI_VIDEO_MODELS: GeminiVideoModel[] = [
  // (Google's Omni guide: up to 6 reference images a request, 3 per character for up to 2 characters)
  { id: 'gemini-omni-1.2-flash', minSeconds: 3, maxSeconds: 15, references: 6, extendTo: 30 },
  { id: 'gemini-omni-1.1-flash', minSeconds: 3, maxSeconds: 10 },
]

/**
 * Lyria over the Interactions API (Google's music guide, 21 Nov 2026): lyria-3.5 makes a whole song of "a couple of
 * minutes" (MP3, 44.1 kHz stereo, SynthID-watermarked); lyria-3-pro-preview is the older full-song model the SDK still
 * names. Not lyria-3-clip-preview: its songs are always 30 s, too short for the library.
 */
export const GEMINI_MUSIC_MODELS: Array<{ id: string }> = [{ id: 'lyria-3.5' }, { id: 'lyria-3-pro-preview' }]

/**
 * Google accepted the clip, then stopped it with its generic "There was a problem processing your request" (AI Studio
 * logs those as 403: seen when the key's project isn't allowed to use the model). Treated as "this key can't use this
 * model": the next model is tried and the key is passed over for clips for a while (another key takes them).
 */
export class GeminiVideoRefused extends Error {
  readonly status = 403
}

/** How long a model the key couldn't use is skipped (and the one that worked is tried first). */
const MEMO_MS = 10 * 60_000

// ---------------- clients (tests inject fakes) ----------------

/** The slice of the OpenAI client stills use. */
export interface OpenAiMediaClient {
  images: { generate(body: ImageGenerateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<ImagesResponse> }
}

/** The fields of an Interactions API interaction video generation reads (the SDK doesn't export its own type). */
export interface GenInteraction {
  id: string
  status: string
  output_video?: { data?: string; uri?: string; mime_type?: string }
  /** A song (Lyria): the SDK's helper over the last audio block. */
  output_audio?: { data?: string; uri?: string; mime_type?: string }
  /** The raw turns, where the audio block is when the helper isn't filled in. */
  steps?: Array<{ content?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }> }>
  outputs?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }>
  errors?: Array<{ code?: string; message?: string }>
}

/** The slice of the Gemini client stills and clips use. */
export interface GeminiMediaClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> }
  interactions: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<GenInteraction>
    get(id: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<GenInteraction>
    cancel(id: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
    delete?(id: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
  }
}

export interface MediaInfo {
  duration?: number
  width?: number
  height?: number
}

export interface GenerateDeps {
  openai: (key: string) => OpenAiMediaClient
  gemini: (key: string) => GeminiMediaClient
  fetch: typeof fetch
  /** Duration and size of a file we wrote (ffprobe). */
  probe: (file: string, signal?: AbortSignal) => Promise<MediaInfo>
  now: () => number
  /** Wait, or throw CancelledError when the signal fires. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Clips joined end to end into one file (ffmpeg): an extended shot whose turns came back as separate pieces. */
  join: (files: string[], out: string, signal?: AbortSignal) => Promise<void>
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const onAbort = () => {
      clearTimeout(t)
      reject(new CancelledError())
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const realDeps: GenerateDeps = {
  openai: (key) => new OpenAI({ apiKey: key, maxRetries: 2 }) as unknown as OpenAiMediaClient,
  gemini: (key) => new GoogleGenAI({ apiKey: key, vertexai: false }) as unknown as GeminiMediaClient,
  fetch: (input, init) => fetch(input, init),
  probe: async (file, signal) => {
    const { probe } = await import('../../media/process')
    const p = await probe(file, signal)
    return { duration: p.duration, width: p.width, height: p.height }
  },
  now: () => Date.now(),
  sleep,
  join: async (files, out, signal) => {
    const { ffmpeg } = await import('../../media/proc')
    // the concat demuxer's list (the pieces come from one model: the same size, rate and streams), re-encoded so the
    // joins are clean whatever each piece's keyframes
    const list = `${out}.txt`
    await fs.promises.writeFile(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'))
    try {
      await ffmpeg(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out], { signal })
    } finally {
      fs.rm(list, { force: true }, () => undefined)
    }
  },
}
let deps: GenerateDeps = realDeps

export const genDeps = () => deps

/** Test hook: fake SDK clients, fetch, probe and clock (no network). Pass undefined to restore the real ones. */
export function setGenerateClients(c: Partial<GenerateDeps> | undefined) {
  deps = c ? { ...realDeps, ...c } : realDeps
  dead.clear()
  working.clear()
  refusedModels.clear()
}

// ---------------- the workspace's key ----------------

export type GenKind = 'image' | 'video' | 'music'

/** A stored workspace key that can make `kind`. `id` names it in the model memo (scope + provider + key hash). */
export interface GenKey {
  provider: GenProvider
  key: string
  id: string
}

const LABEL: Record<GenProvider, string> = { openai: 'OpenAI', gemini: 'Gemini', fal: 'fal.ai' }
/** The models `p` can make `kind` with, in the order they're tried. */
export function candidates(p: GenProvider, kind: GenKind): GeminiVideoModel[] | Array<{ id: string }> {
  if (kind === 'image') return p === 'openai' ? OPENAI_IMAGE_MODELS : p === 'gemini' ? GEMINI_IMAGE_MODELS : []
  if (kind === 'music') return p === 'gemini' ? GEMINI_MUSIC_MODELS : []
  return p === 'gemini' ? GEMINI_VIDEO_MODELS : p === 'fal' ? FAL_VIDEO_MODELS : []
}

const UNREADABLE = 'The saved AI key for this space can’t be read any more (the server’s secrets key changed). An owner needs to enter it again in Settings → AI.'

function noKey(kind: GenKind, meta: Partial<Record<StoredKeyProvider, KeyMeta>>): HttpError {
  if (kind === 'image') return new HttpError(503, 'server', 'AI images need your own OpenAI or Gemini API key. Add one in Settings → AI.')
  if (kind === 'music') return new HttpError(503, 'server', 'AI music needs a Gemini API key (Google’s Lyria). Add one in Settings → AI.')
  if (meta.openai)
    return new HttpError(503, 'server', 'AI video clips need a Gemini or fal.ai API key (OpenAI shut down its Sora video API in September 2026). Add one in Settings → AI.')
  return new HttpError(503, 'server', 'AI video clips need your own Gemini or fal.ai API key. Add one in Settings → AI.')
}

/** Which providers to try for `kind`, best first: stills follow the default writing provider, clips the video choice. */
function providerOrder(doc: AiSettingsDoc, kind: GenKind): GenProvider[] {
  if (kind === 'image') return doc.defaultProvider === 'gemini' ? ['gemini', 'openai'] : ['openai', 'gemini']
  if (kind === 'music') return ['gemini']
  return doc.videoProvider === 'fal' ? ['fal', 'gemini'] : ['gemini', 'fal']
}

/**
 * The key to use for `kind`, or why there is none. A key whose last test failed, or whose models all failed for it
 * lately, is passed over while another works; a saved key that can't be decrypted stops here (never a fallback).
 */
async function pickKey(workspaceId: string, kind: GenKind, loaded?: { doc: AiSettingsDoc; meta: Partial<Record<StoredKeyProvider, KeyMeta>> }, only?: GenProvider): Promise<GenKey | HttpError> {
  const scope = ctx().config.mode === 'desktop' ? LOCAL_SCOPE : workspaceId
  const doc = loaded?.doc ?? (await loadDoc(scope))
  const meta = loaded?.meta ?? (await keyMeta(scope))
  const stored = providerOrder(doc, kind).filter((p) => meta[p] && candidates(p, kind).length && (!only || p === only))
  if (!stored.length) return only && !meta[only] ? new HttpError(503, 'server', `This needs the space’s ${LABEL[only]} key, and it has none. Add one in Settings → AI.`) : noKey(kind, meta)
  let problem: HttpError | undefined
  for (const p of stored) {
    const d = p === 'fal' ? doc.media?.fal : doc.providers[p]
    if (d?.valid === false) {
      problem ??= new HttpError(503, 'server', d.error || `The ${LABEL[p]} key failed its last test. Test it again in Settings → AI.`)
      continue
    }
    const key = await readKey(scope, p)
    if (!key) return new HttpError(503, 'server', UNREADABLE)
    const k: GenKey = { provider: p, key, id: `${scope}|${p}|${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}` }
    if (!liveModels(k, kind, candidates(p, kind)).length) {
      problem ??= noModels(p, kind, candidates(p, kind).map((m) => m.id))
      continue
    }
    return k
  }
  return problem!
}

/** The key for generating `kind` in this workspace (only `only`'s, when given); 503 with the reason when there is none. */
export async function requireKey(workspaceId: string, kind: GenKind, only?: GenProvider): Promise<GenKey> {
  const k = await pickKey(workspaceId, kind, undefined, only)
  if (k instanceof HttpError) throw k
  return k
}

export async function generationCapabilities(workspaceId: string): Promise<GenCapabilities> {
  const scope = ctx().config.mode === 'desktop' ? LOCAL_SCOPE : workspaceId
  const loaded = { doc: await loadDoc(scope), meta: await keyMeta(scope) }
  const image = await pickKey(workspaceId, 'image', loaded)
  const video = await pickKey(workspaceId, 'video', loaded)
  const { SOURCE_NAMES, stockSources } = await import('./stock')
  const names = (m: 'video' | 'photo') => stockSources(m).map((s) => SOURCE_NAMES[s])
  const out: GenCapabilities = { stock: stockSources('video').length + stockSources('photo').length > 0, stockSources: { video: names('video'), photo: names('photo') } }
  if (!(image instanceof HttpError)) out.image = { provider: image.provider as Exclude<GenProvider, 'fal'>, model: liveModels(image, 'image', candidates(image.provider, 'image'))[0].id }
  if (!(video instanceof HttpError)) {
    const m = liveModels(video, 'video', candidates(video.provider, 'video') as GeminiVideoModel[])[0]
    out.video = { provider: video.provider, model: m.id, maxSeconds: m.maxSeconds }
    // a film's characters stay the same from clip to clip when each clip is given their pictures: the clip model has
    // to take them, and this space has to be able to paint them
    if (video.provider === 'gemini' && m.references && out.image) out.video.references = m.references
    // a scene longer than one generation can be one long shot: the clip extended (Gemini Omni), not repeated
    if (video.provider === 'gemini' && m.extendTo) out.video.extendTo = m.extendTo
    // Wan starts each clip from a picture when this space can paint one; fal's price list says what a second costs
    // (the price is the model's it names: none once clips have moved on to another model)
    if (video.provider === 'fal') {
      if (out.image) out.video.fromPicture = true
      const { falModelName, pricePerSecond } = await import('./fal')
      const price = loaded.doc.media?.fal?.price
      const pps = price?.startsWith(`${falModelName(m.id)}:`) ? pricePerSecond(price) : undefined
      if (pps) out.video.pricePerSecond = pps
    }
  }
  return out
}

// ---------------- model fallback ----------------

const MAX_MEMO = 2000
/** `${key id}|${model}` → until when it's skipped. */
const dead = new Map<string, number>()
/** `${key id}|${kind}` → the model that last worked (tried first). */
const working = new Map<string, { model: string; until: number }>()

function remember<V>(map: Map<string, V>, k: string, v: V) {
  if (map.size >= MAX_MEMO) map.delete(map.keys().next().value!)
  map.set(k, v)
}

/** Video models Google stopped with its generic failure lately (the reason shown when none is left to try). */
const refusedModels = new Set<string>()

/** Candidates the key may still be able to use, the one that last worked first. */
export function liveModels<M extends { id: string }>(k: GenKey, kind: GenKind, list: M[]): M[] {
  const now = deps.now()
  const live = list.filter((m) => (dead.get(`${k.id}|${m.id}`) ?? 0) <= now)
  const w = working.get(`${k.id}|${kind}`)
  const first = w && w.until > now ? live.find((m) => m.id === w.model) : undefined
  return first ? [first, ...live.filter((m) => m !== first)] : live
}

const statusOf = (err: unknown) => (err as { status?: unknown }).status
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err ?? ''))

/** True when the error means "this key can't use this model" (so the next candidate is worth a try). */
export function modelUnavailable(provider: GenProvider, err: unknown): boolean {
  if (err instanceof HttpError) return false
  // fal: a model it doesn't host (any more) is a 404; 403 there means the account (balance, key scope), not the model
  if (provider === 'fal') return err instanceof FalError && (err.status === 404 || err.status === 410)
  if (err instanceof GeminiVideoRefused) return true
  const status = statusOf(err)
  const msg = messageOf(err)
  if (provider === 'openai') {
    if (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.PermissionDeniedError) return true
    if (!(err instanceof OpenAI.APIError)) return false
    if (err.code === 'model_not_found') return true
    return err instanceof OpenAI.BadRequestError && (err.param === 'model' || (/\bmodel\b/i.test(msg) && /(invalid|not supported|unsupported|does not exist|unknown|not available)/i.test(msg)))
  }
  if (status === 404 || status === 403) return true
  return status === 400 && /\bmodel/i.test(msg) && /(not found|not supported|unsupported|no longer available|not available|does not support)/i.test(msg)
}

const unverified = () =>
  new HttpError(403, 'forbidden', 'OpenAI’s image models need a verified organization. Verify it on platform.openai.com (Settings → Organization), then try again.')

/**
 * Account problems that look like rate limits but won't pass by waiting (seen on live keys): OpenAI answers an
 * organization that isn't verified for image models with 429 "… Limit 0"; Gemini answers a key whose project has no
 * billing with 429 "free_tier … limit: 0" (its image and video models have no free tier).
 */
export function accountProblem(p: GenProvider, err: unknown): HttpError | undefined {
  if (statusOf(err) !== 429) return undefined
  const msg = messageOf(err)
  if (p === 'openai' && /limit[:\s]*0\b/i.test(msg)) return unverified()
  if (p === 'gemini' && /free.?tier/i.test(msg) && /limit[:\s]*0\b/i.test(msg))
    return new HttpError(429, 'quota', 'This Gemini key’s Google project has no billing, and Gemini’s image and video models have no free tier. Turn on billing for the project in Google AI Studio, then try again.')
  return undefined
}

/** An error for people, with this key's text removed in case a provider echoed it (some keys escape redact()). */
export function withoutKey(err: unknown, key: string): unknown {
  if (err instanceof HttpError && key && err.message.includes(key)) return new HttpError(err.status, err.code, err.message.split(key).join('[redacted]'), err.details)
  return err
}

function noModels(p: GenProvider, kind: GenKind, tried: string[], last?: unknown): HttpError {
  if (p === 'openai' && /verif/i.test(messageOf(last))) return unverified()
  if (last instanceof GeminiVideoRefused || (p === 'gemini' && kind === 'video' && tried.length && tried.every((id) => refusedModels.has(id))))
    return new HttpError(
      503,
      'server',
      'Google won’t run Gemini’s video models for this key: it takes each clip, then stops it with “There was a problem processing your request”. That usually means the key’s Google project isn’t allowed to use Gemini Omni video yet. Open Google AI Studio → Logs: a 403 on these requests confirms it; check billing is on for the project. Or add a fal.ai key in Settings → AI to make clips with Wan instead.',
    )
  const what = kind
  const where = p === 'openai' ? 'your OpenAI account' : p === 'fal' ? 'your fal.ai account' : 'Google AI Studio'
  return new HttpError(503, 'server', `This ${LABEL[p]} key can’t use any of the ${what} models Producer Studio works with (${tried.join(', ')}). Check the key’s access in ${where}, or add another provider’s key in Settings → AI.`)
}

/**
 * Run `attempt` with each live candidate until one works. Errors that mean "not this model" move on to the next
 * (remembered for MEMO_MS); any other error is thrown as is for the caller to map.
 */
export async function tryModels<M extends { id: string }, T>(k: GenKey, kind: GenKind, list: M[], attempt: (m: M) => Promise<T>): Promise<{ value: T; model: M }> {
  const tried: string[] = []
  let last: unknown
  for (const m of liveModels(k, kind, list)) {
    try {
      const value = await attempt(m)
      remember(working, `${k.id}|${kind}`, { model: m.id, until: deps.now() + MEMO_MS })
      return { value, model: m }
    } catch (err) {
      if (!modelUnavailable(k.provider, err)) throw err
      remember(dead, `${k.id}|${m.id}`, deps.now() + MEMO_MS)
      if (err instanceof GeminiVideoRefused) refusedModels.add(m.id)
      tried.push(m.id)
      last = err
      log.warn('media model not available to this key, trying the next', {
        provider: k.provider,
        model: m.id,
        status: statusOf(err),
        error: redact(messageOf(err)).split(k.key).join('[redacted]').slice(0, 300),
      })
    }
  }
  throw noModels(k.provider, kind, tried.length ? tried : list.map((m) => m.id), last)
}

// ---------------- files ----------------

/** A new file name in outDir (created if missing). */
export function outFile(outDir: string, prefix: string, ext: string): string {
  fs.mkdirSync(outDir, { recursive: true })
  return path.join(outDir, `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`)
}

/** Width/height/duration of a file we wrote, or nothing when ffprobe can't tell. */
export async function describeFile(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  try {
    return await deps.probe(file, signal)
  } catch (err) {
    if (signal?.aborted) throw new CancelledError()
    log.warn('could not probe a generated file', { file: path.basename(file), error: messageOf(err).slice(0, 200) })
    return {}
  }
}
