// AI video clips for videos made without recordings, billed to the workspace's own Gemini or fal.ai key (which one:
// capabilities.ts). Wan on fal.ai is in fal.ts; Gemini is here.
//   Gemini Omni Flash over the Interactions API: interactions.create in the background (response_format video,
//   16:9 or 9:16 at 720p, duration "<n>s"), interactions.get polled with backoff, the clip read from output_video
//   (GET returns it inline as base64) and written as mp4, then the stored interaction deleted (Google would keep it
//   for up to 55 days). The API reports no percentage, so progress is estimated from elapsed time. A fired signal
//   cancels the remote interaction, and so does VIDEO_TIMEOUT_MS. 1:1 isn't offered by the model: it gets 16:9 (the
//   result carries the real width/height).
// Not here: OpenAI (its Sora video API shut down on 24 Sep 2026, no replacement) and Veo (left the Gemini API on
// 22 Oct 2026). Two request details only the docs vouch for, not a live key: background mode for this model (a 400
// naming it → one synchronous call instead) and the duration format (a 400 naming it → the model's default length).
// The seconds returned are measured from the file, and counted for the Usage page (services/metering recordClip).
// A clip can start from a picture (`image`, a still made first): Wan on fal animates it (image-to-video); Gemini is
// given the words alone, so its clips are made as before.
// A clip can also be given reference pictures (`references`: the film's characters, painted once), so the same fox is
// the same fox in every clip. Gemini Omni 1.2 takes them as image parts before the words (its guide: up to 6 a request,
// 3 per character for up to 2 characters) with video_config.task 'reference_to_video', so a picture is never taken for
// the clip's first frame. Like the two details above, only the docs vouch for this shape: a 400 naming the task or
// the pictures has the clip made without them (as before) rather than not at all.
// Flow-style clips (24 Nov 2026; Google's Flow app has no API, but it is built on these two Omni abilities):
//   a start frame (`startFrame`: flowing scenes, the last frame of the clip before) begins the clip on that picture.
//     Wan takes it as its first frame instead of painting one; Gemini gets it as the only picture with task
//     'image_to_video' (never with reference pictures: a second picture would be read as the shot's last frame).
//   an extension (`extend`: long shots) makes a scene longer than one generation one shot: the clip is extended 3–10 s
//     a turn with previous_interaction_id, up to the model's extendTo (30 s). The guide doesn't say whether a turn
//     returns the whole shot or only what it adds, so each turn's measured length decides (extendShot). The stored
//     interactions are deleted only once the shot is saved, since each turn needs the one before.
import fs from 'node:fs'
import { HttpError, invalid } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { recordClip } from '../../services/metering'
import { redact } from '../common'
import { mapGeminiError } from '../gemini'
import { FAL_IMAGE_VIDEO_MODELS, FAL_VIDEO_MODELS, type FalVideoModel, falClip, falModelName, mapFalError } from './fal'
import { sniffImage } from './images'
import {
  type GeminiMediaClient,
  type GeminiVideoModel,
  type GenInteraction,
  type GenKey,
  GEMINI_VIDEO_MODELS,
  GeminiVideoRefused,
  type MediaInfo,
  accountProblem,
  describeFile,
  genDeps,
  outFile,
  requireKey,
  tryModels,
  withoutKey,
} from './capabilities'
import type { GenAspect, GeneratedFile, GenProvider } from './index'

const VIDEO_TIMEOUT_MS = 15 * 60_000
const POLL_FIRST_MS = 5_000
const POLL_MAX_MS = 20_000
/** Typical generation time; only moves the progress bar while the API says nothing. */
const TYPICAL_MS = 120_000
/** Wan 2.2 A14B at 720p on fal takes a few minutes. */
const FAL_TYPICAL_MS = 180_000
const RESOLUTION = '720p'
const DEFAULT_SECONDS = 8
/** Consecutive failed status checks (network, 429, 5xx) tolerated before giving up on a clip already paid for. */
const MAX_POLL_ERRORS = 4
/** What Gemini is told about a start frame (it goes before the shot's own words). */
export const FROM_FRAME = 'The picture is this shot’s first frame: begin exactly on it and carry on from there.\n\n'
/** What Gemini is told when it extends a shot (before the shot's own words). */
export const EXTEND_WORDS = 'Continue this shot seamlessly from its last frame, in the same scene, look and camera: '
/** One extension turn adds this many seconds at least and at most (Google's Omni guide). */
const EXTEND_MIN = 3
const EXTEND_MAX = 10
/** Seconds still missing below which a shot isn't extended (the timeline holds its last frame that long instead). */
const EXTEND_WORTH = 2
/** Extension turns at most for one shot (15 → 30 s takes two). */
const EXTEND_TURNS = 4
/** The share of the progress bar the first generation of a shot that will be extended takes. */
const FIRST_SHARE = 0.55

