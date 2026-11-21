// AI music for the media library (21 Nov 2026): one song from Google's Lyria on a space's own Gemini key, over the
// Interactions API (Google's music guide: POST /v1beta/interactions {model, input}; the song comes back in the same
// answer as a base64 audio block, MP3 by default; a song is billed per song, not per second). Instrumental songs are
// asked for in the prompt (the library's prompts say so); any lyrics the model returns as text are ignored.
import fs from 'node:fs'
import { HttpError } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { mapGeminiError } from '../gemini'
import { type GenInteraction, GEMINI_MUSIC_MODELS, accountProblem, describeFile, genDeps, outFile, requireKey, tryModels, withoutKey } from './capabilities'

/** A whole song takes Google a minute or two; past this it has stalled. */
const MUSIC_TIMEOUT_MS = 6 * 60_000

export interface MadeSong {
  file: string
  mime: string
  /** Measured from the file. */
  seconds: number
  model: string
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac' }

/** The song's audio block, wherever this answer carries it (the SDK's helper, the turns, or the outputs). */
export function songOf(it: GenInteraction): { data: string; mime: string } | undefined {
  const pick = (b: { data?: string; mime_type?: string } | undefined) => (b?.data ? { data: b.data, mime: (b.mime_type || 'audio/mpeg').split(';')[0].toLowerCase() } : undefined)
  const direct = pick(it.output_audio)
  if (direct) return direct
  const blocks = [...(it.steps ?? []).flatMap((s) => s.content ?? []), ...(it.outputs ?? [])].filter((b) => b.type === 'audio')
  return pick(blocks.at(-1))
}

/** One song on the space's Gemini key, written to `outDir`. */
export async function generateMusic(o: { workspaceId: string; prompt: string; outDir: string; signal?: AbortSignal }): Promise<MadeSong> {
  const k = await requireKey(o.workspaceId, 'music')
  const client = genDeps().gemini(k.key)
  const timer = AbortSignal.timeout(MUSIC_TIMEOUT_MS)
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer
  try {
    const { value, model } = await tryModels(k, 'music', GEMINI_MUSIC_MODELS, async (m) => {
      const it = await client.interactions.create({ model: m.id, input: o.prompt }, { signal })
      if (it.status && ['failed', 'cancelled', 'incomplete'].includes(it.status)) {
        const why = it.errors?.map((e) => e.message).filter(Boolean).join('; ')
        throw new HttpError(502, 'server', `Google didn’t finish the song${why ? `: ${why}` : '.'}`)
      }
      const song = songOf(it)
      if (!song) throw new HttpError(502, 'server', 'Google answered without a song (no audio in the answer). Try again; a prompt it won’t set to music is answered this way too.')
      void client.interactions.delete?.(it.id, {}, { signal: AbortSignal.timeout(10_000) })?.catch(() => undefined)
      return song
    })
    const file = outFile(o.outDir, 'song', EXT[value.mime] ?? 'mp3')
    fs.writeFileSync(file, Buffer.from(value.data, 'base64'))
    const seconds = (await describeFile(file, o.signal)).duration ?? 0
    if (seconds < 5) throw new HttpError(502, 'server', `The song Google sent is ${seconds ? `${seconds.toFixed(1)} s long` : 'unreadable'}: not kept.`)
    log.info('lyria: song made', { model: model.id, seconds: Math.round(seconds) })
    return { file, mime: value.mime, seconds, model: model.id }
  } catch (err) {
    if (o.signal?.aborted) throw new CancelledError()
    if (timer.aborted) throw new HttpError(504, 'server', 'Google took longer than 6 minutes to write the song, so it was stopped.')
    if (err instanceof HttpError) throw withoutKey(err, k.key)
    const account = accountProblem('gemini', err)
    if (account) throw account
    try {
      mapGeminiError(err)
    } catch (mapped) {
      throw withoutKey(mapped, k.key)
    }
  }
}
