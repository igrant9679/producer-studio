// media.denoise (E-21): a cleaned copy of a clip's sound or picture. Sound: ffmpeg's afftdn (spectral), or arnndn with
// an RNNoise model the owner configured (DENOISE_MODEL); the picture is copied untouched and the whole file is done,
// so the copy lines up with the original exactly. Picture: hqdn3d (fast) or nlmeans (stronger, slow) over the part
// the clip shows.
import fs from 'node:fs'
import path from 'node:path'
import type { SmartJobResult } from '@producer/core'
import { ctx } from '../context'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { ffmpegProgress } from './proc'
import { probe, sdrFilters } from './process'
import { type SmartInput, VIDEO_OUT, rangeInput, runSmartTool, smartToolsInfo, sourceRange } from './smartTools'

const level = (s?: number) => Math.max(0, Math.min(100, s ?? 50)) / 100

/** The sound filter for a strength 0..100 (`model`: a file name in the working folder). */
export function audioDenoiseFilter(method: 'afftdn' | 'arnndn', strength?: number, model = 'model.rnnn'): string {
  const k = level(strength)
  // afftdn: noise reduction 6..40 dB, the noise floor tracked through the clip
  if (method === 'afftdn') return `afftdn=nr=${Math.round(6 + k * 34)}:nf=-30:tn=1`
  return `arnndn=m=${model}:mix=${(0.3 + k * 0.7).toFixed(2)}`
}

/** The picture filter for a strength 0..100. */
export function videoDenoiseFilter(method: 'hqdn3d' | 'nlmeans', strength?: number): string {
  const k = level(strength) * 2
  if (method === 'hqdn3d') {
    const f = (v: number) => (v * Math.max(0.1, k)).toFixed(2)
    return `hqdn3d=${f(4)}:${f(3)}:${f(6)}:${f(4.5)}`
  }
  return `nlmeans=s=${(1 + k * 4).toFixed(2)}:p=7:r=15`
}

export async function denoiseClip(jc: JobContext): Promise<SmartJobResult> {
  const input = jc.job.input as unknown as SmartInput
  const tools = await smartToolsInfo()
  const target = input.target === 'video' ? 'video' : 'audio'
  const offered: string[] = target === 'audio' ? tools.denoise.audio : tools.denoise.video
  const method = input.method && offered.includes(input.method) ? input.method : offered[0]
  if (!method) throw new HttpError(501, 'server', tools.why.denoise ?? 'Denoising is not available on this server')
  return runSmartTool(
    'denoise',
    jc,
    async ({ row, src, work, progress }) => {
      const info = await probe(src, jc.signal)
      if (target === 'audio') {
        if (!info.hasAudio) throw new HttpError(400, 'invalid', 'This clip has no sound to clean')
        let model: string | undefined
        if (method === 'arnndn') {
          model = 'model.rnnn'
          fs.copyFileSync(ctx().config.denoiseModel!, path.join(work, model))
        }
        const af = audioDenoiseFilter(method as 'afftdn' | 'arnndn', input.strength, model)
        const dur = info.duration ?? row.meta?.duration ?? 1
        // a sound clip, or the sound of a video used on its own (separated): a sound file; a video keeps its picture as it is
        const soundOnly = row.kind === 'audio' || input.soundOnly === true
        // the picture is copied as it is, so the copy keeps the original's container (WebM sound must be Opus)
        const ext = soundOnly ? '.m4a' : path.extname(src).toLowerCase() || '.mp4'
        const out = path.join(work, `denoised${ext}`)
        const sound = ext === '.webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']
        const fast = ['.mp4', '.m4a', '.mov', '.m4v'].includes(ext) ? ['-movflags', '+faststart'] : []
        const args = soundOnly
          ? ['-i', src, '-map', '0:a:0', '-vn', '-af', af, ...sound, ...fast, out]
          : ['-i', src, '-map', `0:${info.videoStream ?? 'v:0'}`, '-map', `0:${info.audioStream ?? 'a:0'}`, '-c:v', 'copy', '-af', af, ...sound, ...fast, out]
        await ffmpegProgress(args, dur, (f) => progress(f, 'Cleaning the sound'), { signal: jc.signal, cwd: work })
        return { file: out, mime: soundOnly ? 'audio/mp4' : row.mime, kind: soundOnly ? 'audio' : 'video', offset: 0 }
      }
      if (row.kind !== 'video') throw new HttpError(400, 'invalid', 'Picture denoising works on video clips')
      const range = sourceRange(input, info.duration ?? row.meta?.duration)
      const out = path.join(work, 'denoised.mp4')
      const vf = [videoDenoiseFilter(method as 'hqdn3d' | 'nlmeans', input.strength), ...(await sdrFilters(info))].join(',')
      const hasAudio = info.hasAudio
      const args = [...rangeInput(src, range), '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []), '-vf', vf, ...VIDEO_OUT, ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), out]
      await ffmpegProgress(args, range.length ?? info.duration ?? 1, (f) => progress(f, 'Cleaning the picture'), { signal: jc.signal, cwd: work })
      return { file: out, mime: 'video/mp4', kind: 'video', offset: range.from, length: range.length }
    },
    { target, method, strength: input.strength ?? 50 },
  )
}