/** Interaction states after which nothing more will happen. */
const FINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action'])
const REFUSAL = /(safety|polic(y|ies)|blocked|prohibited|responsible ai|\brai\b|violat|sensitive)/i

const refused = () => new HttpError(422, 'invalid', 'Gemini declined to make this clip (its content rules). Try describing the scene differently.')
const timedOut = () =>
  new HttpError(504, 'server', `The AI clip wasn’t ready after ${VIDEO_TIMEOUT_MS / 60_000} minutes, so it was stopped. Try again, perhaps with a simpler scene.`)
const statusOf = (err: unknown) => (err as { status?: unknown }).status
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err ?? ''))

/** Seconds the model can make: a whole number within its range (8 when unspecified). */
export function clampSeconds(m: GeminiVideoModel, seconds: number): number {
  const n = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : DEFAULT_SECONDS
  return Math.min(m.maxSeconds, Math.max(m.minSeconds, n))
}

interface VideoOptions {
  workspaceId: string
  prompt: string
  aspect: GenAspect
  seconds: number
  outDir: string
  /** A still to start the clip from (a file); used by Wan on fal (image-to-video). */
  image?: string
  /** Reference pictures of the clip's characters (files), in the order the prompt numbers them; used by Gemini. */
  references?: string[]
  /** The frame the clip starts from (a file; flowing scenes: the last frame of the clip before it). Wan takes it as its
   * first frame in place of `image`; Gemini as its only picture (image_to_video), so `references` are left out. */
  startFrame?: string
  /** A clip asked for longer than one generation is extended to `seconds` (up to the model's extendTo: Gemini Omni),
   * rather than left at the model's longest. */
  extend?: boolean
  /** Only this provider's key (the media library's clips are Gemini's, whatever the space's video choice). */
  provider?: GenProvider
  signal?: AbortSignal
  onProgress?: (fraction: number, message: string) => void
}
type MadeClip = GeneratedFile & {
  seconds: number
  fromPicture?: boolean
  /** Reference pictures the clip was made with. */
  references?: number
  /** It began on the start frame it was given (false or absent: the provider wouldn't take it, so it didn't). */
  fromFrame?: boolean
  /** It was extended: its length before (seconds). */
  extendedFrom?: number
  /** It was to be extended and wasn't, or not all the way: why, in words for people. */
  notExtended?: string
}

/**
 * One AI clip on the space's own key. Each clip a provider returns is counted for the Usage page (its seconds as
 * measured from the file, under the provider and model that made it): the provider bills by the second, and nothing
 * else here tells the owner how many were generated.
 */
export async function generateVideo(opts: VideoOptions): Promise<MadeClip> {
  const clip = await makeVideo(opts)
  await recordClip(opts.workspaceId, clip)
  return clip
}

