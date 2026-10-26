// AI video clips for videos made without recordings, billed to the workspace's own Gemini key.
//   Gemini Omni Flash over the Interactions API: interactions.create in the background (response_format video,
//   16:9 or 9:16 at 720p, duration "<n>s"), interactions.get polled with backoff, the clip read from output_video
//   (GET returns it inline as base64) and written as mp4, then the stored interaction deleted (Google would keep it
//   for up to 55 days). The API reports no percentage, so progress is estimated from elapsed time. A fired signal
//   cancels the remote interaction, and so does VIDEO_TIMEOUT_MS. 1:1 isn't offered by the model: it gets 16:9 (the
//   result carries the real width/height).
// Not here: OpenAI (its Sora video API shut down on 24 Sep 2026, no replacement) and Veo (left the Gemini API on
// 22 Oct 2026). Two request details only the docs vouch for, not a live key: background mode for this model (a 400
// naming it → one synchronous call instead) and the duration format (a 400 naming it → the model's default length).
// The seconds returned are measured from the file.
import fs from 'node:fs'
import { HttpError, invalid } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { redact } from '../common'
import { mapGeminiError } from '../gemini'
import {
  type GeminiMediaClient,
  type GeminiVideoModel,
  type GenInteraction,
  GEMINI_VIDEO_MODELS,
  accountProblem,
  describeFile,
  genDeps,
  outFile,
  requireKey,
  tryModels,
  withoutKey,
} from './capabilities'
import type { GenAspect, GeneratedFile } from './index'

const VIDEO_TIMEOUT_MS = 15 * 60_000
const POLL_FIRST_MS = 5_000
const POLL_MAX_MS = 20_000
/** Typical generation time; only moves the progress bar while the API says nothing. */
const TYPICAL_MS = 120_000
const RESOLUTION = '720p'
const DEFAULT_SECONDS = 8
/** Consecutive failed status checks (network, 429, 5xx) tolerated before giving up on a clip already paid for. */
const MAX_POLL_ERRORS = 4

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

export async function generateVideo(opts: {
  workspaceId: string
  prompt: string
  aspect: GenAspect
  seconds: number
  outDir: string
  signal?: AbortSignal
  onProgress?: (fraction: number, message: string) => void
}): Promise<GeneratedFile & { seconds: number }> {
  if (opts.signal?.aborted) throw new CancelledError()
  const prompt = opts.prompt.trim()
  if (!prompt) throw invalid('Describe the clip to generate.')
  const k = await requireKey(opts.workspaceId, 'video')
  const client = genDeps().gemini(k.key)
  const say = opts.onProgress ?? (() => undefined)
  say(0, 'Starting the AI clip')
  let clip: Awaited<ReturnType<typeof omniClip>>
  let model: GeminiVideoModel
  let current: string | undefined
  try {
    ;({ value: clip, model } = await tryModels(k, 'video', GEMINI_VIDEO_MODELS, (m) => {
      current = m.id
      return omniClip(client, m, { ...opts, prompt }, say)
    }))
  } catch (err) {
    if (opts.signal?.aborted || err instanceof CancelledError) throw new CancelledError()
    try {
      mapVideoError(err, current)
    } catch (mapped) {
      throw withoutKey(mapped, k.key)
    }
  }
  say(0.95, 'Saving the clip')
  const file = outFile(opts.outDir, 'ai-clip', clip.mime === 'video/webm' ? 'webm' : 'mp4')
  await fs.promises.writeFile(file, clip.bytes)
  const info = await describeFile(file, opts.signal)
  say(1, 'Clip ready')
  return {
    file,
    mime: clip.mime,
    provider: 'gemini',
    model: model.id,
    seconds: info.duration ?? clip.seconds,
    ...(info.width ? { width: info.width, height: info.height } : {}),
  }
}

/** One clip from one model: start it, wait for it, return its bytes. */
async function omniClip(
  client: GeminiMediaClient,
  m: GeminiVideoModel,
  opts: { prompt: string; aspect: GenAspect; seconds: number; signal?: AbortSignal },
  say: (fraction: number, message: string) => void,
): Promise<{ bytes: Buffer; mime: string; seconds: number }> {
  const { now, sleep } = genDeps()
  const seconds = clampSeconds(m, opts.seconds)
  const started = now()
  const deadline = started + VIDEO_TIMEOUT_MS
  let it = await start(
    client,
    {
      model: m.id,
      input: opts.prompt,
      response_format: { type: 'video', aspect_ratio: opts.aspect === '9:16' ? '9:16' : '16:9', resolution: RESOLUTION, duration: `${seconds}s` },
      background: true,
    },
    opts.signal,
  )
  let wait = POLL_FIRST_MS
  let errors = 0
  try {
    while (!FINAL.has(it.status)) {
      const left = deadline - now()
      if (left <= 0) {
        await cancelRemote(client, it.id)
        throw timedOut()
      }
      await sleep(Math.min(wait, left), opts.signal)
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5))
      try {
        it = await client.interactions.get(it.id, {}, { signal: opts.signal })
        errors = 0
      } catch (err) {
        const s = statusOf(err)
        if (opts.signal?.aborted || ++errors > MAX_POLL_ERRORS || (typeof s === 'number' && s !== 429 && s < 500)) throw err
        log.warn('gemini clip status check failed, retrying', { id: it.id, status: s, error: redact(messageOf(err)).slice(0, 200) })
        continue
      }
      say(0.05 + 0.85 * (1 - Math.exp(-(now() - started) / TYPICAL_MS)), it.status === 'queued' ? 'Waiting in Gemini’s queue' : 'Generating the clip')
    }
  } catch (err) {
    if (opts.signal?.aborted || err instanceof CancelledError) {
      await cancelRemote(client, it.id)
      throw new CancelledError()
    }
    throw err
  }
  if (it.status !== 'completed') throw failure(it)
  // a synchronous create may answer without the bytes; GET returns them inline
  if (!it.output_video?.data) it = await client.interactions.get(it.id, {}, { signal: opts.signal })
  const video = it.output_video
  if (!video?.data) throw new HttpError(502, 'server', 'Gemini finished the clip but didn’t send it back. Try again.')
  void client.interactions.delete?.(it.id, {}, { signal: AbortSignal.timeout(10_000) })?.catch(() => undefined)
  return { bytes: Buffer.from(video.data, 'base64'), mime: video.mime_type?.startsWith('video/') ? video.mime_type : 'video/mp4', seconds }
}

/** interactions.create, adjusting the two request details the docs leave open when the API names them in a 400. */
async function start(client: GeminiMediaClient, body: Record<string, unknown>, signal?: AbortSignal): Promise<GenInteraction> {
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
      if (msg && attempt < 2 && b.background && /background/i.test(msg)) {
        log.info('gemini clip: background mode refused, generating synchronously', { model: b.model })
        b = { ...b, background: false }
        continue
      }
      if (msg && attempt < 2 && duration && /duration/i.test(msg)) {
        log.info('gemini clip: duration refused, using the model default', { model: b.model, duration })
        b = { ...b, response_format: rf }
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
function failure(it: GenInteraction): HttpError {
  const msg = (it.errors ?? [])
    .map((e) => e.message || e.code || '')
    .filter(Boolean)
    .join('; ')
  if (REFUSAL.test(msg)) return refused()
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
