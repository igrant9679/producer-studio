// A song cut to a length (23 Nov 2026): the music library's songs under a video Producer makes (ai/soundtrack.ts), and
// under the library's own full-motion clips (services/media-library.ts scoreClip). Cut, or looped with a crossfade when
// the song is shorter, faded at the ends, and set to a loudness by two passes of loudnorm (measured, then one gain for
// the whole piece, so its dynamics stay). Only the level changes: the song's pitch and speed are never touched.
import fs from 'node:fs'
import { HttpError } from '../http'
import { measureLoudness } from '../render/loudness'
import { ffmpeg } from './proc'

/** Seconds the song fades out over at the end of the video. */
export const LIBRARY_FADE_OUT = 2.5
/** Seconds two plays of a song overlap where a video longer than it loops it. */
const LOOP_CROSSFADE = 3

/**
 * The music file for a video `duration` long from `src` (a song `seconds` long), as AAC: from `from` seconds into the
 * song (when it is long enough to play from there; a loop starts at its beginning), faded in over `fadeIn` seconds,
 * looped if short, cut, faded out, and set to `lufs` integrated loudness.
 */
export async function fitSong(o: { src: string; seconds: number; duration: number; lufs: number; out: string; from?: number; fadeIn?: number; fadeOut?: number; signal?: AbortSignal }): Promise<void> {
  const d = Math.max(1, o.duration)
  const fade = Math.round(Math.min(o.fadeOut ?? LIBRARY_FADE_OUT, d / 3) * 100) / 100
  const from = o.from && o.from > 0 && o.seconds - o.from >= d ? o.from : 0
  const wav = o.out.replace(/\.[^.]+$/, '') + '.fit.wav'
  const fadeIn = o.fadeIn && o.fadeIn > 0 ? `,afade=t=in:st=0:d=${Math.min(o.fadeIn, d / 3).toFixed(2)}` : ''
  const tail = `atrim=0:${d.toFixed(3)},asetpts=N/SR/TB${fadeIn},afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade}`
  const loops = o.seconds - from >= d ? 1 : o.seconds > LOOP_CROSSFADE * 2 ? Math.min(12, Math.ceil((d - o.seconds) / (o.seconds - LOOP_CROSSFADE)) + 1) : 0
  const args = ['-y', '-v', 'error']
  let graph: string
  if (loops === 1) {
    if (from) args.push('-ss', from.toFixed(3))
    args.push('-i', o.src)
    graph = `[0:a]${tail}[out]`
  } else if (loops > 1) {
    for (let i = 0; i < loops; i++) args.push('-i', o.src)
    const steps: string[] = []
    let prev = '[0:a]'
    for (let i = 1; i < loops; i++) {
      steps.push(`${prev}[${i}:a]acrossfade=d=${LOOP_CROSSFADE}:c1=tri:c2=tri[x${i}]`)
      prev = `[x${i}]`
    }
    graph = `${steps.join(';')};${prev}${tail}[out]`
  } else {
    // a clip too short to crossfade with itself: played over and over
    args.push('-stream_loop', '-1', '-i', o.src)
    graph = `[0:a]${tail}[out]`
  }
  try {
    await ffmpeg([...args, '-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '2', wav], { signal: o.signal })
    const m = await measureLoudness(wav, o.signal)
    // two passes: measured, then one gain for the whole song (its dynamics stay), with a true-peak ceiling
    const level =
      m && m.i > -70
        ? `loudnorm=I=${o.lufs}:TP=-1.5:LRA=11:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary`
        : 'anull'
    await ffmpeg(['-y', '-v', 'error', '-i', wav, '-af', level, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', o.out], { signal: o.signal })
  } finally {
    fs.rm(wav, { force: true }, () => undefined)
  }
  if (!fs.existsSync(o.out)) throw new HttpError(500, 'server', 'The song could not be fitted to the video')
}