async function makeVideo(opts: VideoOptions): Promise<MadeClip> {
  if (opts.signal?.aborted) throw new CancelledError()
  const prompt = opts.prompt.trim()
  if (!prompt) throw invalid('Describe the clip to generate.')
  const k = await requireKey(opts.workspaceId, 'video', opts.provider)
  const say = opts.onProgress ?? (() => undefined)
  say(0, 'Starting the AI clip')
  // Wan starts from the start frame where it would have started from a painted picture
  const onFal = { ...opts, prompt, image: opts.startFrame ?? opts.image }
  const fal = async (key: GenKey): Promise<MadeClip> => ({ ...(await falVideo(key, onFal, say)), ...(opts.startFrame ? { fromFrame: true } : {}) })
  if (k.provider === 'fal') return fal(k)
  try {
    return await geminiVideo(k, { ...opts, prompt }, say)
  } catch (err) {
    // Google refused every video model for this key: a stored fal.ai key makes this clip (and, while Gemini is passed
    // over, the next ones) instead
    if (!(err instanceof HttpError) || err.status !== 503 || opts.provider) throw err
    const next = await requireKey(opts.workspaceId, 'video').catch(() => undefined)
    if (next?.provider !== 'fal') throw err
    log.info('gemini clips refused for this key; making the clip with fal.ai instead')
    return fal(next)
  }
}

/** The seconds a clip was asked for (8 when unspecified). */
const wantedSeconds = (seconds: number) => (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SECONDS)

async function geminiVideo(
  k: GenKey,
  opts: { prompt: string; aspect: GenAspect; seconds: number; outDir: string; references?: string[]; startFrame?: string; extend?: boolean; signal?: AbortSignal },
  say: (fraction: number, message: string) => void,
): Promise<MadeClip> {
  const prompt = opts.prompt
  const client = genDeps().gemini(k.key)
  // a model that extends, asked for a shot noticeably longer than one generation: the first generation is the start
  const longer = (m: GeminiVideoModel) => !!opts.extend && !!m.extendTo && wantedSeconds(opts.seconds) - m.maxSeconds >= EXTEND_WORTH
  // the stored interactions, deleted once the clip is saved (Google would keep them for up to 55 days); an extension
  // needs the interaction before it until it is made
  const stored: string[] = []
  try {
    let clip: Awaited<ReturnType<typeof omniClip>>
    let model: GeminiVideoModel
    let current: string | undefined
    try {
      ;({ value: clip, model } = await tryModels(k, 'video', GEMINI_VIDEO_MODELS, (m) => {
        current = m.id
        const share = longer(m) ? FIRST_SHARE : 1
        return omniClip(client, m, { ...opts, prompt }, (f, msg) => say(f * share, msg))
      }))
    } catch (err) {
      if (opts.signal?.aborted || err instanceof CancelledError) throw new CancelledError()
      try {
        mapVideoError(err, current)
      } catch (mapped) {
        throw withoutKey(mapped, k.key)
      }
    }
    stored.push(clip.id)
    say(longer(model) ? FIRST_SHARE : 0.95, 'Saving the clip')
    const file = outFile(opts.outDir, 'ai-clip', clip.mime === 'video/webm' ? 'webm' : 'mp4')
    await fs.promises.writeFile(file, clip.bytes)
    const info = await describeFile(file, opts.signal)
    let shot: { file: string; seconds: number; info: MediaInfo; extendedFrom?: number; notExtended?: string } = { file, seconds: info.duration ?? clip.seconds, info }
    if (longer(model)) {
      shot = await extendShot(
        client,
        model,
        { prompt, aspect: opts.aspect, outDir: opts.outDir, signal: opts.signal, wanted: Math.min(wantedSeconds(opts.seconds), model.extendTo!), id: clip.id, stored, ...shot },
        (f, msg) => say(FIRST_SHARE + f * (0.95 - FIRST_SHARE), msg),
      )
      say(0.95, 'Saving the clip')
    }
    say(1, 'Clip ready')
    return {
      file: shot.file,
      mime: shot.file === file ? clip.mime : 'video/mp4',
      provider: 'gemini',
      model: model.id,
      seconds: shot.seconds,
      ...(shot.info.width ? { width: shot.info.width, height: shot.info.height } : {}),
      ...(clip.references ? { references: clip.references } : {}),
      ...(opts.startFrame ? { fromFrame: !!clip.fromFrame } : {}),
      ...(shot.extendedFrom !== undefined ? { extendedFrom: shot.extendedFrom } : {}),
      ...(shot.notExtended ? { notExtended: shot.notExtended } : {}),
    }
  } finally {
    for (const id of stored) void client.interactions.delete?.(id, {}, { signal: AbortSignal.timeout(10_000) })?.catch(() => undefined)
  }
}

/**
 * A shot extended turn by turn until it is `wanted` seconds long, each turn 3–10 s continuing from the interaction
 * before it. Google's guide doesn't say whether a turn returns the whole shot so far or only what it adds, so each
 * turn's measured length tells: the whole shot replaces the pieces, a continuation is joined on after them. A turn
 * that fails (or can't be measured) keeps the shot as far as it got and says why: the clip already paid for is never
 * lost to an extension.
 */
async function extendShot(
  client: GeminiMediaClient,
  m: GeminiVideoModel,
  o: { prompt: string; aspect: GenAspect; outDir: string; signal?: AbortSignal; wanted: number; id: string; stored: string[]; file: string; seconds: number; info: MediaInfo },
  say: (fraction: number, message: string) => void,
): Promise<{ file: string; seconds: number; info: MediaInfo; extendedFrom?: number; notExtended?: string }> {
  const from = o.seconds
  let pieces = [o.file]
  let total = o.seconds
  let last = o.id
  let why: string | undefined
  // without the first clip's length nothing below can tell a whole shot from a continuation
  if (o.info.duration === undefined) why = 'its length couldn’t be measured'
  const turns = Math.max(1, Math.ceil((o.wanted - total) / EXTEND_MAX))
  // never backwards: a turn past the estimate (a continuation shorter than asked) stays where the bar is
  let shown = 0
  const tell = (f: number, message: string) => say((shown = Math.max(shown, Math.min(1, f))), message)
  for (let turn = 0; !why && turn < EXTEND_TURNS && o.wanted - total >= EXTEND_WORTH; turn++) {
    const add = Math.min(EXTEND_MAX, Math.max(EXTEND_MIN, Math.ceil(o.wanted - total)))
    const lo = Math.min(turn, turns - 1) / turns
    const message = `Extending the shot to ${Math.round(Math.min(o.wanted, total + add))} s`
    tell(lo, message)
    let ext: Awaited<ReturnType<typeof omniExtend>>
    try {
      ext = await omniExtend(client, m, { prompt: o.prompt, aspect: o.aspect, seconds: add, previous: last, signal: o.signal }, (f) => tell(lo + f / turns, message))
    } catch (err) {
      if (o.signal?.aborted || err instanceof CancelledError) throw new CancelledError()
      why = err instanceof HttpError ? err.message : 'Gemini couldn’t extend it'
      log.warn('gemini clip: an extension failed; the shot is kept as far as it got', { model: m.id, seconds: total, error: redact(messageOf(err)).slice(0, 200) })
      break
    }
    o.stored.push(ext.id)
    last = ext.id
    const part = outFile(o.outDir, 'ai-clip-more', ext.mime === 'video/webm' ? 'webm' : 'mp4')
    await fs.promises.writeFile(part, ext.bytes)
    const d = (await describeFile(part, o.signal)).duration
    if (d === undefined) {
      why = 'the extension’s length couldn’t be measured'
      break
    }
    if (d >= total + add / 2) {
      // the whole shot so far, longer
      pieces = [part]
      total = d
    } else {
      pieces.push(part)
      total += d
    }
  }
  if (total < from + 0.5) return { file: o.file, seconds: from, info: o.info, notExtended: why ?? 'Gemini returned nothing longer' }
  let file = pieces[0]
  if (pieces.length > 1) {
    file = outFile(o.outDir, 'ai-clip-long', 'mp4')
    try {
      await genDeps().join(pieces, file, o.signal)
    } catch (err) {
      if (o.signal?.aborted) throw new CancelledError()
      log.warn('gemini clip: the extended pieces could not be joined; the shot is kept as it was', { error: messageOf(err).slice(0, 200) })
      return { file: o.file, seconds: from, info: o.info, notExtended: 'the extended pieces couldn’t be joined' }
    }
  }
  const info = await describeFile(file, o.signal)
  return { file, seconds: info.duration ?? total, info: info.width ? info : o.info, extendedFrom: from, ...(why ? { notExtended: why } : {}) }
}

/** A clip from Wan on fal.ai, trying FAL_VIDEO_MODELS in order (one fal no longer hosts is skipped). */
async function falVideo(
  k: GenKey,
  opts: { prompt: string; aspect: GenAspect; seconds: number; outDir: string; image?: string; signal?: AbortSignal },
  say: (fraction: number, message: string) => void,
): Promise<GeneratedFile & { seconds: number; fromPicture?: boolean }> {
  const deps = genDeps()
  const image = opts.image ? await dataUri(opts.image) : undefined
  let clip: Awaited<ReturnType<typeof falClip>>
  let model: FalVideoModel
  try {
    ;({ value: clip, model } = await tryModels(k, 'video', image ? FAL_IMAGE_VIDEO_MODELS : FAL_VIDEO_MODELS, (m) =>
      falClip(
        deps,
        k.key,
        m,
        { prompt: opts.prompt, ...(image ? { image } : {}), aspect: opts.aspect, seconds: Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : DEFAULT_SECONDS, signal: opts.signal, timeoutMs: VIDEO_TIMEOUT_MS, pollFirstMs: POLL_FIRST_MS, pollMaxMs: POLL_MAX_MS, typicalMs: FAL_TYPICAL_MS, maxPollErrors: MAX_POLL_ERRORS },
        say,
      ),
    ))
  } catch (err) {
    if (opts.signal?.aborted || err instanceof CancelledError) throw new CancelledError()
    try {
      mapFalError(err)
    } catch (mapped) {
      throw withoutKey(mapped, k.key)
    }
  }
  say(0.95, 'Saving the clip')
  const file = outFile(opts.outDir, 'ai-clip', clip.mime === 'video/webm' ? 'webm' : 'mp4')
  await fs.promises.writeFile(file, clip.bytes)
  const info = await describeFile(file, opts.signal)
  say(1, 'Clip ready')
  log.info('fal clip made', { model: falModelName(model.id), seconds: info.duration ?? clip.seconds, fromPicture: !!image })
  return {
    file,
    mime: clip.mime,
    provider: 'fal',
    model: model.id,
    ...(image ? { fromPicture: true } : {}),
    seconds: info.duration ?? clip.seconds,
    ...(info.width ? { width: info.width, height: info.height } : {}),
  }
}

/** A picture on disk as a data URI (what fal's image_url takes). Pictures are a few hundred KB to a few MB. */
async function dataUri(file: string): Promise<string> {
  const bytes = await fs.promises.readFile(file)
  if (bytes.length > 15 * 1024 * 1024) throw invalid('The starting picture is too big to send (over 15 MB).')
  const mime = sniffImage(bytes)
  if (!mime) throw invalid('The starting picture isn’t a JPEG, PNG or WebP image.')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** A picture on disk as an image part of the request (`what` names it in the reasons it can't be sent). */
async function imagePart(file: string, what = 'A reference picture'): Promise<{ type: 'image'; data: string; mime_type: string }> {
  const bytes = await fs.promises.readFile(file)
  if (bytes.length > 15 * 1024 * 1024) throw invalid(`${what} is too big to send (over 15 MB).`)
  const mime = sniffImage(bytes)
  if (!mime) throw invalid(`${what} isn’t a JPEG, PNG or WebP image.`)
  return { type: 'image', data: bytes.toString('base64'), mime_type: mime }
}

const aspectOf = (aspect: GenAspect) => (aspect === '9:16' ? '9:16' : '16:9')

/** One clip from one model: start it, wait for it, return its bytes and the stored interaction (the caller deletes it). */
async function omniClip(
  client: GeminiMediaClient,
  m: GeminiVideoModel,
  opts: { prompt: string; aspect: GenAspect; seconds: number; references?: string[]; startFrame?: string; signal?: AbortSignal },
  say: (fraction: number, message: string) => void,
): Promise<{ id: string; bytes: Buffer; mime: string; seconds: number; references?: number; fromFrame?: boolean }> {
  const seconds = clampSeconds(m, opts.seconds)
  const started = genDeps().now()
  // a start frame is the only picture sent (image_to_video): with a reference beside it, two pictures would be read
  // as the shot's first and last frames
  const frame = opts.startFrame ? await imagePart(opts.startFrame, 'The starting frame') : undefined
  // else the characters' pictures, for a model that takes them (the others get the words, which describe them too)
  const pictures = frame ? [frame] : m.references ? await Promise.all((opts.references ?? []).slice(0, m.references).map((f) => imagePart(f))) : []
  let references = frame ? 0 : pictures.length
  let fromFrame = !!frame
  const it = await start(
    client,
    {
      model: m.id,
      input: pictures.length ? [...pictures, { type: 'text', text: frame ? FROM_FRAME + opts.prompt : opts.prompt }] : opts.prompt,
      response_format: { type: 'video', aspect_ratio: aspectOf(opts.aspect), resolution: RESOLUTION, duration: `${seconds}s` },
      ...(pictures.length ? { generation_config: { video_config: { task: frame ? 'image_to_video' : 'reference_to_video' } } } : {}),
      background: true,
    },
    opts.signal,
    () => {
      references = 0
      fromFrame = false
    },
  )
  const video = await finish(client, it, started, opts.signal, say)
  return { ...video, seconds, ...(references ? { references } : {}), ...(fromFrame ? { fromFrame } : {}) }
}

/** One extension turn: `seconds` more of the shot `previous` (a stored interaction) made, continuing from its end. */
async function omniExtend(
  client: GeminiMediaClient,
  m: GeminiVideoModel,
  o: { prompt: string; aspect: GenAspect; seconds: number; previous: string; signal?: AbortSignal },
  say: (fraction: number, message: string) => void,
): Promise<{ id: string; bytes: Buffer; mime: string }> {
  const started = genDeps().now()
  const it = await start(
    client,
    {
      model: m.id,
      input: EXTEND_WORDS + o.prompt,
      previous_interaction_id: o.previous,
      response_format: { type: 'video', aspect_ratio: aspectOf(o.aspect), resolution: RESOLUTION, duration: `${o.seconds}s` },
      generation_config: { video_config: { task: 'extend' } },
      background: true,
    },
    o.signal,
  )
  return finish(client, it, started, o.signal, say)
}

/** Wait for a started interaction to finish (polling with backoff, cancelling it on a fired signal or the time limit) and read its clip. */
async function finish(
  client: GeminiMediaClient,
  first: GenInteraction,
  started: number,
  signal: AbortSignal | undefined,
  say: (fraction: number, message: string) => void,
): Promise<{ id: string; bytes: Buffer; mime: string }> {
  const { now, sleep } = genDeps()
  const deadline = started + VIDEO_TIMEOUT_MS
  let it = first
  let wait = POLL_FIRST_MS
  let errors = 0
  try {
    while (!FINAL.has(it.status)) {
      const left = deadline - now()
      if (left <= 0) {
        await cancelRemote(client, it.id)
        throw timedOut()
      }
      await sleep(Math.min(wait, left), signal)
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5))
      try {
        it = await client.interactions.get(it.id, {}, { signal: signal })
        errors = 0
      } catch (err) {
        const s = statusOf(err)
        if (signal?.aborted || ++errors > MAX_POLL_ERRORS || (typeof s === 'number' && s !== 429 && s < 500)) throw err
        log.warn('gemini clip status check failed, retrying', { id: it.id, status: s, error: redact(messageOf(err)).slice(0, 200) })
        continue
      }
      say(0.05 + 0.85 * (1 - Math.exp(-(now() - started) / TYPICAL_MS)), it.status === 'queued' ? 'Waiting in Gemini’s queue' : 'Generating the clip')
    }
  } catch (err) {
    if (signal?.aborted || err instanceof CancelledError) {
      await cancelRemote(client, it.id)
      throw new CancelledError()
    }
    throw err
  }
  if (it.status !== 'completed') throw failure(it)
  // a synchronous create may answer without the bytes; GET returns them inline
  if (!it.output_video?.data) it = await client.interactions.get(it.id, {}, { signal: signal })
  const video = it.output_video
  if (!video?.data) throw new HttpError(502, 'server', 'Gemini finished the clip but didn’t send it back. Try again.')
  return { id: it.id, bytes: Buffer.from(video.data, 'base64'), mime: video.mime_type?.startsWith('video/') ? video.mime_type : 'video/mp4' }
}

/**
 * interactions.create, adjusting the request details the docs leave open when the API names them in a 400: background
 * mode, the duration, and the reference pictures (their task first, then the pictures themselves: `withoutPictures`
 * is told, and the clip is made from the words as it always was).
 */
async function start(client: GeminiMediaClient, body: Record<string, unknown>, signal?: AbortSignal, withoutPictures?: () => void): Promise<GenInteraction> {
  // a synchronous fallback holds the request open for the whole generation: bound it like the polling
  const timer = AbortSignal.timeout(VIDEO_TIMEOUT_MS)
  const both = signal ? AbortSignal.any([signal, timer]) : timer
  let b = body
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.interactions.create(b, { signal: both })
    } catch (err) {
      if (timer.aborted && !signal?.aborted) throw timedOut()
      const msg = statusOf(err) === 400 ? messageOf(err) : ''
      const { duration, ...rf } = b.response_format as Record<string, unknown>
      if (msg && attempt < 4 && b.background && /background/i.test(msg)) {
        log.info('gemini clip: background mode refused, generating synchronously', { model: b.model })
        b = { ...b, background: false }
        continue
      }
      if (msg && attempt < 4 && duration && /duration/i.test(msg)) {
        log.info('gemini clip: duration refused, using the model default', { model: b.model, duration })
        b = { ...b, response_format: rf }
        continue
      }
      if (msg && attempt < 4 && b.generation_config && /(generation_config|video_config|\btask\b|reference_to_video|image_to_video)/i.test(msg)) {
        log.info('gemini clip: the task was refused, sending the request without it', { model: b.model })
        const { generation_config: _task, ...rest } = b
        b = rest
        continue
      }
      if (msg && attempt < 4 && Array.isArray(b.input) && /(image|picture|reference|input|content|modalit)/i.test(msg)) {
        log.warn('gemini clip: reference pictures refused, making the clip from the words', { model: b.model, error: redact(msg).slice(0, 200) })
        const { generation_config: _task, ...rest } = b
        const text = (b.input as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text ?? ''
        // (a start frame's words say there is a picture: not without it)
        b = { ...rest, input: text.startsWith(FROM_FRAME) ? text.slice(FROM_FRAME.length) : text }
        withoutPictures?.()
        continue
      }
      throw err
    }
  }
}

async function cancelRemote(client: GeminiMediaClient, id: string) {
  try {
    await client.interactions.cancel(id, {}, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    log.warn('could not cancel a gemini clip', { id, error: redact(messageOf(err)).slice(0, 200) })
  }
}

/** Why a finished interaction has no clip, in words for people. */
function failure(it: GenInteraction): Error {
  const msg = (it.errors ?? [])
    .map((e) => e.message || e.code || '')
    .filter(Boolean)
    .join('; ')
  if (REFUSAL.test(msg)) return refused()
  // Google's generic stop: not this model for this key (tryModels moves on, then says what it usually means)
  if (it.status === 'failed' && /problem processing your request/i.test(msg)) return new GeminiVideoRefused(msg)
  if (it.status === 'budget_exceeded') return new HttpError(429, 'quota', 'This Gemini key reached its spending cap. Raise it in Google AI Studio, then try again.')
  if (/(quota|rate limit|resource.?exhausted)/i.test(msg)) return new HttpError(429, 'quota', 'Gemini quota or rate limit reached for this key. Try again in a moment, or check your plan in Google AI Studio.')
  if (it.status === 'cancelled') return new HttpError(502, 'server', 'Gemini cancelled the clip before it finished. Try again.')
  return new HttpError(502, 'server', `Gemini couldn’t make this clip${msg ? `: ${redact(msg).slice(0, 300)}` : '. Try again.'}`)
}

function mapVideoError(err: unknown, model?: string): never {
  const account = accountProblem('gemini', err)
  if (account) throw account
  if (statusOf(err) === 400 && REFUSAL.test(messageOf(err))) throw refused()
  // the Interactions client reports network trouble as its own error classes, not fetch's TypeError
  if (err instanceof Error && /^APIConnection/.test(err.name)) throw new HttpError(502, 'server', 'Could not reach Gemini')
  mapGeminiError(err, model)
}
